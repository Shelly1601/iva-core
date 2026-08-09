import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  addressAutocompleteStatus,
  normalizePhotonFeature,
  normalizePhotonResponse,
  suggestGermanAddresses,
} from '../integrations/address-autocomplete.js';

const feature = {
  properties: {
    countrycode: 'DE', street: 'Fritz-Thiele-Straße', housenumber: '3', postcode: '28279', city: 'Bremen', state: 'Bremen', country: 'Deutschland',
  },
};
assert.deepEqual(normalizePhotonFeature(feature), {
  id: 'fritz-thiele-straße 3|28279|bremen',
  label: 'Fritz-Thiele-Straße 3, 28279 Bremen',
  street: 'Fritz-Thiele-Straße', houseNumber: '3', streetLine: 'Fritz-Thiele-Straße 3', postcode: '28279', city: 'Bremen', district: '', state: 'Bremen', country: 'Deutschland',
});
assert.equal(normalizePhotonFeature({ properties: { countrycode: 'US', street: 'Main Street', city: 'Boston' } }), null);
assert.equal(normalizePhotonResponse({ features: [feature, feature] }).length, 1, 'Doppelte Treffer werden entfernt');

let requestedUrl = '';
const result = await suggestGermanAddresses('Fritz-Thiele-Straße 3 Bremen', {
  fetchImpl: async url => {
    requestedUrl = String(url);
    return { ok: true, json: async () => ({ features: [feature] }) };
  },
});
assert.match(requestedUrl, /lang=de/);
assert.match(decodeURIComponent(requestedUrl), /Deutschland/);
assert.equal(result.suggestions[0].postcode, '28279');
assert.equal(result.attribution, '© OpenStreetMap-Mitwirkende');
assert.equal(addressAutocompleteStatus().provider, 'photon');

const customerHtml = await fs.readFile(new URL('../public/customers.html', import.meta.url), 'utf8');
const customerJs = await fs.readFile(new URL('../public/customers.js', import.meta.url), 'utf8');
assert.match(customerHtml, /id="addressSuggestions"/);
assert.match(customerHtml, /© OpenStreetMap/);
assert.match(customerJs, /api\/address-suggestions/);
assert.match(customerJs, /suggestion\.postcode/);
assert.match(customerJs, /suggestion\.city/);

console.log('PASS Adresssuche: Deutschland-Filter, Normalisierung, Dubletten und Attribution');
