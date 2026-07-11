// iva-core/marketing/assist.js
// KI-Assistenz fuers Brand-Profil - laeuft ueber GEMINI (kostenloser Tier), NICHT Claude.
//   refineTone(text):     rohe (gesprochene) Beschreibung -> saubere Tonalitaets-Beschreibung
//   analyzeWebsite(url):   Website lesen -> Vorschlag fuer Tonalitaet + Zielgruppe
// ENV: GEMINI_API_KEY

import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-2.5-flash'; // kostenloser Tier, schnell

export async function refineTone(rawText) {
  if (!process.env.GEMINI_API_KEY) return { ok: false, error: 'GEMINI_API_KEY fehlt' };
  if (!rawText || !String(rawText).trim()) return { ok: false, error: 'kein Text' };
  const { text } = await generateText({
    model: google(MODEL),
    system: 'Mach aus einer rohen, oft gesprochenen Beschreibung eine klare, kompakte Tonalitaets-Beschreibung fuer eine Marke: 2-3 Saetze, Deutsch, konkret (Stil, Ansprache, Wortwahl). Nur die Beschreibung, keine Vorrede.',
    prompt: String(rawText),
  });
  return { ok: true, tone: text.trim() };
}

export async function analyzeWebsite(url) {
  if (!process.env.GEMINI_API_KEY) return { ok: false, error: 'GEMINI_API_KEY fehlt' };
  if (!url || !String(url).trim()) return { ok: false, error: 'keine URL' };
  const full = String(url).trim().replace(/^https?:\/\//i, '');
  let siteText = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch('https://' + full, { headers: { 'User-Agent': 'Mozilla/5.0 (IVA)' }, signal: ctrl.signal });
    clearTimeout(timer);
    const html = await r.text();
    siteText = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
  } catch (e) {
    return { ok: false, error: 'Website nicht erreichbar (' + (e.name === 'AbortError' ? 'Timeout' : e.message) + ')' };
  }
  if (!siteText) return { ok: false, error: 'Website hatte keinen lesbaren Text' };
  const { text } = await generateText({
    model: google(MODEL),
    system: 'Analysiere den Text einer Firmen-Website und leite ab: (1) Tonalitaet der Marke, (2) wahrscheinliche Zielgruppe. Antworte kompakt auf Deutsch, GENAU in diesem Format:\nTonalitaet: <2-3 Saetze>\nZielgruppe: <Stichworte zu Beschaeftigung, Alter, Beruf, Einkommen>\nBeginne den Tonalitaets-Teil mit "Laut Website ...".',
    prompt: 'Website-Text:\n' + siteText,
  });
  return { ok: true, suggestion: text.trim() };
}
