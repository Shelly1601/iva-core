import { randomUUID } from 'node:crypto';
import { searchWebCandidates } from '../agents/web.js';
import { createWebsiteUrlImporter } from '../websites/import-url.js';
import { clean, marketingError, publicMarketingUrl } from './project-store.js';
import { scrapeInstagram } from './analyze.js';

export function marketingSourceType(value) {
  const host = new URL(value).hostname.replace(/^www\./, '');
  return /(^|\.)instagram\.com$/.test(host) ? 'instagram' : /(^|\.)linkedin\.com$/.test(host) ? 'linkedin' : 'website';
}
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function socialPost(post) {
  const caption = clean(post.caption || post.text, 4000);
  let url = ''; try { url = publicMarketingUrl(post.url || post.sourceUrl); } catch {}
  if (!caption && !url) return null;
  return { url, caption, type: clean(post.type, 100), postedAt: clean(post.timestamp || post.postedAt, 80), likes: numeric(post.likesCount ?? post.likes), comments: numeric(post.commentsCount ?? post.comments), views: numeric(post.videoViewCount ?? post.views) };
}
export function normalizeMarketingEvidence(value, url, origin = 'provided') {
  const type = marketingSourceType(url);
  const status = value?.status;
  const posts = (Array.isArray(value?.posts) ? value.posts : []).slice(0, 20).map(socialPost).filter(Boolean);
  const text = clean(value?.text || value?.extractedText || value?.caption || value?.content?.text || '', 12000);
  const limits = (Array.isArray(value?.limitations) ? value.limitations : Array.isArray(value?.warnings) ? value.warnings : []).map(v => clean(v, 1000)).slice(0, 10);
  const readable = !['blocked', 'failed', 'unavailable', 'unsupported', 'hint', 'not_read', 'login_required'].includes(status) && Boolean(text.length >= 60 || posts.length);
  const modalities = value?.coverage ? [value.coverage.caption || value.coverage.transcript ? 'text' : '', value.coverage.visual ? 'video' : '', value.coverage.audio ? 'audio' : ''].filter(Boolean) : ['text'];
  return { id: randomUUID(), url, type, origin, title: clean(value?.title, 300) || new URL(url).hostname, status: readable ? 'read' : 'unavailable', text: readable ? text : '', posts: readable ? posts : [], observedAt: new Date().toISOString(), modalities, visualObservations: value?.coverage?.visual ? (value.visualObservations || []).slice(0, 15) : [], audioObservations: value?.coverage?.audio ? (value.audioObservations || []).slice(0, 15) : [], transcript: clean(value?.transcript, 18000), metrics: value?.metrics || null, coverage: value?.coverage || null, limitations: [...limits, ...(type !== 'website' && !posts.length ? ['Keine vollständige Post-Stichprobe oder verifizierten Profilkennzahlen verfügbar.'] : []), ...(readable ? [] : ['Diese Quelle konnte nicht inhaltlich gelesen werden.'])] };
}
export async function collectProjectResearch({ profile, urls = [], automatic = false, projectId, signal, env = process.env, readInstagram = scrapeInstagram, search = searchWebCandidates, readMediaEvidence, readWebsite = createWebsiteUrlImporter().readWebsiteReference }) {
  if (!Array.isArray(urls) || urls.length > 12) throw marketingError('MARKETING_REFERENCE_LIMIT', 'Bitte höchstens zwölf Wettbewerber- oder Beitragslinks pro Recherche angeben.');
  const candidates = new Map();
  const add = (url, origin, title = '') => { try { const normalized = publicMarketingUrl(url); if (normalized && !candidates.has(normalized)) candidates.set(normalized, { url: normalized, origin, title }); } catch {} };
  urls.forEach(url => add(url, 'provided'));
  const limitations = [];
  if (automatic) {
    const topic = clean([profile.industry, profile.offer, profile.audience].filter(Boolean).join(' '), 900);
    if (!topic) throw marketingError('MARKETING_PROFILE_REQUIRED', 'Bitte zuerst Angebot, Branche oder Zielgruppe im Projektprofil ergänzen.');
    for (const query of [`${topic} ${profile.region || 'DACH'} Anbieter Wettbewerber`, `${topic} ${profile.region || 'DACH'} site:instagram.com`, `${topic} ${profile.region || 'DACH'} site:linkedin.com/company`]) {
      signal?.throwIfAborted();
      try { const rows = await search(query, { limit: 4, projectId, signal }); for (const row of (Array.isArray(rows) ? rows : rows.results || [])) add(row.url, 'search', row.title); }
      catch { limitations.push('Ein Teil der automatischen Websuche war nicht verfügbar.'); }
    }
  }
  if (!candidates.size) throw marketingError('MARKETING_NO_REFERENCES', automatic ? 'Die Suche hat keine verwertbaren öffentlichen Quellen gefunden. Wettbewerberlinks können direkt ergänzt werden.' : 'Bitte mindestens einen vollständigen Wettbewerber- oder Beitragslink angeben.');
  const sources = [];
  for (const candidate of [...candidates.values()].slice(0, 12)) {
    signal?.throwIfAborted();
    let evidence;
    try {
      const type = marketingSourceType(candidate.url);
      const profileHandle = type === 'instagram' ? new URL(candidate.url).pathname.match(/^\/([a-z\d._]{1,30})\/?$/i)?.[1] : null;
      if (profileHandle && env.APIFY_TOKEN && readInstagram) {
        const posts = await readInstagram(profileHandle, { resultsLimit: 12 });
        evidence = { status: 'read', title: '@' + profileHandle, posts, text: (posts || []).map(p => p.caption || '').filter(Boolean).join('\n\n'), limitations: ['Beobachtete Stichprobe öffentlicher Posts. Bild-, Ton- und Videoeigenschaften sind daraus nicht vollständig abgeleitet.'] };
      } else if (type === 'website' || type === 'linkedin') evidence = await readWebsite(candidate.url, { signal });
      else if (readMediaEvidence) evidence = await readMediaEvidence(candidate.url, { projectId, signal, env });
      else evidence = { status: 'unavailable', limitations: ['Der öffentliche Social-Reader ist noch nicht angeschlossen. Profil-URLs allein sind keine Contentanalyse.'] };
      sources.push(normalizeMarketingEvidence(evidence, candidate.url, candidate.origin));
      // Discovered links are candidates only. A link never becomes content evidence.
      for (const link of (evidence?.links || evidence?.socialLinks || [])) {
        const url = typeof link === 'string' ? link : link.url;
        try { if (marketingSourceType(publicMarketingUrl(url)) !== 'website') add(url, 'linked'); } catch {}
      }
    } catch { sources.push(normalizeMarketingEvidence({ status: 'unavailable', title: candidate.title, limitations: ['Die Quelle war bei diesem Abruf nicht zugänglich.'] }, candidate.url, candidate.origin)); }
  }
  const seen = new Set(sources.map(s => s.url));
  const discovered = [...candidates.values()].filter(x => !seen.has(x.url)).slice(0, 12).map(x => ({ ...x, type: marketingSourceType(x.url), status: 'hint' }));
  const readCount = sources.filter(s => s.status === 'read').length;
  return { sources, discovered, limitations: [...new Set(limitations)], coverage: { checked: sources.length, read: readCount, socialPosts: sources.reduce((n, s) => n + s.posts.length, 0), incomplete: sources.some(s => s.status !== 'read' || s.type !== 'website' && !s.posts.length) } };
}
