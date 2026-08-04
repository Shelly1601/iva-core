import assert from 'node:assert/strict';
import { energyTariffStatus, prepareEnergyTariffRequest } from '../integrations/energy-tariffs.js';

const old = {
  portal: process.env.ENERGY_TARIFF_PORTAL_URL,
  user: process.env.ENERGY_TARIFF_PORTAL_USER,
  password: process.env.ENERGY_TARIFF_PORTAL_PASSWORD,
};

delete process.env.ENERGY_TARIFF_PORTAL_USER;
delete process.env.ENERGY_TARIFF_PORTAL_PASSWORD;
process.env.ENERGY_TARIFF_PORTAL_URL = 'https://portal-energypartner.de';

const status = energyTariffStatus();
assert.equal(status.provider, 'EnergyPartner24');
assert.equal(status.mode, 'portal-only');
assert.equal(status.comparisonEnabled, false);
assert.equal(status.submissionEnabled, false);

const incomplete = prepareEnergyTariffRequest({ commodity: 'electricity' });
assert.equal(incomplete.status, 'data-required');
assert.ok(incomplete.missing.includes('annualConsumptionKwh'));
assert.ok(incomplete.missing.includes('customerAddressOrPostalCode'));

const prepared = prepareEnergyTariffRequest({
  commodity: 'gas',
  annualConsumptionKwh: '18.500',
  customerAddress: 'Musterstrasse 1, 12345 Musterstadt',
});
assert.equal(prepared.status, 'provider-handoff-ready');
assert.equal(prepared.input.annualConsumptionKwh, 18_500);
assert.equal(prepared.result, null);
assert.match(prepared.disclaimer, /Noch kein Tarifvergleich/);

if (old.portal === undefined) delete process.env.ENERGY_TARIFF_PORTAL_URL; else process.env.ENERGY_TARIFF_PORTAL_URL = old.portal;
if (old.user === undefined) delete process.env.ENERGY_TARIFF_PORTAL_USER; else process.env.ENERGY_TARIFF_PORTAL_USER = old.user;
if (old.password === undefined) delete process.env.ENERGY_TARIFF_PORTAL_PASSWORD; else process.env.ENERGY_TARIFF_PORTAL_PASSWORD = old.password;

console.log('PASS EnergyPartner: sichere Anfragevorbereitung ohne erfundene Tarife oder automatische Einreichung');
