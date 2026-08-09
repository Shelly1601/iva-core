import assert from 'node:assert/strict';
import { buildNameSearchVariants, normalizeName, resolveLeadName } from '../crm/name-matching.js';

assert.equal(normalizeName('Müller-Lüdenscheidt'), 'mueller luedenscheidt');
assert.ok(buildNameSearchVariants('Stephan Meyer').includes('Stefan Meyer'));
assert.ok(buildNameSearchVariants('Michael Toleikis').includes('Toleikis'));

const leads = [
  { id: '1', first_name: 'Michael', last_name: 'Toleikis', email: 'michael@example.test', city: 'Brigachtal' },
  { id: '2', first_name: 'Michaela', last_name: 'Tolksdorf', email: 'michaela@example.test', city: 'Bremen' },
];
const fuzzy = resolveLeadName('Mikael Toleikis', leads);
assert.equal(fuzzy.matchStatus, 'unique');
assert.equal(fuzzy.bestMatch.id, '1');
assert.equal(fuzzy.bestMatch.name, 'Michael Toleikis');

const ambiguous = resolveLeadName('Müller', [
  { id: '3', vorname: 'Anna', nachname: 'Müller' },
  { id: '4', vorname: 'Anne', nachname: 'Müller' },
]);
assert.equal(ambiguous.matchStatus, 'ambiguous');
assert.match(ambiguous.clarification, /Anna Müller/);
assert.equal(resolveLeadName('Unbekannt', leads).matchStatus, 'not-found');

console.log('PASS CRM-Namen: Schreibvarianten, Fuzzy-Ranking und Rückfragepflicht');
