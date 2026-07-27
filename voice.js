// voice.js — Text-to-Speech fuer IVA/Eva. Provider-flexibel (wie images.js).
// Default: ElevenLabs (beste Qualitaet, ein API-Key). Spaeter: Piper (self-hosted, gratis).

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
       .replace(/€/g, ' Euro');
  // Zahl-Bereiche 0..20 ("3-5" -> "drei bis fünf"). Muss vor dem Bindestrich-Schritt laufen.
  const N0_20 = ['null','eins','zwei','drei','vier','fünf','sechs','sieben','acht','neun','zehn','elf','zwölf','dreizehn','vierzehn','fünfzehn','sechzehn','siebzehn','achtzehn','neunzehn','zwanzig'];
  s = s.replace(/\b(\d+)\s*[-–]\s*(\d+)\b/g, (m, a, b) => {
    const ai = parseInt(a, 10), bi = parseInt(b, 10);
    return (ai <= 20 && bi <= 20) ? N0_20[ai] + ' bis ' + N0_20[bi] : m;
  });
  // Wochentags-Kuerzel: "So." -> "Sonntag" (nur wenn ein Datum folgt)
  s = s.replace(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\.(?=,?\s*\d)/g, (m, d) => TAG[d]);
  // Datum "26.07." / "26.07.2026" -> "26. Juli (2026)"
  s = s.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})?/g, (m, d, mo, y) => {
    const i = parseInt(mo, 10) - 1;
    return (i >= 0 && i < 12) ? `${parseInt(d, 10)}. ${MON[i]}${y ? ' ' + y : ''}` : m;
  });
  // Uhrzeit "19:00" -> "19 Uhr", "14:30" -> "14 Uhr 30"
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, mm) => mm === '00' ? `${parseInt(h, 10)} Uhr` : `${parseInt(h, 10)} Uhr ${parseInt(mm, 10)}`);
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
  try {
    if (prov === 'piper') return await piper(t);
    return await elevenlabs(t, voiceId);
  } catch (e) {
    console.error('TTS-Fehler:', e.message);
    return null;
  }
}
