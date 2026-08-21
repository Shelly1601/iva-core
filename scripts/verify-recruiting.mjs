import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import PDFDocument from 'pdfkit';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-recruiting-'));
const recruiting = await import('../recruiting/store.js');

function createPdf(text) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const document = new PDFDocument({ size: 'A4', margin: 50 });
    document.on('data', chunk => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
    document.fontSize(14).text(text);
    document.end();
  });
}

const role = await recruiting.createRecruitingRole({
  role: 'Sales Manager', project: 'IVA Test', titles: ['Sales Manager', 'Vertriebsberater'],
  mustHave: ['B2B Vertrieb', 'CRM | Pipedrive'], niceToHave: ['Energieberatung'], locations: ['Bremen'], excludedTerms: ['Praktikum'],
});
assert.ok(role.id);
const roleDetail = await recruiting.getRecruitingRole(role.id);
assert.equal(roleDetail.searchPlan.mode, 'manual-linkedin-free-search');
assert.ok(roleDetail.searchPlan.queries.length >= 1);
assert.match(roleDetail.searchPlan.queries[0].query, /NOT Praktikum/);

const candidate = await recruiting.createRecruitingCandidate(role.id, {
  name: 'Erika Beispiel', linkedInUrl: 'https://de.linkedin.com/in/erika-beispiel/?trk=test', headline: 'Sales Manager',
});
assert.equal(candidate.linkedInUrl, 'https://www.linkedin.com/in/erika-beispiel');
assert.equal(candidate.screening, null);
await assert.rejects(() => recruiting.createRecruitingCandidate(role.id, { name: 'Erika Beispiel' }), /bereits angelegt/);
await assert.rejects(() => recruiting.createRecruitingCandidate(role.id, { name: 'Falscher Link', linkedInUrl: 'https://example.com/profil' }), /LinkedIn-Profillink/);
const notesOnly = await recruiting.createRecruitingCandidate(role.id, { name: 'Nur Notiz', notes: 'B2B Vertrieb, Pipedrive und Energieberatung vorhanden' });
assert.equal(notesOnly.screening, null, 'Eigene Notizen duerfen nicht als Kandidatenbeleg zaehlen');

const pdf = await createPdf('Erika Beispiel. Seit 2022 arbeite ich im B2B Vertrieb. Ich pflege alle Verkaufschancen in Pipedrive. Außerdem berate ich Kunden zur Energieberatung.');
const screened = await recruiting.storeRecruitingCandidateDocument(candidate.id, { name: 'LinkedIn-Profil.pdf', mime: 'application/pdf', buffer: pdf });
assert.equal(screened.document.mime, 'application/pdf');
assert.equal(screened.screening.mustHave.filter(item => item.status === 'evidenced').length, 2);
assert.equal(screened.screening.evidenceScore, 100);

const listed = await recruiting.listRecruitingCandidates({ roleId: role.id });
assert.equal(listed.length, 2);
assert.equal(listed[0].profileText, undefined);
const updated = await recruiting.updateRecruitingCandidate(candidate.id, { status: 'interview', notes: 'Telefontermin vereinbaren' });
assert.equal(updated.status, 'interview');
assert.equal((await recruiting.recruitingSummary()).counts.interview, 1);

const storedFile = await recruiting.readRecruitingCandidateDocument(candidate.id);
assert.equal(storedFile.meta.name, 'LinkedIn-Profil.pdf');
assert.ok(storedFile.buffer.length > 100);
assert.equal((await recruiting.deleteRecruitingCandidate(candidate.id)).id, candidate.id);
assert.equal((await recruiting.deleteRecruitingCandidate(notesOnly.id)).id, notesOnly.id);
assert.equal((await recruiting.deleteRecruitingRole(role.id)).id, role.id);
assert.equal((await recruiting.recruitingSummary()).counts.candidates, 0);

await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
console.log('PASS kostenloser Recruiting-MVP');
