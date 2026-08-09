import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const customerHtml = await fs.readFile(new URL('../public/customers.html', import.meta.url), 'utf8');
const customerJs = await fs.readFile(new URL('../public/customers.js', import.meta.url), 'utf8');
const serverSource = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
const crmSkillSource = await fs.readFile(new URL('../skills/crm.js', import.meta.url), 'utf8');

const salutationSelect = customerHtml.match(/<select id="newSalutation"[\s\S]*?<\/select>/)?.[0] || '';
assert.deepEqual([...salutationSelect.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), ['male', 'female', 'diverse', 'company']);
assert.match(salutationSelect, />Mann</);
assert.match(salutationSelect, />Frau</);
assert.match(salutationSelect, />Divers</);
assert.match(salutationSelect, />Firma</);
assert.match(customerHtml, /id="newLegalFormField"/);
assert.match(customerHtml, /id="editLegalFormField"/);
assert.match(customerHtml, /id="prepareAddress">Kontaktdaten speichern/);
assert.match(customerJs, /IVA-Kundenakte löschen/);
assert.match(customerJs, /method: 'DELETE'/);
assert.match(customerJs, /Pipedrive, Qonekto und Blau Direkt blieben unverändert/);
assert.doesNotMatch(customerJs, /source\.textContent = customer\.source === 'iva' \? 'Entwurf'/);
assert.match(serverSource, /app\.delete\('\/api\/workspaces\/:id'/);
assert.match(crmSkillSource, /importCrmCustomerFile/);
assert.match(crmSkillSource, /übernimmt deterministisch Anrede, Name\/Firma, Rechtsform, E-Mail, Telefon, Straße, PLZ, Ort und vorhandene CRM-Notizen/i);

console.log('PASS Kundenakten: aktive Akte, Löschung, Kontaktdaten, vier Anreden und CRM-Import');
