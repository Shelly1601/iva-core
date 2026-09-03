import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-knowledge-base-test-'));
const store = await import('../knowledge/store.js');

const queued = await store.createKnowledgeEntry({ title: 'Vertriebskurs', kind: 'course', category: 'Vertrieb', sourceUrl: 'https://example.test/course' });
assert.equal(queued.status, 'needs-material');
assert.equal((await store.knowledgeBaseStatus()).needsMaterial, 1);

const learned = await store.updateKnowledgeEntry(queued.id, { content: 'Die Bedarfsermittlung beginnt mit offenen Fragen. Danach werden Ziele priorisiert.', tags: ['Beratung', 'Bedarf'] });
assert.equal(learned.status, 'ready');
assert.ok(learned.wordCount >= 8);
assert.equal((await store.searchKnowledgeBase('Bedarfsermittlung offene Fragen'))[0].id, queued.id);

const documentEntry = await store.createKnowledgeEntry({ title: 'Kursnotizen', kind: 'document' });
const uploaded = await store.storeKnowledgeDocument(documentEntry.id, { name: 'kurs.md', mime: 'text/markdown', buffer: Buffer.from('# Modul\nRisikoprofil vor der Empfehlung erfassen.') });
assert.equal(uploaded.status, 'ready');
assert.equal(uploaded.document.name, 'kurs.md');
assert.match((await store.getKnowledgeEntry(documentEntry.id)).documentText, /Risikoprofil/);
assert.equal((await store.readKnowledgeDocument(documentEntry.id)).buffer.toString('utf8').startsWith('# Modul'), true);
assert.ok((await store.listKnowledgeEntries({ query: 'Risikoprofil' })).some(item => item.id === documentEntry.id));

assert.rejects(() => store.createKnowledgeEntry({ title: 'Unsicher', sourceUrl: 'file:///etc/passwd' }), /gültige/);
assert.rejects(() => store.storeKnowledgeDocument(documentEntry.id, { name: 'bild.png', mime: 'image/png', buffer: Buffer.from('x') }), /Erlaubt/);
assert.equal((await store.deleteKnowledgeEntry(documentEntry.id)).id, documentEntry.id);
assert.equal(await store.getKnowledgeEntry(documentEntry.id), null);

const html = await fs.readFile(new URL('../public/knowledge.html', import.meta.url), 'utf8');
const js = await fs.readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');
const cockpit = await fs.readFile(new URL('../public/cockpit.html', import.meta.url), 'utf8');
const server = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.doesNotThrow(() => new Function(js));
assert.match(html, /id="entryForm"/);
assert.match(html, /accept="application\/pdf,text\/plain,text\/markdown/);
assert.match(html, /Dein eigener Wissensspeicher/);
assert.match(cockpit, /id="openKnowledge" href="\/knowledge" onclick="event\.stopPropagation\(\)"/);
for (const endpoint of ["/api/knowledge/status", "/api/knowledge',", "/api/knowledge/:id", "/api/knowledge/:id/document"]) assert.match(server, new RegExp(endpoint.replace(/[/:]/g, match => `\\${match}`)));
assert.match(server, /searchPersonalKnowledgeBase/);
assert.match(server, /addPersonalKnowledge/);

await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
console.log('PASS persönliche IVA-Wissensdatenbank: CRUD, Suche, Dateiimport, Chat-Werkzeuge und Cockpit-App geprüft.');
