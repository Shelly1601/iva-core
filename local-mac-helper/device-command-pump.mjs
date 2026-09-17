// One urgent admission slot is reserved even while normal commands are in flight.
// A watchdog reports slow work; it never abandons an unresolved writer promise.
export function createDeviceCommandPump({ run, maintenance = async () => {}, onResult = () => {}, onError = () => {}, onIdle = async () => {}, intervalMs = 1000, normalConcurrency = 4, now = Date.now } = {}) {
  if (typeof run !== 'function') throw new TypeError('run required');
  const active = new Map(); let sequence = 0, timer, maintaining = false, lastMaintenance = -Infinity, idleWork = false;
  function launch(lane) {
    const id = ++sequence;
    const entry = { id, lane, startedAt: now() }; active.set(id, entry);
    entry.promise = Promise.resolve().then(() => run({ lane, maintenance: false }))
      .then(onResult, onError).finally(async () => {
        active.delete(id);
        if (!active.size && !idleWork) { idleWork = true; try { await onIdle(); } catch (error) { onError(error); } finally { idleWork = false; } }
      });
  }
  function tick() {
    if (idleWork) return;
    if (![...active.values()].some(item => item.lane === 'urgent')) launch('urgent');
    if ([...active.values()].filter(item => item.lane === 'normal').length < normalConcurrency) launch('normal');
    if (!maintaining && now() - lastMaintenance >= 15000) {
      maintaining = true; lastMaintenance = now();
      Promise.resolve().then(maintenance).catch(onError).finally(() => { maintaining = false; });
    }
  }
  return {
    tick,
    start() { if (!timer) { tick(); timer = setInterval(tick, intervalMs); } },
    async stop() { clearInterval(timer); timer = null; await Promise.allSettled([...active.values()].map(item => item.promise)); },
    snapshot() { return [...active.values()].map(({ id, lane, startedAt }) => ({ id, lane, startedAt, durationMs: now() - startedAt, slow: now() - startedAt > 30000 })); },
  };
}
