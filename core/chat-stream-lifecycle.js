// This tracks a chat response, not completion of a business workflow. Tool
// arguments/results and provider error messages never enter new checkpoints.
const ERROR_MESSAGES = {
  budget_exceeded: 'Das KI-Budget reicht für den nächsten Modellschritt nicht aus.',
  budget_unreconciled: 'Der bisherige Modellverbrauch muss zuerst geklärt werden.',
  budget_usage_unknown: 'Die Modellabrechnung ist unvollständig oder unklar.',
  budget_bound_exceeded: 'Der Modellverbrauch überschreitet die geprüfte Reservierung.',
  budget_storage_locked: 'Die Budgetabrechnung ist momentan gesperrt.',
  budget_storage_invalid: 'Die gespeicherte Budgetabrechnung ist nicht verlässlich lesbar.',
  budget_storage_unavailable: 'Die Budgetabrechnung konnte nicht sicher gespeichert werden.',
  budget_pricing_unknown: 'Für diese Modellroute fehlt eine gültige Preisprüfung.',
  budget_pricing_changed: 'Die Preisobergrenze hat sich geändert; eine neue Reservierung ist nötig.',
  budget_config_invalid: 'Die Budgetkonfiguration ist ungültig.',
  budget_bound_invalid: 'Für die Modellanfrage fehlt eine gültige Kostengrenze.',
  budget_bound_unknown: 'Für diese Modellroute fehlt eine geprüfte Anfragegrenze.',
  budget_extra_charge_unknown: 'Zusätzliche Anbietergebühren sind noch nicht geprüft.',
  budget_reservation_invalid: 'Die Budgetreservierung ist nicht mehr gültig.',
  router_config_invalid: 'Die Modellkonfiguration ist ungültig; keine Ersatzroute wurde aktiviert.',
  model_output_incomplete: 'Die Modellantwort wurde abgeschnitten.',
  chat_stream_incomplete: 'Die Chatantwort wurde nicht vollständig abgeschlossen.',
  chat_stream_aborted: 'Die Chatantwort wurde abgebrochen.',
  chat_stream_failed: 'Die Chatantwort konnte nicht vollständig übertragen werden.',
  chat_checkpoint_failed: 'Der unterbrochene Chatlauf konnte nicht vollständig gespeichert werden.',
};

export function safeChatStreamError(error) {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code
    : error?.name === 'AbortError' ? 'chat_stream_aborted' : 'chat_stream_failed';
  return Object.assign(new Error(ERROR_MESSAGES[code]), { code });
}
const issue = code => safeChatStreamError({ code });
const toolName = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) ? value : null;

export function createChatStreamLifecycle({ abortSignal, finishRun, saveCompleted, saveInterrupted, recordFailure = async () => {} }) {
  let state = 'open';
  let terminalError;
  let terminalWrite;
  let finishEvent;
  let queue = Promise.resolve();
  let steps = 0;
  let calls = 0;
  let results = 0;
  let characters = 0;
  const tools = new Set();
  const enqueue = action => {
    const pending = queue.then(action);
    queue = pending.catch(() => {});
    return pending;
  };
  const checkpoint = () => `Arbeitsstand: ${steps} Modellschritte; ${calls} Werkzeugaufrufe; ${results} Werkzeugrückgaben; ${characters} Antwortzeichen. Chatantwort nicht abgeschlossen. Vor Wiederholung tatsächliche Aktionsbelege prüfen.`;
  const removeAbortListener = () => abortSignal?.removeEventListener('abort', onAbort);

  function fail(error, status = 'failed') {
    // Latch before any await: no later SDK finish callback may reset failure.
    if (terminalError) return terminalWrite;
    terminalError = safeChatStreamError(error);
    state = status;
    removeAbortListener();
    const progress = checkpoint();
    const names = [...tools];
    terminalWrite = enqueue(async () => {
      // Attempt all independent evidence writes even if one store is down.
      const writes = await Promise.allSettled([
        Promise.resolve().then(() => finishRun({ status, error: `${terminalError.code}: ${terminalError.message}`, resultPreview: progress, tools: names })),
        Promise.resolve().then(() => saveInterrupted({ status, error: terminalError, checkpoint: progress })),
        Promise.resolve().then(() => recordFailure(terminalError)),
      ]);
      if (writes.some(write => write.status === 'rejected')) throw issue('chat_checkpoint_failed');
    });
    return terminalWrite;
  }
  function onAbort() {
    // The transport awaits the same persisted outcome; avoid an unhandled
    // rejection when an AbortSignal callback itself cannot be awaited.
    void fail(issue('chat_stream_aborted'), 'stopped').catch(() => {});
  }
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (abortSignal?.aborted) onAbort();

  return {
    fail,
    onError: ({ error }) => fail(error),
    onChunk: ({ chunk }) => {
      if (state !== 'open') return;
      if (chunk?.type === 'text-delta') characters += String(chunk.textDelta || '').length;
      if (chunk?.type === 'tool-call') {
        calls++;
        const name = toolName(chunk.toolName);
        if (name) tools.add(name);
      }
      if (chunk?.type === 'tool-result') results++;
    },
    onStepFinish: () => { if (state === 'open') steps++; },
    onFinish: event => {
      // SDK completion is only a candidate; the full stream must reach EOF
      // without an error before a chat run can be marked completed.
      if (state === 'open') finishEvent = event;
    },
    async complete() {
      if (terminalError) { await terminalWrite; throw terminalError; }
      if (state === 'completed') return;
      if (abortSignal?.aborted) { await fail(issue('chat_stream_aborted'), 'stopped'); throw terminalError; }
      if (!finishEvent || finishEvent.finishReason !== 'stop' || typeof finishEvent.text !== 'string' || !finishEvent.text.trim() || calls > results) {
        await fail(issue('chat_stream_incomplete')); throw terminalError;
      }
      try {
        await enqueue(async () => {
          if (terminalError || state === 'completed') return;
          await saveCompleted(finishEvent);
          if (terminalError) return;
          await finishRun({ status: 'completed', tools: [...tools], resultPreview: finishEvent.text });
          if (!terminalError) state = 'completed';
        });
      } catch (error) { await fail(issue('chat_checkpoint_failed')); throw issue('chat_checkpoint_failed'); }
      if (terminalError) { await terminalWrite; throw terminalError; }
      removeAbortListener();
    },
    status: () => ({ state, errorCode: terminalError?.code || null }),
  };
}

async function writeText(response, text) {
  if (response.destroyed || response.writableEnded) throw issue('chat_stream_aborted');
  if (!response.headersSent) response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (response.write(text)) return;
  await new Promise((resolve, reject) => {
    const clean = () => { response.off('drain', drained); response.off('error', failed); response.off('close', closed); };
    const drained = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(issue('chat_stream_failed')); };
    const closed = () => { clean(); reject(issue('chat_stream_aborted')); };
    response.once('drain', drained); response.once('error', failed); response.once('close', closed);
  });
}

export async function pipeChatTextStream(result, response) {
  // Preserve the existing deterministic direct-answer path.
  if (!result.ivaStreamLifecycle) return result.pipeTextStreamToResponse(response);
  try {
    for await (const part of result.fullStream) {
      if (part.type === 'error') throw part.error;
      if (part.type === 'text-delta') await writeText(response, part.textDelta);
    }
    await result.ivaStreamLifecycle.complete();
    response.end();
  } catch (error) {
    await result.ivaStreamLifecycle.fail(error);
    throw safeChatStreamError(error);
  }
}
