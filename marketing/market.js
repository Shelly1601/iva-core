// iva-core/marketing/market.js
// Marken-Marktanalyse (breit): schaetzt Markt-Kennzahlen + Konkurrenz-Ueberblick fuer eine Marke.
// Laeuft ueber GEMINI (kostenlos). Rueckgabe: strukturierte Kennzahlen (fuers Dashboard) + Einschaetzung.
// EHRLICH: Das sind fundierte KI-Schaetzungen zur Orientierung, KEINE exakte Marktforschung.
// ENV: GEMINI_API_KEY

import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-2.0-flash';

async function fetchSiteText(url) {
  const full = String(url).trim().replace(/^https?:\/\//i, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch('https://' + full, { headers: { 'User-Agent': 'Mozilla/5.0 (IVA)' }, signal: ctrl.signal });
    clearTimeout(timer);
    const html = await r.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
  } catch { return ''; }
}

export async function marketAnalysis(brand, { customerValue = null } = {}) {
  if (!process.env.GEMINI_API_KEY) return { ok: false, error: 'GEMINI_API_KEY fehlt' };
  const context = [brand?.name && ('Marke: ' + brand.name), brand?.audience && ('Zielgruppe: ' + brand.audience), brand?.tone && ('Tonalitaet: ' + brand.tone)].filter(Boolean).join('\n');
  const siteText = brand?.website ? await fetchSiteText(brand.website) : '';

  const { text } = await generateText({
    model: google(MODEL),
    system: `Du bist ein nuechterner Markt-Analyst. Schaetze fuer die beschriebene Marke die Marktlage. Gib AUSSCHLIESSLICH valides JSON zurueck (keine Erklaerung, kein Markdown), exakt dieses Schema:
{
  "branche": "<kurze Branchen-/Nischenbezeichnung>",
  "wettbewerber_anzahl": "<grobe Zahl oder Spanne, z.B. '50-100'>",
  "top_wettbewerber": ["<Name>", "..."],
  "marktgroesse": "<grobe Schaetzung mit Einheit, z.B. 'ca. 2 Mrd. EUR/Jahr in DE'>",
  "wettbewerbsintensitaet": "<niedrig|mittel|hoch>",
  "trend": "<wachsend|stabil|schrumpfend>",
  "kundenwert": "<typischer Kundenwert als Spanne, z.B. 'ca. 500-2000 EUR'>",
  "marktpotenzial": "<grobe Gesamtpotenzial-Schaetzung; falls mein Kundenwert gegeben, damit rechnen>",
  "chancen": "<1-2 Saetze: wo ist Luft/beste Positionierung>",
  "einschaetzung": "<2-3 Saetze Gesamtbild>"
}
Alles auf Deutsch. Es sind Schaetzungen - lieber ehrliche Spannen als falsche Praezision.`,
    prompt: `${context}\n${siteText ? 'Website-Auszug:\n' + siteText : '(keine Website)'}${customerValue ? '\nMein durchschnittlicher Kundenwert: ' + customerValue : ''}`,
  });

  let analysis;
  try { analysis = JSON.parse(text.replace(/```json|```/gi, '').trim()); }
  catch { analysis = { einschaetzung: text.trim() }; }
  return { ok: true, brand: brand?.name || '', analysis, disclaimer: 'Fundierte KI-Schaetzung zur Orientierung - keine exakte Marktforschung.' };
}
