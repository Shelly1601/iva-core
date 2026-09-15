import { randomUUID } from 'node:crypto';
import { searchWebCandidates } from '../agents/web.js';
import { createWebsiteUrlImporter } from '../websites/import-url.js';
import { clean, marketingError, publicMarketingUrl } from './project-store.js';
import { scrapeInstagram } from './analyze.js';
import { extractMarketingWebsite, isMeaningfulMarketingText } from './web-extract.js';

export function marketingSourceType(value) {
  const parsed = new URL(value), host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
  if (/(^|\.)youtube\.com$/.test(host) || host === 'youtu.be') return 'youtube';
  return /\.(?:mp4|mov|webm)$/i.test(parsed.pathname) ? 'video' : 'website';
}
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function socialPost(post) {
  const supplied = clean(post.caption || post.text, 4000);
  const caption = isMeaningfulMarketingText(supplied, { minimumLength: 1 }) ? supplied : '';
  let url = ''; try { url = publicMarketingUrl(post.url || post.sourceUrl); } catch {}
  if (!caption && !url) return null;
  return { url, caption, type: clean(post.type, 100), postedAt: clean(post.timestamp || post.postedAt, 80), likes: numeric(post.likesCount ?? post.likes), comments: numeric(post.commentsCount ?? post.comments), views: numeric(post.videoViewCount ?? post.views) };
}
export function normalizeMarketingEvidence(value, url, origin = 'provided') {
  const type = marketingSourceType(url);
  const status = value?.status;
  const posts = (Array.isArray(value?.posts) ? value.posts : []).slice(0, 20).map(socialPost).filter(Boolean);
  const suppliedText = clean(value?.text || value?.extractedText || value?.caption || value?.content?.text || '', 12000);
  const hasCaptionText = isMeaningfulMarketingText(value?.caption, { minimumLength: 1 });
  const hasText = (status !== 'metadata_only' || hasCaptionText) && isMeaningfulMarketingText(suppliedText, { title: value?.title });
  const limits = (Array.isArray(value?.limitations) ? value.limitations : Array.isArray(value?.warnings) ? value.warnings : []).map(v => clean(v, 1000)).slice(0, 10);
  const observations = (items, enabled) => enabled && Array.isArray(items) ? items.slice(0, 15).filter(item => item && typeof item.text === 'string' && item.text.trim() && Number.isFinite(item.startSeconds) && Number.isFinite(item.endSeconds) && item.startSeconds >= 0 && item.endSeconds >= item.startSeconds).map(item => ({ startSeconds: item.startSeconds, endSeconds: item.endSeconds, text: clean(item.text, 1500) })) : [];
  const visual = observations(value?.visualObservations, value?.coverage?.visual === true);
  const audio = observations(value?.audioObservations, value?.coverage?.audio === true);
  const transcriptSegments = observations(value?.transcriptSegments, value?.coverage?.transcript === true);
  const hasCaptions = posts.some(post => Boolean(post.caption));
  const readable = !['blocked', 'failed', 'unavailable', 'unsupported', 'hint', 'not_read', 'login_required'].includes(status) && Boolean(hasText || hasCaptions || visual.length || audio.length || transcriptSegments.length);
  const modalities = readable ? [hasText || hasCaptions || transcriptSegments.length ? 'text' : '', visual.length ? 'video' : '', audio.length || transcriptSegments.length ? 'audio' : ''].filter(Boolean) : [];
  let finalUrl = null;
  const suppliedFinalUrl = value?.finalUrl || value?.url;
  if (suppliedFinalUrl) { try { finalUrl = publicMarketingUrl(suppliedFinalUrl); } catch { limits.push('Die zurückgelieferte Weiterleitungsadresse konnte nicht als sichere öffentliche URL übernommen werden.'); } }
  const metrics = value?.metrics ? { views: numeric(value.metrics.views), likes: numeric(value.metrics.likes), comments: numeric(value.metrics.comments) } : null;
  return {
    id: randomUUID(), url, finalUrl, type, origin, title: clean(value?.title, 300) || new URL(url).hostname,
    status: readable ? 'read' : 'unavailable', text: readable && hasText ? suppliedText : '', posts,
    observedAt: new Date().toISOString(), provider: clean(value?.provider || (posts.length ? 'social-metadata' : 'direct-https'), 100), fetchedAt: clean(value?.fetchedAt, 80) || new Date().toISOString(), modalities,
    visualObservations: visual, audioObservations: audio, transcript: transcriptSegments.map(item => item.text).join('\n').slice(0, 18000), metrics,
    coverage: { text: readable && Boolean(hasText || hasCaptions || transcriptSegments.length), visual: readable && visual.length > 0, audio: readable && Boolean(audio.length || transcriptSegments.length), transcript: readable && transcriptSegments.length > 0 },
    limitations: [...limits, ...(type !== 'website' && !hasCaptions ? ['Keine gelesene Post-Caption-Stichprobe verfügbar; vorhandene Profil- oder Beitragskennzahlen sind nur Metadaten.'] : []), ...(readable ? [] : ['Diese Quelle konnte nicht inhaltlich gelesen werden.'])],
  };
}
export async function collectProjectResearch({ profile, urls = [], automatic = false, projectId, signal, env = process.env, readInstagram = scrapeInstagram, search = searchWebCandidates, readMediaEvidence, readWebsite = createWebsiteUrlImporter().readWebsiteReference, extractWebsite = extractMarketingWebsite }) {
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
  const rethrowStopped = error => {
    signal?.throwIfAborted();
    if (['AbortError', 'TimeoutError'].includes(error?.name) || /(?:ABORT|TIMEOUT|TIMED_OUT)/i.test(error?.code || '')) throw error;
  };
  const readWebsiteAddress = async url => {
    signal?.throwIfAborted();
    let result;
    try { result = await readWebsite(url, { signal }); } catch (error) { rethrowStopped(error); }
    signal?.throwIfAborted();
    if (result && isMeaningfulMarketingText(result.text, { title: result.title })) return result;
    if (env.TAVILY_API_KEY) {
      try { result = await extractWebsite(url, { env, signal }); } catch (error) { rethrowStopped(error); result = null; }
      signal?.throwIfAborted();
      if (result && isMeaningfulMarketingText(result.text, { title: result.title })) return result;
    }
    return null;
  };
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
      } else if (type === 'website' || type === 'linkedin') {
        evidence = await readWebsiteAddress(candidate.url);
        const alternate = new URL(candidate.url);
        if (!evidence && type === 'website' && alternate.hostname.startsWith('www.')) {
          alternate.hostname = alternate.hostname.slice(4);
          const alternateUrl = publicMarketingUrl(alternate.href);
          evidence = await readWebsiteAddress(alternateUrl);
          if (evidence) {
            const finalUrl = publicMarketingUrl(evidence.finalUrl || evidence.url || alternateUrl);
            const previousLimits = Array.isArray(evidence.limitations) ? evidence.limitations : Array.isArray(evidence.warnings) ? evidence.warnings : [];
            evidence = { ...evidence, finalUrl, limitations: [`Ursprüngliche www-Adresse nicht lesbar; Inhalt von ${finalUrl} gelesen.`, ...previousLimits] };
          }
        }
      }
      else if (readMediaEvidence) evidence = await readMediaEvidence(candidate.url, { projectId, signal, env });
      else evidence = { status: 'unavailable', limitations: ['Der öffentliche Social-Reader ist noch nicht angeschlossen. Profil-URLs allein sind keine Contentanalyse.'] };
      sources.push(normalizeMarketingEvidence(evidence, candidate.url, candidate.origin));
      // Discovered links are candidates only. A link never becomes content evidence.
      for (const link of (evidence?.links || evidence?.socialLinks || [])) {
        const url = typeof link === 'string' ? link : link.url;
        try { if (marketingSourceType(publicMarketingUrl(url)) !== 'website') add(url, 'linked'); } catch {}
      }
    } catch { signal?.throwIfAborted(); sources.push(normalizeMarketingEvidence({ status: 'unavailable', title: candidate.title, limitations: ['Die Quelle war bei diesem Abruf nicht zugänglich.'] }, candidate.url, candidate.origin)); }
  }
  const seen = new Set(sources.map(s => s.url));
  const discovered = [...candidates.values()].filter(x => !seen.has(x.url)).slice(0, 12).map(x => ({ ...x, type: marketingSourceType(x.url), status: 'hint' }));
  const readCount = sources.filter(s => s.status === 'read').length;
  return { sources, discovered, limitations: [...new Set(limitations)], coverage: { checked: sources.length, read: readCount, socialPosts: sources.reduce((n, s) => n + s.posts.filter(post => Boolean(post.caption)).length, 0), incomplete: sources.some(s => s.status !== 'read' || s.type !== 'website' && !s.posts.some(post => Boolean(post.caption))) } };
}
