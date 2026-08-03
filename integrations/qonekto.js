import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

const DEFAULT_MCP_URL = 'https://app.qonekto.de/api/goalsandconcepts/mcp';
const CONNECT_TIMEOUT_MS = 12_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ARGUMENT_BYTES = 24_000;
const MAX_RESULT_CHARS = 60_000;
const CONFIRMATION_TTL_MS = 10 * 60_000;
const CONFIRMATION_PHRASE = 'Ja, Qonekto-Änderung ausführen';

const CONFIRMABLE_WRITE_NAME_PARTS = [
  'add', 'assign', 'change', 'create', 'edit', 'link', 'move', 'patch',
  'replace', 'restore', 'set', 'store', 'unlink', 'update', 'upload', 'upsert',
  'write',
  'aender', 'ander', 'anleg', 'erstell', 'speicher', 'zuweis',
];

const BLOCKED_WRITE_NAME_PARTS = [
  'cancel', 'close', 'delete', 'destroy', 'import', 'merge', 'purge',
  'remove', 'send', 'sync', 'terminate', 'trigger',
  'archivier', 'beendig', 'kuendig', 'kundig', 'loesch', 'losch', 'stornier',
  'versend',
];

const PREFIX_NAME_PARTS = new Set([
  'aender', 'ander', 'anleg', 'erstell', 'speicher', 'zuweis',
  'archivier', 'beendig', 'kuendig', 'kundig', 'loesch', 'losch', 'stornier',
  'versend', 'abruf', 'anzeig', 'durchsuch', 'les', 'such',
]);

const READ_NAME_PARTS = [
  'average', 'count', 'download', 'export', 'fetch', 'filter', 'find', 'get',
  'group', 'inspect', 'list', 'lookup', 'query', 'read', 'retrieve', 'search',
  'show', 'whoami',
  'abruf', 'anzeig', 'durchsuch', 'find', 'les', 'list', 'such',
];

function normalizeName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function hasNamePart(name, parts) {
  const words = normalizeName(String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2'))
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some(word => parts.some(part => word === part || (PREFIX_NAME_PARTS.has(part) && word.startsWith(part))));
}

export function isReadOnlyQonektoTool(tool) {
  if (!tool || typeof tool.name !== 'string') return false;
  const annotations = tool.annotations || {};
  if (annotations.destructiveHint === true || annotations.readOnlyHint === false) return false;
  if (hasNamePart(tool.name, [...CONFIRMABLE_WRITE_NAME_PARTS, ...BLOCKED_WRITE_NAME_PARTS])) return false;
  if (annotations.readOnlyHint === true) return true;
  return hasNamePart(tool.name, READ_NAME_PARTS);
}

export function isConfirmableQonektoWriteTool(tool) {
  if (!tool || typeof tool.name !== 'string') return false;
  const annotations = tool.annotations || {};
  if (annotations.destructiveHint === true || annotations.readOnlyHint === true) return false;
  if (hasNamePart(tool.name, BLOCKED_WRITE_NAME_PARTS)) return false;
  return hasNamePart(tool.name, CONFIRMABLE_WRITE_NAME_PARTS);
}

function getConfig() {
  const token = String(process.env.QONEKTO_MCP_TOKEN || '').trim();
  const rawUrl = String(process.env.QONEKTO_MCP_URL || DEFAULT_MCP_URL).trim();
  let url;
  try { url = new URL(rawUrl); }
  catch { throw new Error('Qonekto-MCP-URL ist ungueltig.'); }
  if (url.protocol !== 'https:') throw new Error('Qonekto-MCP-URL muss HTTPS verwenden.');
  return { token, url };
}

function safeError(error) {
  const message = String(error?.message || error || 'Unbekannter Fehler');
  if (/401|unauthori|token|credential/i.test(message)) return 'Qonekto hat den MCP-Token nicht akzeptiert.';
  if (/403|forbidden|scope|permission/i.test(message)) return 'Dem Qonekto-Token fehlt eine benoetigte MCP-Berechtigung.';
  if (/timeout|timed out|abort/i.test(message)) return 'Qonekto hat nicht rechtzeitig geantwortet.';
  if (/fetch|network|enotfound|econn|socket/i.test(message)) return 'Qonekto ist gerade nicht erreichbar.';
  return 'Die Qonekto-MCP-Verbindung ist fehlgeschlagen.';
}

function errorCategory(error) {
  const message = `${error?.name || ''} ${error?.code || ''} ${error?.message || error || ''}`;
  if (/401|unauthori|token|credential/i.test(message)) return 'authentication';
  if (/403|forbidden|scope|permission/i.test(message)) return 'permission';
  if (/timeout|timed out|abort/i.test(message)) return 'timeout';
  if (/fetch|network|enotfound|econn|socket/i.test(message)) return 'network';
  if (/protocol|initialize|method|parse|json.?rpc/i.test(message)) return 'protocol';
  return 'connection';
}

function connectionError(source, cause) {
  const error = new Error(safeError(source));
  error.category = errorCategory(source);
  error.cause = cause || source;
  return error;
}

function diagnosticEntry(error) {
  if (!error) return null;
  const message = String(error?.message || error)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return {
    name: String(error?.name || 'Error').slice(0, 80),
    ...(error?.code !== undefined ? { code: String(error.code).slice(0, 40) } : {}),
    ...(error?.status !== undefined ? { status: String(error.status).slice(0, 20) } : {}),
    message,
  };
}

function safeDiagnostics(error) {
  const cause = error?.cause;
  if (cause?.streamableError || cause?.sseError) {
    return {
      streamable: diagnosticEntry(cause.streamableError),
      sseFallback: diagnosticEntry(cause.sseError),
    };
  }
  return { primary: diagnosticEntry(cause || error) };
}

function withTimeout(promise, ms, label, onTimeout) {
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      try { onTimeout?.(); } catch {}
      reject(new Error(`${label} timeout`));
    }, ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}

async function closeQuietly(client, transport) {
  try { await client?.close(); } catch {}
  try { await transport?.close(); } catch {}
}

async function connectWith(Transport, { token, url }) {
  const client = new Client(
    { name: 'iva-core', version: '1.0.0' },
    { listMaxPages: 16 },
  );
  const transport = new Transport(new URL(url), {
    authProvider: { token: async () => token },
    onInsufficientScope: 'throw',
  });
  try {
    await withTimeout(
      client.connect(transport),
      CONNECT_TIMEOUT_MS,
      'Qonekto connect',
      () => { void closeQuietly(client, transport); },
    );
    return { client, transport };
  } catch (error) {
    await closeQuietly(client, transport);
    throw error;
  }
}

async function connectQonekto() {
  const config = getConfig();
  if (!config.token) throw new Error('QONEKTO_MCP_TOKEN ist nicht gesetzt.');
  try {
    return await connectWith(StreamableHTTPClientTransport, config);
  } catch (streamableError) {
    const primaryCategory = errorCategory(streamableError);
    // Auth-/Rechtefehler sind transportunabhaengig. Ein SSE-Fallback wuerde
    // nur die aussagekraeftige Ursache verdecken und eine zweite Anfrage senden.
    if (primaryCategory === 'authentication' || primaryCategory === 'permission') {
      throw connectionError(streamableError);
    }
    try { return await connectWith(SSEClientTransport, config); }
    catch (sseError) {
      throw connectionError(
        errorCategory(sseError) === 'authentication' || errorCategory(sseError) === 'permission'
          ? sseError
          : streamableError,
        { streamableError, sseError },
      );
    }
  }
}

function publicTool(tool) {
  return {
    name: tool.name,
    description: String(tool.description || '').slice(0, 1_500),
    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
  };
}

async function listToolsOn(client) {
  const result = await withTimeout(
    client.listTools(),
    REQUEST_TIMEOUT_MS,
    'Qonekto tools/list',
  );
  return Array.isArray(result?.tools) ? result.tools : [];
}

export async function listQonektoReadTools({ search = '' } = {}) {
  const { client, transport } = await connectQonekto();
  try {
    const query = normalizeName(search);
    const tools = (await listToolsOn(client))
      .filter(isReadOnlyQonektoTool)
      .filter(tool => !query || normalizeName(`${tool.name} ${tool.description || ''}`).includes(query))
      .map(publicTool);
    return { connected: true, readOnly: true, count: tools.length, tools };
  } finally {
    await closeQuietly(client, transport);
  }
}

export async function listQonektoTools({ search = '' } = {}) {
  const { client, transport } = await connectQonekto();
  try {
    const query = normalizeName(search);
    const all = (await listToolsOn(client))
      .filter(tool => !query || normalizeName(`${tool.name} ${tool.description || ''}`).includes(query));
    const readable = all.filter(isReadOnlyQonektoTool).map(tool => ({ ...publicTool(tool), mode: 'read' }));
    const writable = all.filter(isConfirmableQonektoWriteTool).map(tool => ({ ...publicTool(tool), mode: 'write-with-confirmation' }));
    return {
      connected: true,
      readsImmediately: true,
      writesRequireConfirmation: true,
      confirmationPhrase: CONFIRMATION_PHRASE,
      readCount: readable.length,
      writeCount: writable.length,
      blockedCount: Math.max(0, all.length - readable.length - writable.length),
      tools: [...readable, ...writable],
    };
  } finally {
    await closeQuietly(client, transport);
  }
}

function compactResult(value, maxChars = MAX_RESULT_CHARS) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { serialized = JSON.stringify({ error: 'Qonekto-Ergebnis konnte nicht serialisiert werden.' }); }
  if (serialized.length <= maxChars) return value;
  return {
    truncated: true,
    originalCharacters: serialized.length,
    preview: serialized.slice(0, maxChars),
  };
}

export async function callQonektoReadTool(toolName, args = {}) {
  const name = String(toolName || '').trim();
  if (!name) throw new Error('Qonekto-Werkzeugname fehlt.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Qonekto-Argumente muessen ein Objekt sein.');
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) throw new Error('Qonekto-Anfrage ist zu gross.');

  const { client, transport } = await connectQonekto();
  try {
    const available = await listToolsOn(client);
    const selected = available.find(tool => tool.name === name);
    if (!selected) throw new Error(`Qonekto-Werkzeug "${name}" existiert nicht.`);
    if (!isReadOnlyQonektoTool(selected)) throw new Error(`Qonekto-Werkzeug "${name}" ist durch IVAs Leseschutz blockiert.`);
    const result = await withTimeout(
      client.callTool({ name, arguments: args }),
      REQUEST_TIMEOUT_MS,
      `Qonekto tool ${name}`,
    );
    return compactResult({ readOnly: true, tool: name, result });
  } finally {
    await closeQuietly(client, transport);
  }
}

function actionsFile() {
  return `${process.env.DATA_DIR || '/data'}/qonekto-pending-actions.json`;
}

async function loadActions() {
  try {
    const parsed = JSON.parse(await fs.readFile(actionsFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveActions(actions) {
  const file = actionsFile();
  const dir = file.slice(0, file.lastIndexOf('/')) || '.';
  const temp = `${file}.${process.pid}.tmp`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(temp, JSON.stringify(actions, null, 2), { mode: 0o600 });
  await fs.rename(temp, file);
}

let actionWriteChain = Promise.resolve();
function mutateActions(mutator) {
  const operation = actionWriteChain.then(async () => {
    const now = Date.now();
    const actions = (await loadActions()).filter(action => action.status !== 'pending' || action.expiresAt > now);
    const result = await mutator(actions);
    await saveActions(actions.slice(-100));
    return result;
  });
  actionWriteChain = operation.catch(() => {});
  return operation;
}

// Offene Aenderungen enthalten ihre Argumente nur fuer das kurze
// Bestaetigungsfenster. Der unref-Timer haelt den Server nicht kuenstlich am Leben.
const actionCleanupTimer = setInterval(() => {
  void mutateActions(() => {}).catch(() => {});
}, 5 * 60_000);
actionCleanupTimer.unref?.();

function maskValue(key, value) {
  const name = normalizeName(key);
  if (/token|secret|passwort|password/.test(name)) return '[geschuetzt]';
  if (/iban|kontonummer|accountnumber/.test(name)) {
    const raw = String(value || '').replace(/\s/g, '');
    return raw.length > 4 ? `…${raw.slice(-4)}` : '[Bankdaten]';
  }
  if (/bic/.test(name)) return '[BIC hinterlegt]';
  if (typeof value === 'string') return value.slice(0, 160);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item, index) => maskValue(`${key}.${index}`, item));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 30).map(([childKey, child]) => [childKey, maskValue(childKey, child)]));
  return String(value).slice(0, 80);
}

function safeArgumentsPreview(args) {
  return Object.fromEntries(Object.entries(args || {}).slice(0, 30).map(([key, value]) => [key, maskValue(key, value)]));
}

export async function prepareQonektoWriteAction({ sessionId, toolName, args = {} }) {
  const session = String(sessionId || 'default').slice(0, 200);
  const name = String(toolName || '').trim();
  if (!name) throw new Error('Qonekto-Werkzeugname fehlt.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Qonekto-Argumente muessen ein Objekt sein.');
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENT_BYTES) throw new Error('Qonekto-Aenderung ist zu gross.');

  const { client, transport } = await connectQonekto();
  let selected;
  try {
    selected = (await listToolsOn(client)).find(tool => tool.name === name);
  } finally {
    await closeQuietly(client, transport);
  }
  if (!selected) throw new Error(`Qonekto-Werkzeug "${name}" existiert nicht.`);
  if (!isConfirmableQonektoWriteTool(selected)) throw new Error(`Qonekto-Werkzeug "${name}" ist nicht fuer bestaetigte Aenderungen freigegeben.`);

  const createdAt = Date.now();
  const action = {
    id: randomUUID(),
    sessionId: session,
    toolName: name,
    arguments: args,
    preview: safeArgumentsPreview(args),
    status: 'pending',
    createdAt,
    expiresAt: createdAt + CONFIRMATION_TTL_MS,
  };
  await mutateActions(actions => {
    for (const existing of actions) {
      if (existing.sessionId === session && existing.status === 'pending') existing.status = 'superseded';
    }
    actions.push(action);
  });
  return {
    prepared: true,
    executed: false,
    actionId: action.id,
    toolName: action.toolName,
    changes: action.preview,
    expiresInMinutes: CONFIRMATION_TTL_MS / 60_000,
    requiredConfirmation: CONFIRMATION_PHRASE,
    instruction: `Noch nichts wurde geaendert. Frage Nadine eindeutig und fuehre erst nach ihrer exakten Antwort "${CONFIRMATION_PHRASE}" aus.`,
  };
}

function normalizedConfirmation(text) {
  return normalizeName(text).replace(/[^a-z0-9]+/g, ' ').trim();
}

export function isExplicitQonektoConfirmation(text) {
  return normalizedConfirmation(text) === normalizedConfirmation(CONFIRMATION_PHRASE);
}

function isExplicitQonektoCancellation(text) {
  return ['nein', 'abbrechen', 'nein abbrechen', 'qonekto aenderung abbrechen', 'qonekto anderung abbrechen']
    .includes(normalizedConfirmation(text));
}

async function claimLatestPendingAction(sessionId) {
  return mutateActions(actions => {
    const pending = actions
      .filter(action => action.sessionId === String(sessionId) && action.status === 'pending' && action.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!pending) return null;
    pending.status = 'executing';
    pending.claimedAt = Date.now();
    return structuredClone(pending);
  });
}

async function finishAction(actionId, status) {
  await mutateActions(actions => {
    const action = actions.find(item => item.id === actionId);
    if (!action) return;
    action.status = status;
    action.finishedAt = Date.now();
    delete action.arguments;
  });
}

async function cancelLatestPendingAction(sessionId) {
  return mutateActions(actions => {
    const pending = actions
      .filter(action => action.sessionId === String(sessionId) && action.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!pending) return false;
    pending.status = 'cancelled';
    pending.finishedAt = Date.now();
    delete pending.arguments;
    return true;
  });
}

async function executeClaimedAction(action) {
  const { client, transport } = await connectQonekto();
  try {
    const selected = (await listToolsOn(client)).find(tool => tool.name === action.toolName);
    if (!selected || !isConfirmableQonektoWriteTool(selected)) throw new Error('Die vorbereitete Qonekto-Aenderung ist nicht mehr freigegeben.');
    return await withTimeout(
      client.callTool({ name: action.toolName, arguments: action.arguments }),
      REQUEST_TIMEOUT_MS,
      `Qonekto write ${action.toolName}`,
    );
  } finally {
    await closeQuietly(client, transport);
  }
}

export async function handleQonektoConfirmation(sessionId, userText) {
  if (isExplicitQonektoCancellation(userText)) {
    const cancelled = await cancelLatestPendingAction(sessionId);
    return cancelled ? 'Abgebrochen. In Qonekto wurde nichts geaendert.' : null;
  }
  if (!isExplicitQonektoConfirmation(userText)) return null;
  const action = await claimLatestPendingAction(sessionId);
  if (!action) return 'Es gibt keine offene Qonekto-Aenderung zum Bestaetigen.';
  try {
    const result = await executeClaimedAction(action);
    if (result?.isError) {
      await finishAction(action.id, 'failed');
      return `Qonekto hat die bestaetigte Aenderung "${action.toolName}" nicht ausgefuehrt. Es wurden keine weiteren Aktionen gestartet.`;
    }
    await finishAction(action.id, 'completed');
    return `Erledigt. Die bestaetigte Qonekto-Aenderung "${action.toolName}" wurde ausgefuehrt.`;
  } catch (error) {
    await finishAction(action.id, 'failed');
    return `Die bestaetigte Qonekto-Aenderung konnte nicht ausgefuehrt werden: ${safeError(error)}`;
  }
}

let statusCache = null;
let statusInFlight = null;

async function queryQonektoStatus() {
  const configured = Boolean(String(process.env.QONEKTO_MCP_TOKEN || '').trim());
  if (!configured) return { configured: false, reachable: false, readToolCount: 0 };
  try {
    const { client, transport } = await connectQonekto();
    try {
      const tools = await listToolsOn(client);
      return {
        configured: true,
        reachable: true,
        toolCount: tools.length,
        readToolCount: tools.filter(isReadOnlyQonektoTool).length,
        confirmableWriteToolCount: tools.filter(isConfirmableQonektoWriteTool).length,
        blockedToolCount: tools.filter(tool => !isReadOnlyQonektoTool(tool) && !isConfirmableQonektoWriteTool(tool)).length,
        destructiveWriteProtection: true,
        confirmationRequired: true,
      };
    } finally {
      await closeQuietly(client, transport);
    }
  } catch (error) {
    return {
      configured: true,
      reachable: false,
      readToolCount: 0,
      destructiveWriteProtection: true,
      confirmationRequired: true,
      error: safeError(error),
      errorCategory: error?.category || errorCategory(error),
      diagnostic: safeDiagnostics(error),
    };
  }
}

export async function qonektoStatus({ force = false } = {}) {
  if (!String(process.env.QONEKTO_MCP_TOKEN || '').trim()) {
    return { configured: false, reachable: false, readToolCount: 0 };
  }
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  if (!force && statusInFlight) return statusInFlight;
  statusInFlight = queryQonektoStatus();
  try {
    const value = await statusInFlight;
    statusCache = { at: Date.now(), value };
    return value;
  } finally {
    statusInFlight = null;
  }
}

export const QONEKTO_DEFAULT_MCP_URL = DEFAULT_MCP_URL;
export const QONEKTO_RESULT_LIMIT = MAX_RESULT_CHARS;
export const QONEKTO_CONFIRMATION_PHRASE = CONFIRMATION_PHRASE;
