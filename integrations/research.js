import { generateText } from 'ai';
import { chooseModel, chooseModelKey, checkBudget, reserveModelBudget, estimateUsageEUR, recordUsage } from '../core/router.js';

export function parseResearchJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch {}
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('Die Auswertung enthielt kein lesbares Ergebnis.');
}

// Provider choice is reported with the result. A failed provider never becomes
// a fabricated finding; retries retain the original evidence and instructions.
export async function runResearchJson({ system, prompt, task = 'marketing-intelligence', signal, onProgress = async () => {}, env = process.env, maxTokens = 6500 } = {}, dependencies = {}) {
  const choose = dependencies.choose || chooseModel;
  const chooseKey = dependencies.chooseKey || chooseModelKey;
  const generate = dependencies.generate || generateText;
  const check = dependencies.check || checkBudget;
  const reserve = dependencies.reserve || reserveModelBudget;
  const record = dependencies.record || recordUsage;
  const first = choose({ task });
  const variable = { google: 'GEMINI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY' };
  const choices = [first];
  for (const key of ['anthropic:claude-sonnet-4-6', 'google:gemini-3.6-flash']) if (key !== first.key) {
    const provider = key.split(':')[0];
    if (env[variable[provider]]) choices.push(chooseKey(key, { task }));
  }
  const candidates = choices.filter(model => env[variable[model.provider]] || dependencies.generate);
  if (!candidates.length) throw new Error('Für die Auswertung fehlt ein verbundener Modellzugang.');
  const warnings = [];
  const sourcePrompt = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
  if (sourcePrompt.length > 180000) throw new Error('Die Recherche ist für einen einzelnen Auswertungsschritt zu groß.');
  for (const routed of candidates) {
    try {
      let previous = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        const attemptPrompt = attempt
          ? sourcePrompt + '\n\nDeine vorige Antwort war kein gültiges JSON. Liefere dasselbe Ergebnis im geforderten Schema. Vorige Antwort:\n' + previous.slice(0, 18000)
          : sourcePrompt;
        let release;
        try {
          // Every paid invocation, including JSON repair, needs a fresh check
          // and reservation based on the prompt that will actually be sent.
          await check(routed);
          signal?.throwIfAborted();
          release = await reserve(routed, estimateUsageEUR(routed, {
            promptTokens: Math.ceil((attemptPrompt.length + system.length) / 3),
            completionTokens: maxTokens,
          }));
          signal?.throwIfAborted();
          await onProgress({ phase: 'analysis', message: 'IVA wertet die gesammelten Belege aus.', model: routed.key });
          signal?.throwIfAborted();
          const result = await generate({ model: routed.model, system, prompt: attemptPrompt, maxTokens, temperature: 0.2, maxRetries: 0, abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
          // A completed call incurred usage even if cancellation arrived while
          // its response was in flight. Book that usage before propagating it.
          await record(routed, result.usage);
          signal?.throwIfAborted();
          previous = result.text;
          try { return { data: parseResearchJson(result.text), model: routed.key, warnings }; }
          catch (error) { if (attempt) throw error; }
        } finally {
          // Release before the next attempt, next provider, return, or abort.
          if (release) await release();
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error.code === 'budget_exceeded') throw Object.assign(new Error('Das eingerichtete Modellbudget ist ausgeschöpft.'), { code: 'budget_exceeded' });
      warnings.push(`${routed.key} hat keine verwertbare Auswertung geliefert.`);
      await onProgress({ phase: 'provider-unavailable', message: 'Der Modellaufruf war nicht erfolgreich. IVA prüft eine weitere eingerichtete Verbindung.' });
      signal?.throwIfAborted();
    }
  }
  throw new Error('Die Auswertung konnte mit den verbundenen Modellen nicht abgeschlossen werden. Zugang und Guthaben im Verbindungsbereich prüfen.');
}
