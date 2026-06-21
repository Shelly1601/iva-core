// iva-core/marketing/content.js
// Content-Generator (Pipeline-Baustein nach der Analyse):
// Nimmt das gelernte Muster-Profil einer Kampagne (aus analyze.js) + Tonalitaet + eine
// freie Nutzer-Vorgabe ("briefing") und erzeugt fertige Post-Ideen:
//   Hook, Caption, Hashtags + einen Bild-Prompt (den man direkt an images.js geben kann).
// Laeuft ueber Claude (das iva-core ohnehin nutzt) -> praktisch kostenlos.

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

export async function generateContent(campaign, { briefing = '', count = 3, model = 'claude-sonnet-4-6' } = {}) {
  const brand = campaign?.brand || '';
  const tone = campaign?.tone || '';
  const refs = (campaign?.references || []).join(', ');
  const profile = campaign?.analysis?.profile || '';

  const system = `Du bist ein scharfer Social-Media-Content-Creator${brand ? ' fuer die Marke ' + brand : ''}.
${profile
  ? 'Hier ist das gelernte Muster-Profil der Vorbild-Konten (Hooks, Themen, Formate, Tonalitaet, Engagement-Treiber):\n' + profile + '\n'
  : 'Es liegt noch kein analysiertes Muster-Profil vor - orientiere dich an den genannten Vorbild-Konten und der Tonalitaet (Tipp: zuerst die Referenzen analysieren gibt bessere Ergebnisse).\n'}${tone ? 'Gewuenschte Tonalitaet: ' + tone + '\n' : ''}${refs ? 'Vorbild-Konten: ' + refs + '\n' : ''}
Erzeuge ${count} fertige, deutlich unterschiedliche Post-Ideen. Pro Idee GENAU dieses Format (Deutsch), nichts davor oder danach:

### Idee <Nummer>
- Hook: <starke erste Zeile, die sofort fesselt>
- Caption: <fertiger, sofort verwendbarer Post-Text>
- Hashtags: <5-10 passende Hashtags>
- Bild-Prompt: <detaillierter ENGLISCHER Prompt fuer ein hochwertiges, scroll-stoppendes Social-Media-Bild: konkretes Motiv/Szene, Stil (modern editorial, clean, cinematic lighting, realistisch, hohe Detailtiefe), Bildausschnitt, Stimmung, Farbwelt. Beschreibe EIN echtes Foto/Bild, keine Collage. KEIN Text und keine Buchstaben im Bild (Schrift kommt spaeter separat drueber). Mindestens 2-3 Saetze, sehr konkret.>`;

  const userPrompt = briefing
    ? `Meine zusaetzliche Vorgabe fuer diese Ideen: ${briefing}`
    : `Erzeuge ${count} starke Post-Ideen im gelernten Stil.`;

  const { text } = await generateText({ model: anthropic(model), system, prompt: userPrompt });
  return { ok: true, brand, count, briefing, content: text };
}
