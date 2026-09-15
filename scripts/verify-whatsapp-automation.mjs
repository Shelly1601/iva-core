import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWhatsAppEngine, createWhatsAppCustomers, normalizeWhatsAppPhone } from '../integrations/whatsapp-engine.js';
import { createWhatsAppLedger } from '../integrations/whatsapp-ledger.js';
import { createWhatsAppCalendly } from '../integrations/whatsapp-calendly.js';
import { sendWhatsAppText, extractWhatsAppStatuses, extractWhatsAppMessages } from '../integrations/whatsapp.js';
import { normalizeWhatsAppProfile } from '../integrations/whatsapp-store.js';
import { macMiniAccessMiddleware } from '../device-control/macmini-access.js';

const instant = Date.parse('2026-09-16T09:00:00Z'), slot = '2026-09-17T10:00:00.000Z';
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-whatsapp-')); t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const profile = { id: 'profile-a', projectId: 'a', phoneNumberId: '111111111', enabled: true, task: 'appointment', mode: 'lead', timezone: 'Europe/Berlin', calendlyEventTypeUri: 'https://api.calendly.com/event_types/TYPE1', handoffText: 'Die Beratung klärt das persönlich.', answers: [] };
  const other = { ...profile, id: 'profile-b', projectId: 'b', phoneNumberId: '222222222' }, profileRows = [profile, other], calls = { sent: [], booked: [], readbacks: 0, availability: 0 };
  const profileStore = { resolveWhatsAppProfile: async input => profileRows.find(p => input.profileId ? p.id === input.profileId : p.phoneNumberId === input.phoneNumberId && p.enabled), getWhatsAppProfile: async id => profileRows.find(p => p.id === id), listWhatsAppProfiles: async () => profileRows };
  const calendly = { status: () => ({ configured: true, verified: false }), listEventTypes: async () => ({ events: [] }), availability: async () => { calls.availability++; return { checkedAt: new Date(instant).toISOString(), slots: [{ startTime: slot }], eventType: { uri: profile.calendlyEventTypeUri } }; }, prepareBooking: async b => ({ event_type: b.eventTypeUri, start_time: b.startTime, invitee: { email: b.email } }), createBooking: async b => { calls.booked.push(b); return { eventUri: 'https://api.calendly.com/scheduled_events/E1', inviteeUri: 'https://api.calendly.com/scheduled_events/E1/invitees/I1' }; }, reconcileBooking: async b => { calls.readbacks++; return { status: 'confirmed', verified: true, startTime: b.startTime, email: b.email }; }, ...overrides.calendly };
  const options = { dataDir, getProject: async id => ['a', 'b'].includes(id) ? { id } : null, getCustomers: async projectId => projectId === 'a' ? [{ id: 'customer-a', projectId: 'a', name: 'Test Anna', phone: '+49 170 1111111', email: 'anna@example.test' }] : [], profileStore, calendly, now: () => instant, sendText: async envelope => { calls.sent.push(envelope); return { messages: [{ id: 'out-' + calls.sent.length }] }; }, ...overrides, calendly };
  const engine = createWhatsAppEngine(options);
  let seq = 0; const message = (text, extra = {}) => engine.receive({ verified: true, id: 'in-' + ++seq, phoneNumberId: profile.phoneNumberId, sender: '491701111111', timestamp: String(instant / 1000), text, ...extra });
  return { engine, options, dataDir, profile, other, profileRows, calls, message };
}

test('webhook enqueue is durable before processing, restart resumes without redelivery', async t => {
  const f = await fixture(t); const input = { verified: true, id: 'durable', phoneNumberId: f.profile.phoneNumberId, sender: '491701111111', timestamp: String(instant / 1000), text: 'Termin' };
  const ack = await f.engine.enqueueVerified(input); assert.equal(ack.durable, true); assert.equal(f.calls.sent.length, 0);
  const saved = JSON.parse(await fs.readFile(path.join(f.dataDir, 'whatsapp-automation.json'), 'utf8')); assert.equal(saved.inbound[ack.id].status, 'queued');
  const restarted = createWhatsAppEngine(f.options); await restarted.tick(); assert.equal(f.calls.sent.length, 1); await restarted.enqueueVerified(input); await restarted.tick(); assert.equal(f.calls.sent.length, 1);
});

test('status receipt arriving before outbound response survives until matching readback', async t => {
  const f = await fixture(t); await f.engine.acceptStatuses([{ id: 'out-1', phoneNumberId: f.profile.phoneNumberId, recipient: '491701111111', status: 'delivered', timestamp: String(instant / 1000) }], { verified: true });
  const restarted = createWhatsAppEngine(f.options); await f.message('Termin'); await restarted.tick(); assert.equal((await restarted.listConversations({ projectId: 'a' }))[0].deliveries[0].status, 'delivered');
  await assert.rejects(restarted.acceptStatuses([], {}), { status: 403 });
});

test('crash after outbound attempt never triggers another provider send', async t => {
  const f = await fixture(t); await f.message('Termin'); const store = createWhatsAppLedger({ dataDir: f.dataDir });
  await store.transaction(s => { const id = Object.keys(s.inbound)[0]; s.inbound[id].status = 'ready-to-send'; s.outbound[id].status = 'attempted'; delete s.outbound[id].providerMessageId; });
  await createWhatsAppEngine(f.options).tick(); assert.equal(f.calls.sent.length, 1); assert.equal((await f.engine.listConversations({ projectId: 'a' }))[0].deliveries[0].status, 'uncertain');
});

test('changing event type between suggestion and confirmation requires fresh consent', async t => {
  const f = await fixture(t); for (const text of ['Termin', 'anna@example.test', '1']) await f.message(text);
  f.profile.calendlyEventTypeUri = 'https://api.calendly.com/event_types/OTHER'; const response = await f.message('Buchen'); assert.match(response.reply, /Terminzuordnung.*geändert/); assert.equal(f.calls.booked.length, 0); assert.equal((await f.engine.listConversations({ projectId: 'a' }))[0].phase, 'email');
});

test('deactivated mapping retains queued input and does not send or book', async t => {
  const f = await fixture(t); await f.engine.enqueueVerified({ verified: true, id: 'paused', phoneNumberId: f.profile.phoneNumberId, sender: '491701111111', timestamp: String(instant / 1000), text: 'Termin' }); f.profile.enabled = false;
  await f.engine.tick(); assert.equal(f.calls.sent.length, 0); const s = await createWhatsAppLedger({ dataDir: f.dataDir }).read(); assert.equal(Object.values(s.inbound)[0].status, 'queued'); f.profile.enabled = true; await f.engine.tick(); assert.equal(f.calls.sent.length, 1);
});

test('independent processes serialize ledger changes and preserve all writes', async t => {
  const f = await fixture(t), moduleUrl = new URL('../integrations/whatsapp-ledger.js', import.meta.url).href;
  const code = `import {createWhatsAppLedger} from ${JSON.stringify(moduleUrl)}; const store=createWhatsAppLedger({dataDir:process.argv[1]}); for(let i=0;i<10;i++) await store.transaction(s=>{s.checks.counter=(s.checks.counter||0)+1;});`;
  await Promise.all([promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, f.dataDir]), promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, f.dataDir])]);
  assert.equal((await createWhatsAppLedger({ dataDir: f.dataDir }).read()).checks.counter, 20); assert.equal((await fs.stat(path.join(f.dataDir, 'whatsapp-automation.json'))).mode & 0o777, 0o600);
});

test('project lookup uses complete normalized phones, never a shared suffix', async t => {
  assert.equal(normalizeWhatsAppPhone('0170 1111111'), '491701111111'); assert.notEqual(normalizeWhatsAppPhone('+1 91701111111'), '491701111111');
  const lookup = createWhatsAppCustomers({ listProjects: async () => [{ id: 'a' }, { id: 'b' }], listWorkspaces: async () => [{ id: 'one', data: { projectId: 'a' }, customer: { name: 'One', phone: '0170', email: 'one@example.test' } }, { id: 'two', data: { projectId: 'b' }, customer: { email: 'private@example.test' } }, { id: 'none', customer: { name: 'Unassigned' } }] });
  assert.deepEqual((await lookup('a')).map(c => c.id), ['one']);
  const f = await fixture(t), result = await f.message('Termin', { phoneNumberId: f.other.phoneNumberId }); assert.match(result.reply, /Vor- und Nachnamen/); assert.ok(!result.reply.includes('anna'));
});

test('known customer name is reused, email must be actively stated, only a confirmed slot books', async t => {
  const f = await fixture(t);
  assert.match((await f.message('Ich möchte einen Termin')).reply, /a\*\*\*@example.test/);
  assert.match((await f.message('Ja')).reply, /vollständige E-Mail/); assert.equal(f.calls.availability, 0);
  assert.match((await f.message('anna@example.test')).reply, /laut Calendly aktuell frei/);
  assert.match((await f.message('1')).reply, /Soll ich verbindlich buchen/); assert.equal(f.calls.booked.length, 0);
  assert.match((await f.message('Buchen')).reply, /in Calendly bestätigt/); assert.equal(f.calls.booked.length, 1); assert.equal(f.calls.readbacks, 1);
  await f.message('Buchen'); assert.equal(f.calls.booked.length, 1);
  const conversation = (await f.engine.listConversations({ projectId: 'a' }))[0]; assert.equal(conversation.booking.status, 'confirmed'); assert.equal(conversation.name, 'Test Anna');
  await assert.rejects(f.engine.getBooking('b', conversation.bookingId), { status: 404 });
});

test('concurrent duplicate inbound is persisted and sent once', async t => {
  const f = await fixture(t); const input = { verified: true, id: 'same', phoneNumberId: f.profile.phoneNumberId, sender: '491701111111', timestamp: String(instant / 1000), text: 'Termin' };
  await Promise.all([f.engine.receive(input), f.engine.receive(input), f.engine.receive(input)]); await f.engine.tick(); assert.equal(f.calls.sent.length, 1);
  assert.equal((await f.engine.receive(input)).duplicate, true);
});

test('ambiguous customers are not revealed; project reassignment cannot reuse earlier message IDs', async t => {
  const f = await fixture(t, { getCustomers: async () => [{ id: 'one', projectId: 'a', name: 'Private A', phone: '491701111111' }, { id: 'two', projectId: 'a', name: 'Private B', phone: '491701111111' }] });
  const r = await f.message('Termin', { id: 'old-message' }); assert.match(r.reply, /Vor- und Nachnamen/); assert.ok(!r.reply.includes('Private'));
  f.profile.projectId = 'b'; await assert.rejects(f.message('Termin', { id: 'old-message' }), { status: 409 });
});

test('simulation is isolated and can never book or send even on explicit confirmation', async t => {
  const f = await fixture(t); for (const text of ['Termin', 'anna@example.test', '1', 'Buchen']) await f.message(text, { simulate: true, profileId: f.profile.id });
  assert.equal(f.calls.sent.length, 0); assert.equal(f.calls.booked.length, 0); assert.equal((await f.engine.listConversations({ projectId: 'a' })).length, 0); assert.equal((await f.engine.listConversations({ projectId: 'a', simulate: true }))[0].phase, 'simulation-complete');
});

test('uncertain booking never retries POST and may later become confirmed through readback', async t => {
  let posts = 0, found = false, clock = instant;
  const f = await fixture(t, { now: () => clock, calendly: { createBooking: async () => { posts++; throw new Error('secret-token-not-for-output'); }, reconcileBooking: async () => found ? { status: 'confirmed', verified: true } : { status: 'uncertain', verified: false } } });
  for (const text of ['Termin', 'anna@example.test', '1', 'Buchen']) await f.message(text);
  await f.engine.tick(); await f.message('Buchen'); assert.equal(posts, 1);
  let c = (await f.engine.listConversations({ projectId: 'a' }))[0]; assert.equal(c.phase, 'booking-uncertain'); assert.ok(!JSON.stringify(c).includes('secret-token'));
  found = true; clock += 120000; await f.engine.tick(); assert.match((await f.message('Ist mein Termin bestätigt?')).reply, /bestehende Termin ist bestätigt/); assert.equal(posts, 1);
});

test('media event is durably handed off without claiming to read its contents', async t => {
  const f = await fixture(t); f.profile.task = 'claim'; const rows = extractWhatsAppMessages({ entry: [{ changes: [{ value: { metadata: { phone_number_id: f.profile.phoneNumberId }, messages: [{ id: 'image-1', from: '491701111111', timestamp: String(instant / 1000), type: 'image', image: { id: 'opaque-media-id', mime_type: 'image/jpeg', caption: 'Mein Fenster' } }] } }] }] });
  assert.equal(rows.length, 1); const result = await f.engine.receive({ ...rows[0], verified: true }); assert.match(result.reply, /noch nicht inhaltlich ausgewertet/); const c = (await f.engine.listConversations({ projectId: 'a' }))[0]; assert.equal(c.handoff.priority, 'high'); const s = await createWhatsAppLedger({ dataDir: f.dataDir }).read(); assert.equal(Object.values(s.inbound)[0].media.id, 'opaque-media-id');
});

test('human handoff cannot bypass an unresolved booking and create a second appointment', async t => {
  let posts = 0; const f = await fixture(t, { calendly: { createBooking: async () => { posts++; throw new Error('uncertain'); }, reconcileBooking: async () => ({ status: 'uncertain', verified: false }) } });
  for (const text of ['Termin', 'anna@example.test', '1', 'Buchen', 'Ich brauche einen Berater', 'Termin', 'anna@example.test', '1', 'Buchen']) await f.message(text);
  assert.equal(posts, 1); assert.equal(Object.keys((await createWhatsAppLedger({ dataDir: f.dataDir }).read()).bookings).length, 1);
});

test('provider slot loss causes fresh choices, not invented confirmation', async t => {
  const f = await fixture(t, { calendly: { prepareBooking: async () => { throw Object.assign(new Error('gone'), { code: 'CALENDLY_SLOT_GONE' }); } } });
  for (const text of ['Termin', 'anna@example.test', '1']) await f.message(text);
  assert.match((await f.message('Buchen')).reply, /aktuell frei/); assert.equal(f.calls.booked.length, 0);
});

test('damage facts are only intake; advice creates a visible high priority handoff without coverage promise', async t => {
  const f = await fixture(t); f.profile.task = 'claim';
  assert.match((await f.message('Hallo')).reply, /Was ist passiert/);
  await f.message('Das Kellerfenster ist kaputt'); await f.message('Gestern Abend'); await f.message('Im Keller unseres Hauses, eine Scheibe');
  const result = await f.message('Ist das versichert?'); assert.match(result.reply, /fachliche Prüfung/);
  const c = (await f.engine.listConversations({ projectId: 'a' }))[0]; assert.equal(c.claim.status, 'ready-for-review'); assert.equal(c.handoff.priority, 'high'); assert.equal(c.handoff.status, 'open'); assert.equal(f.calls.booked.length, 0);
});

test('an uncertain outbound result does not resend on redelivery, only matching Meta receipts settle', async t => {
  let sends = 0; const f = await fixture(t, { sendText: async () => { sends++; throw new Error('timeout'); } });
  assert.equal((await f.message('Termin', { id: 'lost' })).status, 'uncertain'); await f.engine.tick(); await f.message('Termin', { id: 'lost' }); assert.equal(sends, 1);
  const g = await fixture(t); await g.message('Termin'); await g.engine.acceptStatuses([{ id: 'out-1', phoneNumberId: g.other.phoneNumberId, recipient: '491701111111', status: 'delivered', timestamp: String(instant / 1000) }], { verified: true }); assert.equal((await g.engine.listConversations({ projectId: 'a' }))[0].deliveries[0].status, 'accepted');
  await g.engine.acceptStatuses([{ id: 'out-1', phoneNumberId: g.profile.phoneNumberId, recipient: '491701111111', status: 'delivered', timestamp: String(instant / 1000) }], { verified: true }); assert.equal((await g.engine.listConversations({ projectId: 'a' }))[0].deliveries[0].status, 'delivered');
});

test('unsigned input and stale service window never send', async t => {
  const f = await fixture(t); await assert.rejects(f.message('Termin', { verified: false }), { status: 403 });
  await f.message('Termin', { timestamp: String((instant - 86400001) / 1000) }); assert.equal(f.calls.sent.length, 0);
  await assert.rejects(sendWhatsAppText({ to: '491701111111', phoneNumberId: '111111111', text: 'Test', env: { WHATSAPP_ACCESS_TOKEN: 'fixture', WHATSAPP_GRAPH_VERSION: 'v99.0' }, fetchImpl: async () => { throw new Error('must not call'); } }), /24-Stunden/);
});

test('profile metadata requires explicit project and valid Calendly scope', () => {
  assert.equal(normalizeWhatsAppProfile({ enabled: true, phoneNumberId: '111111111' }).enabled, false);
  assert.throws(() => normalizeWhatsAppProfile({ projectId: '__proto__' }));
  assert.throws(() => normalizeWhatsAppProfile({ projectId: 'a', calendlyEventTypeUri: 'https://attacker.invalid/event_types/one' }));
  assert.equal(normalizeWhatsAppProfile({ projectId: 'a', task: 'claim', timezone: 'Europe/Berlin' }).task, 'claim');
});

test('Calendly transport uses official endpoints, one POST and independent matching readback', async () => {
  const calls = [], booking = { id: 'booking-fixture', eventTypeUri: 'https://api.calendly.com/event_types/T', startTime: slot, email: 'anna@example.test', name: 'Test Anna', timezone: 'Europe/Berlin', sender: '491701111111' };
  const fetchImpl = async (url, options) => { calls.push({ url, options }); const u = new URL(url); assert.equal(u.origin, 'https://api.calendly.com'); assert.equal(options.redirect, 'error'); assert.ok(!url.includes('secret')); let data;
    if (u.pathname === '/event_types/T') data = { resource: { uri: booking.eventTypeUri, active: true, locations: [], custom_questions: [] } };
    else if (u.pathname === '/event_type_available_times') data = { collection: [{ start_time: slot, status: 'available', invitees_remaining: 1 }] };
    else if (u.pathname === '/invitees') data = { resource: { event: 'https://api.calendly.com/scheduled_events/E', uri: 'https://calendly.com/scheduled_events/E/invitees/I' } };
    else if (u.pathname.endsWith('/invitees/I')) data = { resource: { status: 'active', email: booking.email, event: 'https://api.calendly.com/scheduled_events/E', tracking: { utm_content: booking.id } } };
    else data = { resource: { status: 'active', event_type: booking.eventTypeUri, start_time: slot } };
    return { ok: true, text: async () => JSON.stringify(data) };
  };
  const c = createWhatsAppCalendly({ env: { CALENDLY_TOKEN: 'secret' }, fetchImpl, now: () => instant });
  const prepared = await c.prepareBooking(booking), receipt = await c.createBooking(booking, prepared), verified = await c.verifyBooking(booking, receipt); assert.equal(verified.verified, true); assert.equal(calls.filter(c => c.options.method === 'POST').length, 1); assert.equal(JSON.parse(calls.find(c => c.options.method === 'POST').options.body).tracking.utm_content, booking.id);
  await assert.rejects(c.verifyBooking({ ...booking, email: 'wrong@example.test' }, receipt));
});

test('statuses are extracted without exposing arbitrary provider error strings', () => {
  const result = extractWhatsAppStatuses({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '111111111' }, statuses: [{ id: 'out', recipient_id: '49170', status: 'failed', timestamp: '123', errors: [{ message: 'secret' }] }] } }] }] }); assert.equal(result.length, 1); assert.ok(!JSON.stringify(result).includes('secret'));
});

test('external Meta GET/POST reach signature handlers but no adjacent routes bypass owner auth', () => {
  for (const [method, requestPath, allowed] of [['GET', '/webhooks/whatsapp', true], ['POST', '/webhooks/whatsapp', true], ['DELETE', '/webhooks/whatsapp', false], ['POST', '/webhooks/whatsapp/other', false], ['POST', '/api/whatsapp/automation/profiles', false]]) {
    let passed = false, denied = false; const res = { set: () => res, status: () => res, json: () => { denied = true; } }; macMiniAccessMiddleware({ method, path: requestPath, headers: {} }, res, () => { passed = true; }); assert.equal(passed, allowed); assert.equal(denied, !allowed);
  }
});

test('status distinguishes credentials, signed inbound, accepted send and verified delivery', async t => {
  const f = await fixture(t); assert.equal((await f.engine.status()).evidence.verifiedInbound, false); await f.message('Termin'); const after = await f.engine.status(); assert.equal(after.evidence.verifiedInbound, true); assert.equal(after.evidence.sendAccepted, true); assert.equal(after.evidence.deliveryVerified, false); assert.equal(after.evidence.bookingVerified, false);
});
