// voice.js — Text-to-Speech fuer IVA/Eva. Provider-flexibel (wie images.js).
// Default: ElevenLabs (beste Qualitaet, ein API-Key). Spaeter: Piper (self-hosted, gratis).

// Text fuer die Sprachausgabe saeubern: Markdown, Emojis, Listen-Bindestriche raus.
function clean(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')      // **fett** -> fett
    .replace(/^[\s]*[-•]\s+/gm, '')        // Listen-Bindestriche am Zeilenanfang
    .replace(/[#*_`>]/g, '')               // restliche Markdown-Zeichen
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, '') // Emojis/Symbole
    .replace(/\n{2,}/g, '. ')              // Absaetze -> Sprechpause
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2500);                       // Laenge kappen (Kosten + Audiolaenge)
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
