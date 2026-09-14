import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCname } from 'node:dns/promises';
import { createWebsiteStore } from './store.js';
import { normalizeWebsiteFiles, readWebsiteZip, createWebsiteZip } from './archive.js';
import { compileWebsite } from './compiler.js';
import { createGitHubWebsiteConnector } from './github.js';
import { createWebsiteConnections } from './connections.js';
import { generateWebsite, websiteModelStatus, classifyWebsiteMessage } from './generate.js';
const importWebsiteUrl = async (...args) => (await import('./import-url.js')).importWebsiteUrl(...args);
const readWebsiteReference = async (...args) => (await import('./import-url.js')).readWebsiteReference(...args);

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const activeStatus = s => ['queued', 'running'].includes(s);
const cleanError = error => String(error?.message || 'Der Website-Auftrag ist fehlgeschlagen.').replace(/(?:ghp_|github_pat_)[A-Za-z0-9_]+/g, '[Zugang entfernt]').replace(/Bearer\s+\S+/gi, '[Zugang entfernt]').slice(0, 1600);
const slug = text => String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'website';
const timeoutError = () => Object.assign(fail('Der Website-Auftrag hat sein Zeitlimit erreicht. Die letzte gespeicherte Version bleibt erhalten.', 504), { code: 'WEBSITE_JOB_TIMEOUT' });
function checkOperation(context) { if (context && (!context.active || context.controller.signal.aborted)) throw timeoutError(); }
function ensureBuild(result) { if (result?.status !== 'ready' || !result.html) throw fail('Website-Build fehlgeschlagen: ' + (result?.errors || []).map(value => typeof value === 'string' ? value : value.message || 'Compilerfehler').join(' '), 422); return result; }
function unwrapWebsiteZip(files) {
  if (files.some(file => file.path === 'index.html')) return files;
  const first = files[0]?.path.split('/')[0];
  if (!first || !files.every(file => file.path.startsWith(first + '/')) || !files.some(file => file.path === `${first}/index.html`)) return files;
  return normalizeWebsiteFiles(files.map(file => ({ ...file, path: file.path.slice(first.length + 1) })));
}
const hostname = value => {
  const name = String(value || '').toLowerCase().trim();
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw fail('Bitte eine Domain ohne https:// oder Pfad angeben.');
  return name;
};

export function createWebsiteService({ dataDir, getProject, listProjects, env = process.env, compile = compileWebsite, generate = generateWebsite, importUrl = importWebsiteUrl, referenceReader = readWebsiteReference, githubFactory = createGitHubWebsiteConnector, fetchImpl = fetch, dnsCname = resolveCname, jobTimeoutMs = 6 * 60_000, authorizeProject = async () => {} } = {}) {
  if (typeof authorizeProject !== 'function') throw new TypeError('authorizeProject muss eine serverseitige Funktion sein.');
  const store = createWebsiteStore({ dataDir, getProject });
  const connections = createWebsiteConnections({ dataDir, env, fetchImpl });
  const operations = new Map(), previewCache = new Map(), remoteExports = new Map();
  const jobTimeout = Math.max(1, Math.min(6 * 60_000, Number(jobTimeoutMs) || 6 * 60_000));
  const artifactDir = path.join(dataDir, 'website-artifacts');
  const key = (p, s) => `${p}/${s}`;
  async function projectAccess(p) {
    if (await authorizeProject(p) === false) throw fail('Website Studio ist für dieses Projekt nicht freigegeben.', 403);
  }
  async function authorize(context, operation, p, s) {
    checkOperation(context);
    await projectAccess(p);
    if (context?.authorizeOperation && await context.authorizeOperation(operation, { projectId: p, siteId: s, jobId: context.jobId }) === false) throw fail('Für diese Website-Aktion fehlt die Berechtigung.', 403);
    checkOperation(context);
  }
  const hostOrigin = () => {
    if (!env.IVA_WEBSITE_HOST_ORIGIN) return '';
    const url = new URL(env.IVA_WEBSITE_HOST_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.origin === env.IVA_CORE_ORIGIN || url.hostname === env.RAILWAY_PUBLIC_DOMAIN) throw fail('Website-Hosting benötigt eine eigene HTTPS-Adresse.', 503);
    return url.origin;
  };
  async function site(p, s) {
    await projectAccess(p);
    let value = await store.get(p, s);
    if (!value) throw fail('Website wurde in diesem Projekt nicht gefunden.', 404);
    if (activeStatus(value.job?.status) && !operations.has(key(p, s))) {
      value = await store.updateSite(p, s, { job: { ...value.job, status: 'failed', error: 'Der Server wurde während des Auftrags neu gestartet. Die letzte gespeicherte Version ist erhalten.', completedAt: now() } });
    }
    return value;
  }
  async function exclusive(p, s, operation) {
    const id = key(p, s);
    if (operations.has(id)) throw fail('Für diese Website läuft bereits ein Auftrag.', 409);
    if (operations.size >= 3) throw fail('IVA bearbeitet bereits drei Website-Aufträge. Bitte kurz warten.', 429);
    operations.set(id, true);
    try { await site(p, s); return await operation(); } finally { operations.delete(id); }
  }
  async function github() { return githubFactory({ env: await connections.resolveEnv(), fetchImpl }); }
  async function status() {
    return { version: '1.0.0', models: websiteModelStatus(env), github: await connections.status(), hosting: { configured: Boolean(hostOrigin() && env.IVA_WEBSITE_PUBLISH_KEY), provider: 'railway', url: hostOrigin() || null, status: hostOrigin() && env.IVA_WEBSITE_PUBLISH_KEY ? 'configured' : 'needs_hosting_setup' } };
  }
  async function preview(p, s, revisionId) {
    const current = await site(p, s);
    const revision = await store.readRevision(p, s, revisionId || current.draftRevisionId);
    if (!revision) return { html: '', status: 'empty', errors: [], warnings: [] };
    const cacheKey = key(p, s) + '/' + revision.id;
    if (previewCache.has(cacheKey)) return previewCache.get(cacheKey);
    let result;
    try { result = await compile(revision.files); }
    catch (error) { return { html: '', status: 'failed', errors: [cleanError(error)], warnings: [], revisionId: revision.id }; }
    const value = { ...result, revisionId: revision.id };
    if (Buffer.byteLength(value.html || '') <= 5 * 1024 * 1024) {
      if (previewCache.size >= 8) previewCache.delete(previewCache.keys().next().value);
      previewCache.set(cacheKey, value);
    }
    return value;
  }
  async function saveImported(p, s, result, summary, baseRevisionId, context) {
    const current = await site(p, s);
    await authorize(context, 'edit', p, s);
    const saved = await store.saveRevision(p, s, { baseRevisionId: baseRevisionId === undefined ? current.draftRevisionId : baseRevisionId, files: result.files, summary, source: result.source || { type: 'github', url: result.github?.url } });
    checkOperation(context);
    if (result.github) await store.updateSite(p, s, { github: { ...result.github, status: 'imported' } });
    checkOperation(context);
    await store.appendMessage(p, s, { role: 'assistant', content: `${summary}${result.warnings?.length ? '\n' + result.warnings.join('\n') : ''}` });
    return { ...saved, warnings: result.warnings || [], omitted: result.omitted || [] };
  }
  async function importSite(p, s, input, locked = false, context) {
    const run = async () => {
      const baseRevisionId = (await site(p, s)).draftRevisionId;
      await authorize(context, 'edit', p, s);
      if (input.kind === 'github') {
        // Private imports must not borrow the owner's credentials through a
        // customer's otherwise permitted generic website import.
        await authorize(context, 'github', p, s);
        const connector = await github();
        await authorize(context, 'github', p, s);
        const result = await connector.importRepository({ repository: input.repository });
        return saveImported(p, s, result, 'GitHub-Quelldateien als neue Website-Version übernommen.', baseRevisionId, context);
      }
      if (input.kind !== 'url') throw fail('Unbekannte Importart.');
      const result = await importUrl(input.url, { signal: context?.controller.signal });
      return saveImported(p, s, result, result.summary || 'Öffentlich sichtbare Website als bearbeitbaren Snapshot übernommen. Originalcode, Backend und Datenbanken sind darin nicht enthalten.', baseRevisionId, context);
    };
    return locked ? run() : exclusive(p, s, run);
  }
  async function exportGitHub(p, s, input = {}, locked = false, context) {
    const run = async () => {
      await authorize(context, 'github', p, s);
      const current = await site(p, s), revision = await store.readRevision(p, s);
      if (!revision) throw fail('Vor dem GitHub-Export zuerst eine Website erstellen oder importieren.');
      checkOperation(context);
      if (remoteExports.has(key(p, s)) || ['exporting', 'export_uncertain'].includes(current.github?.status)) throw fail('Der vorherige GitHub-Schreibauftrag ist noch nicht eindeutig abgeschlossen. Prüfe zuerst den Repository-Stand; IVA startet keinen doppelten Export.', 409);
      const existing = ['exported', 'export_partial'].includes(current.github?.status) ? current.github : null;
      const operationId = randomUUID();
      let started = false;
      let verified = false;
      try {
        const connector = await github();
        await authorize(context, 'github', p, s);
        await store.updateSite(p, s, { github: { ...(current.github || {}), operationId, status: 'exporting' } });
        checkOperation(context);
        const pending = Promise.resolve().then(async () => {
          // Credentials may take time to resolve. Recheck immediately before
          // invoking the connector; no user input can supply this callback.
          await authorize(context, 'github', p, s);
          started = true;
          return connector.exportRepository({ name: slug(input.name || current.name), description: `Website ${current.name} · IVA Website Studio`, files: revision.files, private: true, ...(existing ? { repository: existing.repository, expectedHead: existing.commitSha } : {}) });
        });
        remoteExports.set(key(p, s), pending);
        const result = await pending;
        // A remote write may finish after a chat deadline. Preserve its verified
        // repository identity so a subsequent request cannot create a duplicate.
        await store.updateSite(p, s, { github: { ...result.github, operationId, status: 'exported' } });
        verified = true;
        checkOperation(context);
        return { ...result, status: 'completed', url: result.github.url };
      } catch (error) {
        if (!verified) {
          if (error.github) await store.updateSite(p, s, { github: { ...error.github, operationId, status: 'export_partial' } });
          else if (!started || ['GITHUB_AUTH_REQUIRED', 'GITHUB_PRIVATE_REQUIRED', 'GITHUB_SECRET_IN_FILE', 'GITHUB_INVALID_NAME', 'GITHUB_OWNER_MISMATCH', 'GITHUB_EXPECTED_HEAD_REQUIRED', 'GITHUB_EXPORT_BUSY', 'GITHUB_HEAD_CHANGED'].includes(error.code)) await store.updateSite(p, s, { github: current.github });
          else await store.updateSite(p, s, { github: { ...(current.github || {}), operationId, status: 'export_uncertain' } });
        }
        throw error;
      } finally { remoteExports.delete(key(p, s)); }
    };
    return locked ? run() : exclusive(p, s, run);
  }
  async function publish(p, s, input = {}, locked = false, context) {
    const run = async () => {
      await authorize(context, 'publish', p, s);
      if (!hostOrigin() || !env.IVA_WEBSITE_PUBLISH_KEY) throw fail('Das eigene Website-Hosting ist noch nicht eingerichtet.', 503);
      const current = await site(p, s);
      const built = await preview(p, s, input.revisionId || current.draftRevisionId);
      if (built.status !== 'ready' || !built.html) throw fail('Veröffentlichung erst nach erfolgreichem Website-Build: ' + (built.errors || []).join(' '));
      checkOperation(context);
      const artifactHash = createHash('sha256').update(built.html).digest('hex');
      await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
      const artifact = { html: built.html, revisionId: built.revisionId, siteId: s, artifactHash };
      const artifactPath = path.join(artifactDir, `${s}-${built.revisionId}.json`);
      await fs.writeFile(artifactPath + '.tmp', JSON.stringify(artifact), { mode: 0o600 });
      await fs.rename(artifactPath + '.tmp', artifactPath);
      await authorize(context, 'publish', p, s);
      const publication = { status: 'published', provider: 'railway', url: `${hostOrigin()}/s/${s}/`, revisionId: built.revisionId, artifactHash, previousRevisionId: current.publishedRevisionId, publishedAt: now(), operationId: randomUUID() };
      await store.updateSite(p, s, { publishedRevisionId: built.revisionId, publication });
      // Confirm the artifact through the public host. Roll back the publication pointer on failure.
      try {
        await authorize(context, 'publish', p, s);
        const response = await fetchImpl(publication.url + '?iva-version=' + built.revisionId, { signal: context ? AbortSignal.any([context.controller.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000), redirect: 'error' });
        await authorize(context, 'publish', p, s);
        if (!response.ok || response.headers.get('x-iva-revision') !== built.revisionId) throw new Error();
      } catch (error) {
        const latest = await store.get(p, s);
        if (latest.publication?.operationId === publication.operationId) await store.updateSite(p, s, { publishedRevisionId: current.publishedRevisionId, publication: current.publication });
        if (error?.status === 403 || error?.code === 'WEBSITE_JOB_TIMEOUT') throw error;
        throw fail('Die Veröffentlichung konnte am Hosting-Ziel nicht bestätigt werden. Die bisher veröffentlichte Version bleibt aktiv.', 502);
      }
      publication.verifiedAt = now();
      checkOperation(context);
      await store.updateSite(p, s, { publication });
      return publication;
    };
    return locked ? run() : exclusive(p, s, run);
  }
  async function domains(p, s, requested) {
    const current = await site(p, s);
    const name = hostname(requested || current.domain?.hostname);
    // DNS alone does not prove platform routing or TLS. Provisioning must be verified separately.
    const target = hostOrigin() ? new URL(hostOrigin()).hostname : '';
    let matches = false;
    try { matches = (await dnsCname(name)).some(value => value.replace(/\.$/, '').toLowerCase() === target); } catch {}
    const active = current.domain?.hostname === name && current.domain?.status === 'active' && matches;
    const value = { hostname: name, status: active ? 'active' : target ? 'needs_hosting_setup' : 'needs_hosting_setup', target, checkedAt: now() };
    await store.updateSite(p, s, { domain: value });
    return { ...value, dns: [], message: active ? 'Domain ist für diese Website eingerichtet.' : 'Domain ist vorgemerkt. Zuerst die Domain am Hosting-Dienst dieser Website zuordnen und dessen konkrete DNS-Einträge übernehmen; vorhandene DNS-Einträge erst danach umstellen.' };
  }
  async function chat(p, s, input, { authorizeOperation } = {}) {
    if (authorizeOperation !== undefined && typeof authorizeOperation !== 'function') throw new TypeError('authorizeOperation muss eine serverseitige Funktion sein.');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 12000) throw fail('Bitte einen Website-Auftrag bis 12.000 Zeichen eingeben.');
    if (!['auto', 'claude', 'gemini', 'groq', undefined].includes(input.model)) throw fail('Unbekanntes Modell.');
    const current = await site(p, s);
    if (input.baseRevisionId !== undefined && input.baseRevisionId !== current.draftRevisionId) throw fail('Die Website wurde inzwischen geändert. Bitte die aktuelle Version laden.', 409);
    const operationKey = key(p, s);
    if (operations.has(operationKey)) throw fail('Für diese Website läuft bereits ein Auftrag.', 409);
    if (operations.size >= 3) throw fail('IVA bearbeitet bereits drei Website-Aufträge. Bitte kurz warten.', 429);
    const jobId = randomUUID(), job = { id: jobId, status: 'queued', type: 'chat', createdAt: now(), message: 'Auftrag angenommen.' };
    operations.set(operationKey, true);
    try {
      await store.appendMessage(p, s, { role: 'user', content: input.message, jobId });
      await store.updateSite(p, s, { job });
    } catch (error) { operations.delete(operationKey); throw error; }
    const context = { active: true, controller: new AbortController(), jobId, authorizeOperation };
    const progress = async patch => { checkOperation(context); Object.assign(job, patch, { status: 'running', updatedAt: now() }); await store.updateSite(p, s, { job }); checkOperation(context); };
    let timer;
    const running = Promise.resolve().then(async () => {
      const work = (async () => {
        await progress({ startedAt: now(), message: 'IVA prüft den Website-Auftrag.' });
        const text = input.message, lower = text.toLowerCase();
        if (classifyWebsiteMessage(text).answerOnly) {
          await authorize(context, 'read', p, s);
          const result = await generate({ message: text, site: current, revision: await store.readRevision(p, s), model: input.model || 'auto', answerOnly: true, onProgress: progress, env, abortSignal: context.controller.signal });
          await authorize(context, 'read', p, s);
          if (typeof result.summary !== 'string' || !result.summary.trim()) throw fail('IVA konnte die Frage noch nicht beantworten.');
          const summary = result.summary.trim().slice(0, 3000);
          // The server owns this mode: even a faulty generator cannot create a
          // revision or route to import, GitHub or publishing from this branch.
          await store.appendMessage(p, s, { role: 'assistant', content: summary, jobId });
          checkOperation(context);
          await store.updateSite(p, s, { job: { ...job, status: 'completed', message: 'Frage beantwortet.', summary, revisionId: current.draftRevisionId, completedAt: now(), executionVerified: true } });
          return;
        }
        const url = text.match(/https:\/\/[^\s<>"']+|www\.[a-z0-9.-]+(?:\/[^\s<>"']*)?/i)?.[0]?.replace(/[),.;!?]+$/, '');
        const absolute = url?.startsWith('www.') ? `https://${url}` : url;
        const wantsGitHub = /github/.test(lower) && /(?:pack|sicher|exportier|speicher|leg|rüber|hochlad|übertrag|push)/.test(lower) && !/(?:nicht|kein).{0,25}github/.test(lower);
        const wantsPublish = /(?:veröffentliche|veröffentlichen|publiziere|stell.{0,20}live|schalte.{0,20}live|publish)/.test(lower) && !/(?:nicht|noch nicht).{0,25}(?:veröffentlich|live|publish)/.test(lower);
        const wantsImport = absolute && /(?:übernimm|übernehm|importier|umzieh|rüberzieh|übertrag|meine website|meine seite)/.test(lower) && !/(?:ähnlich|inspiri|vorbild|referenz)/.test(lower);
        // Reject forbidden combined requests before a permitted edit can save
        // a revision or spend a model call. Recheck again at each side effect.
        if (wantsGitHub) await authorize(context, 'github', p, s);
        if (wantsPublish) await authorize(context, 'publish', p, s);
        let summary = '', saved = null;
        if (wantsImport) {
          await progress({ phase: 'importing', message: 'IVA übernimmt die verfügbaren Website-Dateien.' });
          saved = await importSite(p, s, { kind: new URL(absolute).hostname === 'github.com' ? 'github' : 'url', repository: absolute, url: absolute }, true, context);
          summary = saved.revision.summary;
        }
        const wantsEdit = /(?:ändere|ändern|gestalte|designe|entwickle|baue|erstell|ergänz|verbesser|animiere|animation|farbe|layout|header|footer|typografie|3d)/i.test(text);
        if ((!wantsImport && !wantsGitHub && !wantsPublish) || wantsEdit) {
          const revision = await store.readRevision(p, s);
          checkOperation(context);
          let reference = null;
          if (absolute && !wantsImport) {
            await progress({ phase: 'reference', message: 'IVA liest die angegebene Website als Gestaltungsreferenz.' });
            reference = await referenceReader(absolute, { signal: context.controller.signal });
            checkOperation(context);
          }
          await authorize(context, 'build', p, s);
          let result = await generate({ message: text, site: current, revision, model: input.model || 'auto', reference, onProgress: progress, env, abortSignal: context.controller.signal });
          checkOperation(context);
          await progress({ phase: 'building', message: 'IVA prüft den Website-Build.' });
          try { ensureBuild(await compile(result.files)); }
          catch (error) {
            await authorize(context, 'build', p, s);
            result = await generate({ message: text, site: current, revision: { files: result.files }, model: input.model || 'auto', reference, repair: cleanError(error), onProgress: progress, env, abortSignal: context.controller.signal });
            checkOperation(context);
            ensureBuild(await compile(result.files));
          }
          await authorize(context, 'edit', p, s);
          saved = await store.saveRevision(p, s, { baseRevisionId: revision?.id || null, files: result.files, summary: result.summary, model: result.model });
          checkOperation(context);
          summary += `\n${result.summary}\nModell: ${result.model?.key || job.model}. Neue Version gespeichert und Build geprüft.`;
        }
        if (wantsGitHub) {
          await progress({ phase: 'github', message: 'IVA sichert die Website bei GitHub.' });
          const result = await exportGitHub(p, s, {}, true, context);
          summary += `\nWebsite im privaten GitHub-Repository gesichert: ${result.url}`;
        }
        if (wantsPublish) {
          await progress({ phase: 'publishing', message: 'IVA veröffentlicht die gespeicherte Version.' });
          const result = await publish(p, s, {}, true, context);
          summary += `\nWebsite veröffentlicht und erreichbar: ${result.url}`;
        }
        checkOperation(context);
        await store.appendMessage(p, s, { role: 'assistant', content: summary.trim(), jobId });
        checkOperation(context);
        await store.updateSite(p, s, { job: { ...job, status: 'completed', message: 'Auftrag abgeschlossen.', summary: summary.trim(), revisionId: saved?.revision?.id || (await site(p, s)).draftRevisionId, completedAt: now(), executionVerified: true } });
      })();
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { context.active = false; context.controller.abort(); reject(timeoutError()); }, jobTimeout); });
      try {
        await Promise.race([work, deadline]);
      } catch (error) {
        context.active = false;
        context.controller.abort();
        const message = cleanError(error);
        await store.appendMessage(p, s, { role: 'assistant', content: message, jobId }).catch(() => {});
        await store.updateSite(p, s, { job: { ...job, status: 'failed', error: message, completedAt: now() } }).catch(() => {});
      } finally { clearTimeout(timer); context.active = false; context.controller.abort(); if (operations.get(operationKey) === running) operations.delete(operationKey); }
    });
    operations.set(operationKey, running);
    return { jobId, status: 'queued' };
  }
  async function publishedArtifact({ siteId, hostname: requestedHost }, secret) {
    const expected = Buffer.from(env.IVA_WEBSITE_PUBLISH_KEY || ''), actual = Buffer.from(secret || '');
    if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fail('Unauthorized', 401);
    if (siteId && !/^[a-f0-9-]{36}$/.test(siteId)) throw fail('Website nicht gefunden.', 404);
    const domain = requestedHost ? hostname(requestedHost) : null;
    for (const project of await listProjects()) {
      const sites = await store.list(project.id);
      const match = sites.find(item => domain ? item.domain?.hostname === domain && item.domain.status === 'active' : item.id === siteId);
      if (!match?.publishedRevisionId || match.publication?.status !== 'published') continue;
      const bytes = await fs.readFile(path.join(artifactDir, `${match.id}-${match.publishedRevisionId}.json`));
      return JSON.parse(bytes);
    }
    throw fail('Keine veröffentlichte Website gefunden.', 404);
  }
  return {
    store, connections, status, site, preview, chat, importSite, exportGitHub, publish, domains, publishedArtifact,
    listProjects: async () => {
      const available = [];
      for (const { id, name, description } of await listProjects()) {
        try { await projectAccess(id); available.push({ id, name, description }); }
        catch (error) { if (error.status !== 403) throw error; }
      }
      return available;
    },
    create: async input => { await projectAccess(input.projectId); return store.create(input.projectId, input); },
    list: async p => { await projectAccess(p); return store.list(p); },
    revision: async (p, s, rev) => { await site(p, s); return store.readRevision(p, s, rev); },
    exportZip: async (p, s) => { await site(p, s); const revision = await store.readRevision(p, s); if (!revision) throw fail('Die Website enthält noch keine Dateien.'); return createWebsiteZip(revision.files); },
    importZip: (p, s, bytes) => exclusive(p, s, () => saveImported(p, s, { files: unwrapWebsiteZip(readWebsiteZip(bytes)), source: { type: 'zip' } }, 'ZIP-Quelldateien als neue Version übernommen.')),
    restore: (p, s, input) => exclusive(p, s, async () => { const revision = await store.readRevision(p, s, input.revisionId); if (!revision) throw fail('Version nicht gefunden.', 404); return store.saveRevision(p, s, { baseRevisionId: input.baseRevisionId, files: revision.files, summary: `Version vom ${revision.createdAt} wiederhergestellt.`, source: { type: 'restore', revisionId: revision.id } }); }),
    asset: (p, s, name, bytes) => exclusive(p, s, async () => {
      if (!/\.(?:png|jpe?g|webp|gif|svg|avif|woff2?|mp4|webm|glb|gltf)$/i.test(name || '') || bytes.length > 3 * 1024 * 1024) throw fail('Unterstützt werden Bilder, Schriftdateien, Videos und 3D-Dateien bis 3 MiB.');
      const revision = await store.readRevision(p, s);
      const file = { path: 'assets/' + String(name).replace(/[^a-zA-Z0-9_.-]/g, '_'), encoding: 'base64', content: bytes.toString('base64') };
      const existing = revision?.files || [{ path: 'index.html', content: '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Neue Website</title></head><body><h1>Deine Website</h1></body></html>', encoding: 'utf8' }];
      const saved = await store.saveRevision(p, s, { baseRevisionId: revision?.id || null, files: normalizeWebsiteFiles([...existing.filter(f => f.path !== file.path), file]), summary: `Datei ${file.path} hochgeladen.` });
      await store.appendMessage(p, s, { role: 'assistant', content: `${file.path} ist verfügbar. Beschreibe im Chat, wo ich die Datei verwenden soll.` });
      return saved;
    }),
    waitForJob: async (p, s) => { const job = operations.get(key(p, s)); if (job && job !== true) await job; return site(p, s); },
  };
}
