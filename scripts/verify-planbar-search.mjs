import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-planbar-search-'));
process.env.DATA_DIR = tempDir;
const {
  getPlanbarSearchIndex,
  replacePlanbarSearchIndex,
  searchPlanbarAppointments,
} = await import(`../operations/planbar-search.js?test=${Date.now()}`);

const snapshot = await replacePlanbarSearchIndex({
  updatedAt: '2026-08-22T15:00:00.000Z',
  rangeStart: '2026-08-21',
  rangeEndExclusive: '2026-10-16',
  appointments: [
    { customerName: 'HH Stefanie Schneider', description: '7 kW Cuderos, Kombispeicher', team: 'Team Vitalij 1', resourceId: 'a', startDate: '2026-09-21', endDateExclusive: '2026-09-26' },
    { customerName: 'HH Max Mustermann', description: 'Panasonic', team: 'Infinity Solution', resourceId: 'b', startDate: '2026-10-05', endDateExclusive: '2026-10-10' },
  ],
});
assert.equal(snapshot.appointmentCount, 2);
assert.equal((await getPlanbarSearchIndex()).appointments[0].week, 39);

const byName = await searchPlanbarAppointments({ query: 'Schneider' });
assert.equal(byName.count, 1);
assert.equal(byName.matches[0].team, 'Team Vitalij 1');
assert.equal(byName.matches[0].week, 39);

const byDescription = await searchPlanbarAppointments({ query: 'cuderos', weeks: 3, fromDate: '2026-09-07' });
assert.equal(byDescription.count, 1);
assert.equal(byDescription.matches[0].customerName, 'HH Stefanie Schneider');

const outsideWindow = await searchPlanbarAppointments({ query: 'Panasonic', weeks: 3, fromDate: '2026-09-07' });
assert.equal(outsideWindow.count, 0);

await assert.rejects(() => searchPlanbarAppointments({ query: 'x' }), /mindestens zwei Zeichen/);

const html = await fs.readFile(new URL('../public/projects.html', import.meta.url), 'utf8');
const js = await fs.readFile(new URL('../public/projects.js', import.meta.url), 'utf8');
assert.match(html, /planbar-search/);
assert.match(js, /Planbar-Suche/);
assert.match(js, /planbar\.search\.refresh/);
assert.match(js, /planbar-search\?/);

await fs.rm(tempDir, { recursive: true, force: true });
console.log('PASS: Planbar-Suche nach Name, Beschreibung, Zeitraum und Team');
