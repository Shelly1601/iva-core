import os from 'node:os';
import path from 'node:path';
import { access, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFundingCaseReference } from './funding.mjs';
import {
  DIRECT_SALES_WHATSAPP_GROUP,
  cleanDirectSalesMemberName,
  saveDirectSalesRoster,
} from './direct-sales-roster.mjs';

const WHATSAPP_APP = '/Applications/WhatsApp.app';
const KEYCHAIN_SERVICE = 'de.iva.funding.whatsapp';
const KEYCHAIN_ACCOUNT = 'viktoria-lambel';
const PROBE_SOURCE = fileURLToPath(new URL('./macos/iva-whatsapp-probe.swift', import.meta.url));
const PROBE_BINARY = path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper', 'bin', 'iva-whatsapp-probe');
export const FUNDING_HANDOFF_RECIPIENT = 'Viktoria Lambel';

function commandSucceeds(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || stdout || 'Befehl nicht verfügbar.').trim())));
  });
}

export function normalizeWhatsAppPhone(value) {
  let digits = String(value || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  if (digits.startsWith('0')) digits = `+49${digits.slice(1)}`;
  if (!digits.startsWith('+')) digits = `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(digits)) throw new Error('Viktorias WhatsApp-Nummer fehlt oder ist nicht im gültigen internationalen Format.');
  return digits;
}

export function buildFundingHandoffWhatsApp({ customerName, orderNumber, location, city, phone, decision, stageTransitionVerified = false } = {}) {
  const reference = buildFundingCaseReference({ customerName, orderNumber, location, city });
  if (!reference.orderNumber) throw new Error('WhatsApp-Übergabe gesperrt: Die Auftragsnummer fehlt.');
  if (!decision?.documentsCompleteInPipedrive) {
    throw new Error('WhatsApp-Übergabe gesperrt: Die Pflichtunterlagen sind noch nicht vollständig in Pipedrive verifiziert.');
  }
  if (decision.stage?.key === 'documents' && !stageTransitionVerified) {
    throw new Error('WhatsApp-Übergabe gesperrt: Die Verschiebung nach „Förderung beantragt“ wurde noch nicht verifiziert.');
  }
  if (!['documents', 'fundingRequested'].includes(decision.stage?.key)) {
    throw new Error('WhatsApp-Übergabe gesperrt: unbekannte Pipedrive-Stufe.');
  }
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const text = `${reference.customerName} ${reference.orderNumber} fertig`;
  return {
    recipientName: FUNDING_HANDOFF_RECIPIENT,
    phone: normalizedPhone,
    text,
    reference,
    url: `whatsapp://send?phone=${normalizedPhone.slice(1)}&text=${encodeURIComponent(text)}`,
    ready: true,
    sent: false,
  };
}

export async function readFundingHandoffPhoneFromKeychain() {
  const phone = await commandOutput('/usr/bin/security', [
    'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w',
  ]);
  return normalizeWhatsAppPhone(phone);
}

async function ensureWhatsAppProbe() {
  let compile = true;
  try {
    const [source, binary] = await Promise.all([stat(PROBE_SOURCE), stat(PROBE_BINARY)]);
    compile = source.mtimeMs > binary.mtimeMs;
  } catch {}
  if (compile) {
    await mkdir(path.dirname(PROBE_BINARY), { recursive: true, mode: 0o700 });
    await commandOutput('/usr/bin/swiftc', [PROBE_SOURCE, '-o', PROBE_BINARY]);
  }
  return PROBE_BINARY;
}

export async function probeWhatsAppMacLink() {
  const binary = await ensureWhatsAppProbe();
  return JSON.parse(await commandOutput(binary, []));
}

async function runWhatsAppProbe(args = []) {
  const binary = await ensureWhatsAppProbe();
  return JSON.parse(await commandOutput(binary, args));
}

function participantsFromDump(dump) {
  return (dump?.textNodes || [])
    .filter(node => {
      const actions = Array.isArray(node?.actions) ? node.actions : [];
      const frame = node?.frame || {};
      return node?.role === 'AXButton'
        && (actions.includes('AXScrollDownByPage') || actions.includes('AXScrollUpByPage'))
        && Number(frame.x) > 650
        && Number(frame.y) > 330
        && Number(frame.width) > 350
        && Number(frame.height) > 30
        && Number(frame.height) < 100;
    })
    .map(node => cleanDirectSalesMemberName(node.description))
    .filter(Boolean);
}

function dumpShowsActiveChat(dump, chatName) {
  const normalizeChatName = value => String(value || '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('de');
  const expected = normalizeChatName(chatName);
  return (dump?.textNodes || []).some(node =>
    node?.identifier === 'NavigationBar_HeaderViewButton'
    && normalizeChatName(node.description) === expected);
}

export async function sendExactWhatsAppGroupMessage({
  chatName,
  message,
  expectedInfoMarker = 'Heat Hero',
} = {}) {
  const expectedChat = String(chatName || '').trim();
  const exactMessage = String(message || '').trim();
  const infoMarker = String(expectedInfoMarker || '').trim().toLocaleLowerCase('de');
  if (!expectedChat || !exactMessage) throw new Error('WhatsApp-Gruppe und Nachricht müssen vollständig angegeben sein.');
  const diagnosis = await diagnoseWhatsAppMac();
  if (!diagnosis.installed || !diagnosis.running || !diagnosis.linkedAccountVerified) {
    throw new Error('Die native WhatsApp-App ist nicht vollständig geöffnet und verknüpft.');
  }
  for (let index = 0; index < 3; index += 1) {
    const closed = await runWhatsAppProbe(['--press-description', 'Fertig']).then(() => true).catch(() => false);
    if (!closed) break;
  }
  let dump = await runWhatsAppProbe(['--dump']);
  if (!dumpShowsActiveChat(dump, expectedChat)) {
    await runWhatsAppProbe(['--open-chat', expectedChat]);
    dump = await runWhatsAppProbe(['--dump']);
  }
  if (!dumpShowsActiveChat(dump, expectedChat)) throw new Error(`Die WhatsApp-Gruppe „${expectedChat}“ ist nicht eindeutig aktiv.`);
  await runWhatsAppProbe(['--press-identifier', 'NavigationBar_HeaderViewButton']);
  const info = await runWhatsAppProbe(['--dump']);
  const infoText = (info.textNodes || []).map(node => `${node?.description || ''} ${node?.value || ''}`).join(' ').toLocaleLowerCase('de');
  if (infoMarker && !infoText.includes(infoMarker)) {
    await runWhatsAppProbe(['--press-description', 'Fertig']).catch(() => {});
    throw new Error(`Die aktive WhatsApp-Gruppe konnte nicht dem erwarteten Bereich „${expectedInfoMarker}“ zugeordnet werden.`);
  }
  await runWhatsAppProbe(['--press-description', 'Fertig']);
  await new Promise(resolve => setTimeout(resolve, 1400));
  const result = await runWhatsAppProbe(['--send-message', expectedChat, exactMessage]);
  if (result.verified !== true) throw new Error(result.error || 'Die WhatsApp-Nachricht wurde nicht sichtbar verifiziert.');
  return {
    chatName: expectedChat,
    message: exactMessage,
    sent: result.sent === true,
    idempotent: result.idempotent === true,
    verified: true,
    evidence: result.evidence || 'Nachricht bereits sichtbar vorhanden.',
    nativeApp: true,
  };
}

export async function syncDirectSalesRosterFromWhatsApp({ persist = true } = {}) {
  for (let index = 0; index < 3; index += 1) {
    const closed = await runWhatsAppProbe(['--press-description', 'Fertig'])
      .then(() => true)
      .catch(() => false);
    if (!closed) break;
  }
  const initialDump = await runWhatsAppProbe(['--dump']);
  if (!dumpShowsActiveChat(initialDump, DIRECT_SALES_WHATSAPP_GROUP)) {
    await runWhatsAppProbe(['--open-chat', DIRECT_SALES_WHATSAPP_GROUP]);
  }
  await runWhatsAppProbe(['--press-identifier', 'NavigationBar_HeaderViewButton']);
  await runWhatsAppProbe(['--press-description', 'Mitglieder']);
  await runWhatsAppProbe(['--scroll-members', '10']).catch(() => {});

  const members = new Set();
  let unchangedPages = 0;
  for (let page = 0; page < 16 && unchangedPages < 4; page += 1) {
    const dump = await runWhatsAppProbe(['--dump']);
    const before = members.size;
    for (const name of participantsFromDump(dump)) members.add(name);
    unchangedPages = members.size === before ? unchangedPages + 1 : 0;
    if (page < 15 && unchangedPages < 4) {
      await runWhatsAppProbe(['--scroll-members', '-1']).catch(() => { unchangedPages = 4; });
    }
  }
  await runWhatsAppProbe(['--press-description', 'Fertig']).catch(() => {});
  if (!persist) return { groupName: DIRECT_SALES_WHATSAPP_GROUP, members: [...members], persisted: false };
  return saveDirectSalesRoster([...members], { groupName: DIRECT_SALES_WHATSAPP_GROUP, sourceMemberCount: 27 });
}

export async function diagnoseWhatsAppMac() {
  let installed = true;
  try { await access(WHATSAPP_APP); }
  catch { installed = false; }
  const running = installed && await commandSucceeds('/usr/bin/pgrep', ['-x', 'WhatsApp']);
  const recipientConfigured = await commandSucceeds('/usr/bin/security', [
    'find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE,
  ]);
  let uiProbe = { linkedLikely: false, hasQrIndicator: false, hasLoginIndicator: false };
  if (running) {
    try { uiProbe = await probeWhatsAppMacLink(); }
    catch {}
  }
  const linkedAccountVerified = Boolean(uiProbe.linkedLikely);
  return {
    installed,
    running,
    bundleId: 'net.whatsapp.WhatsApp',
    recipientName: FUNDING_HANDOFF_RECIPIENT,
    recipientConfigured,
    linkedAccountVerified,
    outboundReady: false,
    uiState: {
      chatInterfaceVisible: linkedAccountVerified,
      qrVisible: Boolean(uiProbe.hasQrIndicator),
      loginVisible: Boolean(uiProbe.hasLoginIndicator),
    },
    required: installed
      ? [
          ...(linkedAccountVerified ? [] : ['WhatsApp Business mit der Mac-App verknüpfen']),
          ...(recipientConfigured ? [] : ['Viktorias exakte Mobilnummer einmalig verifizieren']),
          'Testnachricht kontrollieren',
        ]
      : ['WhatsApp aus dem Mac App Store installieren'],
  };
}
