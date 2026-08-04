import crypto from 'crypto';

const DEFAULT_PORTAL_URL = 'https://portal-energypartner.de';
const COMMODITIES = new Set(['electricity', 'gas']);

function cleanText(value, max = 500) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function positiveNumber(value) {
  let normalized = String(value ?? '').trim().replace(/\s/g, '');
  if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) normalized = normalized.replace(/\./g, '');
  else normalized = normalized.replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function safeHttpsUrl(value, fallback = '') {
  try {
    const parsed = new URL(cleanText(value, 2_000) || fallback);
    return parsed.protocol === 'https:' ? parsed.toString().replace(/\/$/, '') : fallback;
  } catch {
    return fallback;
  }
}

export function energyTariffStatus() {
  const portalUrl = safeHttpsUrl(process.env.ENERGY_TARIFF_PORTAL_URL, DEFAULT_PORTAL_URL);
  const apiUrl = safeHttpsUrl(process.env.ENERGY_TARIFF_API_URL);
  const portalLoginConfigured = Boolean(process.env.ENERGY_TARIFF_PORTAL_USER && process.env.ENERGY_TARIFF_PORTAL_PASSWORD);
  const apiCredentialsConfigured = Boolean(apiUrl && process.env.ENERGY_TARIFF_API_TOKEN);

  return {
    provider: cleanText(process.env.ENERGY_TARIFF_PROVIDER, 120) || 'EnergyPartner24',
    portalUrl,
    mode: apiCredentialsConfigured ? 'api-contract-pending' : portalLoginConfigured ? 'portal-login-configured' : 'portal-only',
    portalLoginConfigured,
    apiCredentialsConfigured,
    comparisonEnabled: false,
    submissionEnabled: false,
    reason: apiCredentialsConfigured
      ? 'API-Zugang ist hinterlegt, aber das offizielle Request-/Response-Schema muss noch verifiziert werden.'
      : portalLoginConfigured
        ? 'Portalzugang ist hinterlegt. Die erlaubte Browser-Automation und der authentifizierte Ablauf muessen noch verifiziert werden.'
        : 'Die oeffentliche Portal-URL ist vorbereitet. Fuer Live-Vergleiche fehlt ein freigegebener API- oder Portalzugang.',
  };
}

export function prepareEnergyTariffRequest(input = {}) {
  const commodity = cleanText(input.commodity, 40).toLowerCase();
  const annualConsumptionKwh = positiveNumber(input.annualConsumptionKwh);
  const customerAddress = cleanText(input.customerAddress, 500);
  const postalCode = cleanText(input.postalCode, 20);
  const city = cleanText(input.city, 160);
  const missing = [];

  if (!COMMODITIES.has(commodity)) missing.push('commodity');
  if (!annualConsumptionKwh) missing.push('annualConsumptionKwh');
  if (!customerAddress && !postalCode) missing.push('customerAddressOrPostalCode');

  const provider = energyTariffStatus();
  return {
    id: crypto.randomUUID(),
    schemaVersion: 'iva-energy-tariff-request-1.0',
    createdAt: new Date().toISOString(),
    status: missing.length ? 'data-required' : provider.comparisonEnabled ? 'calculation-ready' : 'provider-handoff-ready',
    missing,
    input: {
      commodity: COMMODITIES.has(commodity) ? commodity : '',
      annualConsumptionKwh,
      customerName: cleanText(input.customerName, 200),
      customerAddress,
      postalCode,
      city,
      meterType: cleanText(input.meterType, 120),
      currentSupplier: cleanText(input.currentSupplier, 200),
      currentTariff: cleanText(input.currentTariff, 200),
      desiredStartDate: cleanText(input.desiredStartDate, 40),
      notes: cleanText(input.notes, 2_000),
    },
    provider: {
      name: provider.provider,
      portalUrl: provider.portalUrl,
      mode: provider.mode,
    },
    result: null,
    disclaimer: 'Noch kein Tarifvergleich. Preise, Boni, Laufzeiten und Verfuegbarkeit duerfen erst aus einem belegten Provider-Ergebnis uebernommen werden.',
  };
}

export async function prepareWorkspaceEnergyTariffRequest({ workspaces, workspaceId, input = {} }) {
  const workspace = await workspaces.getWorkspace(workspaceId);
  if (!workspace) return null;

  const heating = workspace.data?.heating || {};
  const inferredConsumption = String(heating.consumptionUnit || '').toLowerCase() === 'kwh'
    ? heating.annualConsumption
    : null;
  const request = prepareEnergyTariffRequest({
    ...input,
    customerName: input.customerName || workspace.customer?.name,
    customerAddress: input.customerAddress || workspace.customer?.address,
    annualConsumptionKwh: input.annualConsumptionKwh || inferredConsumption,
    meterType: input.meterType || workspace.data?.electrical?.meterType,
  });
  const previous = Array.isArray(workspace.data?.tariffRequests) ? workspace.data.tariffRequests : [];
  const updated = await workspaces.updateWorkspace(workspaceId, {
    data: { tariffRequests: [...previous.slice(-19), request] },
  });
  return { request, workspace: updated };
}
