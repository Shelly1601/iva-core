import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const MAX_JOBS = 100;
const MAX_QUEUE = 20;
const MAX_STORAGE = 10 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_INPUT = 256 * 1024;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const STATUSES = new Set(['queued', 'running', ...TERMINAL]);
const failure = (code, message, status = 500) => Object.assign(new Error(message), { code, status });
const errors = {
  JOB_FAILED: 'Die Auswertung konnte nicht abgeschlossen werden. Bitte erneut versuchen.',
  JOB_TIMEOUT: 'Die Auswertung hat ihr Zeitlimit erreicht. Bereits bestätigte Ergebnisse bleiben im jeweiligen Bereich erhalten.',
  JOB_INTERRUPTED: 'Die Auswertung wurde durch einen Neustart oder das Beenden des Dienstes unterbrochen.',
  JOB_RESULT_LIMIT: 'Das Ergebnis überschreitet die Größe der gespeicherten Jobantwort.',
  JOB_STORAGE: 'Der Jobstatus konnte nicht vollständig gespeichert werden.',
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** In-process queue, with durable status. Handlers must honor signal before their own writes. */
export function createOpportunityJobs({ dataDir, handlers, timeoutMs = 360000, env = process.env } = {}) {
  if (!dataDir || typeof dataDir !== 'string' || !handlers || typeof handlers !== 'object') throw failure('JOB_CONFIG', 'Jobs benötigen Datenverzeichnis und Handler.');
  const directory = path.resolve(dataDir, 'opportunity-jobs');
  const deadlineMs = Math.max(1, Math.min(3600000, Number(timeoutMs) || 360000));
  const records = new Map(), sizes = new Map(), active = new Map(), fingerprints = new Map();
  const queue = [];
  let serial = Promise.resolve(), stopped = false;
  const secretValues = Object.entries(env).filter(([key, value]) => /token|secret|password|api.?key|authorization/i.test(key) && typeof value === 'string' && value.length >= 8).map(([, value]) => value);
  function cleanString(value, limit = Infinity) {
    let result = String(value).slice(0, limit);
    for (const secret of secretValues) result = result.split(secret).join('[Zugang entfernt]').split(encodeURIComponent(secret)).join('[Zugang entfernt]');
    return result.replace(/((?:access_token|api_key|api-key|token|signature|password|secret)=)[^\s&#"']+/gi, '$1[entfernt]').replace(/\bBearer\s+[A-Za-z\d._~+/=-]+/gi, 'Bearer [entfernt]');
  }
  function scrub(value, depth = 0) {
    if (depth > 40) throw failure('JOB_RESULT_LIMIT', errors.JOB_RESULT_LIMIT);
    if (typeof value === 'string') return cleanString(value);
    if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /^(?:token|access.?token|refresh.?token|session.?token|api.?key|password|secret|authorization|cookie)$/i.test(key) ? '[Zugang entfernt]' : scrub(item, depth + 1)]));
    return value;
  }
  const snapshot = job => { if (!job) return null; const { fingerprint, ...visible } = job; return JSON.parse(JSON.stringify(visible)); };
  const filepath = id => path.join(directory, `${id}.json`);
  async function safeDirectory() {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('JOB_STORAGE', 'Das Jobverzeichnis ist nicht sicher zugänglich.');
  }
  async function safeTarget(filename) {
    try { const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw failure('JOB_STORAGE', 'Der Jobpfad ist nicht sicher zugänglich.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function remove(id) {
    await safeTarget(filepath(id));
    await fs.unlink(filepath(id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    records.delete(id); sizes.delete(id);
  }
  async function save(job) {
    const content = JSON.stringify(job);
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_FILE) throw failure('JOB_RESULT_LIMIT', errors.JOB_RESULT_LIMIT);
    await safeDirectory();
    const total = () => [...sizes.values()].reduce((sum, value) => sum + value, 0) - (sizes.get(job.id) || 0) + bytes;
    const stale = [...records.values()].filter(row => row.id !== job.id && TERMINAL.has(row.status)).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.id.localeCompare(b.id));
    while ((records.size > MAX_JOBS || total() > MAX_STORAGE) && stale.length) await remove(stale.shift().id);
    if (records.size > MAX_JOBS || total() > MAX_STORAGE) throw failure('JOB_STORAGE', 'Der begrenzte Jobspeicher ist momentan ausgelastet.', 429);
    await safeTarget(filepath(job.id));
    const temporary = path.join(directory, `${job.id}.${randomUUID()}.tmp`);
    let file;
    try {
      file = await fs.open(temporary, 'wx', 0o600);
      await file.writeFile(content, 'utf8'); await file.sync(); await file.close(); file = null;
      await fs.rename(temporary, filepath(job.id));
      sizes.set(job.id, bytes);
    } finally { await file?.close().catch(() => {}); await fs.unlink(temporary).catch(() => {}); }
  }
  async function initialize() {
    await safeDirectory();
    const entries = await fs.readdir(directory);
    const candidates = [];
    for (const name of entries) {
      if (!/^[a-f\d-]{36}\.json$/i.test(name)) continue;
      const id = name.slice(0, -5); if (!UUID.test(id)) continue;
      const stat = await fs.lstat(filepath(id));
      if (!stat.isFile() || stat.isSymbolicLink()) throw failure('JOB_STORAGE', 'Ein gespeicherter Jobpfad ist nicht sicher zugänglich.');
      candidates.push({ id, stat });
    }
    candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    let retainedBytes = 0;
    for (const [index, item] of candidates.entries()) {
      if (index >= MAX_JOBS || item.stat.size > MAX_FILE || retainedBytes + item.stat.size > MAX_STORAGE) { await remove(item.id); continue; }
      let handle;
      try {
        handle = await fs.open(filepath(item.id), constants.O_RDONLY | constants.O_NOFOLLOW);
        if ((await handle.stat()).size > MAX_FILE) throw failure('JOB_STORAGE', errors.JOB_STORAGE);
        const job = JSON.parse(await handle.readFile('utf8'));
        if (job.id !== item.id || !STATUSES.has(job.status) || typeof job.kind !== 'string' || typeof job.submittedAt !== 'string') throw failure('JOB_STORAGE', errors.JOB_STORAGE);
        records.set(job.id, scrub(job)); sizes.set(job.id, item.stat.size); retainedBytes += item.stat.size;
      } catch (error) { if (error.code === 'ELOOP') throw failure('JOB_STORAGE', errors.JOB_STORAGE); await remove(item.id); }
      finally { await handle?.close().catch(() => {}); }
    }
    for (const job of records.values()) {
      if (job.status === 'running' || job.status === 'queued') {
        Object.assign(job, { status: 'interrupted', phase: 'interrupted', message: errors.JOB_INTERRUPTED, finishedAt: new Date().toISOString(), error: { code: 'JOB_INTERRUPTED', message: errors.JOB_INTERRUPTED } });
        await save(job);
      }
    }
  }
  const ready = initialize(); ready.catch(() => {});
  function locked(operation) {
    const pending = serial.then(async () => { await ready; return operation(); });
    serial = pending.catch(() => {}); return pending;
  }
  function kick() {
    void locked(async () => {
      while (!stopped && active.size < 2 && queue.length) {
        const item = queue.shift();
        const job = records.get(item.id);
        if (!job || job.status !== 'queued') continue;
        const run = { controller: new AbortController(), done: false, progress: null, progressPromise: null };
        active.set(job.id, run);
        Object.assign(job, { status: 'running', phase: 'starting', message: 'Die Auswertung wird gestartet.', startedAt: new Date().toISOString() });
        try { await save(job); }
        catch { active.delete(job.id); fingerprints.delete(job.fingerprint); Object.assign(job, { status: 'failed', phase: 'failed', finishedAt: new Date().toISOString(), message: errors.JOB_STORAGE, error: { code: 'JOB_STORAGE', message: errors.JOB_STORAGE } }); continue; }
        execute(job, item.input, run);
      }
    }).catch(() => {});
  }
  async function finish(job, run, status, result, code) {
    if (run.done) return;
    run.done = true; clearTimeout(run.timer);
    return locked(async () => {
      Object.assign(job, { status, phase: status, message: status === 'completed' ? 'Auswertung abgeschlossen.' : errors[code] || errors.JOB_FAILED, finishedAt: new Date().toISOString() });
      if (status === 'completed') {
        try { job.result = scrub(JSON.parse(JSON.stringify(result ?? null))); if (Buffer.byteLength(JSON.stringify(job)) > MAX_FILE) throw failure('JOB_RESULT_LIMIT', errors.JOB_RESULT_LIMIT); }
        catch { delete job.result; Object.assign(job, { status: 'failed', phase: 'failed', message: errors.JOB_RESULT_LIMIT, error: { code: 'JOB_RESULT_LIMIT', message: errors.JOB_RESULT_LIMIT } }); }
      } else job.error = { code: errors[code] ? code : 'JOB_FAILED', message: errors[code] || errors.JOB_FAILED };
      try { await save(job); }
      catch { delete job.result; Object.assign(job, { status: 'failed', phase: 'failed', message: errors.JOB_STORAGE, error: { code: 'JOB_STORAGE', message: errors.JOB_STORAGE } }); await save(job).catch(() => {}); }
      finally { active.delete(job.id); fingerprints.delete(job.fingerprint); kick(); }
    });
  }
  function execute(job, input, run) {
    const onProgress = value => {
      if (run.done || run.controller.signal.aborted) return Promise.resolve();
      const progress = value && typeof value === 'object' ? value : { message: value };
      run.progress = { phase: typeof progress.phase === 'string' && /^[a-z\d_-]{1,64}$/i.test(progress.phase) ? progress.phase : job.phase, message: cleanString(progress.message || 'Auswertung läuft.', 600) };
      if (!run.progressPromise) {
        run.progressPromise = locked(async () => {
          if (run.done || !run.progress) return;
          const latest = run.progress; run.progress = null; Object.assign(job, latest); await save(job);
        }).catch(() => {}).finally(() => { run.progressPromise = null; if (run.progress && !run.done) void onProgress(run.progress); });
      }
      return run.progressPromise;
    };
    run.timer = setTimeout(() => { run.controller.abort(); void finish(job, run, 'failed', null, 'JOB_TIMEOUT').catch(() => {}); }, deadlineMs);
    Promise.resolve().then(() => handlers[job.kind](input, { signal: run.controller.signal, onProgress })).then(result => finish(job, run, 'completed', result), () => finish(job, run, 'failed', null, 'JOB_FAILED')).catch(() => {});
  }
  return {
    async submit(kind, input = {}) {
      if (typeof kind !== 'string' || !/^[a-z][a-z\d-]{0,63}$/i.test(kind) || !Object.hasOwn(handlers, kind) || typeof handlers[kind] !== 'function') throw failure('JOB_KIND', 'Unbekannter Auswertungstyp.', 400);
      let copy, encoded;
      try { const original = JSON.stringify(input); if (!original || Buffer.byteLength(original) > MAX_INPUT) throw new Error(); copy = JSON.parse(original); encoded = JSON.stringify(canonical(copy)); }
      catch { throw failure('JOB_INPUT', 'Die Anfrage ist zu groß oder enthält ungültige Daten.', 400); }
      const fingerprint = createHash('sha256').update(kind + '\n' + encoded).digest('hex');
      const job = await locked(async () => {
        if (stopped) throw failure('JOB_STOPPED', 'Die Jobverarbeitung wurde beendet.', 503);
        const existing = fingerprints.get(fingerprint); if (existing) return snapshot(records.get(existing));
        if (queue.length >= MAX_QUEUE) throw failure('JOB_QUEUE_FULL', 'Die Warteschlange ist momentan voll. Bitte später erneut versuchen.', 429);
        const job = { id: randomUUID(), kind, fingerprint, status: 'queued', phase: 'queued', message: 'Die Auswertung wartet auf einen freien Platz.', submittedAt: new Date().toISOString(), startedAt: null, finishedAt: null, result: null, error: null };
        records.set(job.id, job);
        try { await save(job); } catch (error) { records.delete(job.id); throw error; }
        fingerprints.set(fingerprint, job.id); queue.push({ id: job.id, input: copy }); return snapshot(job);
      });
      kick(); return job;
    },
    async get(id) {
      if (typeof id !== 'string' || !UUID.test(id)) throw failure('JOB_ID', 'Ungültige Job-ID.', 400);
      return locked(() => snapshot(records.get(id)));
    },
    async list() { return locked(() => [...records.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt) || b.id.localeCompare(a.id)).map(snapshot)); },
    async close() {
      const running = await locked(async () => {
        stopped = true;
        for (const item of queue.splice(0)) {
          const job = records.get(item.id); fingerprints.delete(job.fingerprint);
          Object.assign(job, { status: 'interrupted', phase: 'interrupted', message: errors.JOB_INTERRUPTED, finishedAt: new Date().toISOString(), error: { code: 'JOB_INTERRUPTED', message: errors.JOB_INTERRUPTED } }); await save(job);
        }
        return [...active.entries()];
      });
      await Promise.all(running.map(([id, run]) => { run.controller.abort(); return finish(records.get(id), run, 'interrupted', null, 'JOB_INTERRUPTED'); }));
    },
  };
}
