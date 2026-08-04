import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-advice-test-'));
process.env.DATA_DIR = temp;

try {
  const catalog = await import('../advice/catalog.js');
  const knowledge = await import('../advice/knowledge-store.js');
  const publicCatalog = catalog.publicAdviceCatalog();
  assert.equal(publicCatalog.modules.length, 12);
  assert.ok(catalog.getAdviceModule('din-77230'));
  assert.ok(catalog.getAdviceModule('din-77235'));
  assert.ok(catalog.getAdviceModule('contract-comparison')?.knowledgeSearch);
  assert.ok(catalog.getAdviceModule('gkv-comparison'));
  assert.equal(catalog.getAdviceModule('energy-planning')?.launchMode, 'energie');
  assert.ok(catalog.getAdviceModule('energy-tariff-comparison'));
  assert.equal(catalog.getAdviceModule('corporate-benefits')?.calculator, 'corporate-benefits');
  assert.equal(publicCatalog.groups.find(group => group.id === 'corporate')?.label, 'Firmenvorsorge & Benefits');
  assert.equal(publicCatalog.groups.find(group => group.id === 'energy')?.label, 'Energie & Versorgung');

  const initial = await knowledge.listAdviceKnowledge();
  assert.equal(initial.referenceCount, 12);
  assert.equal(initial.productDocumentCount, 4);

  await knowledge.addAdviceKnowledgeSource({
    kind: 'ipid', category: 'hausrat', provider: 'Barmenia', product: 'Top Hausrat', tariff: 'Top-Schutz', year: '2015',
    title: 'Barmenia Top Hausrat · Produktinformation 2015', url: 'https://example.test/barmenia-top-hausrat-2015.pdf',
  });
  const found = await knowledge.listAdviceKnowledge({ search: 'Barmenia 2015' });
  assert.equal(found.sources.length, 1);
  assert.equal(found.productDocumentCount, 5);
  assert.equal(found.sources[0].status, 'pending-review');

  await assert.rejects(() => knowledge.addAdviceKnowledgeSource({ title: 'Unsicher', url: 'javascript:alert(1)' }), /HTTP/);
  console.log('PASS Beratung: 12 Module, Firmenvorsorge, Energie-Einstiege, DIN-Trennung, Quellenbibliothek und Connector-Basis');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
