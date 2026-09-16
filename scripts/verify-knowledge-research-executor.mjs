import test from 'node:test';
import assert from 'node:assert/strict';
import {
  knowledgeResearchCapabilities, normalizeResearchDomains,
  collectKnowledgeResearch, synthesizeKnowledgeResearch,
} from '../knowledge/research-executor.js';

const plan = { topic: 'Planung', keywords: [], excludeTerms: [], domains: ['example.com'], region: 'Deutschland', objective: 'Methoden prüfen', category: 'Allgemein', maxSources: 2 };
const pageText = 'Eine öffentlich beschriebene Methode unterstützt die Planung verschiedener Aufgaben. Dabei werden Ziele, Zuständigkeiten, Termine, Abhängigkeiten, Ressourcen, Messgrößen, Erfahrungen und offene Fragen systematisch dokumentiert. Verantwortliche prüfen regelmäßig Ergebnisse und korrigieren erkennbare Probleme. Die vorgestellten Arbeitsschritte enthalten konkrete Beispiele, nützliche Werkzeuge, nachvollziehbare Annahmen sowie wichtige Grenzen für unterschiedliche betriebliche Situationen.';
const searchResult = { results: [{ url: 'https://example.com/research', title: 'Öffentliche Methode' }] };
const read = async url => ({ url, title: 'Öffentliche Methode', text: pageText });
const prefix = error => error.code?.startsWith('KNOWLEDGE_RESEARCH_');
const collected = (quote, extra = '') => ({ sources: [{ id: 'S1', url: 'https://example.com/research', title: 'Quelle', text: `${quote} ${extra}`, hash: 'test', kind: 'page-read' }], limitations: [] });
const synthesize = (text, quote, extra = '', other = {}) => synthesizeKnowledgeResearch(plan, collected(quote, extra), {
  synthesize: async () => ({ title: 'Geprüfte Planung', findings: [{ text, quote, sourceId: 'S1' }], limitations: [], ...other }),
});

test('capabilities expose ready/message/missing and obey the supplied environment', () => {
  const routed = { key: 'google:test', provider: 'google' };
  const missing = knowledgeResearchCapabilities({ env: {}, routed });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missing, ['TAVILY_API_KEY', 'GEMINI_API_KEY']);
  assert.match(missing.message, /Websuche und Modellzugang/);
  const ready = knowledgeResearchCapabilities({ env: { TAVILY_API_KEY: 'test-search', GOOGLE_API_KEY: 'test-model' }, routed });
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missing, []);
  assert.equal(ready.searchReady, true);
  assert.equal(ready.modelReady, true);
  assert.match(ready.message, /bereit/);
  assert.equal(knowledgeResearchCapabilities({ env: {}, search: async () => [], synthesize: async () => ({}) }).ready, true);
});

test('domain validation reports only knowledge-specific errors', () => {
  for (const value of ['example.com', ['https://example.com'], ['127.0.0.1'], ['localhost.local'], ['example.com/path']]) {
    assert.throws(() => normalizeResearchDomains(value), prefix);
  }
  assert.deepEqual(normalizeResearchDomains(['www.example.com', 'example.com', 'docs.example.com']), ['example.com', 'docs.example.com']);
});

test('search uses the injected key, fixed endpoint, domain filter, no redirects and no source-body hints', async () => {
  const calls = [];
  const result = await collectKnowledgeResearch(plan, { env: { TAVILY_API_KEY: 'injected-only-test-key' }, read,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(searchResult), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.tavily.com/search');
    assert.equal(call.options.redirect, 'error');
    assert(call.options.signal instanceof AbortSignal);
    const body = JSON.parse(call.options.body);
    assert.equal(body.api_key, 'injected-only-test-key');
    assert.deepEqual(body.include_domains, ['example.com']);
    assert.equal(body.max_results, 8);
    assert.equal(body.include_raw_content, false);
    assert.equal(body.include_answer, false);
  }
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].kind, 'page-read');
  assert(!JSON.stringify(result).includes('injected-only-test-key'));
});

test('missing injected search credentials do not fall back to process environment or network', async () => {
  let calls = 0;
  await assert.rejects(collectKnowledgeResearch(plan, { env: {}, fetchImpl: async () => { calls++; } }), error => error.code === 'KNOWLEDGE_RESEARCH_SEARCH_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('pre-aborted collection never starts search', async () => {
  const controller = new AbortController(); controller.abort('private abort reason');
  let calls = 0;
  await assert.rejects(collectKnowledgeResearch(plan, { signal: controller.signal, search: async () => { calls++; } }), error => error.code === 'KNOWLEDGE_RESEARCH_ABORTED' && !error.message.includes('private'));
  assert.equal(calls, 0);
});

test('abort stops a pending provider fetch and prevents a second paid query', async () => {
  const controller = new AbortController(); let calls = 0, providerSignal;
  const promise = collectKnowledgeResearch(plan, { env: { TAVILY_API_KEY: 'test' }, signal: controller.signal,
    fetchImpl: async (_url, options) => { calls++; providerSignal = options.signal; controller.abort(); return new Promise(() => {}); },
  });
  await assert.rejects(promise, error => error.code === 'KNOWLEDGE_RESEARCH_ABORTED');
  assert.equal(calls, 1);
  assert.equal(providerSignal.aborted, true);
});

test('abort during response-body streaming cancels the reader and stops collection', async () => {
  const controller = new AbortController(); let cancelled = false, calls = 0;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"results":')); }, cancel() { cancelled = true; } });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(collectKnowledgeResearch(plan, { env: { TAVILY_API_KEY: 'test' }, signal: controller.signal,
      fetchImpl: async () => { calls++; return new Response(stream, { status: 200 }); },
    }), error => error.code === 'KNOWLEDGE_RESEARCH_ABORTED');
  } finally { clearTimeout(timer); }
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});

test('oversize search responses and failed providers never become source evidence or leak messages', async () => {
  let reads = 0, calls = 0;
  await assert.rejects(collectKnowledgeResearch(plan, { env: { TAVILY_API_KEY: 'test' }, read: async () => { reads++; },
    fetchImpl: async () => { calls++; return new Response('{}', { status: 200, headers: { 'Content-Length': String(2 * 1024 * 1024) } }); },
  }), error => error.code === 'KNOWLEDGE_RESEARCH_NO_READABLE_SOURCES' && /ausreichend öffentlich lesbar/.test(error.message));
  assert.equal(reads, 0); assert.equal(calls, 2);
  await assert.rejects(collectKnowledgeResearch(plan, { search: async () => { throw new Error('private-key-test'); } }), error => prefix(error) && !error.message.includes('private-key-test'));
});

test('injected search receives env and signal; off-domain redirects and unreadable pages are rejected', async () => {
  const env = { TAVILY_API_KEY: 'test' }, controller = new AbortController();
  await assert.rejects(collectKnowledgeResearch(plan, { env, signal: controller.signal,
    search: async (_query, options) => { assert.equal(options.env, env); assert.equal(options.signal, controller.signal); return searchResult.results; },
    read: async () => ({ url: 'https://different.example.net/source', title: 'Quelle', text: pageText }),
  }), error => error.code === 'KNOWLEDGE_RESEARCH_NO_READABLE_SOURCES');
  await assert.rejects(collectKnowledgeResearch(plan, { search: async () => searchResult.results,
    read: async url => ({ url, title: 'Login', text: pageText }),
  }), error => error.code === 'KNOWLEDGE_RESEARCH_NO_READABLE_SOURCES');
});

test('grounding rejects changed numeric values, percentages, dates, signs and spelled-out values', async () => {
  for (const [text, quote] of [
    ['Die gemessene Verbesserung beträgt 12 % im Versuch.', 'Die gemessene Verbesserung beträgt 3 % im Versuch.'],
    ['Die Studie dokumentiert 12 abgeschlossene Projekte.', 'Die Studie dokumentiert 112 abgeschlossene Projekte.'],
    ['Die gemessene Verbesserung beträgt 12 % im Versuch.', 'Die gemessene Verbesserung beträgt 12 Prozentpunkte im Versuch.'],
    ['Der Versuch endet am 12.03.2026 laut Dokumentation.', 'Der Versuch endet am 03.12.2026 laut Dokumentation.'],
    ['Der Versuch endet am 2026-03-12 laut Dokumentation.', 'Der Versuch endet am 2026-12-03 laut Dokumentation.'],
    ['Die beobachtete Veränderung beträgt -12 im Versuch.', 'Die beobachtete Veränderung beträgt 12 im Versuch.'],
    ['Die gemessene Verbesserung beträgt zwölf Prozent.', 'Die gemessene Verbesserung beträgt 3 % im Versuch.'],
    ['Die gemessene Verbesserung beträgt 3,2 % im Versuch.', 'Die gemessene Verbesserung beträgt 32 % im Versuch.'],
  ]) await assert.rejects(synthesize(text, quote), error => error.code === 'KNOWLEDGE_RESEARCH_NO_GROUNDED_FINDINGS', text);
});

test('a number elsewhere in the source or in a different source cannot support the assigned quote', async () => {
  const quote = 'Die gemessene Verbesserung beträgt 3 % im Versuch.';
  await assert.rejects(synthesize('Die gemessene Verbesserung beträgt 12 % im Versuch.', quote, 'Ein anderer Versuch zeigt 12 % Verbesserung.'), error => error.code === 'KNOWLEDGE_RESEARCH_NO_GROUNDED_FINDINGS');
  const data = collected(quote); data.sources.push({ id: 'S2', text: 'Ein anderer Versuch zeigt 12 % Verbesserung.' });
  await assert.rejects(synthesizeKnowledgeResearch(plan, data, { synthesize: async () => ({ findings: [{ sourceId: 'S1', text: 'Der Versuch liefert 12 % Verbesserung.', quote }] }) }), error => error.code === 'KNOWLEDGE_RESEARCH_NO_GROUNDED_FINDINGS');
});

test('quoted percentages may use the percent word while keeping the exact numeric value', async () => {
  const quote = 'Die gemessene Verbesserung beträgt 3 % im Versuch.';
  const result = await synthesize('Im Versuch wurde eine Verbesserung von 3 Prozent festgestellt.', quote);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(Object.keys(result).sort(), ['findings', 'limitations', 'model', 'title']);
  assert.equal(result.sources, undefined);
});

test('direct quotations are limited to 25 words per source, summed across its findings', async () => {
  const first = 'Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu';
  const second = 'Omikron Pi Rho Sigma Tau Ypsilon Phi Chi Psi Omega Planung Wissen Prüfung';
  const result = await synthesizeKnowledgeResearch(plan, collected(first, second), { synthesize: async () => ({ findings: [
    { sourceId: 'S1', text: 'Die Methode beschreibt nachvollziehbare Arbeitsschritte.', quote: first },
    { sourceId: 'S1', text: 'Die Methode unterstützt eine strukturierte Prüfung.', quote: second },
  ] }) });
  assert.equal(result.findings.length, 1);
  assert.match(result.limitations.join(' '), /verworfen/);
});

test('exactly 25 quoted words are accepted and 26 words are rejected', async () => {
  const words = Array.from({ length: 26 }, () => 'Beleg');
  assert.equal((await synthesize('Die Methode beschreibt nachvollziehbare Arbeitsschritte.', words.slice(0, 25).join(' '))).findings.length, 1);
  await assert.rejects(synthesize('Die Methode beschreibt nachvollziehbare Arbeitsschritte.', words.join(' ')), error => error.code === 'KNOWLEDGE_RESEARCH_NO_GROUNDED_FINDINGS');
});

test('unsupported numeric headlines fall back to the requested topic and full source bodies are absent', async () => {
  const quote = 'Die gemessene Verbesserung beträgt 3 % im Versuch.';
  const result = await synthesize('Im Versuch wurde eine Verbesserung von 3 % festgestellt.', quote, 'PRIVATE_SOURCE_BODY_MARKER', { title: '12 % Verbesserung' });
  assert.equal(result.title, plan.topic);
  assert(!JSON.stringify(result).includes('PRIVATE_SOURCE_BODY_MARKER'));
});

test('model errors and budget exhaustion are safe and namespaced', async () => {
  await assert.rejects(synthesizeKnowledgeResearch(plan, collected(pageText), { synthesize: async () => { throw new Error('private-model-key'); } }), error => error.code === 'KNOWLEDGE_RESEARCH_SYNTHESIS_FAILED' && !error.message.includes('private-model-key'));
  await assert.rejects(synthesizeKnowledgeResearch(plan, collected(pageText), {
    routed: { key: 'anthropic:test', provider: 'anthropic' }, check: async () => { throw Object.assign(new Error('private-budget-data'), { code: 'budget_exceeded' }); },
  }), error => error.code === 'KNOWLEDGE_RESEARCH_BUDGET_EXCEEDED');
});

test('pre-aborted synthesis never starts the model and malformed findings are discarded', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(synthesizeKnowledgeResearch(plan, collected(pageText), { signal: controller.signal, synthesize: async () => { calls++; } }), error => error.code === 'KNOWLEDGE_RESEARCH_ABORTED');
  assert.equal(calls, 0);
  await assert.rejects(synthesizeKnowledgeResearch(plan, collected(pageText), { synthesize: async () => ({ findings: [null, false, {}, 'bad'] }) }), error => error.code === 'KNOWLEDGE_RESEARCH_NO_GROUNDED_FINDINGS');
});
