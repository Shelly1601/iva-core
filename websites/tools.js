import { tool } from 'ai';
import { z } from 'zod';

export function websiteSkill({ service, projectId = '' }) {
  const projectSchema = projectId ? {} : { projectId: z.string().min(1).max(100) };
  const scoped = input => projectId || input.projectId;
  const siteSchema = { ...projectSchema, siteId: z.string().uuid() };
  const tools = {
    listIvaWebsites: tool({ description: 'Listet die echten Website-Projekte und ihre Versionen, GitHub-Sicherungen und Veröffentlichungen. Der Website-Studio-Bereich zeigt links den Chat und rechts die Vorschau.', parameters: z.object(projectSchema), execute: async input => ({ projectId: scoped(input), websites: await service.list(scoped(input)), studioUrl: `/website-studio?projectId=${encodeURIComponent(scoped(input))}` }) }),
    getIvaWebsite: tool({ description: 'Prüft eine konkrete Website und den tatsächlichen Status des letzten Website-Auftrags. queued/running ist kein fertiges Ergebnis.', parameters: z.object(siteSchema), execute: async input => service.site(scoped(input), input.siteId) }),
    createIvaWebsite: tool({ description: 'Legt auf Nutzerauftrag eine neue Website im gewählten Projekt an. Erstellt noch keinen Inhalt. Danach runIvaWebsiteTask mit dem vollständigen Auftrag nutzen.', parameters: z.object({ ...projectSchema, name: z.string().min(1).max(150), sourceUrl: z.string().url().optional() }), execute: async input => { const site = await service.create({ ...input, projectId: scoped(input) }); return { ...site, studioUrl: `/website-studio?projectId=${encodeURIComponent(scoped(input))}&siteId=${site.id}` }; } }),
    runIvaWebsiteTask: tool({ description: 'Bearbeitet eine Projekt-Website mit dem konkreten Nutzerauftrag: gestalten, 3D ergänzen, URL/GitHub übernehmen, privat bei GitHub sichern oder ausdrücklich veröffentlichen. Auftrag unverfälscht weitergeben. Neue Version/Build werden geprüft. queued erst mit getIvaWebsite bis zum belegten Endstatus prüfen. Keine erfundenen Zugänge, keine generischen IVA-Core-Builds für Webseiten.', parameters: z.object({ ...siteSchema, message: z.string().min(1).max(12000), model: z.enum(['auto', 'claude', 'gemini', 'groq']).optional() }), execute: async input => { const p = scoped(input), site = await service.site(p, input.siteId); return { ...(await service.chat(p, input.siteId, { message: input.message, model: input.model || 'auto', baseRevisionId: site.draftRevisionId })), studioUrl: `/website-studio?projectId=${encodeURIComponent(p)}&siteId=${site.id}`, note: 'Auftrag gestartet. Fertigstellung am gespeicherten Website-Job prüfen.' }; } }),
  };
  return Object.fromEntries(Object.entries(tools).map(([name, value]) => [name, { ...value, ...(projectId ? { projectId } : {}), iva: { skillId: 'websites' } }]));
}
