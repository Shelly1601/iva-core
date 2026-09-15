import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectPlanbarForecastSource, buildPlanbarForecast } from '../local-mac-helper/planbar-forecast.mjs';
import { refreshPlanbarPage } from '../local-mac-helper/planbar.mjs';
import { assertPlanbarForecastRunCurrent, createForecastDeliveryLedger, deliverValidatedPlanbarForecast, forecastRebuildRequired, recordPlanbarForecastRebuild } from '../local-mac-helper/planbar-forecast-mail.mjs';
import { buildSentVerificationAppleScript } from '../local-mac-helper/outlook.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const mailModule = new URL('../local-mac-helper/planbar-forecast-mail.mjs', import.meta.url).href;
const example = { id: 'one', team: 'Team Eins', start: '2026-09-14 08:00', end: '2026-09-18 18:00', customerName: 'Kunde Eins', task: '8 kW Midea', workAddress: { street: 'Teststraße 1', city: 'Berlin' } };
const rows = buildPlanbarForecast([example], { firstWeek: 38, lastWeek: 47 }).rows;
const run = () => ({ period: 'KW 38-47 / 2026', year: 2026, firstWeek: 38, lastWeek: 47, sender: 'n.sell@heat-hero.com', recipient: 'a.keller@heat-hero.com', subject: 'Planbar-Listen KW 38-47 / 2026', attachments: ['/fixture/gesamt.xlsx', '/fixture/midea.xlsx'], attachmentNames: ['gesamt.xlsx', 'midea.xlsx'], manifest: { totalRows: rows.length, manufacturers: ['Midea'], verification: { excludedResourceLeaks: 0 } }, sourceSnapshot: { source: { collectedAt: new Date().toISOString() }, forecast: { rows } } });
const memory = () => { let log = { entries: [] }; return { loadLog: async () => structuredClone(log), saveLog: async value => { log = structuredClone(value); }, verifyCurrent: async () => ({ exactMatch: true }) }; };
const verified = () => ({ sent: true, sentFolderVerified: true });
async function temporary(t) { const dir = await mkdtemp(path.join(tmpdir(), 'iva-forecast-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test('every source collection reloads first and retains proof alongside uncached data', async () => {
  const order = [], refreshedAt = new Date(Date.now() - 10).toISOString(), collectedAt = new Date().toISOString();
  const source = await collectPlanbarForecastSource({ firstWeek: 38, lastWeek: 47,
    refresh: async () => { order.push('reload'); return { verified: true, refreshedAt }; },
    execute: async script => { order.push('extract'); assert.match(script, /_ivaForecastFresh/); assert.match(script, /no-cache, no-store, max-age=0/); assert.match(script, /url.origin !== location.origin/); return JSON.stringify({ cacheBypass: true, collectedAt, entries: [example] }); },
  });
  assert.deepEqual(order, ['reload', 'extract']);
  assert.equal(source.reloadVerified, true);
  assert.equal(source.planbarRefreshedAt, refreshedAt);
  await assert.rejects(collectPlanbarForecastSource({ refresh: async () => ({ verified: false }), execute: async () => { throw new Error('must not extract'); } }), /Neuladevorgang/);
});

test('reload waits for a new ready document rather than accepting old rendered content', async () => {
  let probes = 0; const calls = [];
  const result = await refreshPlanbarPage({ wait: async () => {}, execute: async script => {
    calls.push(script);
    if (script === 'String(performance.timeOrigin)') return '100';
    if (script.startsWith('location.reload')) return 'RELOADING';
    return JSON.stringify(++probes === 1 ? { origin: 100, ready: true } : probes === 2 ? { origin: 101, ready: false } : { origin: 101, ready: true });
  } });
  assert.equal(result.verified, true); assert.equal(probes, 3); assert.equal(calls.filter(value => value.startsWith('location.reload')).length, 1);
});

test('missing visible resource mapping blocks an export instead of leaking excluded teams', () => {
  assert.throws(() => buildPlanbarForecast([{ ...example, team: '' }], { firstWeek: 38, lastWeek: 47 }), /Planbar-Spalte/);
});

test('freshness requires another reload and detects a moved appointment as actionable rebuild', async () => {
  const input = run(); let collections = 0;
  const fresh = () => ({ source: { collectedAt: new Date().toISOString(), planbarRefreshedAt: new Date(Date.now() - 1).toISOString(), reloadVerified: true, cacheBypass: true }, forecast: { rows, rowCount: rows.length, byManufacturer: { Midea: rows } } });
  const result = await assertPlanbarForecastRunCurrent(input, { collectFreshForecast: async () => { collections += 1; return fresh(); } });
  assert.equal(result.exactMatch, true); assert.equal(collections, 1);
  await assert.rejects(assertPlanbarForecastRunCurrent(input, { collectFreshForecast: async () => { const changed = fresh(); changed.forecast.rows = rows.map(row => ({ ...row, kalenderwoche: 'KW 39', kalenderwocheNummer: 39 })); return changed; } }), error => error.code === 'PLANBAR_FORECAST_REBUILD_REQUIRED' && error.recoverable && error.nextAction === 'rebuild_forecast_same_job');
  await assert.rejects(assertPlanbarForecastRunCurrent(input, { collectFreshForecast: async () => { const stale = fresh(); stale.source.reloadVerified = false; return stale; } }), /erneute Planbar-Abfrage/);
});

test('changed data rebuilds and rechecks within the same delivery identity before one send', async () => {
  const store = memory(); const events = []; const initial = run();
  const result = await deliverValidatedPlanbarForecast(initial, { ...store, deliveryRunKey: 'same-request',
    verifyCurrent: async current => { events.push('check'); if (!current.rebuilt) throw forecastRebuildRequired('Termin verschoben.'); return { exactMatch: true }; },
    rebuildRun: async context => { events.push('rebuild'); assert.equal(context.deliveryRunKey, 'manual:same-request'); assert.equal(context.attempt, 1); return { ...context.run, rebuilt: true, attachments: ['/new/new.xlsx'], attachmentNames: ['new.xlsx'] }; },
    send: async message => { events.push('send'); assert.deepEqual(message.attachments, ['/new/new.xlsx']); return verified(); },
  });
  assert.deepEqual(events, ['check', 'rebuild', 'check', 'send']);
  assert.equal(result.deliveryRunKey, 'manual:same-request');
  assert.deepEqual(result.attachments, ['new.xlsx']);
  assert.equal((await store.loadLog()).entries.length, 1);
});

test('a continuously changing source is bounded and never creates a send claim', async () => {
  const store = memory(); let rebuilds = 0, sends = 0;
  await assert.rejects(deliverValidatedPlanbarForecast(run(), { ...store, deliveryRunKey: 'unstable', verifyCurrent: async () => { throw forecastRebuildRequired('Neue Änderung.'); }, rebuildRun: async ({ run }) => { rebuilds += 1; return run; }, send: async () => { sends += 1; return verified(); } }), error => error.code === 'PLANBAR_FORECAST_REBUILD_REQUIRED');
  assert.equal(rebuilds, 3); assert.equal(sends, 0); assert.equal((await store.loadLog()).entries.length, 0);
});

test('uncertain retries use the original message and fixed attempt window, never rebuilt attachments', async () => {
  const store = memory(); let sends = 0;
  await assert.rejects(deliverValidatedPlanbarForecast(run(), { ...store, deliveryRunKey: 'uncertain', send: async () => { sends += 1; throw new Error('Timeout'); }, verify: async () => { throw new Error('Noch nicht sichtbar'); } }), /ausdrücklich nicht erneut/);
  const original = (await store.loadLog()).entries[0];
  const changed = { ...run(), period: 'KW 39-48 / 2026', subject: 'Falscher neuer Betreff', attachments: ['/later/different.xlsx'], attachmentNames: ['different.xlsx'] };
  const result = await deliverValidatedPlanbarForecast(changed, { ...store, deliveryRunKey: 'uncertain', verifyCurrent: async () => { throw new Error('must not reread Planbar'); }, send: async () => { sends += 1; return verified(); }, verify: async message => {
    assert.equal(message.subject, original.subject); assert.deepEqual(message.attachments, original.attachments);
    assert.equal(message.notBefore, original.verificationNotBefore); assert.equal(message.notAfter, original.verificationNotAfter);
    return { verified: true };
  } });
  assert.equal(sends, 1); assert.equal(result.duplicateVerified, true); assert.equal(result.subject, original.subject);
});

test('parallel calls with cloned logs and durable receipts submit the same request once', async t => {
  const outputRoot = await temporary(t), ledger = createForecastDeliveryLedger({ outputRoot }), store = memory(); let sends = 0;
  const options = { ...store, ledger, deliveryRunKey: 'concurrent', send: async () => { sends += 1; await new Promise(resolve => setTimeout(resolve, 10)); return verified(); } };
  const results = await Promise.all([deliverValidatedPlanbarForecast(run(), options), deliverValidatedPlanbarForecast(run(), options)]);
  assert.equal(sends, 1); assert(results.every(result => result.sentFolderVerified));
  assert.equal((await createForecastDeliveryLedger({ outputRoot }).read('manual:concurrent')).status, 'sent_verified');
});

test('separate processes cannot claim the same persistent delivery', async t => {
  const outputRoot = await temporary(t);
  const script = `import {createForecastDeliveryLedger} from ${JSON.stringify(mailModule)}; const ledger=createForecastDeliveryLedger({outputRoot:${JSON.stringify(outputRoot)}}); console.log(JSON.stringify(await ledger.claim({deliveryRunKey:'manual:cross-process',status:'submission_started',id:String(process.pid)})));`;
  const results = await Promise.all([exec(process.execPath, ['--input-type=module', '-e', script]), exec(process.execPath, ['--input-type=module', '-e', script])]);
  assert.equal(results.map(result => JSON.parse(result.stdout)).filter(result => result.created).length, 1);
});

test('CLI emits a real persisted rebuild marker and repeated attempts remain bounded', async t => {
  const outputRoot = await temporary(t), directory = path.join(outputRoot, '2026-09-15-kw38-47'); await mkdir(directory);
  const filenames = ['Planbar_Gesamtliste_KW38-47_2026.xlsx', 'Planbar_Midea_KW38-47_2026.xlsx'];
  await Promise.all(filenames.map(name => writeFile(path.join(directory, name), 'fixture')));
  const headers = ['Kalenderwoche', 'Kunde', 'Telefon', 'Adresse', 'Anlage'];
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ period: 'KW 38-47 / 2026', files: filenames.map((file, i) => ({ file, label: i ? 'Midea' : 'Gesamtliste', rows: 1 })), verification: { readBack: true, formulaErrors: 0, exactHeaders: headers, renderedSheets: 2, excludedResources: ['David Service', 'Dawid Service', 'Antonio Lausic', 'Antonio Lausich', 'Antonio Lausitsch'], excludedResourceLeaks: 0 } }));
  await writeFile(path.join(directory, 'qa.json'), '[{},{}]');
  await writeFile(path.join(directory, 'forecast-data.json'), JSON.stringify({ source: { entries: [example], collectedAt: new Date().toISOString(), cacheBypass: true }, forecast: { rows } }));
  await assert.rejects(exec(process.execPath, ['local-mac-helper/planbar-forecast-mail.mjs', directory, '--commit', '--delivery-run', 'cli-job'], { cwd: root, env: { ...process.env, IVA_PLANBAR_OUTPUT_ROOT: outputRoot } }), error => { const marker = JSON.parse(error.stdout); return error.code === 3 && marker.code === 'PLANBAR_FORECAST_REBUILD_REQUIRED' && marker.deliveryRunKey === 'manual:cli-job'; });
  const marker = JSON.parse(await readFile(path.join(directory, 'forecast-rebuild-required.json'), 'utf8'));
  assert.equal(marker.runDirectory, path.basename(directory)); assert.equal(marker.attempt, 1); assert.equal(marker.sent, false);
  for (let attempt = 2; attempt <= 4; attempt += 1) {
    const next = await recordPlanbarForecastRebuild(directory, forecastRebuildRequired('Noch geändert.'), { outputRoot, deliveryRunKey: 'cli-job' });
    assert.equal(next.attempt, attempt); assert.equal(next.recoverable, attempt <= 3);
  }
});

test('CLI verifies a persisted sent receipt even when the original export folder no longer exists', async t => {
  const outputRoot = await temporary(t), ledger = createForecastDeliveryLedger({ outputRoot });
  const receipt = { ...run(), id: 'receipt', deliveryRunKey: 'manual:verified-cli', runMode: 'manual', automationSlotKey: '', createdAt: new Date().toISOString(), sentAt: new Date().toISOString(), status: 'sent_verified', sentFolderVerified: true, attachments: ['original.xlsx'] };
  await ledger.claim(receipt);
  const result = await exec(process.execPath, ['local-mac-helper/planbar-forecast-mail.mjs', path.join(outputRoot, 'missing'), '--commit', '--delivery-run', 'verified-cli'], { cwd: root, env: { ...process.env, IVA_PLANBAR_OUTPUT_ROOT: outputRoot } });
  assert.equal(JSON.parse(result.stdout).duplicateVerified, true);
  const script = `import {latestVerifiedPlanbarForecastDelivery as proof} from ${JSON.stringify(mailModule)}; console.log(JSON.stringify([await proof({runMode:'manual',deliveryRunKey:'other'}),await proof({runMode:'manual',deliveryRunKey:'verified-cli'})]));`;
  const proofs = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, IVA_PLANBAR_OUTPUT_ROOT: outputRoot } })).stdout);
  assert.equal(proofs[0], null); assert.equal(proofs[1].deliveryRunKey, 'verified-cli');
});

test('sent verification has a fixed lower and upper bound instead of broadening forever on retry', () => {
  const { script } = buildSentVerificationAppleScript({ from: run().sender, to: [run().recipient], subject: run().subject, attachments: run().attachments, notBefore: '2026-09-15T08:00:01Z', notAfter: '2026-09-15T08:10:01Z' });
  assert.match(script, /set earliestTime to \(current date\) \+/);
  assert.match(script, /set latestTime to \(current date\) \+/);
  assert.match(script, /less than or equal to latestTime/);
  assert.throws(() => buildSentVerificationAppleScript({ from: run().sender, to: [run().recipient], subject: run().subject, attachments: run().attachments, notBefore: 'invalid' }), /zeitfenster/i);
});
