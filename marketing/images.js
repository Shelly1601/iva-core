// iva-core/marketing/images.js
// Bild-Generierung der Marketing-Maschine - provider-flexibel.
// Start-Provider: fal.ai (eine API, viele Modelle, pay-per-use, kein Abo).
// Modell pro Aufruf/Kampagne waehlbar - guenstig bis premium:
//   schnell (~0,3 ct, Drafts/Masse) ... nanobanana (premium, stark bei Text im Bild + Marken-Konsistenz).
// ENV: FAL_KEY.  Spaeter leicht um weitere Provider erweiterbar (Switch auf Modell-/Provider-Ebene).

const FAL_BASE = 'https://fal.run/';

// Freundliche Namen -> fal Model-IDs. Erweiterbar.
export const MODELS = {
  schnell:          'fal-ai/flux/schnell',   // schnell + spottbillig, fuer Drafts/Masse
  flux:             'fal-ai/flux/dev',       // bessere Qualitaet
  'flux-pro':       'fal-ai/flux-pro/v1.1',  // premium Flux
  nanobanana:       'fal-ai/nano-banana',    // Nano Banana: Text im Bild + Konsistenz
  'nanobanana-pro': 'fal-ai/nano-banana-pro',
};

// erlaubt friendly-name ODER volle fal-ID
function resolveModel(model) {
  if (!model) return MODELS.schnell;
  return MODELS[model] || model;
}

// Generiert 1..n Bilder. Rueckgabe: { ok, model, images:[{url,width,height}] } oder { ok:false, error }.
export async function generateImage(prompt, { model = 'schnell', imageSize = 'square_hd', numImages = 1, extra = {} } = {}) {
  const key = process.env.FAL_KEY;
  if (!key) return { ok: false, error: 'FAL_KEY fehlt' };
  if (!prompt || !String(prompt).trim()) return { ok: false, error: 'prompt fehlt' };

  const id = resolveModel(model);
  const body = { prompt, num_images: numImages, ...extra };
  // Flux nutzt image_size; Schnell braucht wenige Steps. Nano Banana nimmt nur prompt (+ optional extra, z.B. aspect_ratio).
  if (id.includes('flux')) body.image_size = body.image_size || imageSize;
  if (id === MODELS.schnell) body.num_inference_steps = body.num_inference_steps || 4;

  try {
    const r = await fetch(FAL_BASE + id, {
      method: 'POST',
      headers: { Authorization: 'Key ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: `fal ${r.status}: ${JSON.stringify(data).slice(0, 200)}`, model: id };
    const images = (data.images || []).map(im => ({ url: im.url, width: im.width, height: im.height, contentType: im.content_type }));
    return { ok: true, model: id, images, seed: data.seed };
  } catch (e) {
    return { ok: false, error: e.message, model: id };
  }
}
