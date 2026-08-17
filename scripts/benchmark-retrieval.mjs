// Benchmark: Retrieval-Provider fuer deutsche Behoerdenfragen.
// Vergleich: Tavily, Brave Search, Google Custom Search.
// Kein Produktions-Code, kein Import in agents/web.js.
//
// Voraussetzungen (Env-Variablen, in iva-core/.env oder Shell):
//   TAVILY_API_KEY   (bereits vorhanden fuer Produktion)
//   BRAVE_API_KEY    (neu; kostenlos bei api-dashboard.search.brave.com anlegen)
//   GOOGLE_API_KEY   (neu; Google Cloud Console -> API Key)
//   GOOGLE_CSE_ID    (neu; programmablesearchengine.google.com -> neue Engine
//                    mit den 6 Behoerden-Domains als "Sites to search",
//                    dann Search engine ID = cx-Wert)
// Fehlt ein Key, wird der Provider uebersprungen (kein Abbruch).
//
// Ausfuehren:
//   node scripts/benchmark-retrieval.mjs
// Output:
//   scripts/benchmark-retrieval-results.csv + kompakte Konsolen-Tabelle

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 12 typische Behoerdenfragen, mit den fuer die jeweilige Frage
// akzeptablen Behoerden-Domains (Kategorie-spezifisch).
const QUESTIONS = [
  { q: 'Wie hoch ist die aktuelle Jahresarbeitsentgeltgrenze?',
    domains: ['gkv-spitzenverband.de', 'bundesgesundheitsministerium.de', 'bmg.bund.de'] },
  { q: 'Wie hoch war die Jahresarbeitsentgeltgrenze 2025?',
    domains: ['gkv-spitzenverband.de', 'bundesgesundheitsministerium.de', 'bmg.bund.de'] },
  { q: 'Wie hoch ist der Grundfreibetrag 2026?',
    domains: ['bundesfinanzministerium.de', 'bmf.bund.de', 'gesetze-im-internet.de'] },
  { q: 'Wie hoch ist der aktuelle Mindestlohn?',
    domains: ['bmas.de', 'mindestlohn-kommission.de'] },
  { q: 'Was ist die Beitragsbemessungsgrenze in der Rentenversicherung 2026?',
    domains: ['deutsche-rentenversicherung.de', 'bmas.de', 'gkv-spitzenverband.de'] },
  { q: 'Wie hoch war die Rentenanpassung 2025?',
    domains: ['deutsche-rentenversicherung.de', 'bmas.de'] },
  { q: 'Wie hoch ist der Kinderfreibetrag 2026?',
    domains: ['bundesfinanzministerium.de', 'bmf.bund.de', 'gesetze-im-internet.de'] },
  { q: 'Wie hoch ist der allgemeine Beitragssatz zur gesetzlichen Krankenversicherung 2026?',
    domains: ['gkv-spitzenverband.de', 'bundesgesundheitsministerium.de', 'bmg.bund.de'] },
  { q: 'Wie hoch ist der Zusatzbeitrag zur gesetzlichen Krankenversicherung 2026?',
    domains: ['gkv-spitzenverband.de', 'bundesgesundheitsministerium.de', 'bmg.bund.de'] },
  { q: 'Was steht in § 32a EStG?',
    domains: ['gesetze-im-internet.de', 'bundesfinanzministerium.de'] },
  { q: 'Wie hoch ist der Regelbedarf 2026?',
    domains: ['bmas.de', 'bundesgesundheitsministerium.de'] },
  { q: 'Wie hoch ist das maximale Elterngeld?',
    domains: ['bmas.de', 'familienportal.de'] },
];

const RUNS_PER_PAIR = 3;
const PAUSE_MS = 500;

// Helfer
function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}
function isHitDomain(url, domains) {
  const h = hostOf(url);
  return domains.some(d => h === d || h.endsWith('.' + d));
}
function isLexikon(url, title) {
  const s = (String(url || '') + ' ' + String(title || '')).toLowerCase();
  const soft = ['/lexikon', '/glossar', '/glossary', '/faq', '/definition', '/begriff',
    '/ueberblick', '/überblick', '/erklaerung', '/erklärung', '/was-ist', '/was_ist',
    '/wasist', '/wiki', '/ratgeber', '/blog', '/a-z/',
    'was ist ', 'einfach erklärt', 'einfach erklaert'];
  return soft.some(k => s.includes(k));
}
function isGoodHit(hit, domains) {
  return isHitDomain(hit.url, domains) && !isLexikon(hit.url, hit.title);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Provider-Adapter — einheitliches Rueckgabeformat:
// { results: [{url,title,snippet}], durationMs } oder { error, durationMs }
async function tavilySearch(query, domains) {
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: 'advanced',
        include_domains: domains,
        max_results: 10,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { error: `http_${res.status}`, durationMs: Date.now() - t0 };
    const j = await res.json();
    return {
      results: (j.results || []).map(r => ({ url: r.url, title: r.title || '', snippet: r.content || '' })),
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'unknown'), durationMs: Date.now() - t0 };
  }
}

async function braveSearch(query, domains) {
  const siteFilter = domains.map(d => `site:${d}`).join(' OR ');
  const fullQuery = `${query} (${siteFilter})`;
  const t0 = Date.now();
  try {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', fullQuery);
    url.searchParams.set('country', 'DE');
    url.searchParams.set('search_lang', 'de');
    url.searchParams.set('count', '10');
    const res = await fetch(url.toString(), {
      headers: {
        'X-Subscription-Token': process.env.BRAVE_API_KEY,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { error: `http_${res.status}`, durationMs: Date.now() - t0 };
    const j = await res.json();
    return {
      results: (j.web?.results || []).map(r => ({ url: r.url, title: r.title || '', snippet: r.description || '' })),
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'unknown'), durationMs: Date.now() - t0 };
  }
}

async function googleCseSearch(query, domains) {
  // CSE ist vorkonfiguriert mit den 6 Behoerden-Domains als "Sites to search".
  // Optional zusaetzlich per siteSearch auf die erste Kategorie-Domain filtern,
  // um Cross-Category-Rauschen (z.B. BMAS-Treffer bei Grundfreibetrag) zu
  // reduzieren.
  const t0 = Date.now();
  try {
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', process.env.GOOGLE_API_KEY);
    url.searchParams.set('cx', process.env.GOOGLE_CSE_ID);
    url.searchParams.set('q', query);
    url.searchParams.set('num', '10');
    url.searchParams.set('lr', 'lang_de');
    url.searchParams.set('gl', 'de');
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { error: `http_${res.status}`, durationMs: Date.now() - t0 };
    const j = await res.json();
    return {
      results: (j.items || []).map(r => ({ url: r.link, title: r.title || '', snippet: r.snippet || '' })),
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return { error: e?.name === 'TimeoutError' ? 'timeout' : (e?.message || 'unknown'), durationMs: Date.now() - t0 };
  }
}

// Provider-Registry: nur aktivieren, wenn Key vorhanden.
const PROVIDERS = [
  { name: 'tavily', fn: tavilySearch, need: ['TAVILY_API_KEY'] },
  { name: 'brave',  fn: braveSearch,  need: ['BRAVE_API_KEY'] },
  { name: 'google', fn: googleCseSearch, need: ['GOOGLE_API_KEY', 'GOOGLE_CSE_ID'] },
];
const active = PROVIDERS.filter(p => {
  const missing = p.need.filter(k => !process.env[k]);
  if (missing.length) { console.error(`[skip] ${p.name}: fehlt ${missing.join(', ')}`); return false; }
  return true;
});
if (active.length === 0) {
  console.error('Kein Provider aktivierbar. Setze mindestens TAVILY_API_KEY, BRAVE_API_KEY oder GOOGLE_API_KEY/GOOGLE_CSE_ID.');
  process.exit(1);
}
console.log(`Aktive Provider: ${active.map(p => p.name).join(', ')}`);
console.log(`Fragen: ${QUESTIONS.length} × Provider: ${active.length} × Läufe: ${RUNS_PER_PAIR} = ${QUESTIONS.length * active.length * RUNS_PER_PAIR} Calls\n`);

// Main
const rows = [];
for (let qi = 0; qi < QUESTIONS.length; qi++) {
  const question = QUESTIONS[qi];
  console.log(`[${qi + 1}/${QUESTIONS.length}] ${question.q}`);
  for (const p of active) {
    for (let run = 1; run <= RUNS_PER_PAIR; run++) {
      const r = await p.fn(question.q, question.domains);
      let top1 = '', top5 = '', resultCount = 0, firstUrl = '';
      if (r.error) {
        console.log(`  ${p.name} run${run}: ERROR ${r.error} (${r.durationMs}ms)`);
      } else {
        resultCount = r.results.length;
        firstUrl = r.results[0]?.url || '';
        top1 = r.results[0] ? isGoodHit(r.results[0], question.domains) : false;
        top5 = r.results.slice(0, 5).some(h => isGoodHit(h, question.domains));
        console.log(`  ${p.name} run${run}: ${r.durationMs}ms | hits=${resultCount} | top1=${top1} | top5=${top5} | #1=${firstUrl.slice(0, 80)}`);
      }
      rows.push({
        provider: p.name,
        q: question.q,
        run,
        top1: r.error ? '' : String(top1),
        top5: r.error ? '' : String(top5),
        durationMs: r.durationMs,
        error: r.error || '',
        resultCount,
        firstUrl,
      });
      await sleep(PAUSE_MS);
    }
  }
}

// CSV
const csvPath = path.join(__dirname, 'benchmark-retrieval-results.csv');
const header = 'provider,question,run,top1,top5,durationMs,error,resultCount,firstUrl';
const escape = (v) => `"${String(v).replace(/"/g, '""')}"`;
const csv = [header].concat(rows.map(r =>
  [r.provider, escape(r.q), r.run, r.top1, r.top5, r.durationMs, r.error, r.resultCount, escape(r.firstUrl)].join(',')
)).join('\n');
await fs.writeFile(csvPath, csv);

// Aggregation: pro Provider Top-1-/Top-5-Trefferquote (Frage zaehlt als Erfolg,
// wenn mindestens 1 von RUNS_PER_PAIR Laeufen erfolgreich war), Median-/P95-
// Latenz, Fehlerzahl.
function agg(providerName) {
  const p = rows.filter(x => x.provider === providerName);
  let top1Count = 0, top5Count = 0;
  for (const q of QUESTIONS) {
    const runs = p.filter(x => x.q === q.q && !x.error);
    if (runs.some(x => x.top1 === 'true')) top1Count++;
    if (runs.some(x => x.top5 === 'true')) top5Count++;
  }
  const ok = p.filter(x => !x.error).map(x => x.durationMs).sort((a, b) => a - b);
  const median = ok[Math.floor(ok.length / 2)] || 0;
  const p95 = ok[Math.floor(ok.length * 0.95)] || 0;
  const errors = p.filter(x => x.error).length;
  return {
    provider: providerName,
    top1: `${top1Count}/${QUESTIONS.length}`,
    top5: `${top5Count}/${QUESTIONS.length}`,
    median_ms: median,
    p95_ms: p95,
    errors: `${errors}/${p.length}`,
  };
}

console.log('\n=== Zusammenfassung ===');
console.table(active.map(p => agg(p.name)));
console.log(`\nCSV: ${csvPath}`);
