import { randomUUID, createHash } from 'node:crypto';
import { createProjectMarketingStore, clean, marketingError } from './project-store.js';
import { generateProjectMarketing, marketingModels } from './project-generation.js';
import { collectProjectResearch } from './project-research.js';
import { createHiggsfieldClient, higgsfieldModels } from './higgsfield.js';

const publicProfile = value => ({ ...value, logo: value.logo ? { mime: value.logo.mime, available: true } : null });
const connectionFingerprint = values => createHash('sha256').update(JSON.stringify(Object.entries(values || {}).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
export function createProjectMarketingService({ dataDir, getProject, listProjects = async () => [], providers, env = process.env, readMediaEvidence, search, generate = generateProjectMarketing, collect = collectProjectResearch, higgsfield = createHiggsfieldClient(), operationTimeoutMs = 300000 } = {}) {
  const store = createProjectMarketingStore({ dataDir, getProject });
  const active = new Map();
  const polling = new Map();
  const recovery = new Map();
  async function recoverProject(projectId) {
    if (!recovery.has(projectId)) recovery.set(projectId, store.mutate(projectId, state => {
      for (const collection of ['research', 'drafts']) for (const row of state[collection]) if (row.status === 'running') Object.assign(row, { status: 'failed', message: 'Der frühere Auftrag wurde durch einen Neustart unterbrochen. Bitte erneut starten.' });
      for (const row of state.videos) if (row.status === 'submitting') Object.assign(row, { status: 'submission_uncertain', message: 'Der Auftragsstatus konnte vor dem Neustart nicht bestätigt werden. Bitte vor einem neuen kostenpflichtigen Auftrag im Higgsfield-Konto prüfen.' });
      return true;
    }).catch(error => { recovery.delete(projectId); throw error; }));
    await recovery.get(projectId);
  }
  async function projects() { return (await listProjects()).map(p => ({ id: p.id, name: p.name })); }
  async function snapshot(projectId) {
    await recoverProject(projectId);
    const data = await store.snapshot(projectId);
    const status = providers ? await providers.status(projectId) : [];
    return { ...data, profile: publicProfile(data.profile), models: marketingModels(env), connectors: status, videoModels: higgsfieldModels(), activeJob: active.get(projectId)?.public || null };
  }
  async function startJob(projectId, kind, input) {
    await recoverProject(projectId);
    const profile = structuredClone((await store.snapshot(projectId)).profile);
    if (active.has(projectId)) throw marketingError('MARKETING_BUSY', 'Für dieses Projekt läuft bereits ein Marketingauftrag.', 409);
    if (!profile.offer || !profile.audience) throw marketingError('MARKETING_PROFILE_REQUIRED', 'Bitte zuerst Angebot und Zielgruppe im Projektprofil ergänzen.');
    if (!['research', 'content'].includes(kind)) throw new Error('Unknown job kind');
    const abort = new AbortController();
    const job = { public: { id: randomUUID(), kind, status: 'running', startedAt: new Date().toISOString() }, abort };
    active.set(projectId, job);
    const collection = kind === 'research' ? 'research' : 'drafts';
    let record;
    try { record = await store.add(projectId, collection, { status: 'running', profile: publicProfile(profile), briefing: clean(input.briefing, 6000), format: clean(input.format || 'reel', 60) }); }
    catch (error) { active.delete(projectId); throw error; }
    job.public.recordId = record.id;
    const timer = setTimeout(() => abort.abort(), operationTimeoutMs);
    timer.unref?.();
    const task = (async () => {
      try {
        let evidence;
        if (kind === 'research') evidence = await collect({ profile, urls: input.urls || [], automatic: input.automatic === true, projectId, signal: abort.signal, env, ...(search ? { search } : {}), readMediaEvidence });
        else {
          const reference = input.researchId ? await store.get(projectId, 'research', input.researchId) : null;
          if (reference && !['complete', 'partial'].includes(reference.status)) throw marketingError('MARKETING_ANALYSIS_PENDING', 'Bitte eine abgeschlossene Analyse auswählen.');
          evidence = reference?.evidence || { sources: [], discovered: [], limitations: ['Dieser Entwurf basiert auf deinem Projektprofil; es wurde keine Wettbewerberanalyse ausgewählt.'] };
        }
        abort.signal.throwIfAborted();
        if (kind === 'research' && !evidence.sources.some(s => s.status === 'read')) {
          await store.update(projectId, collection, record.id, { status: 'unavailable', evidence, message: 'Quellen gefunden, aber keine Inhalte lesbar. Es wurde keine KI-Contentanalyse behauptet.' });
          return;
        }
        await store.project(projectId);
        const result = await generate({ kind, profile, evidence: evidence.sources, briefing: clean(input.briefing, 6000), format: clean(input.format || 'reel', 60), model: input.model || 'auto', signal: abort.signal, env });
        abort.signal.throwIfAborted();
        await store.update(projectId, collection, record.id, { status: kind === 'research' && evidence.coverage?.incomplete ? 'partial' : 'complete', researchId: input.researchId || null, evidence, result });
      } catch (error) { await store.settle(projectId, collection, record.id, { status: 'failed', message: abort.signal.aborted ? 'Der Auftrag hat sein Zeitlimit erreicht. Es wurde kein fertiges Ergebnis gespeichert.' : error.code ? clean(error.message, 500) : 'Der Auftrag konnte nicht abgeschlossen werden. Bitte die Verbindungen prüfen und erneut versuchen.' }); }
      finally { clearTimeout(timer); if (active.get(projectId) === job) active.delete(projectId); }
    })();
    job.promise = task;
    // If an injected provider ignores abort, the visible job still ends on time.
    abort.signal.addEventListener('abort', () => { if (active.get(projectId) === job) { active.delete(projectId); void store.settle(projectId, collection, record.id, { status: 'failed', message: 'Der Marketingauftrag hat sein Zeitlimit erreicht.' }).catch(() => {}); } }, { once: true });
    task.catch(() => {});
    return { ...job.public, recordId: record.id };
  }
  async function providerEnv(projectId) {
    await store.project(projectId);
    if (!providers) throw marketingError('MARKETING_CONNECTION_MISSING', 'Higgsfield bitte in diesem Projekt verbinden.', 503);
    const resolved = await providers.resolveEnv(projectId, 'higgsfield');
    await store.project(projectId);
    return resolved;
  }
  async function quoteVideo(projectId, input) {
    const p = (await store.snapshot(projectId)).profile;
    if (!p.offer || !p.audience) throw marketingError('MARKETING_PROFILE_REQUIRED', 'Bitte zuerst Angebot und Zielgruppe hinterlegen.');
    let prompt = clean(input.prompt, 5000);
    if (input.draftId) {
      const draft = await store.get(projectId, 'drafts', input.draftId);
      const item = draft.result?.items?.[Number(input.itemIndex) || 0];
      if (!item?.videoPrompt) throw marketingError('MARKETING_VIDEO_DRAFT', 'Dieser Entwurf enthält noch keine Videoanweisung.');
      prompt = item.videoPrompt;
    }
    const model = input.model;
    const prepared = higgsfield.prepare({ model, prompt, aspectRatio: input.aspectRatio, duration: input.duration, imageUrl: input.imageUrl });
    const credentials = await providerEnv(projectId);
    const estimate = await higgsfield.estimate(prepared, credentials);
    const quote = await store.add(projectId, 'videoQuotes', { prepared, estimate, connectionFingerprint: connectionFingerprint(credentials), profileVersion: p.version || null, expiresAt: new Date(Date.now() + 10 * 60000).toISOString(), status: 'quoted' });
    return { id: quote.id, model, prompt, ...estimate, expiresAt: quote.expiresAt, status: 'quoted' };
  }
  async function submitVideo(projectId, input) {
    await recoverProject(projectId);
    if (input.confirmCost !== true) throw marketingError('MARKETING_COST_CONFIRMATION', 'Bitte den angezeigten Videoauftrag mit Kosten bestätigen.');
    const quote = await store.get(projectId, 'videoQuotes', input.quoteId);
    if (Date.parse(quote.expiresAt) < Date.now()) throw marketingError('MARKETING_QUOTE_EXPIRED', 'Die Kostenschätzung ist abgelaufen. Bitte erneut prüfen.', 409);
    const currentEnv = await providerEnv(projectId);
    if (quote.connectionFingerprint !== connectionFingerprint(currentEnv)) throw marketingError('MARKETING_CONNECTION_CHANGED', 'Die Projektverbindung wurde geändert. Bitte ein neues Kostenangebot anfordern.', 409);
    const freshEstimate = await higgsfield.estimate(quote.prepared, currentEnv);
    if (Number(freshEstimate.usd) > Number(quote.estimate.usd) || Number(freshEstimate.credits) > Number(quote.estimate.credits)) throw marketingError('MARKETING_PRICE_CHANGED', 'Der Anbieterpreis hat sich erhöht. Bitte eine neue Kostenschätzung anfordern.', 409);
    // Claim once before the external paid mutation. An uncertain POST is never retried.
    const video = await store.mutate(projectId, state => {
      const q = state.videoQuotes.find(x => x.id === quote.id);
      if (q.status !== 'quoted') throw marketingError('MARKETING_ALREADY_SUBMITTED', 'Dieser Videoauftrag wurde bereits gestartet. Status im Projekt prüfen.', 409);
      q.status = 'submitting';
      const row = { id: randomUUID(), projectId, quoteId: q.id, model: q.prepared.model, prompt: q.prepared.payload.prompt, estimate: q.estimate, status: 'submitting', createdAt: new Date().toISOString() };
      state.videos.unshift(row); return row;
    });
    let submitted = false, receipt;
    try {
      const freshEnv = await providerEnv(projectId);
      if (quote.connectionFingerprint !== connectionFingerprint(freshEnv)) throw marketingError('MARKETING_CONNECTION_CHANGED', 'Die Projektverbindung wurde geändert. Bitte ein neues Kostenangebot anfordern.', 409);
      await store.project(projectId);
      submitted = true;
      receipt = await higgsfield.submit(quote.prepared, freshEnv);
      return await store.update(projectId, 'videos', video.id, { ...receipt, status: receipt.status, retention: 'Higgsfield garantiert mindestens sieben Tage Abrufbarkeit. Ergebnis bitte herunterladen.' });
    } catch (error) {
      if (!submitted) { await store.settle(projectId, 'videos', video.id, { status: 'canceled', message: 'Lokaler Auftrag vor der Anbieteranfrage abgebrochen; Projektfreigabe oder Zugang wurde geändert.' }); throw error; }
      if (receipt) { await store.settle(projectId, 'videos', video.id, { ...receipt, message: 'Bestätigter Anbieterbeleg gespeichert; die Projektfreigabe erlaubt momentan keine weitere Verarbeitung.' }); throw error; }
      await store.settle(projectId, 'videos', video.id, { status: 'submission_uncertain', message: 'Higgsfield hat keinen eindeutigen Auftragsstatus zurückgegeben. Zur Vermeidung doppelter Kosten nicht automatisch wiederholen; Auftrag im Higgsfield-Konto prüfen.' });
      throw marketingError('MARKETING_SUBMISSION_UNCERTAIN', 'Der Videoauftrag konnte nicht eindeutig bestätigt werden. Bitte den Status im Higgsfield-Konto prüfen, bevor du neu startest.', 502);
    }
  }
  async function videoStatus(projectId, id) {
    const video = await store.get(projectId, 'videos', id);
    if (!video.requestId || !['queued', 'in_progress'].includes(video.status)) return video;
    const key = `${projectId}:${id}`;
    if (polling.has(key)) return polling.get(key);
    if (Date.now() - Date.parse(video.checkedAt || '1970-01-01') < 4000) return video;
    const pending = (async () => { const result = await higgsfield.status(video.requestId, await providerEnv(projectId)); return store.update(projectId, 'videos', id, { ...result, checkedAt: new Date().toISOString() }); })();
    polling.set(key, pending); try { return await pending; } finally { polling.delete(key); }
  }
  return { projects, snapshot, saveProfile: async (id, input) => publicProfile(await store.saveProfile(id, input)), saveLogo: store.saveLogo, logo: async id => (await store.snapshot(id)).profile.logo, startJob, quoteVideo, submitVideo, videoStatus, waitForIdle: async id => { await active.get(id)?.promise; }, store };
}
