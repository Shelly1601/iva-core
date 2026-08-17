import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MANUFACTURER_LEAD_CONFIG_PATH = path.join(MODULE_DIR, 'manufacturer-lead-config.json');
export const DEFAULT_MANUFACTURER_LEAD_STATE_PATH = path.join(
  process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
  'manufacturer-lead-state.json',
);

const MODES = new Set(['observe-only', 'dry-run', 'live']);
const OUTSIDE_ACTIONS = new Set(['manual', 'reject']);
const ACTIVATION_CHECKS = [
  'passwordsRotated',
  'correctIMacConfirmed',
  'outlookPrepared',
  'browserTabsPrepared',
  'enteAuthPrepared',
  'dryRunApproved',
];

function compact(value) {
  return String(value || '').trim();
}

function normalize(value) {
  return compact(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('de-DE')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(compact).filter(Boolean))];
}

export async function loadManufacturerLeadConfig(configPath = DEFAULT_MANUFACTURER_LEAD_CONFIG_PATH) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return validateManufacturerLeadConfig(config);
}

export function validateManufacturerLeadConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Hersteller-Lead-Konfiguration fehlt.');
  if (config.version !== 1) throw new Error('Unbekannte Hersteller-Lead-Konfigurationsversion.');
  if (!MODES.has(config.mode)) throw new Error('Modus muss observe-only, dry-run oder live sein.');
  if (!OUTSIDE_ACTIONS.has(config.territories?.outsideAreaAction)) throw new Error('outsideAreaAction muss manual oder reject sein.');
  if (compact(config.accounts?.heatHeroEmail).toLowerCase() !== 'n.sell@heat-hero.com') {
    throw new Error('Das HeatHero-Konto muss exakt n.sell@heat-hero.com sein.');
  }
  if (compact(config.enteAuth?.entryName).toLowerCase() !== 'promatch') throw new Error('Der Ente-Auth-Eintrag muss exakt ProMatch heißen.');
  if (compact(config.enteAuth?.account).toLowerCase() !== 'n.sell@heat-hero.com') {
    throw new Error('Das Ente-Auth-Konto muss exakt n.sell@heat-hero.com sein.');
  }
  const forbidden = uniqueStrings(config.enteAuth?.forbiddenAccountMarkers).map(normalize);
  if (!forbidden.includes(normalize('A.Lausig'))) throw new Error('Der Schutz gegen das falsche ProMatch-Konto A.Lausig fehlt.');
  if (config.wattfox?.crmUpdatesAllowed !== false) throw new Error('Wattfox-CRM-Änderungen müssen bis zur separaten Freigabe ausgeschaltet bleiben.');

  const serialized = JSON.stringify(config).toLowerCase();
  for (const marker of ['password', 'passwort', 'totpsecret', 'otpsecret', 'recoverycode']) {
    if (serialized.includes(`\"${marker}\"`)) throw new Error('Zugangsdaten dürfen nicht in der Konfiguration stehen.');
  }
  return config;
}

export function getManufacturerLeadReadiness(config) {
  validateManufacturerLeadConfig(config);
  const blockers = [];
  const activation = config.activation || {};
  const territories = config.territories || {};
  const hasAcceptedArea = uniqueStrings(territories.acceptedPostalCodes).length
    || uniqueStrings(territories.acceptedPostalCodePrefixes).length
    || uniqueStrings(territories.acceptedCities).length;

  if (!config.enabled) blockers.push('Automatik ist noch deaktiviert.');
  if (config.mode !== 'live') blockers.push('Modus ist noch nicht live.');
  if (!hasAcceptedArea) blockers.push('Es sind noch keine Annahmegebiete hinterlegt.');
  for (const check of ACTIVATION_CHECKS) {
    if (activation[check] !== true) blockers.push(`Aktivierungsprüfung fehlt: ${check}.`);
  }

  return {
    ready: blockers.length === 0,
    mode: config.mode,
    enabled: config.enabled === true,
    outsideAreaAction: territories.outsideAreaAction,
    blockers,
    safeguards: {
      ambiguousAddressAction: 'manual',
      duplicateAction: 'skip',
      otpLogging: false,
      wattfoxCrmUpdates: false,
    },
  };
}

export function classifyManufacturerLeadAddress(address, config) {
  validateManufacturerLeadConfig(config);
  const rawAddress = compact(address);
  if (!rawAddress) return { decision: 'manual', reason: 'Adresse fehlt.' };

  const territories = config.territories || {};
  const normalizedAddress = normalize(rawAddress);
  const postalCode = rawAddress.match(/(?:^|\D)(\d{5})(?:\D|$)/)?.[1] || null;
  const acceptedPostalCodes = uniqueStrings(territories.acceptedPostalCodes);
  const acceptedPrefixes = uniqueStrings(territories.acceptedPostalCodePrefixes);
  const acceptedCities = uniqueStrings(territories.acceptedCities).map(normalize);
  const excludedPostalCodes = new Set(uniqueStrings(territories.excludedPostalCodes));

  if (postalCode && excludedPostalCodes.has(postalCode)) {
    return territories.outsideAreaAction === 'reject'
      ? { decision: 'reject', reason: `PLZ ${postalCode} ist ausdrücklich ausgeschlossen.`, postalCode }
      : { decision: 'manual', reason: `PLZ ${postalCode} ist ausgeschlossen; automatische Ablehnung ist nicht freigegeben.`, postalCode };
  }

  const postalCodeMatch = postalCode && (
    acceptedPostalCodes.includes(postalCode)
    || acceptedPrefixes.some(prefix => postalCode.startsWith(prefix))
  );
  const cityMatch = acceptedCities.find(city => new RegExp(`(?:^| )${city}(?: |$)`).test(normalizedAddress));
  if (postalCodeMatch || cityMatch) {
    return {
      decision: 'accept',
      reason: postalCodeMatch ? `PLZ ${postalCode} liegt im Annahmegebiet.` : `Ort ${cityMatch} liegt im Annahmegebiet.`,
      postalCode,
    };
  }

  if (!postalCode && !cityMatch) return { decision: 'manual', reason: 'Adresse enthält keine eindeutig prüfbare PLZ oder freigegebene Stadt.' };
  if (territories.outsideAreaAction === 'reject') {
    return { decision: 'reject', reason: `PLZ ${postalCode} liegt außerhalb der freigegebenen Gebiete.`, postalCode };
  }
  return { decision: 'manual', reason: `PLZ ${postalCode} liegt nicht im Annahmegebiet; automatische Ablehnung ist nicht freigegeben.`, postalCode };
}

export function manufacturerLeadFingerprint(input) {
  const stable = [
    normalize(input?.source),
    normalize(input?.externalId),
    normalize(input?.address),
    normalize(input?.receivedAt),
  ].join('|');
  if (!stable.replace(/\|/g, '')) throw new Error('Für den Fingerprint fehlen Quelldaten.');
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function emptyState() {
  return { version: 1, manufacturerLeads: [], wattfoxMessages: [] };
}

export async function loadManufacturerLeadState(statePath = DEFAULT_MANUFACTURER_LEAD_STATE_PATH) {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (state?.version !== 1) throw new Error('Unbekannte Hersteller-Lead-Statusversion.');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

async function saveState(state, statePath) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, statePath);
}

export async function recordManufacturerOperation(input, options = {}) {
  const statePath = options.statePath || DEFAULT_MANUFACTURER_LEAD_STATE_PATH;
  const type = compact(input?.type);
  if (!['manufacturerLead', 'wattfoxMessage'].includes(type)) throw new Error('Ergebnistyp muss manufacturerLead oder wattfoxMessage sein.');
  const state = await loadManufacturerLeadState(statePath);
  const now = compact(input.timestamp) || new Date().toISOString();

  if (type === 'manufacturerLead') {
    const fingerprint = compact(input.fingerprint) || manufacturerLeadFingerprint(input);
    if (state.manufacturerLeads.some(item => item.fingerprint === fingerprint)) {
      return { recorded: false, duplicate: true, fingerprint };
    }
    state.manufacturerLeads.push({
      fingerprint,
      timestamp: now,
      source: compact(input.source),
      externalId: compact(input.externalId),
      customerName: compact(input.customerName),
      address: compact(input.address),
      decision: compact(input.decision) || 'manual',
      portalAction: compact(input.portalAction),
      crmStatus: compact(input.crmStatus),
      salespersonAssigned: input.salespersonAssigned === true,
      salespersonName: compact(input.salespersonName),
      note: compact(input.note),
    });
    state.manufacturerLeads = state.manufacturerLeads.slice(-5000);
    await saveState(state, statePath);
    return { recorded: true, duplicate: false, fingerprint };
  }

  const fingerprint = compact(input.fingerprint) || crypto.createHash('sha256').update([
    normalize(input.folder),
    normalize(input.messageId),
    normalize(input.subject),
    normalize(input.receivedAt),
  ].join('|')).digest('hex');
  if (state.wattfoxMessages.some(item => item.fingerprint === fingerprint)) {
    return { recorded: false, duplicate: true, fingerprint };
  }
  state.wattfoxMessages.push({
    fingerprint,
    timestamp: now,
    folder: compact(input.folder),
    messageId: compact(input.messageId),
    subject: compact(input.subject),
    receivedAt: compact(input.receivedAt),
    customerReference: compact(input.customerReference),
    category: compact(input.category),
    outcome: compact(input.outcome),
    requiresFollowUp: input.requiresFollowUp === true,
    note: compact(input.note),
  });
  state.wattfoxMessages = state.wattfoxMessages.slice(-10000);
  await saveState(state, statePath);
  return { recorded: true, duplicate: false, fingerprint };
}

function berlinDate(value = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}

export function buildManufacturerOperationsReport(state, options = {}) {
  const endDate = options.endDate || berlinDate();
  const days = Number(options.days || 1);
  const startDateValue = new Date(`${endDate}T12:00:00.000Z`);
  startDateValue.setUTCDate(startDateValue.getUTCDate() - Math.max(1, days) + 1);
  const startDate = startDateValue.toISOString().slice(0, 10);
  const inRange = item => {
    const value = new Date(item.timestamp);
    if (!Number.isFinite(value.getTime())) return false;
    const itemDate = berlinDate(value);
    return itemDate >= startDate && itemDate <= endDate;
  };
  const leads = (state.manufacturerLeads || []).filter(inRange);
  const wattfox = (state.wattfoxMessages || []).filter(inRange);
  const missingSalesperson = leads.filter(item => item.crmStatus === 'created' && !item.salespersonAssigned);
  const manual = leads.filter(item => item.decision === 'manual');
  const failed = leads.filter(item => ['failed', 'blocked'].includes(item.portalAction) || item.crmStatus === 'failed');
  return {
    period: { start: startDate, end: endDate, days },
    leads: {
      total: leads.length,
      accepted: leads.filter(item => item.decision === 'accept').length,
      rejected: leads.filter(item => item.decision === 'reject').length,
      manual: manual.length,
      crmCreated: leads.filter(item => item.crmStatus === 'created').length,
      missingSalesperson: missingSalesperson.length,
      failed: failed.length,
      items: leads,
    },
    wattfox: {
      total: wattfox.length,
      requiresFollowUp: wattfox.filter(item => item.requiresFollowUp).length,
      items: wattfox,
    },
    attention: {
      missingSalesperson,
      manual,
      failed,
      wattfoxFollowUps: wattfox.filter(item => item.requiresFollowUp),
    },
  };
}
