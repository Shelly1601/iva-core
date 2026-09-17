// Charge each actual provider request, including tool steps and SDK retries.
// Model selection, source material and output are never cheapened or truncated.
const fail = (code, message) => Object.assign(new Error(message), { code });
const LIMITS = {
  'anthropic:claude-sonnet-4-6': { input: 1000000, output: 65536 },
  'anthropic:claude-haiku-4-5-20251001': { input: 200000, output: 64000 },
  'google:gemini-3.6-flash': { input: 1048576, output: 65536 },
  'groq:openai/gpt-oss-120b': { input: 131072, output: 65536 },
};

export function providerRequestBound(routed, options) {
  const limits = LIMITS[routed.key];
  if (!limits) throw fail('budget_bound_unknown', 'Für dieses Modell fehlt eine geprüfte Anfragegrenze.');
  if (options.mode?.tools?.some(tool => tool.type !== 'function')) {
    throw fail('budget_extra_charge_unknown', 'Kosten für anbieterinterne Werkzeuge sind noch nicht im Budget geprüft.');
  }
  const multimodal = options.prompt?.some(message => Array.isArray(message.content) && message.content.some(part => ['image', 'file'].includes(part.type)));
  // One token per UTF-8 byte plus serialization overhead is a conservative
  // textual bound. Media reserve the entire supported input window instead.
  const inputTokens = multimodal || routed.provider === 'google' ? limits.input : Buffer.byteLength(JSON.stringify({ prompt: options.prompt, mode: options.mode, providerMetadata: options.providerMetadata }), 'utf8') + 8192;
  const output = options.maxTokens;
  if (output != null && (!Number.isSafeInteger(output) || output <= 0)) throw fail('budget_bound_invalid', 'Ungültige Ausgabelänge.');
  // Gemini thinking can consume tokens outside the older SDK's visible limit.
  const outputTokens = routed.provider === 'google' ? limits.output : Math.min(output ?? limits.output, limits.output);
  return { inputTokens, outputTokens };
}

export function completeProviderUsage(routed, result) {
  const usage = result.usage;
  if (routed.provider !== 'anthropic') return usage;
  const extra = result.providerMetadata?.anthropic || {};
  const cache = ['cacheCreationInputTokens', 'cacheReadInputTokens'].reduce((sum, key) => {
    const value = extra[key] ?? 0;
    if (!Number.isSafeInteger(value) || value < 0) throw fail('budget_usage_unknown', 'Ungültiger Cacheverbrauch.');
    return sum + value;
  }, 0);
  return { promptTokens: (usage?.inputTokens ?? usage?.promptTokens) + cache, completionTokens: usage?.outputTokens ?? usage?.completionTokens };
}

export function wrapBudgetedModel(model, routed, { reserve, estimate }) {
  async function admit(options) {
    options.abortSignal?.throwIfAborted();
    const reservation = await reserve(routed, estimate(routed, providerRequestBound(routed, options)));
    try { options.abortSignal?.throwIfAborted(); await reservation.markDispatched(); }
    catch (error) { await reservation.release({ confirmedNotSent: true }); throw error; }
    return reservation;
  }
  async function hold(reservation) { try { await reservation.release(); } catch { /* durable unresolved hold */ } }
  const methods = {
    async doGenerate(options) {
      const reservation = await admit(options);
      try {
        const result = await model.doGenerate(options);
        await reservation.settle(completeProviderUsage(routed, result));
        if (result.finishReason === 'length') throw fail('model_output_incomplete', 'Modellantwort wurde abgeschnitten; kein vollständiges Ergebnis.');
        return result;
      } catch (error) { await hold(reservation); throw error; }
    },
    async doStream(options) {
      const reservation = await admit(options);
      let result;
      try { result = await model.doStream(options); }
      catch (error) { await hold(reservation); throw error; }
      const reader = result.stream.getReader();
      let settled = false;
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              if (!settled) { await hold(reservation); throw fail('budget_usage_unknown', 'Modellstream ohne bestätigte Abrechnung beendet.'); }
              controller.close(); return;
            }
            if (next.value.type === 'finish') {
              await reservation.settle(completeProviderUsage(routed, next.value));
              settled = true;
              if (next.value.finishReason === 'length') throw fail('model_output_incomplete', 'Modellantwort wurde abgeschnitten; kein vollständiges Ergebnis.');
            }
            if (next.value.type === 'error') { await hold(reservation); throw next.value.error; }
            controller.enqueue(next.value);
          } catch (error) { if (!settled) await hold(reservation); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { if (!settled) await hold(reservation); } },
      });
      return { ...result, stream };
    },
  };
  // Bind unmodified provider methods to retain private fields and capabilities.
  return new Proxy(model, { get(target, key) { if (key in methods) return methods[key]; const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value; } });
}
