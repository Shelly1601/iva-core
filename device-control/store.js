import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateDewarmteLinkPdfInput } from '../projects/dewarmte.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'device-commands.json');
const MAX_COMMANDS = 500;
const DEFAULT_TTL_MS = 15 * 60_000;
const DEFERRED_IMAC_COMMAND_TTL_MS = 24 * 60 * 60_000;
const LEASE_MS = 5 * 60_000;
const AGENT_ONLINE_MS = 60_000;
const DEWARMTE_INPUT_RETENTION_MS = 3 * 24 * 60 * 60_000;

// Serialize the complete read/modify/write transaction, not just rename.
let storeTransaction = Promise.resolve();
function transaction(work) {
  const next = storeTransaction.then(work);
  storeTransaction = next.catch(() => {});
  return next;
}

export const IVA_IMAC_DEVICE_ID = 'imac-nadine';
export const DEVICE_AGENT_PROTOCOL_VERSION = 2;
export const DEVICE_ACTIONS = Object.freeze({
  'agent.status': Object.freeze({ description: 'Attestierten iMac-Agent und iCloud-Workspace prüfen', mutating: false, requiresAttestedAgent: true }),
  'computer.status': Object.freeze({ description: 'Status des iMac-Helfers prüfen', mutating: false, requiresAttestedAgent: true }),
  'funding.monitor.status': Object.freeze({ description: 'Fördermonitor-Status prüfen', mutating: false, requiresAttestedAgent: true }),
  'funding.monitor.run': Object.freeze({ description: 'Fördermonitor einmal im gesperrten Review-Modus ausführen', mutating: false, requiresAttestedAgent: true }),
  'funding.legacy-monitor.suspend': Object.freeze({ description: 'Veralteten lokalen 30-Minuten-Fördermonitor ohne Dateilöschung anhalten', mutating: true, requiresAttestedAgent: true }),
  'funding.reviews.list': Object.freeze({ description: 'Lokale Förder-Prüfwarteschlange zusammenfassen', mutating: false, requiresAttestedAgent: true }),
  'planbar.search.refresh': Object.freeze({ description: 'Sichtbaren Planbar-Terminindex rein lesend aktualisieren', mutating: false, requiresAttestedAgent: true }),
  'planbar.customer.schedule': Object.freeze({ description: 'Einen eindeutig belegten Kunden über den lokalen iMac-Workflow in Planbar terminieren', mutating: true, requiresAttestedAgent: true }),
  'project.workflow.run': Object.freeze({ description: 'Einen freigegebenen Projekt-Workflow einmalig manuell starten', mutating: true, requiresAttestedAgent: true }),
  'portal.credentials.status': Object.freeze({ description: 'Nur die Belegung von IVAs lokalem macOS-Schlüsselbund prüfen', mutating: false, requiresAttestedAgent: true }),
  'portal.login': Object.freeze({ description: 'Bei einem vorab freigegebenen Portal mit lokalem Schlüsselbund anmelden', mutating: false, requiresAttestedAgent: true }),
  'knowledge.import.start': Object.freeze({ description: 'Einen fortsetzbaren Kursimport mit lokalem Login und optionaler Drive-Lernakte starten', mutating: true, requiresAttestedAgent: true }),
  'app.open': Object.freeze({ description: 'Eine freigegebene App auf dem iMac öffnen', mutating: true, requiresAttestedAgent: true }),
  'codex.task.start': Object.freeze({ description: 'Einen ausdrücklich beauftragten IVA-Bau- oder iMac-Operationsauftrag im lokalen Codex starten', mutating: true, requiresAttestedAgent: true }),
  'codex.task.status': Object.freeze({ description: 'Status eines lokalen Codex-Bauauftrags lesen', mutating: false, requiresAttestedAgent: true }),
});

async function loadStore() {
  try {
    const value = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    return {
      version: 2,
      commands: Array.isArray(value.commands) ? value.commands : [],
      agents: value.agents && typeof value.agents === 'object' ? value.agents : {},
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { version: 2, commands: [], agents: {} };
  }
}

async function saveStore(store) {
  await fs.mkdir(path.dirname(STORE_FILE), { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const compact = {
    version: 2,
    commands: store.commands
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(-MAX_COMMANDS),
    agents: store.agents && typeof store.agents === 'object' ? store.agents : {},
  };
  try {
    await fs.writeFile(temporary, JSON.stringify(compact, null, 2));
    await fs.rename(temporary, STORE_FILE);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validateCredentialEnvelope(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Number(value.version) !== 1 || value.algorithm !== 'RSA-OAEP-256+A256GCM') {
    throw new Error('Der verschlüsselte Zugangsdaten-Umschlag ist ungültig.');
  }
  const field = (name, max) => {
    const text = String(value[name] || '');
    if (!text || text.length > max || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error('Der verschlüsselte Zugangsdaten-Umschlag ist ungültig.');
    return text;
  };
  if (Object.keys(value).some(key => ['username', 'password', 'totp', 'secret'].includes(key.toLowerCase()))) {
    throw new Error('Zugangsdaten dürfen den Gerätekanal ausschließlich verschlüsselt passieren.');
  }
  return { version: 1, algorithm: value.algorithm, wrappedKey: field('wrappedKey', 800), iv: field('iv', 80), ciphertext: field('ciphertext', 24_000) };
}

function normalizedHostname(value) {
  return cleanText(value, 160).toLowerCase().replace(/\.local$/, '');
}

function isIcloudIvaWorkspace(value) {
  const workspace = cleanText(value, 1000);
  return workspace.includes('/Library/Mobile Documents/com~apple~CloudDocs/IVA-Assistent/iva-core');
}

function normalizedAgentMetadata(input = {}) {
  const credentialEnvelope = input.credentialEnvelope && typeof input.credentialEnvelope === 'object'
    && Number(input.credentialEnvelope.version) === 1
    && input.credentialEnvelope.algorithm === 'RSA-OAEP-256+A256GCM'
    && /^[A-Za-z0-9+/]+={0,2}$/.test(String(input.credentialEnvelope.publicKey || ''))
    && String(input.credentialEnvelope.publicKey || '').length <= 1600
    && /^[a-f0-9]{24}$/.test(String(input.credentialEnvelope.fingerprint || ''))
    ? {
      version: 1,
      algorithm: input.credentialEnvelope.algorithm,
      publicKey: String(input.credentialEnvelope.publicKey),
      fingerprint: String(input.credentialEnvelope.fingerprint),
    }
    : null;
  return {
    hostname: normalizedHostname(input.hostname),
    uiBusy: input.uiBusy === true,
    protocolVersion: Number(input.protocolVersion || 0),
    release: cleanText(input.release, 120),
    runtimeRevision: /^[a-f0-9]{64}$/.test(input.runtimeRevision || '') ? input.runtimeRevision : '',
    workspace: cleanText(input.workspace, 1000),
    iCloudAuthoritative: input.iCloudAuthoritative === true,
    allowedActions: [...new Set((Array.isArray(input.allowedActions) ? input.allowedActions : [])
      .map(value => cleanText(value, 100)).filter(value => DEVICE_ACTIONS[value]))].sort(),
    credentialEnvelope,
  };
}

function assertAttestedImacMetadata(metadata) {
  if (!metadata.hostname || !metadata.hostname.includes('imac')) {
    throw new Error('Geräte-Attestierung abgelehnt: Der Ausführungsrechner ist kein iMac.');
  }
  if (!Number.isInteger(metadata.protocolVersion) || metadata.protocolVersion < DEVICE_AGENT_PROTOCOL_VERSION) {
    throw new Error(`Geräte-Attestierung abgelehnt: Protokoll ${DEVICE_AGENT_PROTOCOL_VERSION} oder neuer ist erforderlich.`);
  }
  if (!metadata.iCloudAuthoritative || !isIcloudIvaWorkspace(metadata.workspace)) {
    throw new Error('Geräte-Attestierung abgelehnt: Der verbindliche IVA-iCloud-Workspace ist nicht aktiv.');
  }
  if (!metadata.release) throw new Error('Geräte-Attestierung abgelehnt: Die Agent-Version fehlt.');
}

function assertClaimingAgent(store, deviceId, input = {}) {
  const attested = store.agents?.[deviceId];
  if (!attested?.attested) return null; // Einmalige, rückwärtskompatible Migration bis zum ersten v2-iMac-Heartbeat.
  const metadata = normalizedAgentMetadata(input);
  assertAttestedImacMetadata(metadata);
  if (metadata.hostname !== attested.hostname) {
    throw new Error(`Geräte-Attestierung abgelehnt: ${metadata.hostname || 'unbekannter Rechner'} ist nicht der gebundene iMac.`);
  }
  // Die Positivliste wurde bereits über den signierten Heartbeat attestiert.
  // Der anschließende GET-Abruf enthält bewusst keinen JSON-Body und damit
  // keine allowedActions; verwende deshalb die zuletzt serverseitig gebundene
  // Liste, statt alle wartenden Befehle fälschlich zu blockieren.
  return { ...metadata, allowedActions: [...(attested.allowedActions || [])] };
}

export async function recordDeviceAgentHeartbeat({ deviceId = IVA_IMAC_DEVICE_ID, ...input } = {}) {
  return transaction(async () => {
    if (cleanText(deviceId, 80) !== IVA_IMAC_DEVICE_ID) throw new Error('Unbekanntes IVA-Gerät.');
    const metadata = normalizedAgentMetadata(input);
    assertAttestedImacMetadata(metadata);
    const store = await loadStore();
    const previous = store.agents?.[deviceId];
    if (previous?.attested && previous.hostname !== metadata.hostname) {
      throw new Error(`Geräte-Attestierung abgelehnt: Der Gerätekanal ist bereits an ${previous.hostname} gebunden.`);
    }
    const now = new Date().toISOString();
    store.agents = store.agents || {};
    store.agents[deviceId] = {
      deviceId,
      ...metadata,
      attested: true,
      firstAttestedAt: previous?.firstAttestedAt || now,
      lastPolledAt: previous?.lastPolledAt || null,
      lastSeenAt: now,
    };
    await saveStore(store);
    return { ...store.agents[deviceId], online: true };
  });
}

export async function deviceAgentStatus(deviceId = IVA_IMAC_DEVICE_ID) {
  const store = await loadStore();
  const agent = store.agents?.[cleanText(deviceId, 80)];
  if (!agent) {
    return {
      deviceId: IVA_IMAC_DEVICE_ID,
      attested: false,
      online: false,
      requiredProtocolVersion: DEVICE_AGENT_PROTOCOL_VERSION,
      detail: 'Der neue iMac-Agent hat sich noch nicht mit dem iCloud-Workspace attestiert.',
    };
  }
  const online = Date.now() - Date.parse(agent.lastSeenAt || 0) <= AGENT_ONLINE_MS;
  const dispatchReady = online && Date.now() - Date.parse(agent.lastPolledAt || 0) <= AGENT_ONLINE_MS;
  return {
    ...agent,
    online,
    dispatchReady,
    requiredProtocolVersion: DEVICE_AGENT_PROTOCOL_VERSION,
    detail: online ? (dispatchReady ? 'iMac verbunden; Befehlsabholung bestätigt.' : 'iMac verbunden; Befehlsabholung noch nicht bestätigt.') : 'Der attestierte iMac-Agent hat sich zuletzt nicht innerhalb von 60 Sekunden gemeldet.',
  };
}

function validatePayload(action, payload = {}) {
  if (action === 'planbar.customer.schedule') {
    const customerName = cleanText(payload.customerName, 220);
    const partnerId = cleanText(payload.partnerId, 80).toLowerCase();
    const partnerName = cleanText(payload.partnerName, 80);
    const partnerPrefix = cleanText(payload.partnerPrefix, 6).toUpperCase();
    const schedulingMode = payload.schedulingMode === 'enter-block-first' ? 'enter-block-first' : 'free-resource';
    const allowFreeResourceFallback = schedulingMode === 'enter-block-first' && payload.allowFreeResourceFallback === true;
    const isoYear = Number(payload.isoYear);
    const week = Number(payload.week);
    if (customerName.length < 3) throw new Error('Für die Planbar-Terminierung fehlt der vollständige Kundenname.');
    if (!partnerId || !partnerName || !/^[A-Z0-9]{1,6}$/.test(partnerPrefix)) {
      throw new Error('Für die Planbar-Terminierung fehlt ein gültiger Partner mit Planbar-Kürzel.');
    }
    if (!Number.isInteger(isoYear) || isoYear < 2000 || isoYear > 2100) throw new Error('Ungültiges ISO-Kalenderjahr.');
    if (!Number.isInteger(week) || week < 1 || week > 53) throw new Error('Ungültige ISO-Kalenderwoche.');
    if (typeof payload.materialDeliverySpace !== 'boolean' || typeof payload.theftWeatherProtected !== 'boolean') {
      throw new Error('Die beiden Materialfragen müssen vor der Planbar-Terminierung eindeutig mit Ja oder Nein beantwortet sein.');
    }
    const publicRequest = payload.source === 'public-heat-hero';
    if (publicRequest && (partnerId !== 'heat-hero' || partnerPrefix !== 'HH' || schedulingMode !== 'free-resource'
      || !cleanText(payload.objectLocation, 180))) throw new Error('Öffentliche Anfragen sind ausschließlich für Heat Hero zulässig.');
    return {
      customerName,
      partnerId,
      partnerName,
      partnerPrefix,
      schedulingMode,
      allowFreeResourceFallback,
      isoYear,
      requestId: cleanText(payload.requestId, 100),
      week,
      materialDeliverySpace: payload.materialDeliverySpace,
      theftWeatherProtected: payload.theftWeatherProtected,
      additionalInfo: cleanText(payload.additionalInfo, 2000),
      ...(publicRequest ? { source: 'public-heat-hero', firstName: cleanText(payload.firstName, 100),
        lastName: cleanText(payload.lastName, 100), objectLocation: cleanText(payload.objectLocation, 180) } : {}),
    };
  }
  if (action === 'project.workflow.run') {
    const projectId = cleanText(payload.projectId, 100);
    const workflowId = cleanText(payload.workflowId, 140);
    const heatHeroAllowed = new Set(['funding-daily-sequence', 'funding-monitor', 'kfw-funding-amount-morning', 'kfw-approval-morning', 'planbar-weekly-export', 'planbar-completion-morning', 'montage-required-fields-morning', 'manufacturer-leads-wattfox', 'installation-plan-material-list']);
    const dewarmteAllowed = projectId === 'dewarmte' && workflowId === 'dewarmte-link-to-material-pdf';
    if (!(projectId === 'heat-hero' && heatHeroAllowed.has(workflowId)) && !dewarmteAllowed) {
      throw new Error('Dieser Projekt-Workflow ist für den manuellen iMac-Start nicht freigegeben.');
    }
    const dewarmteInput = dewarmteAllowed ? validateDewarmteLinkPdfInput(payload) : null;
    return {
      projectId,
      workflowId,
      displayName: cleanText(payload.displayName, 220) || workflowId,
      ...(cleanText(payload.requestId, 160) ? { requestId: cleanText(payload.requestId, 160) } : {}),
      runMode: payload.runMode === 'automatic' ? 'automatic' : 'manual',
      ...(payload.runMode === 'automatic' && cleanText(payload.automationSlotKey, 180)
        ? { automationSlotKey: cleanText(payload.automationSlotKey, 180) }
        : {}),
      ...(dewarmteInput || {}),
    };
  }
  if (action === 'portal.credentials.status' || action === 'portal.login') {
    const service = cleanText(payload.service, 40).toLowerCase();
    if (!['panasonic', 'bosch', 'pipedrive', 'airtable', 'planbar'].includes(service)) {
      throw new Error('Dieser Portalzugang ist für die iMac-Anmeldung nicht freigegeben.');
    }
    return { service };
  }
  if (action === 'knowledge.import.start') {
    const importId = cleanText(payload.importId, 80);
    const entryId = cleanText(payload.entryId, 80);
    const title = cleanText(payload.title, 240);
    const credentialProfileId = cleanText(payload.credentialProfileId, 80).toLowerCase();
    let sourceUrl;
    try { sourceUrl = new URL(cleanText(payload.sourceUrl, 1800)); } catch { throw new Error('Ungültige Kursadresse.'); }
    if (!/^[a-f0-9-]{36}$/i.test(importId) || !/^[a-f0-9-]{36}$/i.test(entryId) || !title) throw new Error('Der Wissensimport ist unvollständig.');
    if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password) throw new Error('Der Wissensimport benötigt HTTPS.');
    const expectedProfileId = `course-${crypto.createHash('sha256').update(sourceUrl.hostname.toLowerCase()).digest('hex').slice(0, 18)}`;
    if (credentialProfileId !== expectedProfileId) throw new Error('Das Kurs-Zugangsprofil passt nicht zur Kursadresse.');
    const mode = payload.mode === 'iva-drive' ? 'iva-drive' : 'iva-only';
    return {
      importId,
      entryId,
      title,
      sourceUrl: sourceUrl.toString(),
      mode,
      accessMode: payload.accessMode === 'purchase-needed' ? 'purchase-needed' : 'existing',
      archiveFolderUrl: mode === 'iva-drive' ? cleanText(payload.archiveFolderUrl, 1800) : '',
      credentialProfileId,
      credentialEnvelope: validateCredentialEnvelope(payload.credentialEnvelope),
      attempt: Math.max(1, Math.min(20, Number(payload.attempt) || 1)),
      requestId: cleanText(payload.requestId || `knowledge-import:${importId}:${Number(payload.attempt) || 1}`, 160),
    };
  }
  if (action === 'app.open') {
    const app = cleanText(payload.app, 80);
    if (!['Microsoft Outlook', 'Google Chrome', 'WhatsApp', 'Codex', 'ChatGPT'].includes(app)) {
      throw new Error('Diese App ist für die iMac-Fernsteuerung nicht freigegeben.');
    }
    return { app };
  }
  if (action === 'codex.task.start') {
    const prompt = cleanText(payload.prompt, 12_000);
    if (prompt.length < 10) throw new Error('Der Codex-Auftrag ist zu kurz.');
    return {
      prompt,
      title: cleanText(payload.title || 'IVA-Bauauftrag', 180),
      requestId: cleanText(payload.requestId, 100),
      mode: payload.mode === 'operational' ? 'operational' : 'build',
      acceptanceCriteria: (Array.isArray(payload.acceptanceCriteria) ? payload.acceptanceCriteria : [])
        .map(value => cleanText(value, 500)).filter(Boolean).slice(0, 12),
    };
  }
  if (action === 'codex.task.status') {
    const jobId = cleanText(payload.jobId, 80);
    if (!/^[a-f0-9-]{20,80}$/i.test(jobId)) throw new Error('Ungültige Codex-Auftrags-ID.');
    return { jobId };
  }
  return {};
}

export async function enqueueDeviceCommand({ deviceId = IVA_IMAC_DEVICE_ID, action, payload = {}, requestedBy = 'iva', requestText = '' } = {}) {
  return transaction(async () => {
    const device = cleanText(deviceId, 80);
    const actionName = cleanText(action, 100);
    if (device !== IVA_IMAC_DEVICE_ID) throw new Error('Unbekanntes IVA-Gerät.');
    if (!DEVICE_ACTIONS[actionName]) throw new Error('Diese iMac-Aktion ist nicht freigegeben.');
    const normalizedPayload = validatePayload(actionName, payload);
    const now = new Date();
    const store = await loadStore();
    if (actionName === 'codex.task.start' && normalizedPayload.requestId) {
      const existing = store.commands.find(item => item.deviceId === device
        && item.action === actionName
        && ['queued', 'running'].includes(item.status)
        && Date.parse(item.expiresAt) > now.getTime()
        && item.payload?.requestId === normalizedPayload.requestId);
      if (existing) return { ...existing };
    }
    if (actionName === 'knowledge.import.start' && normalizedPayload.requestId) {
      const existing = store.commands.find(item => item.deviceId === device
        && item.action === actionName
        && item.payload?.requestId === normalizedPayload.requestId
        && Date.parse(item.expiresAt) > now.getTime());
      if (existing) return { ...existing };
    }
    if (actionName === 'planbar.search.refresh') {
      const existing = store.commands.find(item => item.deviceId === device
        && item.action === actionName
        && ['queued', 'running'].includes(item.status)
        && Date.parse(item.expiresAt) > now.getTime());
      if (existing) return { ...existing };
    }
    if (actionName === 'planbar.customer.schedule' || actionName === 'project.workflow.run') {
      // Eine Outbox-Wiederholung nach einem Serverabbruch muss auch einen schon
      // abgeschlossenen Auftrag wiederfinden, nicht erneut ausführen.
      const sameRequest = normalizedPayload.requestId && store.commands.find(item => item.deviceId === device
        && item.action === actionName && item.payload?.requestId === normalizedPayload.requestId);
      if (sameRequest) return { ...sameRequest };
      const fingerprint = JSON.stringify({ ...normalizedPayload, requestId: undefined });
      const existing = store.commands.find(item => item.deviceId === device
        && item.action === actionName
        && ['queued', 'running'].includes(item.status)
        && Date.parse(item.expiresAt) > now.getTime()
        && JSON.stringify({ ...item.payload, requestId: undefined }) === fingerprint);
      if (existing) return { ...existing };
    }
    const command = {
      id: crypto.randomUUID(),
      deviceId: device,
      action: actionName,
      payload: normalizedPayload,
      status: 'queued',
      requestedBy: cleanText(requestedBy, 120) || 'iva',
      requestText: cleanText(requestText, 500),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (DEVICE_ACTIONS[actionName].requiresAttestedAgent ? DEFERRED_IMAC_COMMAND_TTL_MS : DEFAULT_TTL_MS)).toISOString(),
      attempts: 0,
    };
    store.commands.push(command);
    await saveStore(store);
    return command;
  });
}

export async function claimNextDeviceCommand(deviceId = IVA_IMAC_DEVICE_ID, agentMetadata = {}) {
  return transaction(async () => {
    const store = await loadStore();
    const claimingAgent = assertClaimingAgent(store, deviceId, agentMetadata);
    const now = Date.now();
    let changed = false;
    if (claimingAgent) {
      store.agents[deviceId].lastPolledAt = new Date(now).toISOString();
      changed = true;
    }
    for (const command of store.commands) {
      if (command.status === 'queued' && Date.parse(command.expiresAt) <= now) {
        command.status = 'expired';
        command.completedAt = new Date().toISOString();
        changed = true;
      }
      if (command.status === 'running' && Date.parse(command.leaseExpiresAt || 0) <= now) {
        const uncertainMutation = DEVICE_ACTIONS[command.action]?.mutating === true && command.action !== 'knowledge.import.start';
        command.status = uncertainMutation || command.attempts >= 3 ? 'failed' : 'queued';
        if (uncertainMutation) {
          command.error = 'Ausführung nach Verbindungsabbruch unklar. Keine automatische Wiederholung einer schreibenden Aktion; Ergebnis zuerst prüfen.';
          command.completedAt = new Date(now).toISOString();
        }
        delete command.leaseToken;
        delete command.leaseExpiresAt;
        changed = true;
      }
    }
    const command = store.commands.find(item => item.deviceId === deviceId
      && item.status === 'queued'
      && (!item.retryAt || Date.parse(item.retryAt) <= now)
      // The Planbar search refresh reads the live tooltip endpoint for an
      // explicit range without steering or reloading the shared UI. It is safe
      // to claim while another workflow owns the UI lock; scheduling and every
      // other UI-writing action remain blocked here.
      && (!claimingAgent?.uiBusy || ['agent.status', 'codex.task.status', 'funding.monitor.status', 'funding.reviews.list', 'portal.credentials.status', 'planbar.search.refresh'].includes(item.action))
      && (!DEVICE_ACTIONS[item.action]?.requiresAttestedAgent
        || (claimingAgent && claimingAgent.allowedActions.includes(item.action))));
    if (!command) {
      if (changed) await saveStore(store);
      return null;
    }
    command.status = 'running';
    command.startedAt = new Date().toISOString();
    command.attempts = Number(command.attempts || 0) + 1;
    command.leaseToken = crypto.randomBytes(24).toString('hex');
    command.leaseExpiresAt = new Date(Date.now() + LEASE_MS).toISOString();
    if (claimingAgent) command.claimedBy = claimingAgent;
    await saveStore(store);
    return { ...command };
  });
}

export async function completeDeviceCommand({ deviceId, commandId, leaseToken, ok, result = null, error = '', failureStage = '', agentMetadata = {} } = {}) {
  return transaction(async () => {
    const store = await loadStore();
    const command = store.commands.find(item => item.id === String(commandId) && item.deviceId === String(deviceId));
    if (!command || command.status !== 'running') throw new Error('Aktiver iMac-Befehl wurde nicht gefunden.');
    if (!leaseToken || leaseToken !== command.leaseToken) throw new Error('iMac-Befehlslease ist ungültig.');
    if (command.claimedBy) {
      const completingAgent = assertClaimingAgent(store, deviceId, agentMetadata);
      if (!completingAgent || completingAgent.hostname !== command.claimedBy.hostname) {
        throw new Error('Geräte-Attestierung abgelehnt: Der Befehl darf nur vom attestierten iMac abgeschlossen werden.');
      }
    }
    command.status = ok === true ? 'completed' : 'failed';
    command.completedAt = new Date().toISOString();
    command.result = ok === true ? result : null;
    command.error = ok === true ? null : cleanText(error, 1000);
    // Ausschließlich attestierte Vorstartfehler: niemals unklare Schreibaktionen,
    // Lease-Verluste oder fachlich blockierte Workflows automatisch wiederholen.
    const knowledgeExternalBlocker = command.action === 'knowledge.import.start'
      && /captcha|konto(?:sperre| gesperrt)|account locked|externe best[aä]tigung|purchase|bezahlung|buchung/i.test(String(error || ''));
    const retryKnowledgeImport = ok !== true && command.action === 'knowledge.import.start' && command.claimedBy
      && !knowledgeExternalBlocker && command.attempts < 3 && Date.parse(command.expiresAt) > Date.now() + 60_000;
    const retryPlanbarBeforeLaunch = ok !== true && command.action === 'planbar.customer.schedule' && command.claimedBy
      && failureStage === 'before_launch' && command.attempts < 3 && Date.parse(command.expiresAt) > Date.now() + 60_000;
    if (retryPlanbarBeforeLaunch || retryKnowledgeImport) {
      command.status = 'queued';
      command.retryAt = new Date(Date.now() + command.attempts * 15_000).toISOString();
      command.failureStage = command.action === 'knowledge.import.start' ? 'automatic-recovery' : 'before_launch';
      delete command.completedAt;
    } else {
      delete command.retryAt;
      if (command.action === 'knowledge.import.start' && command.payload?.credentialEnvelope) {
        delete command.payload.credentialEnvelope;
        command.credentialsPurgedAt = new Date().toISOString();
      }
    }
    delete command.leaseToken;
    delete command.leaseExpiresAt;
    await saveStore(store);
    return { ...command };
  });
}

export async function cancelDeviceCommand({ deviceId = IVA_IMAC_DEVICE_ID, commandId, reason = '' } = {}) {
  return transaction(async () => {
    const store = await loadStore();
    const command = store.commands.find(item => item.id === String(commandId) && item.deviceId === String(deviceId));
    if (!command) throw new Error('iMac-Befehl wurde nicht gefunden.');
    if (command.status !== 'queued') {
      throw new Error(`Nur ein wartender iMac-Befehl kann abgebrochen werden (Status: ${command.status}).`);
    }
    command.status = 'canceled';
    command.completedAt = new Date().toISOString();
    command.cancelReason = cleanText(reason, 500) || 'Vom Auftraggeber vor Ausführung abgebrochen.';
    await saveStore(store);
    const { leaseToken, ...safe } = command;
    return safe;
  });
}

export async function listDeviceCommands({ deviceId = IVA_IMAC_DEVICE_ID, limit = 50 } = {}) {
  const store = await loadStore();
  return store.commands
    .filter(command => !deviceId || command.deviceId === deviceId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(MAX_COMMANDS, Number(limit) || 50)))
    .map(({ leaseToken, ...command }) => ({
      ...command,
      payload: command.payload?.credentialEnvelope
        ? { ...command.payload, credentialEnvelope: { encrypted: true, version: command.payload.credentialEnvelope.version } }
        : command.payload,
    }));
}

export async function cleanupExpiredDewarmteCommandInputs({ now = Date.now() } = {}) {
  return transaction(async () => {
    const store = await loadStore();
    let redacted = 0;
    for (const command of store.commands) {
      if (command?.action !== 'project.workflow.run' || command.payload?.projectId !== 'dewarmte'
        || now - Date.parse(command.createdAt) < DEWARMTE_INPUT_RETENTION_MS || command.inputPurgedAt) continue;
      delete command.payload.sourceUrl;
      delete command.payload.supplementaryText;
      delete command.payload.supplementaryPdfId;
      delete command.payload.supplementaryPdfName;
      delete command.payload.recipientEmail;
      command.inputPurgedAt = new Date(now).toISOString();
      redacted += 1;
    }
    if (redacted) await saveStore(store);
    return { redacted, retentionDays: 3 };
  });
}

export async function deviceCommandStatus(commandId) {
  const store = await loadStore();
  const command = store.commands.find(item => item.id === String(commandId));
  if (!command) return null;
  const { leaseToken, ...safe } = command;
  return safe;
}
