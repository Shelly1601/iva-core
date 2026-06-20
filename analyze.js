// iva-core/marketing/analyze.js
// Analyse-Engine (Baustein 1 der Marketing-Maschine):
// Referenz-Konten (Instagram) per Apify scrapen -> verdichten -> das LLM destilliert
// ein verwertbares Muster-Profil: Hooks, Themen, Formate, Frequenz, Tonalitaet,
// Engagement-Treiber + sofort umsetzbare Content-Ideen.
//
// Apify-Actor: apify/instagram-scraper (run-sync-get-dataset-items).
// Benoetigt ENV: APIFY_TOKEN (und ANTHROPIC_API_KEY, wie der Rest von iva-core).

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const APIFY_URL = 'https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items';

// Akzeptiert '@handle', 'handle' oder volle URL -> normalisierte Profil-URL.
function profileUrl(h) {
  const handle = String(h).trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/[/?].*$/, '');
  return `https://www.instagram.com/${handle}/`;
}

// Holt die letzten N Posts EINES Kontos von Apify.
export async function scrapeInstagram(handle, { resultsLimit = 30 } = {}) {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN fehlt');
  const body = {
    directUrls: [profileUrl(handle)],
    resultsType: 'posts',
    resultsLimit,
    addParentData: false,
  };
  const r = await fetch(`${APIFY_URL}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Apify ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json(); // Array von Post-Objekten
}

// Verdichtet rohe Posts zu Kennzahlen + Top-Beispielen (spart Tokens, schaerft die Muster).
function condense(posts) {
  const clean = (posts || []).filter(p => p && (p.caption || p.type));
  if (!clean.length) return { sample: 0 };
  const eng = p => (p.likesCount || 0) + (p.commentsCount || 0);
  const byEng = [...clean].sort((a, b) => eng(b) - eng(a));
  const formatMix = {};
  for (const p of clean) { const t = p.type || 'Unknown'; formatMix[t] = (formatMix[t] || 0) + 1; }
  const times = clean.map(p => p.timestamp).filter(Boolean).map(t => +new Date(t)).sort((a, b) => a - b);
  let cadenceDays = null;
  if (times.length > 1) cadenceDays = +(((times.at(-1) - times[0]) / 86400000) / (times.length - 1)).toFixed(1);
  return {
    sample: clean.length,
    owner: clean[0]?.ownerUsername || null,
    formatMix,
    avgLikes: Math.round(clean.reduce((s, p) => s + (p.likesCount || 0), 0) / clean.length),
    avgComments: Math.round(clean.reduce((s, p) => s + (p.commentsCount || 0), 0) / clean.length),
    cadenceDays,
    topPosts: byEng.slice(0, 8).map(p => ({
      hook: (p.caption || '').split('\n')[0].slice(0, 200),
      type: p.type,
      likes: p.likesCount, comments: p.commentsCount,
      views: p.videoViewCount || p.videoPlayCount || null,
      hashtags: (p.hashtags || []).slice(0, 10),
    })),
  };
}

// Hauptfunktion: scrape (pro Konto, fehler-isoliert) -> verdichten -> LLM-Muster-Profil.
export async function analyzeReferences(handles, { brand = '', resultsLimit = 30, model = 'claude-sonnet-4-6' } = {}) {
  const list = Array.isArray(handles) ? handles : [handles];
  const perAccount = [];
  for (const h of list) {
    try { perAccount.push({ handle: h, stats: condense(await scrapeInstagram(h, { resultsLimit })) }); }
    catch (e) { perAccount.push({ handle: h, error: e.message }); }
  }
  const ok = perAccount.filter(a => a.stats && a.stats.sample);
  if (!ok.length) return { ok: false, error: 'Keine Daten von den Referenz-Konten erhalten', perAccount };

  const { text } = await generateText({
    model: anthropic(model),
    system: `Du bist ein scharfer Social-Media-Stratege. Analysiere die verdichteten Daten echter Referenz-Konten und destilliere ein SOFORT verwertbares Muster-Profil${brand ? ' fuer die Marke ' + brand : ''}.
Antworte kompakt auf Deutsch, mit genau diesen Abschnitten:
- Hooks: 5-8 wiederkehrende Aufhaenger als Vorlagen mit [Platzhaltern]
- Themen: die staerksten inhaltlichen Winkel
- Formate: was zieht (Reel/Bild/Carousel) und warum
- Frequenz: empfohlene Posting-Kadenz, abgeleitet aus den Daten
- Tonalitaet: Stil in 2-3 Saetzen
- Engagement-Treiber: was die Top-Posts gemeinsam haben
- Content-Ideen: 5 konkrete, morgen umsetzbare Posts fuer die eigene Marke
Keine Floskeln, keine Tabellen, kurze Zeilen mit Bindestrich.`,
    prompt: `Verdichtete Referenz-Daten (JSON):\n${JSON.stringify(ok, null, 2)}`,
  });

  return { ok: true, brand, accounts: ok.map(a => a.handle), profile: text, raw: perAccount };
}
