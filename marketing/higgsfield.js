import { clean, marketingError, publicMarketingUrl } from './project-store.js';

// Verified against https://docs.higgsfield.ai/docs/openapi.json, 2026-09-14.
const ORIGIN = 'https://api.higgsfield.ai';
const MODELS = {
  'veo-3.1': { endpoint: '/veo3.1', label: 'Veo 3.1 · 1080p mit Ton', durations: [4, 6, 8], imageRequired: false },
  'veo-3.1-image': { endpoint: '/veo3.1/image-to-video', label: 'Veo 3.1 · eigenes Bild animieren', durations: [4, 6, 8], imageRequired: true },
  'veo-3.1-fast': { endpoint: '/veo3.1/fast', label: 'Veo 3.1 Fast · Preis vergleichen', durations: [4, 6, 8], imageRequired: false },
};
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const STATES = new Set(['queued', 'in_progress', 'nsfw', 'failed', 'completed', 'canceled']);
export const higgsfieldModels = () => Object.entries(MODELS).map(([id, row]) => ({ id, label: row.label, durations: row.durations, imageRequired: row.imageRequired, resolution: '1080', audio: true }));
function authorization(env) {
  const id = env.HF_API_KEY_ID, secret = env.HF_API_KEY_SECRET;
  if (typeof id !== 'string' || typeof secret !== 'string' || !id || !secret || /[\s:]/.test(id) || /[\s:]/.test(secret) || id.length > 500 || secret.length > 1000) throw marketingError('HIGGSFIELD_MISSING', 'Bitte Higgsfield mit Key-ID und Secret für dieses Projekt verbinden.', 503);
  return `Key ${id}:${secret}`;
}
export function createHiggsfieldClient({ fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  function prepare({ model = 'veo-3.1', prompt, aspectRatio = '9:16', duration = 6, imageUrl = '' } = {}) {
    const row = MODELS[model];
    if (!row || !row.durations.includes(Number(duration)) || !['9:16','16:9'].includes(aspectRatio)) throw marketingError('HIGGSFIELD_INPUT', 'Bitte ein verfügbares Videomodell, eine passende Dauer und ein Seitenverhältnis wählen.');
    if (typeof prompt !== 'string' || prompt.trim().length < 10 || prompt.length > 5000) throw marketingError('HIGGSFIELD_PROMPT', 'Bitte eine konkrete Videoanweisung mit 10 bis 5000 Zeichen eingeben.');
    const payload = { prompt: prompt.trim(), duration: String(duration), resolution: '1080', aspect_ratio: aspectRatio, generate_audio: true };
    if (row.imageRequired) { if (!imageUrl) throw marketingError('HIGGSFIELD_IMAGE', 'Für dieses Modell fehlt die öffentliche Adresse deines Ausgangsbildes.'); payload.image_url = publicMarketingUrl(imageUrl); }
    return { model, endpoint: row.endpoint, payload };
  }
  function validatePrepared(value) {
    const checked = prepare({ model: value?.model, prompt: value?.payload?.prompt, duration: value?.payload?.duration, aspectRatio: value?.payload?.aspect_ratio, imageUrl: value?.payload?.image_url });
    if (checked.endpoint !== value?.endpoint || JSON.stringify(checked.payload) !== JSON.stringify(value.payload)) throw marketingError('HIGGSFIELD_INPUT', 'Der vorbereitete Videoauftrag ist nicht mehr gültig.');
    return checked;
  }
  async function request(route, env, body) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try { response = await fetchImpl(ORIGIN + route, { method: body ? 'POST' : 'GET', headers: { Authorization: authorization(env), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error' }); }
    catch (error) { if (error.code) throw error; throw marketingError('HIGGSFIELD_UNAVAILABLE', 'Higgsfield ist momentan nicht erreichbar. Es wurde kein Erfolg bestätigt.', 502); }
    if (response.redirected || response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== ORIGIN) throw marketingError('HIGGSFIELD_REDIRECT', 'Higgsfield hat eine nicht erlaubte Weiterleitung geliefert.', 502);
    if (!response.ok) throw marketingError('HIGGSFIELD_REQUEST_FAILED', `Higgsfield meldet HTTP ${response.status}. Zugang, Modellfreigabe oder Guthaben im Anbieter-Konto prüfen.`, response.status === 401 || response.status === 403 ? 503 : 502);
    if (Number(response.headers.get('content-length') || 0) > 2 * 1024 * 1024) throw marketingError('HIGGSFIELD_RESPONSE_SIZE', 'Higgsfield hat eine zu große Antwort geliefert.', 502);
    const reader = response.body?.getReader(); let text;
    if (reader) { const chunks = []; let bytes = 0; while (true) { signal.throwIfAborted(); const result = await reader.read(); if (result.done) break; bytes += result.value.length; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw marketingError('HIGGSFIELD_RESPONSE_SIZE', 'Higgsfield hat eine zu große Antwort geliefert.', 502); } chunks.push(Buffer.from(result.value)); } text = Buffer.concat(chunks).toString('utf8'); }
    else text = await response.text();
    try { return JSON.parse(text); } catch { throw marketingError('HIGGSFIELD_RESPONSE', 'Higgsfield hat keine auswertbare Antwort geliefert.', 502); }
  }
  async function estimate(prepared, env) {
    const checked = validatePrepared(prepared);
    const value = await request('/estimate' + checked.endpoint, env, checked.payload);
    if (!['credits','usd'].every(key => (typeof value[key] === 'number' || typeof value[key] === 'string' && value[key].trim()) && Number.isFinite(Number(value[key])) && Number(value[key]) >= 0)) throw marketingError('HIGGSFIELD_ESTIMATE', 'Higgsfield hat keinen vollständigen Preis genannt. Es wurde kein Video bestellt.', 502);
    return { credits: String(value.credits), usd: String(value.usd), currency: 'USD', provider: 'higgsfield', checkedAt: new Date().toISOString(), source: 'https://docs.higgsfield.ai/docs/concepts/billing-and-retention' };
  }
  function normalize(value, expectedId) {
    if (!UUID.test(value.request_id || '') || expectedId && value.request_id !== expectedId || !STATES.has(value.status)) throw marketingError('HIGGSFIELD_STATUS', 'Higgsfield hat keinen eindeutigen Auftragsstatus geliefert.', 502);
    let videoUrl = null;
    if (value.status === 'completed') { try { const url = new URL(value.video?.url); if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 8192) throw new Error(); videoUrl = url.href; } catch { throw marketingError('HIGGSFIELD_OUTPUT_MISSING', 'Higgsfield meldet fertig, aber das Video ist noch nicht abrufbar.', 502); } }
    return { requestId: value.request_id, status: value.status, videoUrl, ...(value.status === 'failed' || value.status === 'nsfw' ? { message: value.status === 'nsfw' ? 'Der Anbieter hat den Inhalt abgelehnt.' : 'Higgsfield konnte diesen Videoauftrag nicht fertigstellen.' } : {}) };
  }
  async function submit(prepared, env) { const checked = validatePrepared(prepared); return normalize(await request(checked.endpoint, env, checked.payload)); }
  async function status(id, env) { if (!UUID.test(id)) throw marketingError('HIGGSFIELD_REQUEST_ID', 'Ungültiger Videoauftrag.'); return normalize(await request(`/requests/${id}/status`, env), id); }
  return { prepare, estimate, submit, status };
}
export async function verifyHiggsfieldConnection(env, dependencies = {}) {
  const client = createHiggsfieldClient(dependencies);
  await client.estimate(client.prepare({ model: 'veo-3.1', prompt: 'A calm view of an unoccupied modern studio in natural daylight.', duration: 4 }), env);
  return { ok: true, verified: true, detail: 'Zugang und Kostenschätzung für Veo 3.1 erfolgreich geprüft. Es wurde kein Video erzeugt.' };
}
