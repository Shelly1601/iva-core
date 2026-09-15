// Marketing-Skill: Kampagnen, Brand-Profile, Referenz-Analyse, Bild- und
// Content-Generierung. Deps: die bereits bestehenden marketing/*-Module.
import { tool } from 'ai';
import { z } from 'zod';

export function marketingSkill({ campaigns, brands, analyzeReferences, generateImage, generateContent, projectService, projectId }) {
  if (projectService && projectId) return projectMarketingSkill({ service: projectService, projectId });
  return {
    listCampaigns: tool({
      description: 'Listet alle Marketing-Kampagnen.',
      parameters: z.object({}),
      execute: async () => ({ campaigns: await campaigns.listCampaigns() }),
    }),
    createCampaign: tool({
      description: 'Legt eine Marketing-Kampagne an. type: content|lead-gen|ads|email. autonomy: observe|suggest|auto.',
      parameters: z.object({
        name: z.string(),
        brand: z.string().optional(),
        type: z.enum(['content', 'lead-gen', 'ads', 'email']).optional(),
        references: z.array(z.string()).optional(),
        tone: z.string().optional(),
        targetChannel: z.string().optional(),
        autonomy: z.enum(['observe', 'suggest', 'auto']).optional(),
      }),
      execute: async (input) => await campaigns.createCampaign(input),
    }),
    analyzeReferences: tool({
      description: 'Analysiert Referenz-Konten (Instagram-Handles) und liefert ein Muster-Profil + Content-Ideen. Dauert ~30-60s (scrapt live via Apify).',
      parameters: z.object({ handles: z.array(z.string()), brand: z.string().optional() }),
      execute: async ({ handles, brand }) => await analyzeReferences(handles, { brand }),
    }),
    analyzeCampaign: tool({
      description: 'Analysiert die Referenz-Konten einer bestehenden Kampagne (per id) und speichert das Muster-Profil in der Kampagne.',
      parameters: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const c = await campaigns.getCampaign(id);
        if (!c) return { ok: false, error: 'Kampagne nicht gefunden' };
        const res = await analyzeReferences(c.references, { brand: c.brand });
        if (res.ok) await campaigns.updateCampaign(id, { analysis: { profile: res.profile, accounts: res.accounts, at: new Date().toISOString() } });
        return res;
      },
    }),
    generateImage: tool({
      description: 'Generiert ein Bild aus einem Prompt (fal.ai). model: schnell (guenstig, default) | flux | flux-pro | nanobanana (premium, stark bei Text im Bild). Gibt Bild-URLs zurueck.',
      parameters: z.object({ prompt: z.string(), model: z.string().optional(), numImages: z.number().optional() }),
      execute: async ({ prompt, model, numImages }) => await generateImage(prompt, { model: model || 'nanobanana', numImages: numImages || 1 }),
    }),
    generateContent: tool({
      description: 'Erzeugt fertigen Content fuer eine Kampagne im gelernten Stil + Brand-Profil. format: reel (Reel-Skript, default) | image (Bild-Post) | email. Optionale Vorgabe (briefing).',
      parameters: z.object({
        campaignId: z.string(),
        briefing: z.string().optional(),
        count: z.number().optional(),
        format: z.enum(['reel', 'image', 'email']).optional(),
      }),
      execute: async ({ campaignId, briefing, count, format }) => {
        const c = await campaigns.getCampaign(campaignId);
        if (!c) return { ok: false, error: 'Kampagne nicht gefunden' };
        const brand = c.brandId ? await brands.getBrand(c.brandId) : null;
        return await generateContent(c, brand, { briefing, count: count || 3, format: format || 'reel' });
      },
    }),
    listBrands: tool({
      description: 'Listet alle Marken-Profile (eigene + Referenz-Brands).',
      parameters: z.object({}),
      execute: async () => ({ brands: await brands.listBrands() }),
    }),
    createBrand: tool({
      description: 'Legt ein Marken-Profil an. type: own (eigene Marke) | reference (Vorbild-Marke). Felder: name, website, instagram, linkedin, colors[], tone, audience.',
      parameters: z.object({
        name: z.string(),
        type: z.enum(['own', 'reference']).optional(),
        website: z.string().optional(),
        instagram: z.string().optional(),
        linkedin: z.string().optional(),
        colors: z.array(z.string()).optional(),
        tone: z.string().optional(),
        audience: z.string().optional(),
      }),
      execute: async (input) => await brands.createBrand(input),
    }),
    updateBrand: tool({
      description: 'Aktualisiert ein Marken-Profil per id (beliebige Felder: name, website, instagram, linkedin, colors, tone, audience).',
      parameters: z.object({
        id: z.string(),
        name: z.string().optional(),
        website: z.string().optional(),
        instagram: z.string().optional(),
        linkedin: z.string().optional(),
        colors: z.array(z.string()).optional(),
        tone: z.string().optional(),
        audience: z.string().optional(),
      }),
      execute: async ({ id, ...patch }) => await brands.updateBrand(id, patch),
    }),
  };
}

export const marketingSkillMeta = {
  id: 'marketing',
  toolNames: ['listCampaigns', 'createCampaign', 'analyzeReferences', 'analyzeCampaign', 'generateImage', 'generateContent', 'listBrands', 'createBrand', 'updateBrand'],
};


// Bind the project on the server. The model cannot substitute another project ID.
export function projectMarketingSkill({ service, projectId }) {
  if (!service || !projectId) throw new Error('Projekt und Marketingdienst fehlen.');
  return {
    getProjectMarketing: tool({
      description: 'Liest ausschließlich das aktive Projekt: Markenprofil, echte Wettbewerberanalysen, Entwürfe, Verbindungen und Videoaufträge. Laufende Aufträge sind noch keine fertigen Ergebnisse.',
      parameters: z.object({}),
      execute: async () => service.snapshot(projectId),
    }),
    saveProjectMarketingProfile: tool({
      description: 'Speichert vom Nutzer angegebene Firmendaten, Angebot, Zielgruppe und Markenregeln im aktiven Projekt. Keine Fakten, Profiladressen oder Farben erfinden.',
      parameters: z.object({ name: z.string().optional(), company: z.string().optional(), offer: z.string().optional(), audience: z.string().optional(), industry: z.string().optional(), region: z.string().optional(), website: z.string().optional(), instagram: z.string().optional(), linkedin: z.string().optional(), colors: z.array(z.string()).optional(), tone: z.string().optional(), rules: z.string().optional() }),
      execute: async input => service.saveProfile(projectId, input),
    }),
    researchProjectCompetitors: tool({
      description: 'Startet echte öffentliche Wettbewerberrecherche für das aktive Projekt. URLs oder automatische Suche anhand von Angebot/Zielgruppe. Gefundene Links sind erst nach erfolgreichem Lesen inhaltliche Belege. Gibt einen laufenden Auftrag zurück; später getProjectMarketing abfragen.',
      parameters: z.object({ urls: z.array(z.string()).max(12).optional(), automatic: z.boolean().optional(), briefing: z.string().optional() }),
      execute: async input => service.startJob(projectId, 'research', input),
    }),
    draftProjectMarketingContent: tool({
      description: 'Erstellt eigenständige Contententwürfe oder Kampagnenkonzepte aus dem aktiven Projektprofil und optional einer abgeschlossenen Analyse dieses Projekts. Keine Veröffentlichung oder Nachrichten. Gibt zunächst einen laufenden Auftrag zurück.',
      parameters: z.object({ researchId: z.string().optional(), briefing: z.string().optional(), format: z.enum(['reel', 'ugc', 'carousel', 'campaign', 'linkedin']).optional() }),
      execute: async input => service.startJob(projectId, 'content', input),
    }),
    estimateProjectMarketingVideo: tool({
      description: 'Fragt den realen Higgsfield-Preis für einen konkreten Videoentwurf im aktiven Projekt ab. Erzeugt noch kein Video. Kostenangebot zeigen und zur Bestätigung auf /marketing?projectId=' + encodeURIComponent(projectId) + ' verweisen.',
      parameters: z.object({ prompt: z.string(), model: z.enum(['veo-3.1', 'veo-3.1-image', 'veo-3.1-fast']).optional(), duration: z.enum(['4', '6', '8']).optional(), aspectRatio: z.enum(['9:16','16:9']).optional(), imageUrl: z.string().optional() }),
      execute: async input => service.quoteVideo(projectId, input),
    }),
  };
}
