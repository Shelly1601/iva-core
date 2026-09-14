import crypto from 'node:crypto';

const API = 'https://api.github.com';
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/i;
const OWNER = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const REPOSITORY = /^[a-z\d_.-]{1,100}$/i;
const REF = /^(?!\.)(?!.*(?:\.\.|@\{|\\|\/$|\/\/))[a-z\d_./-]{1,200}$/i;
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const assertSha = value => {
  if (!SHA.test(String(value || ''))) throw failure('GITHUB_INVALID_RESPONSE', 'GitHub lieferte keine gültige Revision.', 502);
  return value.toLowerCase();
};
const safeRef = value => {
  if (typeof value !== 'string' || !REF.test(value) || value.endsWith('.lock') || value.split('/').some(part => part.startsWith('.') || part.endsWith('.'))) {
    throw failure('GITHUB_INVALID_REF', 'Ungültiger GitHub-Branch oder Commit.');
  }
  return value;
};
const refPath = value => safeRef(value).split('/').map(encodeURIComponent).join('/');
const equalRepository = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();

export function inspectGitHubWebsiteReference(reference) {
  if (typeof reference !== 'string' || reference.length > 600 || reference !== reference.trim()) throw failure('GITHUB_INVALID_REPOSITORY', 'Bitte einen GitHub-Repository-Link angeben.');
  const raw = reference.startsWith('https://') ? reference : `https://github.com/${reference}`;
  let url;
  try { url = new URL(raw); } catch { throw failure('GITHUB_INVALID_REPOSITORY', 'Ungültiger GitHub-Repository-Link.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || /%|\\/.test(raw)) {
    throw failure('GITHUB_INVALID_REPOSITORY', 'Nur direkte GitHub-Repository-Links ohne Zugangsdaten sind erlaubt.');
  }
  const parts = url.pathname.replace(/\/$/, '').slice(1).split('/');
  if (![2, 4].includes(parts.length) || (parts.length === 4 && parts[2] !== 'tree')) throw failure('GITHUB_INVALID_REPOSITORY', 'Link muss ein Repository oder einen einfachen Branch bezeichnen.');
  const [owner, rawName] = parts;
  const name = rawName.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPOSITORY.test(name) || ['.', '..'].includes(name)) throw failure('GITHUB_INVALID_REPOSITORY', 'Ungültiger GitHub-Repository-Name.');
  const ref = parts[3] ? safeRef(parts[3]) : null;
  return { repository: `${owner}/${name}`, owner, name, url: `https://github.com/${owner}/${name}`, ref };
}

function pathPolicy(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\x00-\x1f\x7f\\]/.test(value) || value.startsWith('/') || /^[a-z]:/i.test(value)) throw failure('GITHUB_INVALID_PATH', 'Unzulässiger Dateipfad im Repository.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw failure('GITHUB_INVALID_PATH', 'Unzulässiger Dateipfad im Repository.');
  const lower = parts.map(part => part.toLowerCase());
  if (lower.some(part => part === '.git' || part === 'node_modules' || part === '.ds_store')) return 'excluded_directory';
  if (lower.some(part => /^\.env(?:\.|$)/.test(part) || ['.npmrc', '.pypirc', '.netrc', 'credentials.json', 'credentials', 'id_rsa', 'id_ed25519'].includes(part) || /\.(?:pem|key|p12|pfx)$/.test(part))) return 'credentials_excluded';
  return '';
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_BYTES / 3) * 4 + 1024 || !/^[a-z\d+/=\r\n]*$/i.test(value)) throw failure('GITHUB_INVALID_FILE', 'Ungültiger Dateiinhalt.');
  const normalized = value.replace(/[\r\n]/g, '');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.toString('base64') !== normalized) throw failure('GITHUB_INVALID_FILE', 'Ungültige Base64-Datei.');
  return bytes;
}

function fileBytes(file) {
  if (file.encoding === 'base64') return decodeBase64(file.content);
  if (!['utf8', 'utf-8', undefined].includes(file.encoding) || typeof file.content !== 'string') throw failure('GITHUB_INVALID_FILE', 'Dateien müssen Text oder Base64-Inhalte enthalten.');
  return Buffer.from(file.content, 'utf8');
}

export function validateGitHubWebsiteFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw failure('GITHUB_FILE_LIMIT', `Ein Website-Export benötigt 1 bis ${MAX_FILES} Dateien.`);
  let total = 0;
  const names = new Set();
  return files.map(file => {
    if (!file || pathPolicy(file.path)) throw failure('GITHUB_SENSITIVE_PATH', 'Zugangsdaten und ausgeschlossene Verzeichnisse dürfen nicht exportiert werden.');
    const key = file.path.normalize('NFC').toLowerCase();
    if (names.has(key)) throw failure('GITHUB_DUPLICATE_PATH', 'Doppelte Dateipfade im Website-Export.');
    names.add(key);
    const bytes = fileBytes(file);
    total += bytes.length;
    if (total > MAX_BYTES) throw failure('GITHUB_SIZE_LIMIT', 'Website-Dateien überschreiten die Grenze von 20 MiB.');
    return { path: file.path, bytes, mode: file.mode === '100755' ? '100755' : '100644' };
  });
}

async function mapBounded(items, mapper, concurrency = 4) {
  const result = new Array(items.length);
  let next = 0;
  let error;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!error && next < items.length) {
      const index = next++;
      try { result[index] = await mapper(items[index], index); } catch (caught) { error ||= caught; }
    }
  }));
  if (error) throw error;
  return result;
}

function blobHash(bytes) {
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function outputFile(path, bytes, mode) {
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!content.includes('\0')) return { path, content, encoding: 'utf8', mode };
  } catch { /* Binary assets are preserved byte-for-byte. */ }
  return { path, content: bytes.toString('base64'), encoding: 'base64', mode };
}

export function createGitHubWebsiteConnector({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15_000, operationTimeoutMs = 180_000 } = {}) {
  const token = String(env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  const requestTimeout = Math.min(Math.max(Number(timeoutMs) || 15_000, 1), 30_000);
  const operationTimeout = Math.min(Math.max(Number(operationTimeoutMs) || 180_000, 1), 300_000);
  const activeExports = new Set();
  const status = () => ({ provider: 'github', configured: Boolean(token), verified: false, state: token ? 'configured' : 'missing_credentials', publicImportAvailable: true, limits: { files: MAX_FILES, bytes: MAX_BYTES }, note: token ? 'Zugang hinterlegt; Berechtigungen werden bei Verwendung geprüft.' : 'Öffentliche Repositories können importiert werden. Private Repositories und Export benötigen einen GitHub-Zugang.' });
  const context = () => ({ deadline: Date.now() + operationTimeout });
  async function request(route, { method = 'GET', body, ctx } = {}) {
    const remaining = ctx ? ctx.deadline - Date.now() : operationTimeout;
    if (remaining <= 0) throw failure('GITHUB_TIMEOUT', 'GitHub-Vorgang hat das Zeitlimit überschritten.', 504);
    if (!route.startsWith('/') || route.startsWith('//') || /[\r\n\\]/.test(route)) throw failure('GITHUB_INVALID_ROUTE', 'Unzulässiges GitHub-API-Ziel.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(requestTimeout, remaining));
    const abortError = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(failure('GITHUB_TIMEOUT', 'GitHub hat nicht rechtzeitig geantwortet.', 504)), { once: true }));
    try {
      return await Promise.race([(async () => {
        let response;
        try {
          response = await fetchImpl(`${API}${route}`, { method, redirect: 'error', signal: controller.signal, headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'IVA-Website-Studio', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        } catch (error) {
          if (controller.signal.aborted) throw failure('GITHUB_TIMEOUT', 'GitHub hat nicht rechtzeitig geantwortet.', 504);
          throw failure('GITHUB_UNREACHABLE', 'GitHub ist derzeit nicht erreichbar. Ein unklarer Schreibausgang muss vor einem neuen Versuch geprüft werden.', 502);
        }
        if (response.redirected || response.url && new URL(response.url).origin !== API || response.status >= 300 && response.status < 400) throw failure('GITHUB_REDIRECT_BLOCKED', 'GitHub-Weiterleitungen werden zum Schutz des Zugangs nicht verfolgt.', 502);
        if (!response.ok) {
          const messages = { 401: ['GITHUB_AUTH_REQUIRED', 'GitHub-Zugang wurde abgelehnt.'], 403: ['GITHUB_PERMISSION', 'GitHub-Berechtigung fehlt oder das API-Limit wurde erreicht.'], 404: ['GITHUB_NOT_FOUND', 'GitHub-Repository oder Revision wurde nicht gefunden.'], 409: ['GITHUB_CONFLICT', 'GitHub meldet einen Versionskonflikt.'], 422: ['GITHUB_REJECTED', 'GitHub hat den Schreibvorgang abgelehnt. Repository-Name, Rechte und aktuellen Branch prüfen.'] };
          const [code, message] = messages[response.status] || ['GITHUB_RESPONSE_ERROR', 'GitHub konnte den Vorgang nicht ausführen.'];
          throw failure(code, message, response.status);
        }
        if (Number(response.headers?.get?.('content-length') || 0) > MAX_BYTES * 2) throw failure('GITHUB_SIZE_LIMIT', 'GitHub-Antwort überschreitet die zulässige Größe.', 502);
        let raw;
        if (response.body?.getReader) {
          const reader = response.body.getReader();
          const chunks = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > MAX_BYTES * 2) { await reader.cancel(); throw failure('GITHUB_SIZE_LIMIT', 'GitHub-Antwort überschreitet die zulässige Größe.', 502); }
            chunks.push(Buffer.from(value));
          }
          raw = Buffer.concat(chunks).toString('utf8');
        } else raw = await response.text();
        if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES * 2) throw failure('GITHUB_SIZE_LIMIT', 'GitHub-Antwort überschreitet die zulässige Größe.', 502);
        try { return JSON.parse(raw); } catch { throw failure('GITHUB_INVALID_RESPONSE', 'GitHub lieferte eine ungültige Antwort.', 502); }
      })(), abortError]);
    } finally { clearTimeout(timer); }
  }
  function metadata(repo, reference, branch, commitSha) {
    if (!equalRepository(repo.full_name, reference.repository)) throw failure('GITHUB_REPOSITORY_MISMATCH', 'GitHub-Repository stimmt nicht mit dem ausgewählten Ziel überein.', 409);
    return { repository: reference.repository, url: reference.url, branch: safeRef(branch), commitSha: assertSha(commitSha), private: repo.private === true };
  }
  async function importRepository({ repository, ref } = {}) {
    const reference = inspectGitHubWebsiteReference(repository);
    const ctx = context();
    const root = `/repos/${reference.repository}`;
    const repo = await request(root, { ctx });
    if (!equalRepository(repo.full_name, reference.repository)) throw failure('GITHUB_REPOSITORY_MISMATCH', 'GitHub-Repository wurde verschoben oder stimmt nicht überein.', 409);
    const branch = safeRef(ref || reference.ref || repo.default_branch);
    const commit = await request(`${root}/commits/${encodeURIComponent(branch)}`, { ctx });
    const commitSha = assertSha(commit.sha);
    const treeSha = assertSha(commit.commit?.tree?.sha);
    const tree = await request(`${root}/git/trees/${treeSha}?recursive=1`, { ctx });
    if (tree.truncated || !Array.isArray(tree.tree)) throw failure('GITHUB_TREE_INCOMPLETE', 'Das Repository ist zu groß für einen vollständigen Import. Bitte einen Website-Export hochladen.', 413);
    const omitted = [];
    let bytesDeclared = 0;
    const selected = [];
    for (const entry of tree.tree) {
      const reason = pathPolicy(entry.path);
      if (entry.type === 'tree') continue;
      if (reason || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) { omitted.push({ path: entry.path, reason: reason || 'links_or_submodules_unsupported' }); continue; }
      const size = Number(entry.size);
      if (!Number.isSafeInteger(size) || size < 0) throw failure('GITHUB_INVALID_RESPONSE', 'GitHub-Dateigröße ist ungültig.', 502);
      bytesDeclared += size;
      if (selected.length >= MAX_FILES || bytesDeclared > MAX_BYTES) throw failure('GITHUB_IMPORT_LIMIT', 'Repository überschreitet 500 Dateien oder 20 MiB. Bitte einen begrenzten Website-Export hochladen.', 413);
      selected.push({ ...entry, sha: assertSha(entry.sha) });
    }
    if (!selected.length) throw failure('GITHUB_EMPTY_REPOSITORY', 'Das Repository enthält keine importierbaren Website-Dateien.');
    let bytesReceived = 0;
    const files = await mapBounded(selected, async entry => {
      const blob = await request(`${root}/git/blobs/${entry.sha}`, { ctx });
      if (blob.encoding !== 'base64' || assertSha(blob.sha) !== entry.sha) throw failure('GITHUB_INVALID_BLOB', 'GitHub-Datei konnte nicht eindeutig geprüft werden.', 502);
      const bytes = decodeBase64(blob.content);
      bytesReceived += bytes.length;
      if (bytesReceived > MAX_BYTES || bytes.length !== entry.size || blobHash(bytes) !== entry.sha) throw failure('GITHUB_BLOB_MISMATCH', 'GitHub-Datei stimmt nicht mit der festgelegten Revision überein.', 502);
      return outputFile(entry.path, bytes, entry.mode);
    });
    validateGitHubWebsiteFiles(files);
    return { files, github: metadata(repo, reference, branch, commitSha), omitted, bytes: bytesReceived };
  }
  async function exportRepository({ name, description = '', files, private: isPrivate, repository, expectedHead } = {}) {
    if (!token) throw failure('GITHUB_AUTH_REQUIRED', 'Für den Export bitte einen GitHub-Zugang hinterlegen.', 401);
    if (isPrivate !== true) throw failure('GITHUB_PRIVATE_REQUIRED', 'Website-Exporte werden ausschließlich in private Repositories geschrieben.');
    const validated = validateGitHubWebsiteFiles(files);
    if (validated.some(file => token && file.bytes.includes(Buffer.from(token)))) throw failure('GITHUB_SECRET_IN_FILE', 'Eine Website-Datei enthält den GitHub-Zugang und darf nicht exportiert werden.');
    const ctx = context();
    const user = await request('/user', { ctx });
    if (!OWNER.test(String(user.login || ''))) throw failure('GITHUB_INVALID_USER', 'GitHub-Konto konnte nicht geprüft werden.', 502);
    const newName = String(name || '');
    if (!repository && (!REPOSITORY.test(newName) || ['.', '..'].includes(newName))) throw failure('GITHUB_INVALID_NAME', 'Ungültiger Name für das neue GitHub-Repository.');
    const reference = repository ? inspectGitHubWebsiteReference(repository) : inspectGitHubWebsiteReference(`${user.login}/${newName}`);
    if (reference.owner.toLowerCase() !== user.login.toLowerCase()) throw failure('GITHUB_OWNER_MISMATCH', 'Export ist nur in ein Repository des verbundenen GitHub-Kontos möglich.', 403);
    if (repository && !SHA.test(String(expectedHead || ''))) throw failure('GITHUB_EXPECTED_HEAD_REQUIRED', 'Für ein bestehendes Repository wird die zuletzt geprüfte Revision benötigt.', 409);
    const lock = reference.repository.toLowerCase();
    if (activeExports.has(lock)) throw failure('GITHUB_EXPORT_BUSY', 'Für dieses Repository läuft bereits ein Export.', 409);
    activeExports.add(lock);
    let created = false;
    let repo;
    let branch;
    const root = `/repos/${reference.repository}`;
    try {
      if (repository) repo = await request(root, { ctx });
      else {
        repo = await request('/user/repos', { method: 'POST', body: { name: newName, description: String(description).replace(/[\x00-\x1f]/g, ' ').slice(0, 350), private: true, auto_init: false }, ctx });
        created = true;
      }
      if (!equalRepository(repo.full_name, reference.repository) || repo.private !== true || repo.owner?.login?.toLowerCase() !== user.login.toLowerCase()) throw failure('GITHUB_REPOSITORY_MISMATCH', 'Ziel-Repository ist nicht als eigenes privates Repository bestätigt.', 409);
      branch = repository ? safeRef(reference.ref || repo.default_branch) : 'main';
      if (created) {
        await request(`${root}/contents/README.md`, { method: 'PUT', body: { message: 'Initialize private IVA Website Studio repository', content: Buffer.from('# IVA Website Studio\n').toString('base64'), branch }, ctx });
      }
      const readHead = async () => {
        const result = await request(`${root}/git/ref/heads/${refPath(branch)}`, { ctx });
        if (result.object?.type !== 'commit') throw failure('GITHUB_INVALID_RESPONSE', 'GitHub-Branch verweist nicht auf einen Commit.', 502);
        return assertSha(result.object.sha);
      };
      const head = await readHead();
      if (repository && head !== String(expectedHead).toLowerCase()) throw failure('GITHUB_HEAD_CHANGED', 'Das Repository wurde zwischenzeitlich geändert. Bitte erst den aktuellen Stand importieren.', 409);
      const previous = await request(`${root}/git/commits/${head}`, { ctx });
      const baseTree = assertSha(previous.tree?.sha);
      const blobs = await mapBounded(validated, async file => {
        const result = await request(`${root}/git/blobs`, { method: 'POST', body: { content: file.bytes.toString('base64'), encoding: 'base64' }, ctx });
        const sha = assertSha(result.sha);
        if (sha !== blobHash(file.bytes)) throw failure('GITHUB_BLOB_MISMATCH', 'GitHub bestätigte abweichende Dateiinhalte.', 502);
        return { path: file.path, mode: file.mode, type: 'blob', sha };
      });
      // Preserve files not supplied by this export; never delete repository files implicitly.
      const tree = await request(`${root}/git/trees`, { method: 'POST', body: { base_tree: baseTree, tree: blobs }, ctx });
      const nextCommit = await request(`${root}/git/commits`, { method: 'POST', body: { message: 'Update website from IVA Website Studio', tree: assertSha(tree.sha), parents: [head] }, ctx });
      const nextSha = assertSha(nextCommit.sha);
      if (await readHead() !== head) throw failure('GITHUB_HEAD_CHANGED', 'Das Repository wurde während des Exports geändert. Es wurde kein Branch überschrieben.', 409);
      await request(`${root}/git/refs/heads/${refPath(branch)}`, { method: 'PATCH', body: { sha: nextSha, force: false }, ctx });
      if (await readHead() !== nextSha) throw failure('GITHUB_VERIFICATION_FAILED', 'Der GitHub-Export wurde gesendet, aber die aktuelle Revision konnte nicht bestätigt werden. Vor erneutem Export den Repository-Stand prüfen.', 409);
      return { github: metadata(repo, reference, branch, nextSha), created, files: validated.length, status: 'completed' };
    } catch (error) {
      if (created) error.github = { repository: reference.repository, url: reference.url, branch: branch || 'main', private: true, created: true, status: 'incomplete' };
      throw error;
    } finally { activeExports.delete(lock); }
  }
  return Object.freeze({ status, inspectReference: inspectGitHubWebsiteReference, importRepository, exportRepository });
}
