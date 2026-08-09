const clean = (value, max = 2000) => String(value ?? '').trim().slice(0, max);

export const KNOWLEDGE_LIBRARY_VERSION = 'iva-knowledge-library-1.0';

const SOURCES = Object.freeze([
  {
    id: 'mit-ocw', title: 'MIT OpenCourseWare', domain: 'general-learning', authority: 'primary-education', status: 'verified-index',
    url: 'https://ocw.mit.edu/', rights: 'CC BY-NC-SA 4.0; Attribution und ShareAlike beachten; kommerzielle Weiterverwertung gesperrt.',
    retrievalMode: 'index-and-link', allowedUse: ['interne Weiterbildung', 'Quellenhinweis', 'nicht-kommerzielle Lernzusammenfassung'],
    blockedUse: ['bezahlten IVA-Kurs aus OCW-Material erzeugen', 'MIT-Logo oder Endorsement verwenden'],
  },
  {
    id: 'roadmap-sh', title: 'roadmap.sh', domain: 'software-learning', authority: 'community-reference', status: 'verified-index',
    url: 'https://roadmap.sh/', rights: 'Als Navigations- und Checklistenquelle; Rechte je verlinkter Einzelquelle separat pruefen.',
    retrievalMode: 'index-and-link', allowedUse: ['Lernpfade planen', 'Skill-Luecken strukturieren'],
    blockedUse: ['als alleinigen Qualifikationsnachweis verwenden', 'verlinkte Inhalte pauschal uebernehmen'],
  },
  {
    id: 'base44-docs', title: 'Base44 Support & Developer Documentation', domain: 'app-building', authority: 'vendor-primary', status: 'verified-active',
    url: 'https://docs.base44.com/', rights: 'Offizielle Produktdokumentation; zitieren und verlinken, nicht in IVA kopieren.',
    retrievalMode: 'live-reference', allowedUse: ['Funktionsvergleich', 'Integrationsplanung', 'aktuelle Anbieterpruefung'],
    blockedUse: ['Produktversprechen ohne Live-Pruefung', 'Secrets in Frontend oder Wissensspeicher ablegen'],
  },
  {
    id: 'open-generative-ai', title: 'Open Generative AI', domain: 'content-production', authority: 'project-primary', status: 'verified-candidate',
    url: 'https://github.com/anil-matcha/open-generative-ai', rights: 'Quellcode MIT; Modell-, Provider- und Ausgabe-Rechte je verwendetem Dienst/Modell separat pruefen.',
    retrievalMode: 'software-evaluation', allowedUse: ['Architektur vergleichen', 'isolierten Proof of Concept pruefen'],
    blockedUse: ['als kostenlos/unbegrenzt bewerben', 'ungepruefte Desktop-Binaerdatei installieren', 'Cloud-Modellkosten verschweigen'],
  },
  {
    id: 'linkedin-recruiter-help', title: 'LinkedIn Recruiter Help', domain: 'recruiting', authority: 'vendor-primary', status: 'verified-active',
    url: 'https://www.linkedin.com/help/recruiter/', rights: 'Offizielle Hilfe; Plattformbedingungen und gebuchte Produktrechte gelten.',
    retrievalMode: 'live-reference', allowedUse: ['Suchfilter vorbereiten', 'manuelle Recruiter-Suche dokumentieren'],
    blockedUse: ['Profile automatisiert scrapen', 'automatischen Massen-Outreach starten', 'nicht freigegebene Kandidatendaten speichern'],
  },
  {
    id: 'meta-whatsapp-cloud-api', title: 'Meta WhatsApp Cloud API Documentation', domain: 'whatsapp', authority: 'vendor-primary', status: 'verified-active',
    url: 'https://developers.facebook.com/docs/whatsapp/cloud-api/', rights: 'Offizielle Produktdokumentation; Meta- und WhatsApp-Bedingungen gelten.',
    retrievalMode: 'live-reference', allowedUse: ['Webhook-/Nachrichtenintegration pruefen', 'Vorlagen- und Richtlinienstatus nachschlagen'],
    blockedUse: ['Kundennachrichten ohne Rechtsgrundlage senden', 'Token in Browser oder Dokumenten ablegen'],
  },
]);

export function listKnowledgeLibrary({ domain = '', status = '' } = {}) {
  return SOURCES.filter(source => (!domain || source.domain === domain) && (!status || source.status === status)).map(source => ({ ...source }));
}

export function knowledgeLibraryStatus() {
  return {
    version: KNOWLEDGE_LIBRARY_VERSION,
    total: SOURCES.length,
    activeReferenceSources: SOURCES.filter(source => ['verified-active', 'verified-index'].includes(source.status)).length,
    candidateSources: SOURCES.filter(source => source.status === 'verified-candidate').length,
    safeguards: ['Quellenherkunft', 'Rechte je Quelle', 'Aktualitaetsstatus', 'kein ungepruefter Volltextimport', 'keine Secrets'],
  };
}

export function assessKnowledgeSourceCandidate(input = {}) {
  const missing = [];
  if (!clean(input.url, 1000)) missing.push('URL');
  if (!clean(input.publisher, 300)) missing.push('Herausgeber');
  if (!clean(input.rightsBasis, 1000)) missing.push('Rechte-/Lizenzgrundlage');
  if (!clean(input.intendedUse, 1000)) missing.push('beabsichtigte Nutzung');
  if (input.containsPersonalData === true && !clean(input.legalBasis, 1000)) missing.push('Rechtsgrundlage fuer personenbezogene Daten');
  const active = input.isPrimarySource === true && input.rightsConfirmed === true && !missing.length;
  return {
    title: clean(input.title, 300) || 'Neue Quelle',
    status: active ? 'review-ready' : 'candidate-only',
    mayEnterRetrieval: active,
    missing,
    requiredReview: ['fachliche Autoritaet', 'Versions-/Datumsstand', 'Nutzungsrechte', 'Datenschutz', 'Abruf- und Aktualisierungsweg'],
    notice: active
      ? 'Die Quelle ist formal pruefbereit, aber noch nicht automatisch aktiviert.'
      : 'Die Quelle bleibt ausserhalb der aktiven Wissenssuche, bis alle Nachweise vorliegen.',
  };
}
