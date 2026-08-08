import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const WHATSAPP_APP = '/Applications/WhatsApp.app';
export const FUNDING_HANDOFF_RECIPIENT = 'Viktoria Lambel';

function commandSucceeds(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
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

export function buildFundingHandoffWhatsApp({ customerName, orderNumber, phone, decision, stageTransitionVerified = false } = {}) {
  const customer = String(customerName || '').replace(/\s+/g, ' ').trim();
  const order = String(orderNumber || '').replace(/\s+/g, ' ').trim();
  if (!customer) throw new Error('Für die WhatsApp-Übergabe fehlt der Kundenname.');
  if (!order) throw new Error('Für die WhatsApp-Übergabe fehlt die Auftragsnummer.');
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
  const text = `${customer} - ${order} ist fertig`;
  return {
    recipientName: FUNDING_HANDOFF_RECIPIENT,
    phone: normalizedPhone,
    text,
    url: `whatsapp://send?phone=${normalizedPhone.slice(1)}&text=${encodeURIComponent(text)}`,
    ready: true,
    sent: false,
  };
}

export async function diagnoseWhatsAppMac() {
  let installed = true;
  try { await access(WHATSAPP_APP); }
  catch { installed = false; }
  const running = installed && await commandSucceeds('/usr/bin/pgrep', ['-x', 'WhatsApp']);
  return {
    installed,
    running,
    bundleId: 'net.whatsapp.WhatsApp',
    linkedAccountVerified: false,
    outboundReady: false,
    required: installed
      ? ['WhatsApp Business mit der Mac-App verknüpfen', 'Viktorias exakte Mobilnummer einmalig verifizieren', 'Testnachricht kontrollieren']
      : ['WhatsApp aus dem Mac App Store installieren'],
  };
}
