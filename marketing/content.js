// iva-core/marketing/content.js
// Content-Factory: erzeugt fertige Ideen im gelernten Stil + nach Vorgabe, FORMAT-BEWUSST:
//   - reel  -> vollstaendiges Reel-Skript (Hook, Ablauf, On-Screen-Text, Sprechtext, CTA, B-Roll-Prompt, Caption)
//   - image -> Bild-Post (Hook, Caption, Hashtags, Bild-Prompt)
//   - email -> E-Mail (Betreff, Preview, Body, CTA)
// Bezieht das BRAND-PROFIL ein (Zielgruppe, Tonalitaet, Markenfarben) + das Analyse-Muster-Profil.
// Laeuft ueber Claude -> praktisch kostenlos.

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

function formatSpec(format, count) {
  if (format === 'reel') return `Erzeuge ${count} Reel-Ideen. Pro Idee GENAU dieses Format:

### Reel <Nr> – <kurzer Titel>
- Hook (gesprochen): <die ersten 3 Sekunden – muss den Scroll sofort stoppen>
- Ablauf: <3-5 kurze Shots, je mit grober Sekundenangabe>
- On-Screen-Text: <die Text-Overlays fuers Video>
- Sprechtext: <kompletter Voiceover-/Sprechtext>
- CTA: <Handlungsaufruf am Ende>
- B-Roll-Prompt: <detaillierter ENGLISCHER Video-Prompt fuer fal, falls ohne echten Sprecher – konkrete Szene, Stil, Stimmung; KEIN Text im Video>
- Caption: <fertiger Post-Text>
- Hashtags: <5-10>`;
  if (format === 'email') return `Erzeuge ${count} E-Mail-Ideen. Pro Idee GENAU dieses Format:

### E-Mail <Nr>
- Betreff: <starke Betreffzeile>
- Preview: <kurzer Vorschautext>
- Body: <fertiger E-Mail-Text>
- CTA: <Handlungsaufruf>`;
  return `Erzeuge ${count} Bild-Post-Ideen. Pro Idee GENAU dieses Format:

### Idee <Nr>
- Hook: <starke erste Zeile>
- Caption: <fertiger Post-Text>
- Hashtags: <5-10>
- Bild-Prompt: <detaillierter ENGLISCHER Prompt fuer ein hochwertiges Bild: Motiv, Stil, Licht, Stimmung, ggf. Markenfarben. KEIN Text im Bild.>`;
}

export async function generateContent(campaign, brand, { briefing = '', count = 3, format = 'reel', model = 'claude-sonnet-4-6' } = {}) {
  const brandName = brand?.name || campaign?.brand || '';
  const tone = brand?.tone || campaign?.tone || '';
  const audience = brand?.audience || '';
  const colors = (brand?.colors || []).join(', ');
  const refs = (campaign?.references || []).join(', ');
  const profile = campaign?.analysis?.profile || '';

  const brandBlock = [
    brandName ? 'Marke: ' + brandName : '',
    audience ? 'Zielgruppe: ' + audience : '',
    tone ? 'Tonalitaet: ' + tone : '',
    colors ? 'Markenfarben (fuer Bild-/Video-Stimmung): ' + colors : '',
  ].filter(Boolean).join('\n');

  const system = `Du bist ein scharfer Social-Media-Content-Creator${brandName ? ' fuer ' + brandName : ''}.
${brandBlock ? brandBlock + '\n' : ''}${profile ? 'Gelerntes Muster-Profil der Vorbild-Konten:\n' + profile + '\n' : (refs ? 'Vorbild-Konten: ' + refs + '\n' : '')}
${formatSpec(format, count)}

Alles auf Deutsch, sofort verwendbar, keine Vorrede. Richte dich strikt nach Zielgruppe und Tonalitaet der Marke.`;

  const userPrompt = briefing ? `Meine Vorgabe: ${briefing}` : `Erzeuge ${count} starke Ideen im gelernten Stil.`;
  const { text } = await generateText({ model: anthropic(model), system, prompt: userPrompt });
  return { ok: true, brand: brandName, format, count, briefing, content: text };
}
