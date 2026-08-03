import assert from 'node:assert/strict';
import {
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

console.log('PASS Qonekto-Kunden: MCP-Ergebnis, Kunden- und Vertragsnormalisierung');
