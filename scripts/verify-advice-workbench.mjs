import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { extractText } from 'unpdf';
import { calculateFinancialPlan, financialPlanDefaults } from '../public/advice-finance.js';
import { adviceFutureValue } from '../public/advice-calculators.js';
import { createAdviceWorkbench } from '../advice/workbench.js';
import { defaultCriteria, normalizeContract, evaluateInsuranceCase, digest, INSURANCE_CATEGORIES, INSURANCE_CRITERIA_PROFILES, appendInsuranceCriteria } from '../advice/comparison.js';
import { exportAdviceCasePdf } from '../advice/report.js';
import { fillAdviceForm, inspectAdviceForm } from '../advice/form-pdf.js';
import { suggestContractEvidence } from '../advice/extract.js';
import { registerAdviceWorkbenchRoutes } from '../advice/routes.js';

const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const plan = overrides => calculateFinancialPlan({ ...financialPlanDefaults(), savingMonths: 12, drawdownMonths: 0, annualCost: 0, initialCostPercent: 0, contributionCostPercent: 0, monthlyFixedCost: 0, inflation: 0, contributionGrowth: 0, taxRate: 0, ...overrides });
const NOW = '2026-09-16T12:00:00Z';
const evidenceText = 'Versicherungssumme: 5.000.000 EUR. Selbstbehalt: 150 EUR. Jahresbeitrag: 120,00 EUR. Alle genannten Leistungen eingeschlossen. Beitrag einschließlich Versicherungsteuer und aller Gebühren.';
function comparisonFixture() {
  const documents = [{ id: 'doc1', sha256: digest(evidenceText), filename: 'Synthetischer Beleg.txt', text: evidenceText, addedAt: NOW }], criteria = defaultCriteria('sach');
  const evidence = { documentId: 'doc1', sha256: documents[0].sha256, excerpt: evidenceText, locator: 'Seite 1', reviewed: true };
  const contract = (id, amount = 120) => normalizeContract({ id, provider: `Testversicherer ${id}`, tariff: 'Synthetischer Testtarif', premium: { amount, frequency: 'annual', includesTax: true, annualFees: 0, feesConfirmed: true, evidence }, issuedAt: '2026-09-01T12:00:00Z', validUntil: '2026-10-01T12:00:00Z', riskConfirmed: true, facts: Object.fromEntries(criteria.map(c => [c.id, { value: true, evidence }])) }, criteria, documents);
  return { record: { id: 'case1', projectId: 'alpha', customerId: 'client1', title: 'Synthetischer Leistungsvergleich', revision: 1, kind: 'insurance', category: 'sach', criteria, documents, oldContract: contract('old', 150), offers: [contract('one', 120), contract('two', 140)] }, evidence, contract };
}
async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-advice-test-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const service = createAdviceWorkbench({ dataDir, getProject: async id => ['alpha', 'beta'].includes(id) ? { id } : null, getCustomer: async (projectId, customerId) => customerId === `${projectId}-client` ? { id: customerId, projectId, name: 'Synthetische Kundin Änne', email: 'fixture@example.test' } : null });
  return { service, dataDir, scope: { projectId: 'alpha' } };
}

test('financial plan uses effective annual compounding, end-month contributions and exact zero inputs', () => {
  near(plan({ initialCapital: 10000, monthlyContribution: 0, annualReturn: 10 }).summary.finalCapital, 11000);
  near(plan({ initialCapital: 1000, monthlyContribution: 100, annualReturn: 0 }).summary.finalCapital, 2200);
  near(plan({ initialCapital: 1000, monthlyContribution: 100, annualReturn: 10 }).summary.finalCapital, adviceFutureValue(1000, 100, 10, 12));
  const zero = plan({ initialCapital: 0, monthlyContribution: 0, savingMonths: 0 }); assert.equal(zero.summary.finalCapital, 0); assert.equal(zero.points.length, 1);
  near(plan({ initialCapital: 10000, monthlyContribution: 0, annualReturn: -10 }).summary.finalCapital, 9000);
});
test('costs, gain-only assumed tax, contribution increases and real purchasing power are explicit', () => {
  near(plan({ initialCapital: 10000, monthlyContribution: 0, annualReturn: 10, annualCost: 2 }).summary.finalCapital, 10780);
  const taxed = plan({ initialCapital: 10000, monthlyContribution: 0, annualReturn: 10, taxRate: 25 }); near(taxed.summary.tax, 250); near(taxed.summary.finalCapital, 10750);
  assert.equal(plan({ annualReturn: -10, taxRate: 25 }).summary.tax, 0);
  near(plan({ initialCapital: 0, monthlyContribution: 100, annualReturn: 0, savingMonths: 24, contributionGrowth: 10 }).summary.paidIn, 2520);
  near(plan({ initialCapital: 10000, monthlyContribution: 0, annualReturn: 0, inflation: 10 }).summary.finalRealCapital, 10000 / 1.1);
  const mixed = plan({ initialCapital: 10000, monthlyContribution: 100, annualReturn: 5, initialCostPercent: 2, contributionCostPercent: 3, monthlyFixedCost: 5 });
  near(mixed.summary.finalCapital, mixed.summary.paidIn + mixed.summary.investmentReturn - mixed.summary.costs - mixed.summary.tax);
});
test('withdrawal depletion reports only unpaid withdrawals and conserves cash flows', () => {
  const full = plan({ initialCapital: 12000, monthlyContribution: 0, savingMonths: 0, drawdownMonths: 12, monthlyWithdrawal: 1000, drawdownReturn: 0, withdrawalGrowth: 0 });
  near(full.summary.paidOut, 12000); assert.equal(full.summary.depletionMonth, null); near(full.summary.finalCapital, 0);
  const depleted = plan({ initialCapital: 12000, monthlyContribution: 0, savingMonths: 0, drawdownMonths: 13, monthlyWithdrawal: 1000, drawdownReturn: 0, withdrawalGrowth: 0 });
  assert.equal(depleted.summary.depletionMonth, 13); near(depleted.summary.unmetWithdrawals, 1000);
  const empty = plan({ initialCapital: 0, monthlyContribution: 0, monthlyFixedCost: 5 }); near(empty.summary.uncollectedFixedCosts, 60); assert.ok(empty.warnings.length);
});
test('missing, nonfinite, negative capital and fractional-month inputs cannot become valid plans', () => {
  for (const [key, value] of [['initialCapital', -1], ['savingMonths', 1.5], ['savingMonths', Infinity], ['annualReturn', -100], ['annualCost', 100], ['taxRate', 101], ['monthlyContribution', NaN], ['inflation', '']]) assert.equal(plan({ [key]: value }).status, 'data-required');
  assert.equal(calculateFinancialPlan({}).status, 'data-required');
});
test('rankings are evidence- and validity-based, use gross annual costs and ignore favorites', () => {
  const { record } = comparisonFixture(); const result = evaluateInsuranceCase(record, { now: NOW, favorites: [{ category: 'sach', provider: 'Testversicherer two', tariff: 'Synthetischer Testtarif' }] });
  assert.deepEqual(result.ranking.map(row => row.id), ['one', 'two']); assert.equal(result.ranking[1].favorite, true); assert.equal(result.ranking[0].annualDifferenceFromOld, 30); assert.equal(result.liveQuotes, false);
  record.offers[0].premium.frequency = 'monthly'; record.offers[0].premium.amount = 10; near(evaluateInsuranceCase(record, { now: NOW }).offers[0].annualGross, 120);
  record.offers[0].origin = 'scenario'; assert.equal(evaluateInsuranceCase(record, { now: NOW }).offers[0].eligible, false);
});
test('unknown, unreviewed, expired, unmatched risk and failed mandatory criteria stay out of ranking', () => {
  for (const mutate of [r => delete r.offers[0].facts['criterion-1'], r => r.offers[0].facts['criterion-1'].evidence.reviewed = false, r => r.offers[0].validUntil = '2026-09-15T12:00:00Z', r => r.offers[0].issuedAt = '2026-09-17T12:00:00Z', r => r.offers[0].riskConfirmed = false, r => r.offers[0].premium.includesTax = false, r => r.offers[0].premium.feesConfirmed = false, r => { r.criteria[0].mandatory = true; r.offers[0].facts['criterion-1'].value = false; }]) {
    const { record } = comparisonFixture(); mutate(record); const result = evaluateInsuranceCase(record, { now: NOW }); assert.equal(result.offers[0].eligible, false); assert.ok(result.offers[0].reasons.length);
  }
  const { record } = comparisonFixture(); delete record.offers[0].facts['criterion-1']; const unknown = evaluateInsuranceCase(record, { now: NOW }).offers[0]; assert.equal(unknown.rows[0].status, 'unknown'); assert.deepEqual(unknown.scoreRange, [75, 100]);
});
test('criteria weights and benefit targets control ranking before price', () => {
  const { record, evidence } = comparisonFixture(); record.criteria = [{ id: 'coverage', label: 'Deckung', weight: 70, type: 'higher', target: 5000000, unit: 'EUR' }, { id: 'deductible', label: 'Selbstbehalt', weight: 30, type: 'lower', target: 150, unit: 'EUR' }];
  record.offers[0].facts = { coverage: { value: 2500000, evidence }, deductible: { value: 150, evidence } };
  record.offers[1].facts = { coverage: { value: 5000000, evidence }, deductible: { value: 300, evidence } };
  const result = evaluateInsuranceCase(record, { now: NOW }); assert.equal(result.ranking[0].id, 'two'); near(result.ranking[0].score, 85); near(result.ranking[1].score, 65);
});
test('invented excerpts, changed hashes and impossible quote dates fail; extraction only suggests literal candidates', () => {
  const { record, evidence } = comparisonFixture(); const bad = structuredClone(record.offers[0]); bad.facts['criterion-1'].evidence.excerpt = 'Diese Leistung steht gar nicht hier.';
  assert.throws(() => normalizeContract(bad, record.criteria, record.documents), { code: 'ADVICE_EVIDENCE_MISSING' });
  bad.facts['criterion-1'].evidence = evidence; bad.issuedAt = '2026-02-30T12:00:00Z'; assert.throws(() => normalizeContract(bad, record.criteria, record.documents));
  record.documents[0].sha256 = 'changed'; assert.equal(evaluateInsuranceCase(record, { now: NOW }).ranking.length, 0);
  const candidates = suggestContractEvidence(record.documents[0]); assert.equal(candidates.find(c => c.field === 'premium').value, 120); assert.equal(candidates.find(c => c.field === 'coverage').value, 5000000); assert.ok(candidates.every(c => c.confirmed === false));
});
test('project/customer isolation, optimistic revisions, original upload and secret-free provider metadata', async t => {
  const { service, scope } = await fixture(t); const record = await service.create(scope, { customerId: 'alpha-client', title: 'Test', kind: 'insurance', category: 'kv' });
  await assert.rejects(service.get({ projectId: 'beta' }, record.id), { status: 404 });
  await assert.rejects(service.create(scope, { customerId: 'beta-client', title: 'Wrong', kind: 'finance' }), { status: 404 });
  await assert.rejects(service.update(scope, record.id, { expectedRevision: 0, notes: 'stale' }), { code: 'ADVICE_REVISION_CONFLICT' });
  const uploaded = await service.addDocument(scope, record.id, { expectedRevision: 1, filename: 'Test.txt', contentType: 'text/plain', buffer: Buffer.from(evidenceText) });
  assert.equal(uploaded.revision, 2); assert.equal(uploaded.documents[0].text, undefined); assert.equal(uploaded.documents[0].base64, undefined);
  const document = await service.document(scope, record.id, uploaded.documents[0].id); assert.equal(document.text, evidenceText); assert.ok(document.suggestions.length);
  const provider = await service.configureProvider(scope, 'blau-direkt', { portalUrl: 'https://www.maklerinfo.biz/rechner/bd/example', accessRecorded: true, password: 'not-persisted', token: 'not-persisted' });
  await assert.rejects(service.configureProvider(scope, 'blau-direkt', { portalUrl: 'https://www.maklerinfo.biz/rechner?token=secret' }));
  assert.equal(provider.liveQuotes, false); assert.equal(provider.status, 'portal-link-only'); assert.equal(JSON.stringify(provider).includes('not-persisted'), false);
  const prepared = await service.preparation(scope, record.id, 'blau-direkt'); assert.equal(prepared.submitted, false); assert.equal(prepared.customer.id, 'alpha-client');
  await service.setFavorite(scope, { category: 'kv', provider: 'Test', tariff: 'A', favorite: true }); assert.equal((await service.catalog({ projectId: 'beta' })).favorites.length, 0);
});
test('concurrent revisions have one winner and stale crashed locks recover', async t => {
  const { service, scope, dataDir } = await fixture(t); const record = await service.create(scope, { customerId: 'alpha-client', title: 'Test', kind: 'finance' });
  const attempts = await Promise.allSettled([service.update(scope, record.id, { expectedRevision: 1, notes: 'A' }), service.update(scope, record.id, { expectedRevision: 1, notes: 'B' })]);
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  await fs.writeFile(path.join(dataDir, 'advice-workbench/alpha.lock'), JSON.stringify({ pid: 99999999, nonce: 'dead-test' }));
  assert.equal((await service.update(scope, record.id, { expectedRevision: 2, notes: 'recovered' })).revision, 3);
});
async function formFixture() {
  const doc = await PDFDocument.create(), page = doc.addPage([595, 842]), font = await doc.embedFont(StandardFonts.Helvetica); page.drawText('Synthetische Formularvorlage', { x: 54, y: 780, size: 18, font });
  const form = doc.getForm(), name = form.createTextField('customerName'); name.addToPage(page, { x: 54, y: 700, width: 400, height: 28 }); const check = form.createCheckBox('reviewed'); check.addToPage(page, { x: 54, y: 650, width: 18, height: 18 }); form.updateFieldAppearances(font); return Buffer.from(await doc.save());
}
test('original insurer form remains interactive with verified field values; unknown fields, active and signed content reject', async () => {
  const source = await formFixture(), before = digest(source); const result = await fillAdviceForm({ buffer: source, values: { customerName: 'Änne Beispiel', reviewed: true } });
  assert.equal(digest(source), before); const form = (await PDFDocument.load(result.buffer)).getForm(); assert.equal(form.getTextField('customerName').getText(), 'Änne Beispiel'); assert.equal(form.getCheckBox('reviewed').isChecked(), true); assert.equal((await inspectAdviceForm(result.buffer)).length, 2); assert.equal(result.submitted, false);
  await assert.rejects(fillAdviceForm({ buffer: source, values: { missing: 'x' } }));
  const active = await PDFDocument.load(source); active.catalog.set(PDFName.of('OpenAction'), active.context.obj({ S: 'JavaScript', JS: 'app.alert(1)' })); await assert.rejects(inspectAdviceForm(await active.save()), { code: 'ADVICE_UNSAFE_PDF' });
  const signed = await PDFDocument.load(source); signed.catalog.set(PDFName.of('SyntheticSignature'), signed.context.obj({ ByteRange: [0, 10, 20, 30] })); await assert.rejects(inspectAdviceForm(await signed.save()), { code: 'ADVICE_UNSAFE_PDF' });
});
test('customer PDF contains checked inputs, meaningful cashflow and assumptions with readable German text', async () => {
  const record = { id: 'qa', title: 'Finanzplanung für Änne Beispiel', revision: 1, kind: 'finance', customer: { name: 'Änne Beispiel' }, financeInput: { ...financialPlanDefaults(), savingMonths: 24, drawdownMonths: 24 } };
  const file = await exportAdviceCasePdf(record), extracted = await extractText(new Uint8Array(file.buffer), { mergePages: true }); assert.ok(extracted.totalPages >= 3); assert.match(extracted.text, /Kapital im Zeitverlauf/); assert.match(extracted.text, /keine individuelle Depot/); assert.match(extracted.text, /Änne Beispiel/);
  const comparison = await exportAdviceCasePdf(comparisonFixture().record); assert.equal(comparison.buffer.subarray(0, 5).toString(), '%PDF-');
  if (process.env.IVA_ADVICE_QA_DIR) { await fs.mkdir(process.env.IVA_ADVICE_QA_DIR, { recursive: true }); await fs.writeFile(path.join(process.env.IVA_ADVICE_QA_DIR, 'finance.pdf'), file.buffer); await fs.writeFile(path.join(process.env.IVA_ADVICE_QA_DIR, 'comparison.pdf'), comparison.buffer); await fs.writeFile(path.join(process.env.IVA_ADVICE_QA_DIR, 'form.pdf'), (await fillAdviceForm({ buffer: await formFixture(), values: { customerName: 'Änne Beispiel', reviewed: true } })).buffer); }
});
test('HTTP validates scope, serves PDFs privately and exposes no send or application endpoint', async t => {
  const { service } = await fixture(t), app = express(); app.use(express.json({ limit: '12mb' })); registerAdviceWorkbenchRoutes(app, { service });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/advice/workbench`;
  const created = await fetch(base + '/cases?projectId=alpha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerId: 'alpha-client', kind: 'finance', title: 'HTTP Test' }) }); assert.equal(created.status, 201); const row = await created.json();
  assert.equal((await fetch(base + `/cases/${row.id}?projectId=beta`)).status, 404);
  const report = await fetch(base + `/cases/${row.id}/report.pdf?projectId=alpha`); assert.equal(report.status, 200); assert.equal(report.headers.get('cache-control'), 'no-store'); assert.match(report.headers.get('content-type'), /application\/pdf/);
  assert.equal((await fetch(base + `/cases/${row.id}/send?projectId=alpha`, { method: 'POST' })).status, 404);
  const conflict = await fetch(base + `/cases/${row.id}?projectId=alpha`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'beta', expectedRevision: 1 }) }); assert.equal(conflict.status, 400);
});

test('six broad criteria profiles map to the correct categories and append only explicitly selected stable IDs', () => {
  assert.equal(INSURANCE_CRITERIA_PROFILES.length, 6);assert.equal(new Set(INSURANCE_CRITERIA_PROFILES.flatMap(p=>p.criteria.map(c=>c.id))).size,120);
  for (const category of INSURANCE_CATEGORIES) {
    assert.equal(defaultCriteria(category.id).length,4);
    assert.equal(category.profiles.length,category.id==='sach'?3:1);
    for (const profile of category.profiles) {
      assert.equal(profile.criteria.length,20);assert.ok(profile.criteria.every(c=>c.type==='boolean'&&!c.mandatory));
      const base=defaultCriteria(category.id),snapshot=structuredClone(base),ids=profile.criteria.map(c=>c.id);
      const added=appendInsuranceCriteria(base,{category:category.id,profileId:profile.id,criterionIds:ids});assert.equal(added.length,24);assert.deepEqual(base,snapshot);assert.deepEqual(added.slice(0,4),base);
      added[4].label='Vom Kunden konkretisiertes Ziel';added[4].weight=7;added[4].mandatory=true;
      assert.deepEqual(appendInsuranceCriteria(added,{category:category.id,profileId:profile.id,criterionIds:ids}),added);
      assert.throws(()=>appendInsuranceCriteria(base,{category:category.id,profileId:profile.id,criterionIds:[ids[0],ids[0]]}));
    }
  }
  const phv=INSURANCE_CRITERIA_PROFILES.find(p=>p.id==='phv'),base=defaultCriteria('sach');
  assert.throws(()=>appendInsuranceCriteria(base,{category:'kv',profileId:'phv',criterionIds:[phv.criteria[0].id]}));
  assert.throws(()=>appendInsuranceCriteria(base,{category:'sach',profileId:'phv',criterionIds:['made-up']}));
  const full=appendInsuranceCriteria(base,{category:'sach',profileId:'phv',criterionIds:phv.criteria.map(c=>c.id)});
  const hausrat=INSURANCE_CRITERIA_PROFILES.find(p=>p.id==='hausrat');assert.throws(()=>appendInsuranceCriteria(full,{category:'sach',profileId:'hausrat',criterionIds:hausrat.criteria.map(c=>c.id)}),/30 Kriterien/);assert.equal(full.length,24);
});
test('adding and disabling template criteria preserves existing contract values, reviewed evidence and user weights through save/reload',async t=>{
  const {service,scope}=await fixture(t);let saved=await service.create(scope,{customerId:'alpha-client',title:'Existing case',kind:'insurance',category:'sach'});
  saved=await service.addDocument(scope,saved.id,{expectedRevision:saved.revision,filename:'Original.txt',contentType:'text/plain',buffer:Buffer.from(evidenceText)});
  const old=comparisonFixture().record.oldContract,offer=comparisonFixture().record.offers[0];
  for(const c of [old,offer])for(const proof of [c.premium.evidence,...Object.values(c.facts).map(f=>f.evidence)]){proof.documentId=saved.documents[0].id;proof.sha256=saved.documents[0].sha256;}
  saved.criteria[0].weight=42;saved.criteria[0].label='Bereits konkretisiertes Kundenziel';
  saved=await service.update(scope,saved.id,{expectedRevision:saved.revision,criteria:saved.criteria,oldContract:old,offers:[offer]});
  const originals=structuredClone({oldContract:saved.oldContract,offers:saved.offers,criteria:saved.criteria});
  const profile=INSURANCE_CRITERIA_PROFILES.find(p=>p.id==='phv'),selected=profile.criteria.slice(0,3).map(c=>c.id);
  const expanded=appendInsuranceCriteria(saved.criteria,{category:'sach',profileId:'phv',criterionIds:selected});
  await service.update(scope,saved.id,{expectedRevision:saved.revision,criteria:expanded});saved=await service.get(scope,saved.id);
  assert.deepEqual(saved.oldContract,originals.oldContract);assert.deepEqual(saved.offers,originals.offers);assert.deepEqual(saved.criteria.slice(0,4),originals.criteria);
  let result=evaluateInsuranceCase(await service.exportRecord(scope,saved.id),{now:NOW});assert.equal(result.ranking.length,0);assert.ok(result.offers[0].rows.filter(row=>selected.includes(row.id)).every(row=>row.status==='unknown'));
  for(const c of saved.criteria)if(selected.includes(c.id))c.weight=0;
  await service.update(scope,saved.id,{expectedRevision:saved.revision,criteria:saved.criteria});saved=await service.get(scope,saved.id);
  assert.deepEqual(saved.oldContract,originals.oldContract);assert.deepEqual(saved.offers,originals.offers);result=evaluateInsuranceCase(await service.exportRecord(scope,saved.id),{now:NOW});assert.equal(result.ranking.length,1);
});
