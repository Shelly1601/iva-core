import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-capability-test-'));

const { evaluateCapability, listCapabilityReviews } = await import('../capabilities/evaluator.js');
const { listKnowledgeLibrary, assessKnowledgeSourceCandidate, knowledgeLibraryStatus } = await import('../knowledge/library.js');
const { createCandidateSearchPlan, screenResumeAgainstCriteria, createInterviewGuide } = await import('../recruiting/assistant.js');
const { createOrUpdateWhatsAppHandoff, listWhatsAppHandoffs, updateWhatsAppHandoff } = await import('../integrations/whatsapp-store.js');

const duplicate = evaluateCapability({
  title: 'Noch ein App Builder', problem: 'Prototypen bauen', existingAgent: 'iva-builder',
  expectedRunsPerMonth: 2, minutesSavedPerRun: 30, setupHours: 30, currentCoveragePercent: 90,
  requiresExternalTool: true, officialEvidence: ['https://docs.example.test'], rightsClear: true, securityReviewed: true,
});
assert.equal(duplicate.decision, 'do-not-build');

const unverified = evaluateCapability({ title: 'Unbekanntes Reel-Tool', problem: 'Videos erzeugen', requiresExternalTool: true, rightsClear: false });
assert.equal(unverified.decision, 'reject');
assert.ok(unverified.blockers.length >= 2);
assert.ok(listCapabilityReviews({ decision: 'new-agent-candidate' }).some(item => item.targetAgent === 'iva-recruiting'));

assert.ok(knowledgeLibraryStatus().total >= 6);
assert.ok(listKnowledgeLibrary({ domain: 'recruiting' }).some(item => item.id === 'linkedin-recruiter-help'));
const mitSource = listKnowledgeLibrary({ domain: 'general-learning' }).find(item => item.id === 'mit-ocw');
assert.equal(mitSource.retrievalMode, 'concept-retrieval-with-citations');
assert.ok(mitSource.allowedUse.some(item => /Kurskonzepte/.test(item)));
assert.ok(mitSource.blockedUse.some(item => /nahezu unveraendert/.test(item)));
const sourceCandidate = assessKnowledgeSourceCandidate({
  title: 'Offizielle Testquelle', url: 'https://example.test/docs', publisher: 'Anbieter', rightsBasis: 'Link und Zitat erlaubt',
  intendedUse: 'Live-Referenz', isPrimarySource: true, rightsConfirmed: true,
});
assert.equal(sourceCandidate.status, 'review-ready');
assert.equal(sourceCandidate.mayEnterRetrieval, true);

const search = createCandidateSearchPlan({ role: 'Sales Manager', mustHave: ['B2B Vertrieb', 'CRM'], niceToHave: ['Energie'], locations: ['Bremen'] });
assert.match(search.booleanQuery, /B2B Vertrieb/);
assert.equal(search.mode, 'manual-linkedin-recruiter-search');

const screening = screenResumeAgainstCriteria({
  role: 'Sales Manager',
  cvText: 'Seit 2022 verantworte ich den B2B Vertrieb. In Pipedrive pflege ich das CRM und habe die Abschlussquote verbessert.',
  mustHave: ['B2B Vertrieb', 'CRM'], niceToHave: ['Energie'],
});
assert.equal(screening.result, 'manual-review-required');
assert.equal(screening.mustHave.filter(item => item.status === 'evidenced').length, 2);
assert.match(screening.notice, /keine automatische Absage/i);

const guide = createInterviewGuide({ role: 'Sales Manager', mustHave: ['B2B Vertrieb'], durationMinutes: 45 });
assert.equal(guide.durationMinutes, 45);
assert.ok(guide.agenda.some(item => Array.isArray(item.questions)));

const ticket = await createOrUpdateWhatsAppHandoff({ profileId: 'profile-1', sender: '491749173355', owner: 'Viktoria', reasons: ['claim-review'], priority: 'high', lastMessage: 'Schaden melden' });
assert.equal(ticket.status, 'open');
assert.equal(ticket.priority, 'high');
assert.equal((await listWhatsAppHandoffs({ status: 'open' })).length, 1);
const resolved = await updateWhatsAppHandoff(ticket.id, { status: 'resolved', note: 'Persoenlich uebernommen' });
assert.equal(resolved.status, 'resolved');
assert.ok(resolved.resolvedAt);
const nextTicket = await createOrUpdateWhatsAppHandoff({ id: ticket.id, profileId: 'profile-1', sender: '491749173355', reasons: ['new-request'], lastMessage: 'Neue Anfrage' });
assert.notEqual(nextTicket.id, ticket.id);
assert.equal(nextTicket.status, 'open');

await fs.rm(process.env.DATA_DIR, { recursive: true, force: true });
console.log('PASS Nutzenpruefung, Wissensmediathek, Recruiting und WhatsApp-Tickets');
