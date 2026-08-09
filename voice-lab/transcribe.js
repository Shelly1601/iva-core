const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

function extensionForMime(mime = '') {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  return 'webm';
}

export async function transcribeAudio(buffer, { mime = 'audio/webm', fileName = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Keine Audiodaten empfangen.');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('Audio ist größer als 15 MB.');
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY fehlt.');
  const startedAt = Date.now();
  const form = new FormData();
  const safeName = String(fileName || `voice.${extensionForMime(mime)}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), safeName);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'de');
  form.append('temperature', '0');
  form.append('prompt', 'Deutsche Geschäftssprache. Eigennamen und buchstabierte Namen exakt wiedergeben. Häufige Begriffe: IVA, Heat Hero, HausWertSchutz, Qonekto, Blau Direkt, Pipedrive, Photovoltaik, Wärmepumpe. Keine Namen ergänzen oder frei korrigieren.');
  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: form,
  });
  const raw = await response.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { payload = null; }
  if (!response.ok) throw new Error(`Groq Transkription ${response.status}: ${String(payload?.error?.message || raw).slice(0, 180)}`);
  return {
    text: String(payload?.text || '').trim(),
    model: 'whisper-large-v3-turbo',
    language: 'de',
    durationMs: Date.now() - startedAt,
    audioBytes: buffer.length,
    audioStored: false,
  };
}
