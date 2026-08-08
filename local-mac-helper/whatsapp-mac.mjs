import os from 'node:os';
import path from 'node:path';
import { access, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFundingCaseReference } from './funding.mjs';

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
    child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error((stderr || 'Schlüsselbund-Eintrag nicht verfügbar.').trim())));
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
  const text = `${reference.text} ist fertig`;
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
