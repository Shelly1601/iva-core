import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  arrayFromPayload,
  normalizeReference,
  normalizeQonektoContract,
  normalizeQonektoCustomer,
  unwrapQonektoResult,
} from '../integrations/qonekto-customers.js';

assert.deepEqual(
  unwrapQonektoResult({
    readOnly: true,
    tool: 'listKunden',
    result: { content: [{ type: 'text', text: '{"data":[{"ameise_id":123}]}' }] },
  }),
  { data: [{ ameise_id: 123 }] },
);

const customer = normalizeQonektoCustomer({
  ameise_id: 123,
  titel: 'Dr.',
  vorname: 'Mara',
  nachname: 'Muster',
  strasse: 'Testweg 1',
  plz: '12345',
  ort: 'Berlin',
  kommunikationen: [
    { art: 'E-Mail', wert: 'mara@example.test' },
    { art: 'Mobil', wert: '+49 170 1234567' },
  ],
});
assert.equal(customer.id, '123');
assert.equal(customer.name, 'Dr. Mara Muster');
assert.equal(customer.email, 'mara@example.test');
assert.equal(customer.mobile, '+49 170 1234567');
assert.equal(customer.address, 'Testweg 1, 12345 Berlin');

const nestedCustomer = normalizeQonektoCustomer({
  data: {
    kunde: {
      ameise_id: 'K-789',
      stammdaten: { vorname: 'Nora', nachname: 'Nested', geburtsdatum: '1980-02-03' },
      hauptadresse: { strasse: 'Innenweg 4', plz: '54321', ort: 'Köln' },
      kommunikation: {
        1: { kommunikationsart: 'E-Mail', wert: 'nora@example.test' },
        2: { kommunikationsart: 'Mobiltelefon', wert: '+49 171 7654321' },
      },
    },
  },
});
assert.equal(nestedCustomer.id, 'K-789');
assert.equal(nestedCustomer.name, 'Nora Nested');
assert.equal(nestedCustomer.email, 'nora@example.test');
assert.equal(nestedCustomer.mobile, '+49 171 7654321');
assert.equal(nestedCustomer.address, 'Innenweg 4, 54321 Köln');

const contract = normalizeQonektoContract({
  ameise_id: 456,
  kunde_id: 123,
  sparte: 'Hausrat',
  gesellschaft: 'Beispiel Versicherung AG',
  versicherungsscheinnummer: 'HR-123',
  beitrag_netto: 19.95,
});
assert.equal(contract.id, '456');
assert.equal(contract.customerId, '123');
assert.equal(contract.category, 'Hausrat');
assert.equal(contract.netPremium, 19.95);

const nestedContracts = arrayFromPayload({
  response: {
    data: {
      vertraege: {
        first: { vertrag: { ameise_id: 'V-1', kunde_ameise_id: 'K-789', sparte: 'Haftpflicht' } },
        second: { vertrag: { ameise_id: 'V-2', kunde_ameise_id: 'K-789', sparte: 'Hausrat' } },
      },
    },
  },
}, ['vertraege', 'contracts']);
assert.equal(nestedContracts.length, 2);
assert.equal(normalizeQonektoContract(nestedContracts[0]).customerId, 'K-789');
assert.equal(normalizeQonektoContract(nestedContracts[1]).category, 'Hausrat');

const referencedContract = normalizeQonektoContract({
  vertrag: {
    id: 'V-3',
    kunde: { ameise_id: 'K-789' },
    sparte: { bezeichnung: 'Wohngebäude' },
    gesellschaft: { name: 'Beispiel Versicherer' },
  },
});
assert.equal(referencedContract.id, 'V-3', 'verschachtelte Kunden-ID darf die Vertrags-ID nicht ueberschreiben');
assert.equal(referencedContract.category, 'Wohngebäude');
assert.equal(referencedContract.company, 'Beispiel Versicherer');

assert.deepEqual(
  arrayFromPayload({ anreden: { 1: 'Herr', 2: 'Frau', 7: 'Firma' } }, ['anreden']),
  [{ id: '1', label: 'Herr' }, { id: '2', label: 'Frau' }, { id: '7', label: 'Firma' }],
);
assert.equal(normalizeReference({ anrede_ameise_id: 1 }, 'salutation').label, 'Herr');
assert.equal(normalizeReference({ vermittler_id: '009T7N' }, 'broker').label, 'Nadine Sell');
assert.deepEqual(
  normalizeReference({ vermittler_ameise_id: 'A-1', vorname: 'Mara', nachname: 'Makler' }, 'broker'),
  { id: 'A-1', label: 'Mara Makler', raw: { vermittler_ameise_id: 'A-1', vorname: 'Mara', nachname: 'Makler' } },
);

const customerHtml = await fs.readFile(new URL('../public/customers.html', import.meta.url), 'utf8');
const customerJs = await fs.readFile(new URL('../public/customers.js', import.meta.url), 'utf8');
assert.match(customerHtml, /id="newBroker"><option value="009T7N">Nadine Sell · 009T7N/);
assert.match(customerHtml, /id="newTransferToQonekto" type="checkbox"/);
assert.match(customerHtml, /id="closeNewCustomer"[^>]+type="button"|type="button"[^>]+id="closeNewCustomer"/);
assert.match(customerHtml, /id="cancelNewCustomer"/);
assert.match(customerJs, /qonektoDraft: values/);
assert.match(customerJs, /transferLocalCustomerBtn/);
assert.doesNotMatch(customerJs, /prepareCreateCustomer/);

console.log('PASS Qonekto-Kunden: verschachtelte MCP-Ergebnisse, Kunden- und Vertragsnormalisierung');
