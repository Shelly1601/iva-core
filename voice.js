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

async function elevenlabs(text) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) { console.error('TTS: kein ELEVENLABS_API_KEY gesetzt'); return null; }
  const voice = process.env.ELEVENLABS_VOICE_ID || EL_DEFAULT_VOICE;
  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2 },
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
export async function speak(text, { provider } = {}) {
  const t = clean(text);
  if (!t) return null;
  const prov = provider || process.env.TTS_PROVIDER || 'elevenlabs';
  try {
    if (prov === 'piper') return await piper(t);
    return await elevenlabs(t);
  } catch (e) {
    console.error('TTS-Fehler:', e.message);
    return null;
  }
}
