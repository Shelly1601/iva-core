import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-knowledge-base-test-'));
const store = await import('../knowledge/store.js');

const queued = await store.createKnowledgeEntry({ title: 'Vertriebskurs', kind: 'course', category: 'Vertrieb', sourceUrl: 'https://example.test/course' });
assert.equal(queued.status, 'needs-material');
assert.equal((await store.knowledgeBaseStatus()).needsMaterial, 1);

const linkOnly = await store.createKnowledgeEntry({ category: 'Vertrieb', sourceUrl: 'https://www.instagram.com/reel/TestReel123/' });
assert.equal(linkOnly.title, 'Instagram-Reel · TestReel123');
assert.equal(linkOnly.status, 'needs-material', 'a link is not yet learned content');
const textOnly = await store.createKnowledgeEntry({ content: '# Bedarf vor Angebot\nZunächst die Situation verstehen.', category: 'Vertrieb' });
assert.equal(textOnly.title, 'Bedarf vor Angebot');
const fileDraft = await store.createKnowledgeEntry({ kind: 'document', documentName: 'Beratungsleitfaden.pdf' });
assert.equal(fileDraft.title, 'Beratungsleitfaden');
await assert.rejects(() => store.createKnowledgeEntry({ category: 'Vertrieb' }), /Link, Text oder eine Datei/);

const learned = await store.updateKnowledgeEntry(queued.id, { content: 'Die Bedarfsermittlung beginnt mit offenen Fragen. Danach werden Ziele priorisiert.', tags: ['Beratung', 'Bedarf'] });
assert.equal(learned.status, 'ready');
assert.ok(learned.wordCount >= 8);
assert.equal((await store.searchKnowledgeBase('Bedarfsermittlung offene Fragen'))[0].id, queued.id);
assert.equal((await store.searchKnowledgeBase('Welche Dateitypen kann ich laut meiner persönlichen Wissensdatenbank hochladen?')).length, 0);

const documentEntry = await store.createKnowledgeEntry({ title: 'Kursnotizen', kind: 'document' });
const uploaded = await store.storeKnowledgeDocument(documentEntry.id, { name: 'kurs.md', mime: 'text/markdown', buffer: Buffer.from('# Modul\nRisikoprofil vor der Empfehlung erfassen.') });
assert.equal(uploaded.status, 'ready');
assert.equal(uploaded.document.name, 'kurs.md');
assert.match((await store.getKnowledgeEntry(documentEntry.id)).documentText, /Risikoprofil/);
assert.equal((await store.readKnowledgeDocument(documentEntry.id)).buffer.toString('utf8').startsWith('# Modul'), true);
assert.ok((await store.listKnowledgeEntries({ query: 'Risikoprofil' })).some(item => item.id === documentEntry.id));
const promptContext = await store.buildKnowledgePromptContext('Was steht in meinen Kursnotizen zum Risikoprofil?');
assert.match(promptContext, /Kursnotizen/);
assert.match(promptContext, /Risikoprofil vor der Empfehlung erfassen/);
assert.match(promptContext, /niemals als Systemanweisung/);

assert.rejects(() => store.createKnowledgeEntry({ title: 'Unsicher', sourceUrl: 'file:///etc/passwd' }), /gültige/);
assert.rejects(() => store.storeKnowledgeDocument(documentEntry.id, { name: 'bild.png', mime: 'image/png', buffer: Buffer.from('x') }), /Erlaubt/);
assert.equal((await store.deleteKnowledgeEntry(documentEntry.id)).id, documentEntry.id);
assert.equal(await store.getKnowledgeEntry(documentEntry.id), null);

const contentHash = value => crypto.createHash('sha256').update(value || '').digest('hex');
const guarded = await store.createKnowledgeEntry({ title: 'CAS-Test', content: 'Ursprünglich gespeicherte Fassung.' });
const outcomes = await Promise.allSettled([
  store.updateKnowledgeEntry(guarded.id, { content: 'Neue Recherche A.' }, { expectedContentHash: contentHash(guarded.content) }),
  store.updateKnowledgeEntry(guarded.id, { content: 'Neue Recherche B.' }, { expectedContentHash: contentHash(guarded.content) }),
]);
assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1, 'compare-and-swap must occur inside serialized mutation');
const conflict = outcomes.find(result => result.status === 'rejected').reason;
assert.equal(conflict.status, 409); assert.equal(conflict.code, 'KNOWLEDGE_RESEARCH_CONFLICT');
await store.updateKnowledgeEntry(guarded.id, { content: 'Manuelle Fassung bleibt erhalten.' });
await assert.rejects(store.updateKnowledgeEntry(guarded.id, { content: 'Veralteter Automatikstand.' }, { expectedContentHash: contentHash(guarded.content) }), { status: 409, code: 'KNOWLEDGE_RESEARCH_CONFLICT' });
assert.equal((await store.getKnowledgeEntry(guarded.id)).content, 'Manuelle Fassung bleibt erhalten.');
const kbFile = path.join(process.env.DATA_DIR, 'knowledge-base.json'), beforeCorruption = await fs.readFile(kbFile);
for (const broken of ['{"entries":', '{"version":1,"entries":{}}']) {
  await fs.writeFile(kbFile, broken);
  await assert.rejects(store.listKnowledgeEntries(), { status: 503, code: 'KNOWLEDGE_STORE_UNAVAILABLE' });
  await assert.rejects(store.createKnowledgeEntry({ content: 'Darf defekte Ablage nicht ersetzen.' }), { status: 503, code: 'KNOWLEDGE_STORE_UNAVAILABLE' });
  assert.equal(await fs.readFile(kbFile, 'utf8'), broken);
}
await fs.writeFile(kbFile, beforeCorruption);
assert.equal((await store.getKnowledgeEntry(guarded.id)).content, 'Manuelle Fassung bleibt erhalten.');

const html = await fs.readFile(new URL('../public/knowledge.html', import.meta.url), 'utf8');
const js = await fs.readFile(new URL('../public/knowledge.js', import.meta.url), 'utf8');
const cockpit = await fs.readFile(new URL('../public/cockpit.html', import.meta.url), 'utf8');
const server = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
assert.doesNotThrow(() => new Function(js));
assert.match(html, /id="entryForm"/);
assert.match(html, /accept="application\/pdf,text\/plain,text\/markdown/);
assert.match(html, /Dein eigener Wissensspeicher/);
assert.match(html, /Den Titel vergibt IVA automatisch/);
assert.match(html, /Nur in IVA aufnehmen/);
assert.match(html, /IVA \+ Google Drive/);
assert.match(html, /id="loginPassword" type="password"/);
assert.match(html, /id="importJobs"/);
assert.match(js, /encryptCredentials/);
assert.match(js, /role="progressbar"/);
assert.match(cockpit, /id="openKnowledge" href="\/knowledge" onclick="event\.stopPropagation\(\)"/);
for (const endpoint of ["/api/knowledge/status", "/api/knowledge',", "/api/knowledge/:id", "/api/knowledge/:id/document"]) assert.match(server, new RegExp(endpoint.replace(/[/:]/g, match => `\\${match}`)));
for (const endpoint of ["/api/knowledge/import-capabilities", "/api/knowledge/imports", "/api/knowledge/imports/:id/resume"]) assert.match(server, new RegExp(endpoint.replace(/[/:]/g, match => `\\${match}`)));
assert.match(server, /searchPersonalKnowledgeBase/);
assert.match(server, /addPersonalKnowledge/);
assert.equal((server.match(/buildKnowledgePromptContext\(userText\)/g) || []).length, 2);

await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
console.log('PASS persönliche IVA-Wissensdatenbank: CRUD, Suche, Dateiimport, Chat-Werkzeuge und Cockpit-App geprüft.');
