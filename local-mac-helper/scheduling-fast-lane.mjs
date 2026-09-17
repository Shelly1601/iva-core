import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { planbarSchedulingKey, isoWeekRange, mergePlanbarSchedulingProgress, mergeSchedulingMilestones } from '../operations/customer-scheduling.js';

const read = file => readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
async function save(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
  await rename(temporary, file);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export function canonicalSchedulingExecutionKey(request) {
  if (!/^\d+$/.test(String(request.dealId || ''))) return planbarSchedulingKey(request);
  return createHash('sha256').update(JSON.stringify(['deal', String(request.dealId), Number(request.isoYear), Number(request.week)])).digest('hex');
}

export const SCHEDULING_STEP_BUDGETS = Object.freeze({ claim: 2000, slot: 10000, week: 8000, stage: 10000, minimal: 30000 });
export const MANUALLY_BOOKED_REQUEST = 'a788fb1e-d23b-48e2-91c7-d48ac18d967f';

// Adapter calls are the only system boundary. Every write has a persisted intent;
// an interrupted intent can only be adopted through a fresh target readback.
// withResource must retain ownership on an uncertain write until reconciliation.
export async function runSchedulingFastLane(request, { root, adapters, withResource, onProgress = async () => {}, onIntent = async () => {}, now = Date.now } = {}) {
  if (!root || !adapters || typeof withResource !== 'function') throw Error('Scheduling persistence, adapters and resource leases are required');
  isoWeekRange(request.isoYear, request.week);
  if (!request.customerName || !(request.partnerId || request.partnerPrefix)) throw Error('Scheduling identity missing');
  const key = canonicalSchedulingExecutionKey(request), directory = path.join(root, key);
  const claim = path.join(directory, 'execution'), file = path.join(directory, 'state.json');
  await mkdir(directory, { recursive: true });
  try { await mkdir(claim); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize dead-owner recovery too: a second contender must never rename
    // the newly acquired live execution directory using an earlier stale read.
    const recovery = path.join(directory, 'recovery');
    try { await mkdir(recovery); } catch (race) { if (race.code === 'EEXIST') return { duplicate: true, schedulingKey: key, state: await read(file) }; throw race; }
    try {
      const owner = await read(path.join(claim, 'owner.json'));
      if (!owner || alive(owner.pid)) return { duplicate: true, schedulingKey: key, state: await read(file) };
      await rm(claim, { recursive: true });
      await mkdir(claim);
      // Fill owner before releasing recovery, so an unknown owner stays safe.
      await save(path.join(claim, 'owner.json'), { pid: process.pid, acquiredAt: now() });
    } finally { await rm(recovery, { recursive: true, force: true }); }
  }
  const owner = { pid: process.pid, jobId: request.jobId || `scheduling-${key}`, acquiredAt: now() };
  await save(path.join(claim, 'owner.json'), owner);
  let state = await read(file);
  if (!state && key !== planbarSchedulingKey(request)) {
    // Keep legacy receipts authoritative when adopting resolved deal keys. The
    // canonical execution claim serializes migration across entry channels.
    const aliases = [...new Set([planbarSchedulingKey(request), planbarSchedulingKey({...request, source: undefined}), planbarSchedulingKey({...request, source: 'public-heat-hero'})])];
    const historical = [];
    for (const alias of aliases) {
      const legacyOwner = await read(path.join(root, alias, 'execution', 'owner.json'));
      if (legacyOwner && alive(legacyOwner.pid)) { await rm(claim,{recursive:true,force:true}); return {duplicate:true,schedulingKey:key,legacyOwner:true}; }
      const candidate = await read(path.join(root, alias, 'state.json'));
      if(candidate) historical.push(candidate);
    }
    if(historical.length > 1 && new Set(historical.map(item=>item.reservation?.appointmentId).filter(Boolean)).size > 1) {
      await rm(claim,{recursive:true,force:true}); throw Error('Conflicting legacy reservations require reconciliation');
    }
    state = historical.find(item=>item.milestones?.pipedriveStage) || historical.find(item=>item.reservation) || historical[0] || null;
    if (state) {
      if(state.dealId && state.dealId!==String(request.dealId)){await rm(claim,{recursive:true,force:true});throw Error('Legacy receipt belongs to another deal');}
      state = {...state,migratedFrom:state.schedulingKey,schedulingKey:key};
    }
  }
  if (!state) {
    const receivedAt = Date.parse(request.createdAt || '') || now();
    state = { version: 1, schedulingKey: key, legacySchedulingKey: planbarSchedulingKey(request), jobId: owner.jobId, requestId: request.requestId || request.id,
      receivedAt, claimedAt: now(), deadlineAt: receivedAt + 30 * 60_000, queueDelayMs: Math.max(0, now() - receivedAt),
      status: 'claimed', intents: {}, milestones: {}, stepDurationMs: {}, attempts: 0 };
  }
  state.legacySchedulingKey ||= planbarSchedulingKey(request);
  state.attempts++;
  const persist = async status => {
    state.sequence = (state.sequence || 0) + 1; state.status = status; state.totalDurationMs = Math.max(0, now() - state.receivedAt);
    state.slaViolated = state.totalDurationMs > (state.minimalVerifiedAt ? 30 * 60_000 : 30_000);
    state.updatedAt = now(); await save(file, state); await onProgress(structuredClone(state));
  };
  const verified = proof => proof?.verified === true && Number.isFinite(Date.parse(proof.verifiedAt));
  async function step(name, scope, action) {
    const started = now();
    try { return await withResource(scope, action, { jobId: state.jobId, priority: 100, criticalSection: name }); }
    finally { state.stepDurationMs[name] = (state.stepDurationMs[name] || 0) + now() - started; await save(file, state); }
  }
  async function intent(name, value) { state.intents[name] = { ...value, attemptedAt: now() }; await persist(`${name}_intent`); await onIntent(name, structuredClone(state)); }
  try {
    await persist('reconciling');
    if (!state.reservation) await step('slot', 'planbar-write', async () => {
      const observation = await adapters.planbar.findExisting(request, state.intents.slot);
      if (observation?.ambiguous || observation?.conflictingAppointment) throw Error('Planbar target ambiguous or an existing appointment conflicts');
      let target = observation?.appointment;
      if (!target) {
        if (state.intents.slot || request.adoptExisting === true || state.requestId === MANUALLY_BOOKED_REQUEST) throw Error('Planbar intent/manual appointment requires readback; creating a replacement is forbidden');
        if (observation?.absenceVerified !== true || observation?.identityVerified !== true || observation?.capacityVerified !== true) throw Error('Planbar identity, duplicate search and capacity must be verified before writing');
        await intent('slot', { schedulingKey: key });
        target = await adapters.planbar.create(request, observation);
      }
      const proof = await adapters.planbar.read(target, request);
      if (proof?.isoYear !== Number(request.isoYear) || proof?.week !== Number(request.week)) throw Error('Planbar readback week differs from request');
      state.reservation = mergePlanbarSchedulingProgress(null, { status: 'reserved', reservation: proof }).reservation;
      state.slotDurationMs = now() - state.claimedAt;
      await persist('slot_verified');
    });
    if (!state.milestones.pipedriveWeek) await step('week', 'pipedrive-write', async () => {
      const expected = `KW${String(Number(request.week)).padStart(2, '0')}`;
      let deal = await adapters.pipedrive.read(request);
      if (!deal?.identityVerified || !/^\d+$/.test(String(deal.dealId))) throw Error('Pipedrive deal identity not verified');
      if (state.dealId && state.dealId !== String(deal.dealId)) throw Error('Pipedrive deal changed during recovery');
      state.dealId = String(deal.dealId);
      if (deal.week !== expected) {
        if (state.intents.week) throw Error('KW write outcome requires reconciliation');
        await intent('week', { dealId: state.dealId, value: expected });
        await adapters.pipedrive.writeWeek(state.dealId, expected);
        deal = await adapters.pipedrive.read(request);
      }
      if (deal.week !== expected || !verified(deal) || String(deal.dealId) !== state.dealId) throw Error('KW readback failed');
      state.milestones = mergeSchedulingMilestones(state.milestones, { pipedriveWeek: { dealId: state.dealId, value: expected, verified: true, verifiedAt: deal.verifiedAt } }, state.reservation);
      await persist('week_verified');
    });
    if (!state.milestones.pipedriveStage) await step('stage', 'pipedrive-write', async () => {
      let deal = await adapters.pipedrive.read(request);
      if (!deal?.identityVerified || String(deal.dealId) !== state.dealId || deal.week !== state.milestones.pipedriveWeek.value) throw Error('CRM identity or KW no longer matches');
      let transition = state.intents.stage;
      if (!transition) {
        const order = deal.visibleStageOrder?.map(String), from = String(deal.stageId), index = order?.indexOf(from);
        if (!order || new Set(order).size !== order.length || index < 0 || !order[index + 1]) throw Error('No uniquely verified right-hand phase');
        await intent('stage', { dealId: state.dealId, fromStageId: from, toStageId: order[index + 1], visibleStageOrder: order });
        transition = state.intents.stage;
        await adapters.pipedrive.writeStage(state.dealId, transition.fromStageId, transition.toStageId);
        deal = await adapters.pipedrive.read(request);
      }
      // Never derive a second right neighbour after a crash following PUT.
      if (String(deal.stageId) !== transition.toStageId || String(deal.dealId) !== state.dealId || !verified(deal)) throw Error('Phase intent requires target readback; no second transition permitted');
      state.milestones = mergeSchedulingMilestones(state.milestones, { pipedriveStage: { ...transition, verified: true, verifiedAt: deal.verifiedAt } }, state.reservation);
      state.minimalVerifiedAt = now(); state.minimalDurationMs = now() - state.receivedAt;
      state.minimalSlaViolated = state.minimalDurationMs > 30_000;
      await persist('minimal_verified');
    });
    const order = request.orderNumberSource;
    if (!request.orderNumber || order?.kind !== 'signed-offer' || !order.documentId || order.verified !== true) {
      state.remainingActions = ['signed_offer_order_number', 'native_whatsapp', 'details'];
      await persist('minimal_verified_whatsapp_pending'); return state;
    }
    if (!state.milestones.whatsapp) await step('whatsapp', 'native-whatsapp', async () => {
      const message = { app: 'native-whatsapp', community: 'Heat Hero GmbH', group: 'Terminierung Dispo', customerName: request.customerName,
        orderNumber: request.orderNumber, orderNumberSource: order, text: `${request.customerName}, KW ${Number(request.week)}, ${request.orderNumber}` };
      let found = await adapters.whatsapp.find(message, state.intents.whatsapp);
      if (!found?.messageId) {
        if (state.intents.whatsapp || found?.absenceVerified !== true || found?.communityVerified !== true) throw Error('WhatsApp send outcome or community requires reconciliation');
        await intent('whatsapp', { text: message.text, community: message.community, group: message.group });
        found = await adapters.whatsapp.send(message);
      }
      const proof = await adapters.whatsapp.read(found, message);
      if (proof?.text !== message.text || proof?.community !== message.community || proof?.group !== message.group || proof?.app !== 'native-whatsapp' || (proof.customerName && proof.customerName !== request.customerName)) throw Error('WhatsApp target readback mismatch');
      state.milestones = mergeSchedulingMilestones(state.milestones, { whatsapp: { ...message, ...proof } }, state.reservation);
      await persist('whatsapp_verified');
    });
    state.remainingActions = ['details'];
    await persist('fast_lane_verified'); return state;
  } catch (error) {
    state.error = String(error.message).slice(0, 1000);
    await persist('reconciliation_required'); throw error;
  } finally { await rm(claim, { recursive: true, force: true }); }
}
