// voice.js — Text-to-Speech fuer IVA/Eva. Provider-flexibel (wie images.js).
// Default: ElevenLabs (beste Qualitaet, ein API-Key). Spaeter: Piper (self-hosted, gratis).

// Deutsche Zahl-Ausgabe (0..999.999.999). ElevenLabs spricht ausgeschriebene
// Zahlen deutlich zuverlaessiger als Ziffern mit Punkt-Tausendertrennung.
function germanNumber(n) {
  n = Math.trunc(Number(n));
  if (!Number.isFinite(n)) return '';
  if (n < 0) return 'minus ' + germanNumber(-n);
  if (n === 0) return 'null';
  const ones = ['', 'ein', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'];
  const teens = ['zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
  const tens = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
  const under100 = (x) => {
    if (x < 10) return x === 1 ? 'eins' : ones[x];
    if (x < 20) return teens[x - 10];
    const t = Math.floor(x / 10), o = x % 10;
    if (o === 0) return tens[t];
    if (o === 1) return 'einund' + tens[t];
    return ones[o] + 'und' + tens[t];
  };
  const under1000 = (x) => {
    if (x < 100) return under100(x);
    const h = Math.floor(x / 100), r = x % 100;
    const base = (h === 1 ? 'ein' : ones[h]) + 'hundert';
    return r === 0 ? base : base + under100(r);
  };
  if (n < 1000) return under1000(n);
  if (n < 1000000) {
    const t = Math.floor(n / 1000), r = n % 1000;
    const base = (t === 1 ? 'ein' : under1000(t)) + 'tausend';
    return r === 0 ? base : base + ' ' + under1000(r);
  }
  if (n < 1000000000) {
    const m = Math.floor(n / 1000000), r = n % 1000000;
    const mBase = m === 1 ? 'eine Million' : germanNumber(m) + ' Millionen';
    return r === 0 ? mBase : mBase + ' ' + germanNumber(r);
  }
  return String(n);
}

// Feste Fach-Aussprache-Ersetzungen. Reihenfolge: laengste Schluessel zuerst,
// damit "Jahresarbeitsentgeltgrenze" vor moeglichen Teil-Matches greift.
const TTS_TERMS = [
  ['Jahresarbeitsentgeltgrenze', 'Einkommensgrenze für die gesetzliche Krankenversicherung'],
  ['Beitragsbemessungsgrenze',   'Beitragsbemessungsgrenze'], // bleibt, aber vor BBG-Kuerzel-Match, um Doppel-Ersetzung zu vermeiden
  ['bAV',  'betriebliche Altersvorsorge'],
  ['bKV',  'betriebliche Krankenversicherung'],
  ['PKV',  'private Krankenversicherung'],
  ['GKV',  'gesetzliche Krankenversicherung'],
  ['BBG',  'Beitragsbemessungsgrenze'],
];
function replaceTerms(s) {
  for (const [k, v] of TTS_TERMS) {
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?<![\\p{L}\\d])' + esc + '(?![\\p{L}\\d])', 'gu');
    s = s.replace(re, v);
  }
  return s;
}

// Text fuer die Sprachausgabe saeubern: Markdown, Emojis, Listen-Bindestriche raus.
function clean(text) {
  const MON = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  const TAG = { Mo:'Montag', Di:'Dienstag', Mi:'Mittwoch', Do:'Donnerstag', Fr:'Freitag', Sa:'Samstag', So:'Sonntag' };
  const ABK = { 'z.B.':'zum Beispiel', 'z. B.':'zum Beispiel', 'u.a.':'unter anderem', 'd.h.':'das heißt', 'usw.':'und so weiter', 'ca.':'circa', 'inkl.':'inklusive', 'evtl.':'eventuell', 'bzw.':'beziehungsweise', 'Nr.':'Nummer', 'Tel.':'Telefon' };
  let s = String(text || '');
  // Markdown, Emojis, Struktur raus
  s = s.replace(/\*\*(.+?)\*\*/g, '$1')
       .replace(/^[\s]*[-•*]\s+/gm, '')
       .replace(/[#*_`>|]/g, '')
       .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '');
  // Fach-Aussprache-Ersetzungen zuerst (Komposita + Kuerzel).
  s = replaceTerms(s);
  // Abkuerzungen ausschreiben
  for (const [k, v] of Object.entries(ABK)) s = s.split(k).join(v);
  // Einheiten & Symbole (Wortgrenzen, damit 'Wärmepumpe'/'CO2-Bilanz' korrekt bleiben).
  s = s.replace(/\bkWh\b/g, 'Kilowattstunden')
       .replace(/\bkW\b/g, 'Kilowatt')
       .replace(/(?<![\p{L}\d])W(?![\p{L}\d])/gu, 'Watt')
       .replace(/\bPV\b/g, 'Photovoltaik')
       .replace(/\bWP\b/g, 'Wärmepumpe')
       .replace(/\bCO2\b/g, 'CO zwei')
       .replace(/°C\b/g, ' Grad Celsius')
       .replace(/%/g, ' Prozent')
       .replace(/€/g, ' Euro')
       .replace(/\bEUR\b/g, 'Euro')
       .replace(/\bUSD\b/g, 'US-Dollar');
  // Zahlen mit Punkt-Tausendertrennung -> deutsche Wortform.
  // "73.800" -> "dreiundsiebzigtausend achthundert". Vor der Datumsregel, weil
  // Datumsformate (26.07.2025) niemals einer .\d{3}-Gruppe entsprechen.
  s = s.replace(/(?<![\p{L}\d])(\d{1,3}(?:\.\d{3})+)(?![\p{L}\d])/gu,
    (m) => germanNumber(parseInt(m.replace(/\./g, ''), 10)));
  // Wochentags-Kuerzel: "So." -> "Sonntag" (nur wenn ein Datum folgt)
  s = s.replace(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\.(?=,?\s*\d)/g, (m, d) => TAG[d]);
  // Datum "26.07." / "26.07.2026" -> "26. Juli (2026)". Jahr wird spaeter in
  // Wortform gebracht.
  s = s.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/g, (m, d, mo, y) => {
    const i = parseInt(mo, 10) - 1;
    return (i >= 0 && i < 12) ? `${parseInt(d, 10)}. ${MON[i]}${y ? ' ' + y : ''}` : m;
  });
  // Jahreszahlen 1900..2099 (auch die aus der Datumsregel) -> Wortform.
  // "2025" -> "zweitausend fünfundzwanzig".
  s = s.replace(/(?<![\p{L}\d])(19\d{2}|20\d{2})(?![\p{L}\d])/gu,
    (m) => germanNumber(parseInt(m, 10)));
  // Paragraph-Referenzen: "§ 32a" -> "Paragraph zweiunddreißig a"
  s = s.replace(/§\s*(\d+)\s*([a-zA-Z])?/g,
    (_, num, letter) => 'Paragraph ' + germanNumber(parseInt(num, 10)) + (letter ? ' ' + letter.toLowerCase() : ''));
  // Artikel-Referenzen: "Art. 12" -> "Artikel zwölf"
  s = s.replace(/\bArt\.\s*(\d+)/gi,
    (_, num) => 'Artikel ' + germanNumber(parseInt(num, 10)));
  // Zahl-Bereiche 0..20 ("3-5" -> "drei bis fünf"). Vor dem Bindestrich-Schritt.
  const N0_20 = ['null','eins','zwei','drei','vier','fünf','sechs','sieben','acht','neun','zehn','elf','zwölf','dreizehn','vierzehn','fünfzehn','sechzehn','siebzehn','achtzehn','neunzehn','zwanzig'];
  s = s.replace(/\b(\d+)\s*[-–]\s*(\d+)\b/g, (m, a, b) => {
    const ai = parseInt(a, 10), bi = parseInt(b, 10);
    return (ai <= 20 && bi <= 20) ? N0_20[ai] + ' bis ' + N0_20[bi] : m;
  });
  // Uhrzeit "19:00" -> "neunzehn Uhr", "14:30" -> "vierzehn Uhr dreißig"
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, mm) => {
    const H = germanNumber(parseInt(h, 10));
    if (mm === '00') return `${H} Uhr`;
    return `${H} Uhr ${germanNumber(parseInt(mm, 10))}`;
  });
  // Verbleibende Zahl + Einheit ausschreiben (Euro, Prozent, Grad Celsius, ...)
  s = s.replace(/(?<![\p{L}\d])(\d{1,6})\s+(Euro|Prozent|Grad Celsius|Kilowatt(?:stunden)?|Watt|US-Dollar)\b/gu,
    (_, num, unit) => germanNumber(parseInt(num, 10)) + ' ' + unit);
  // Aufzaehlungs-Bindestrich -> Sprechpause
  s = s.replace(/\s[-–]\s/g, ', ');
  // Absaetze -> Pause, Whitespace normalisieren, Laenge kappen
  s = s.replace(/\n{2,}/g, '. ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 2500);
}

// ElevenLabs: Standard-Stimme "Rachel" als Fallback. Eigene deutsche Stimme:
// in ElevenLabs waehlen und die Voice-ID in ELEVENLABS_VOICE_ID eintragen.
const EL_DEFAULT_VOICE = '21m00Tcm4TlvDq8ikWAM';

async function elevenlabs(text, voiceOverride) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) { console.error('TTS: kein ELEVENLABS_API_KEY gesetzt'); return null; }
  const voice = voiceOverride || process.env.ELEVENLABS_VOICE_ID || EL_DEFAULT_VOICE;
  const model = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?optimize_streaming_latency=4&output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.35, similarity_boost: 0.80, style: 0.45, use_speaker_boost: true, speed: 1.08 },
    }),
  });
  if (!r.ok) { console.error('TTS ElevenLabs:', r.status, (await r.text()).slice(0, 160)); return null; }
  return { buffer: Buffer.from(await r.arrayBuffer()), mime: 'audio/mpeg', ext: 'mp3' };
}

// Platzhalter fuer den spaeteren, kostenlosen self-hosted Weg.
async function piper(text) {
  console.error('TTS: Piper noch nicht eingerichtet - nutze vorerst ElevenLabs.');
  return null;
}

// speak(text) -> { buffer, mime, ext } | null
export async function speak(text, { provider, voiceId } = {}) {
  const t = clean(text);
  if (!t) return null;
  const prov = provider || process.env.TTS_PROVIDER || 'elevenlabs';
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] [TTS] start | provider=${prov} | chars=${t.length}`);
  try {
    const out = (prov === 'piper') ? await piper(t) : await elevenlabs(t, voiceId);
    const dur = Date.now() - t0;
    console.log(`[${new Date().toISOString()}] [TTS] done | duration=${dur}ms | ${out ? out.buffer.length + 'B ' + out.mime : 'null'}`);
    return out;
  } catch (e) {
    const dur = Date.now() - t0;
    console.error(`[${new Date().toISOString()}] [TTS] error | duration=${dur}ms | ${e.message}`);
    return null;
  }
}
