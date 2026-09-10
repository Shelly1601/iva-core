import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-planbar-search-'));
process.env.DATA_DIR = tempDir;
const {
  auditPlanbarDescription,
  getPlanbarSearchIndex,
  replacePlanbarSearchIndex,
  searchPlanbarAppointments,
} = await import(`../operations/planbar-search.js?test=${Date.now()}`);

assert.deepEqual(auditPlanbarDescription(''), { completeByFormat: false, gaps: ['missing-description'] });
assert.deepEqual(auditPlanbarDescription('Kunde kann das Material lagern.'), { completeByFormat: false, gaps: ['missing-installation'] });
assert.deepEqual(auditPlanbarDescription('Wärmepumpe Panasonic'), { completeByFormat: false, gaps: ['missing-heat-pump-output'] });
assert.deepEqual(auditPlanbarDescription('10 kW Wärmepumpe'), { completeByFormat: false, gaps: ['missing-heat-pump-manufacturer'] });
assert.deepEqual(auditPlanbarDescription('Kunde kann das Material lagern; 10 kW Panasonic'), { completeByFormat: false, gaps: ['heat-pump-not-first'] });
assert.equal(auditPlanbarDescription('10 kW Panasonic, Kombispeicher').completeByFormat, true);
assert.equal(auditPlanbarDescription('Wärmepumpe: 10 kW Panasonic, Kombispeicher').completeByFormat, true);
assert.deepEqual(auditPlanbarDescription('7 kW Bosch, Neu-Isolierung'), { completeByFormat: false, gaps: ['bosch-model-number'] });
assert.equal(auditPlanbarDescription('7 kW Bosch, Bosch Inneneinheit CS6800IAW12E').completeByFormat, true);
assert.equal(auditPlanbarDescription('7 kW Bosch CS6800iAW 7, Neu-Isolierung').completeByFormat, true);
assert.deepEqual(auditPlanbarDescription('11 kW Vaillant, Außenverrohrung 2 m'), { completeByFormat: false, gaps: ['vaillant-variant'] });
assert.equal(auditPlanbarDescription('11 kW Vaillant Pro, Außenverrohrung 2 m').completeByFormat, true);
assert.equal(auditPlanbarDescription('12 kW Vaillant Plus, Außenverrohrung 2 m').completeByFormat, true);

const snapshot = await replacePlanbarSearchIndex({
  updatedAt: '2026-08-22T15:00:00.000Z',
  rangeStart: '2026-08-21',
  rangeEndExclusive: '2026-10-16',
  appointments: [
    { customerName: 'HH Stefanie Schneider', description: '7 kW Cuderos, Kombispeicher', team: 'Team Vitalij 1', resourceId: 'a', startDate: '2026-09-21', endDateExclusive: '2026-09-26' },
    { customerName: 'HH Max Mustermann', description: 'Panasonic', team: 'Infinity Solution', resourceId: 'b', startDate: '2026-10-05', endDateExclusive: '2026-10-10' },
    { customerName: 'HH Peter Galle', description: 'Kundentermin', team: 'Team Vitalij 1', resourceId: 'c', startDate: '2026-09-07', endDateExclusive: '2026-09-12' },
  ],
});
assert.equal(snapshot.appointmentCount, 3);
const storedIndex = await getPlanbarSearchIndex();
assert.equal(storedIndex.appointments.find(item => item.customerName.includes('Schneider')).week, 39);
assert.equal(storedIndex.descriptionAudit.candidateCount, 2);
assert.deepEqual(
  storedIndex.descriptionAudit.candidates.map(item => item.gaps),
  [['missing-installation'], ['missing-heat-pump-output']],
);

const byName = await searchPlanbarAppointments({ query: 'Schneider' });
assert.equal(byName.count, 1);
assert.equal(byName.matches[0].team, 'Team Vitalij 1');
assert.equal(byName.matches[0].week, 39);

const byDescription = await searchPlanbarAppointments({ query: 'cuderos', weeks: 3, fromDate: '2026-09-07' });
assert.equal(byDescription.count, 1);
assert.equal(byDescription.matches[0].customerName, 'HH Stefanie Schneider');

const byUnprefixedFullName = await searchPlanbarAppointments({ query: 'peter galle' });
assert.equal(byUnprefixedFullName.count, 1, 'ein sichtbares Planbar-Kürzel darf die Namenssuche nicht verhindern');
assert.equal(byUnprefixedFullName.matches[0].customerName, 'HH Peter Galle');

const outsideWindow = await searchPlanbarAppointments({ query: 'Panasonic', weeks: 3, fromDate: '2026-09-07' });
assert.equal(outsideWindow.count, 0);

await assert.rejects(() => searchPlanbarAppointments({ query: 'x' }), /mindestens zwei Zeichen/);

const html = await fs.readFile(new URL('../public/projects.html', import.meta.url), 'utf8');
const js = await fs.readFile(new URL('../public/projects.js', import.meta.url), 'utf8');
const server = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
const workflow = await fs.readFile(new URL('../PLANBAR_VERVOLLSTAENDIGUNG_WORKFLOW.md', import.meta.url), 'utf8');
const enterWorkflow = await fs.readFile(new URL('../PLANBAR_ENTER_AIRTABLE_WORKFLOW.md', import.meta.url), 'utf8');
assert.match(html, /planbar-search/);
assert.match(js, /Planbar-Suche/);
assert.match(js, /planbar\.search\.refresh/);
assert.match(js, /planbar-search\?/);
assert.match(js, /Der durchsuchte Stand ist veraltet/);
assert.match(server, /express\.json\(\{[\s\S]*?limit: '2mb'/, 'Planbar-Snapshots passen sicher durch den begrenzten JSON-Parser');
assert.match(workflow, /zwingende Anlagenbeleg/, 'Die Workflow-Spezifikation verlangt einen tatsächlichen Anlagenbeleg.');
assert.match(workflow, /Bestehende Beschreibungen ergänzen statt verlieren/, 'Bestehende Feldnotizen dürfen nicht pauschal verloren gehen.');
assert.match(workflow, /geprüft und geändert/, 'Manuell geprüfte Beschreibungen sind gegen eine automatische Komplett-Ersetzung geschützt.');
assert.match(enterWorkflow, /Bosch.*Modell/, 'ENTER darf die Bosch-Modellkennung nicht mehr pauschal auslassen.');
assert.match(enterWorkflow, /Bestehende Beschreibungen ergänzen statt verlieren/, 'ENTER übernimmt dieselbe sichere Ergänzungslogik für vorhandene Kundentermine.');

const { collectFreshPlanbarSearchSnapshot, planbarSearchIndexPayload } = await import(`../local-mac-helper/device-agent.mjs?test=${Date.now()}`);
let reloads = 0;
const direct = await collectFreshPlanbarSearchSnapshot({
  collect: async () => ({ updatedAt: '2026-08-29T12:00:00.000Z', appointments: [{ customerName: 'HH Peter Galle' }] }),
  refresh: async () => { reloads += 1; return { refreshedAt: 'never' }; },
});
assert.equal(direct.refreshMode, 'direct-live-read');
assert.equal(direct.sourceCheckedAt, '2026-08-29T12:00:00.000Z');
assert.equal(direct.pageRefreshedAt, null, 'Ein direkter Quellcheck behauptet keinen Seitenreload');
assert.equal(reloads, 0, 'die Live-Lesung wartet nicht unnötig auf einen Planbar-Seitenreload');

let reads = 0;
const fallback = await collectFreshPlanbarSearchSnapshot({
  collect: async () => {
    reads += 1;
    if (reads === 1) throw new Error('Sitzung abgelaufen');
    return { updatedAt: '2026-08-29T12:01:00.000Z', appointments: [{ customerName: 'HH Peter Galle' }] };
  },
  refresh: async () => { reloads += 1; return { refreshedAt: '2026-08-29T12:00:30.000Z' }; },
});
assert.equal(fallback.refreshMode, 'page-reload-fallback');
assert.equal(fallback.sourceCheckedAt, '2026-08-29T12:01:00.000Z');
assert.equal(fallback.pageRefreshedAt, '2026-08-29T12:00:30.000Z');
assert.equal(reads, 2);

const compactPayload = planbarSearchIndexPayload({
  updatedAt: '2026-08-29T12:02:00.000Z',
  rangeStart: '2026-08-24',
  rangeEndExclusive: '2026-12-14',
  appointments: [{ customerName: 'HH Peter Galle' }],
  resources: Array.from({ length: 500 }, (_, id) => ({ id, name: `Team ${id}` })),
  capacityBookings: Array.from({ length: 1000 }, (_, id) => ({ id, text: 'Belegt' })),
  stats: { entries: 1000 },
});
assert.deepEqual(Object.keys(compactPayload).sort(), ['appointments', 'rangeEndExclusive', 'rangeStart', 'updatedAt']);
assert.equal(compactPayload.appointments[0].customerName, 'HH Peter Galle');

await fs.rm(tempDir, { recursive: true, force: true });
console.log('PASS: Planbar-Suche nach Name, Beschreibung, Zeitraum und Team');
