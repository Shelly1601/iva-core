import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { extractText } from 'unpdf';
import { exportCreatorProduct, prepareCreatorExport } from '../creator/export.js';
import { createCreatorService } from '../creator/service.js';
const sample = JSON.parse(await fs.readFile(new URL('./fixtures/creator/export-sample.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(sample);
const hash = value => createHash('sha256').update(value).digest('hex');
function withSnippet(usage = 'quotation') {
  const data = fresh(), source = data.version.sourceSnapshots[0];
  const snippet = { id: 'quote-one', sourceId: source.id, sourceSha256: source.sha256, text: 'Ein kurzer Beispielsatz.', usage, rightsConfirmed: usage !== 'quotation', rightsBasis: usage === 'quotation' ? '' : 'Eigene eigens verfasste Testunterlage', attribution: 'Quelle Beispiel', locator: 'Absatz 1' };
  source.content += '\n' + snippet.text;
  source.sha256 = snippet.sourceSha256 = hash(source.content);
  const block = `> ${snippet.text}\n> — ${snippet.attribution} (${snippet.locator})`;
  data.version.exactSnippets = [snippet]; data.version.units[0].exactSnippetIds = [snippet.id]; data.version.units[0].content += '\n\n' + block;
  return { data, source, snippet, block };
}
function unzip(buffer) {
  let offset = 0; const files = new Map();
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressed = buffer.readUInt32LE(offset + 18), size = buffer.readUInt32LE(offset + 22), nameSize = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameSize).toString('utf8'), start = offset + 30 + nameSize + extra;
    const value = inflateRawSync(buffer.subarray(start, start + compressed)); assert.equal(value.length, size); assert.equal(files.has(name), false); files.set(name, value); offset = start + compressed;
  }
  assert.equal(buffer.readUInt32LE(offset), 0x02014b50); return files;
}

test('only ready, complete and structurally complete immutable products export', async () => {
  for (const mutate of [data => data.product.status = 'generating', data => data.version.stage = 'outline', data => data.version.units.pop(), data => data.version.units[1].id = 'one', data => data.version.units[0].content = '', data => data.version.outline[1].id = 'missing', data => data.version.createdAt = '2026-02-30T12:00:00Z', data => data.version.productSnapshot = { id: 'other', projectId: data.product.projectId }]) {
    const data = fresh(); mutate(data); await assert.rejects(exportCreatorProduct({ ...data, format: 'md' }));
  }
  await assert.rejects(exportCreatorProduct({ ...fresh(), format: 'epub' }));
});
test('Markdown contains complete units, exercises and attributed sources but no original source fulltext', async () => {
  const before = fresh(), result = await exportCreatorProduct({ ...before, format: 'md' });
  assert.match(result.contentType, /markdown/); assert.match(result.filename, /^[a-z0-9-]+\.md$/);
  const content = result.buffer.toString('utf8');
  for (const unit of sample.version.units) { assert.ok(content.includes(unit.content)); for (const exercise of unit.exercises) assert.ok(content.includes(exercise)); }
  assert.ok(content.includes('Übungen')); assert.ok(content.includes(hash(before.version.sourceSnapshots[0].content)));
  assert.doesNotMatch(content, /PRIVATE_ORIGINAL_SOURCE_DO_NOT_EXPORT/);
  assert.doesNotMatch(content, /INTERNAL_CREATOR_BRIEF_DO_NOT_PUBLISH/);
  assert.ok(content.includes(before.version.plan.promise));
  assert.deepEqual(before, sample);
});
test('ZIP packages lesson files, full PDF, workbook, source metadata and verifiable file checksums', async () => {
  const result = await exportCreatorProduct({ ...fresh(), format: 'zip' }); assert.equal(result.contentType, 'application/zip');
  const files = unzip(result.buffer), manifest = JSON.parse(files.get('manifest.json'));
  assert.ok(files.has('produkt.pdf')); assert.ok(files.has('produkt.md')); assert.ok(files.has('workbook.pdf')); assert.ok(files.has('workbook.md')); assert.ok(files.has('README.md'));
  assert.equal([...files.keys()].filter(name => name.startsWith('lektionen/')).length, 3);
  for (const entry of manifest.files) assert.equal(hash(files.get(entry.name)), entry.sha256);
  assert.equal(manifest.sourceContentsIncluded, false); assert.equal(manifest.sources[0].content, undefined);
  for (const [name, content] of files) {
    const readable = name.endsWith('.pdf') ? (await extractText(new Uint8Array(content), { mergePages: true })).text : content.toString('utf8');
    assert.doesNotMatch(readable, /PRIVATE_ORIGINAL_SOURCE_DO_NOT_EXPORT|INTERNAL_CREATOR_BRIEF_DO_NOT_PUBLISH/);
  }
  assert.equal(manifest.product.brief, undefined);
  const pdf = await PDFDocument.load(files.get('produkt.pdf')); assert.ok(pdf.getPageCount() >= 6); assert.match(pdf.getTitle(), /Klar beraten/);
  assert.ok((await PDFDocument.load(files.get('workbook.pdf'))).getPageCount() >= 5);
});
test('missing sources, unapproved licensed excerpts and missing attributed blocks fail closed', async () => {
  const data = fresh(); data.version.units[0].sourceIds.push('missing'); assert.throws(() => prepareCreatorExport(data), /fehlenden Quellennachweis/);
  const approved = withSnippet('licensed'); approved.snippet.rightsConfirmed = false;
  assert.throws(() => prepareCreatorExport(approved.data), error => error.code === 'CREATOR_EXPORT_RIGHTS_REQUIRED');
  approved.snippet.rightsConfirmed = true; assert.equal(prepareCreatorExport(approved.data).snippets.length, 1);
  approved.data.version.units[0].content = approved.data.version.units[0].content.replace(approved.block, '');
  assert.throws(() => prepareCreatorExport(approved.data), /Zitatblock/);
  const wrongSource = withSnippet(); wrongSource.snippet.sourceSha256 = 'b'.repeat(64); assert.throws(() => prepareCreatorExport(wrongSource.data), /Quellennachweis/);
});
test('short quotations need attribution and location but no ownership checkbox; every occurrence counts', async () => {
  const { data, snippet, block } = withSnippet();
  assert.equal(prepareCreatorExport(data).snippets[0].rightsConfirmed, false);
  assert.ok((await exportCreatorProduct({ ...data, format: 'md' })).buffer.toString().includes(block));
  data.version.units[1].exactSnippetIds = [snippet.id]; data.version.units[1].exercises.push(block.repeat(8));
  assert.throws(() => prepareCreatorExport(data), /25 Wörter/);
  const missingLocation = withSnippet(); missingLocation.snippet.locator = ''; assert.throws(() => prepareCreatorExport(missingLocation.data), /Fundstelle/);
});
test('originality is rechecked across source identities and raw sources stay private', () => {
  const { data, source, snippet, block } = withSnippet();
  const second = { ...source, id: 'source-copy', originalId: 'another-import-id' }; data.version.sourceSnapshots.push(second);
  const secondSnippet = { ...snippet, id: 'quote-two', sourceId: second.id }; data.version.exactSnippets.push(secondSnippet);
  data.version.units[1].exactSnippetIds = [secondSnippet.id]; data.version.units[1].content += '\n\n' + block.repeat(8);
  assert.throws(() => prepareCreatorExport(data), /25 Wörter/);
  const copied = fresh(); copied.version.sourceSnapshots[0].content = 'Eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn.';
  copied.version.sourceSnapshots[0].sha256 = hash(copied.version.sourceSnapshots[0].content);
  copied.version.units[0].content = copied.version.sourceSnapshots[0].content;
  assert.throws(() => prepareCreatorExport(copied), error => error.code === 'CREATOR_SOURCE_OVERLAP');
  const corrupt = fresh(); corrupt.version.sourceSnapshots[0].content += ' tampered'; assert.throws(() => prepareCreatorExport(corrupt), /Prüfsumme/);
});
test('unsafe links fail before export, raw HTML is escaped, filenames cannot escape their package', async () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,test', 'https://user:secret@example.test/private']) {
    const data = fresh(); data.version.units[0].content = `[Klicken](${url})`; await assert.rejects(exportCreatorProduct({ ...data, format: 'md' }));
  }
  const data = fresh(); data.product.title = '../../Mein Produkt'; data.version.units[0].title = '../../../Kapitel'; data.version.units[0].content = '<script>alert("x")</script>\n\nSicherer Text mit ÄÖÜ äöü ß.';
  const result = await exportCreatorProduct({ ...data, format: 'md' }); assert.ok(!result.filename.includes('/')); assert.match(result.buffer.toString(), /&lt;script&gt;/); assert.doesNotMatch(result.buffer.toString(), /<script>/);
});
test('long paragraphs and long headings flow across pages with no missing final unit', async () => {
  const data = fresh(); data.version.units[0].content = Array.from({ length: 85 }, (_, i) => `## Abschnitt ${i + 1}\n\n` + 'Änderungen verständlich erklären und gemeinsam nächste Schritte festlegen. '.repeat(7)).join('\n\n');
  data.version.units[0].title = 'Ein umfangreiches Kapitel über klare Kommunikation und nachvollziehbare Entscheidungen im Kundenalltag';
  const result = await exportCreatorProduct({ ...data, format: 'pdf' }); const pdf = await PDFDocument.load(result.buffer);
  assert.ok(pdf.getPageCount() > 20); assert.equal(result.buffer.subarray(0, 5).toString(), '%PDF-');
  const extracted = (await extractText(new Uint8Array(result.buffer), { mergePages: true })).text;
  assert.match(extracted, /Abschnitt 85/); assert.ok(extracted.includes(data.version.units.at(-1).title));
});
test('an unsupported glyph reports a concrete issue instead of silent black boxes', async () => {
  const data = fresh(); data.version.units[0].content += '\n\n🦄';
  await assert.rejects(exportCreatorProduct({ ...data, format: 'pdf' }), error => error.code === 'CREATOR_EXPORT_UNSUPPORTED_GLYPH');
  assert.ok((await exportCreatorProduct({ ...data, format: 'md' })).buffer.toString().includes('🦄'));
});

test('actual engine exportData contracts export own excerpts and short quotations without provider calls', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-creator-export-contract-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sourceText = 'Das ist unser kurzer eigener Beispielsatz. Dieser unabhängige Quellenabschnitt dient ausschließlich einem synthetischen Vertragstest.';
  const paragraph = 'Wähle eine überschaubare Alltagssituation und beschreibe das beobachtete Ergebnis in deinen eigenen Worten. Überlege anschließend, welches Detail noch unklar ist. Ein gezieltes Gespräch über diesen Punkt hilft, den nächsten Schritt gemeinsam zu planen. Halte das überprüfbare Ziel schriftlich fest, damit später ein sachlicher Rückblick möglich wird. ';
  const generate = async ({ stage, input }) => ({ model: 'fixture:local-only', data: stage === 'plan' ? { positioning: 'Ein eigener Lernweg für verständliche Alltagsgespräche.', promise: 'Die Teilnehmer entwickeln eine kleine eigene Gesprächsroutine.', approach: 'Beobachtung, konkrete Rückfrage und überprüfbares Ziel bilden eine eigene praktische Reihenfolge.', learningObjectives: ['Ein konkretes Gesprächsziel beschreiben'], differentiation: ['Eigene Beispiele und praktische Aufgaben'], limitations: [], sourceIds: [] } : stage === 'outline' ? { outline: Array.from({ length: 4 }, (_, i) => ({ title: `Eigene Lektion ${i + 1}`, objective: `Ein überprüfbares Ergebnis für Arbeitsschritt ${i + 1} formulieren.`, sourceIds: ['S1'] })) } : { title: input.unit.title, content: paragraph.repeat(3), examples: ['Fiktives Beispiel: Anna benennt einen unklaren Punkt und formuliert dazu eine offene Frage.'], exercises: ['Notiere einen Anlass und eine passende Rückfrage. Prüfe, ob die Frage ohne Zusatzinformationen verständlich ist.'], sourceIds: ['S1'], exactSnippetIds: [] } });
  const service = createCreatorService({ dataDir, getProject: async id => ({ id }), generate, getKnowledgeEntry: async id => ({ id, status: 'ready', title: 'Eigene synthetische Notiz', content: sourceText, url: 'https://example.test/fixture' }) });
  const scope = { projectId: 'export-contract' };
  for (const usage of ['own', 'quotation']) {
    const product = await service.create(scope, { type: 'course', title: `Vertragstest ${usage}`, brief: 'Ein eigenständiger Übungskurs mit konkreten Beispielen.', unitCount: 4 });
    await service.addSources(scope, product.id, { knowledgeIds: ['fixture'], sourceRights: usage === 'own' ? [{ sourceId: 'S1', usage: 'own', rightsConfirmed: true, rightsBasis: 'Eigene synthetische Notiz für diesen Test verfasst' }] : [] });
    await service.addExactSnippet(scope, product.id, { sourceId: 'S1', text: 'Das ist unser kurzer eigener Beispielsatz.', usage, attribution: 'Testautorin', locator: 'Satz 1', rightsConfirmed: usage === 'own', rightsBasis: usage === 'own' ? 'Eigene Testunterlage ausdrücklich zur Übernahme freigegeben' : '' });
    const job = await service.startJob(scope, product.id); let finished;
    for (let i = 0; i < 400; i++) { finished = await service.getJob(scope, job.id); if (!['queued', 'running'].includes(finished.status)) break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(finished.status, 'completed', JSON.stringify(finished));
    const exportData = await service.exportData(scope, product.id), exported = await exportCreatorProduct({ ...exportData, format: 'zip' });
    const files = unzip(exported.buffer), manifest = JSON.parse(files.get('manifest.json'));
    assert.equal(manifest.exactSnippets[0].usage, usage); assert.equal(manifest.exactSnippets[0].rightsConfirmed, usage === 'own');
    assert.equal(manifest.sources[0].rights.usage, usage === 'own' ? 'own' : 'research');
    assert.equal(manifest.exactSnippets[0].sourceSha256, manifest.sources[0].sha256);
    assert.ok(files.get('produkt.md').toString().includes('> Das ist unser kurzer eigener Beispielsatz.\n> — Testautorin (Satz 1)'));
    assert.ok(!files.get('manifest.json').toString().includes(sourceText));
  }
});

if (process.env.IVA_CREATOR_EXPORT_SAMPLE) {
  await fs.mkdir(process.env.IVA_CREATOR_EXPORT_SAMPLE, { recursive: true });
  for (const format of ['pdf', 'md', 'zip']) { const result = await exportCreatorProduct({ ...fresh(), format }); await fs.writeFile(new URL(`file://${process.env.IVA_CREATOR_EXPORT_SAMPLE}/${result.filename}`), result.buffer); }
}
