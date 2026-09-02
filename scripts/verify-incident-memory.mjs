import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-incident-memory-'));
process.env.DATA_DIR = temp;
process.env.IVA_MAC_HELPER_DATA_DIR = path.join(temp, 'local');
const memory = await import(`../operations/incident-memory.js?test=${crypto.randomUUID()}`);
const localMemory = await import(`../local-mac-helper/incident-journal.mjs?test=${crypto.randomUUID()}`);

const base = {
  system: 'imac', workflowId: 'planbar-completion-morning', action: 'browser.read', step: 'load-board',
  error: 'HTTP 401 Bearer super-secret-token-and-more at /Users/nadine/private/file 12345', runId: 'run-1',
};
const first = await memory.recordIncident(base);
assert.equal(first.status, 'open');
assert.equal(first.occurrences, 1);
assert.doesNotMatch(first.error, /super-secret|\/Users\/nadine/);

const resolved = await memory.recordIncident({
  ...base,
  status: 'resolved',
  cause: 'Der lokale Lauf nutzte eine veraltete Geräteauthentifizierung.',
  remedy: 'Die attestierte zentrale Runtime verwenden und die Sitzung erneut prüfen.',
  prevention: 'Vor dem Lauf zentrale Runtime und Authentifizierungsstatus prüfen.',
  evidence: 'Status-Endpunkt lieferte danach HTTP 200.',
  safeToAutoApply: true,
});
assert.equal(resolved.status, 'resolved');
assert.equal(resolved.occurrences, 1);

const lessons = await memory.findPreventiveLessons({ system: 'imac', workflowId: 'planbar-completion-morning', action: 'browser.read' });
assert.equal(lessons.length, 1);
assert.match(lessons[0].prevention, /zentrale Runtime/);

await memory.markPreventiveLessonUsed(resolved.fingerprint, { runId: 'run-2', prevented: true, evidence: 'Preflight erfolgreich.' });
const summary = await memory.incidentMemorySummary();
assert.equal(summary.resolved, 1);
assert.equal(summary.preventedCount, 1);

const localResolved = await localMemory.recordLocalIncident({
  system: 'imac', workflowId: 'planbar-completion-morning', action: 'browser.read', step: 'load-board',
  error: 'Session expired', runId: 'local-run-1', status: 'resolved', cause: 'Sitzung war abgelaufen.',
  remedy: 'Sitzung über den sicheren Login-Helfer erneuern.', evidence: 'Planbar-Board danach sichtbar aktuell.', safeToAutoApply: true,
});
assert.equal((await localMemory.findLocalPreventions({ system: 'imac', workflowId: 'planbar-completion-morning', action: 'browser.read' })).length, 1);
await localMemory.markLocalPreventionUsed(localResolved.fingerprint, { runId: 'local-run-2', prevented: true, evidence: 'Preflight erfolgreich.' });
assert.equal((await localMemory.localIncidentSummary()).preventedCount, 1);

await Promise.all(Array.from({ length: 30 }, (_, index) => memory.recordIncident({
  system: 'railway', workflowId: `parallel-${index % 3}`, action: 'test', step: 'write',
  error: `Parallel failure ${index % 3}`, runId: `parallel-run-${index}`,
})));
const parallel = await memory.listIncidents({ limit: 100 });
assert.ok(parallel.some(item => item.occurrences >= 10));

await fs.writeFile(path.join(temp, 'incident-memory.json'), '{broken json', 'utf8');
const recovered = await memory.incidentMemorySummary();
assert.equal(recovered.total, 0);
assert.equal(recovered.recoveredCorruptions, 1);

await fs.rm(temp, { recursive: true, force: true });
console.log('Incident-memory verification passed.');
