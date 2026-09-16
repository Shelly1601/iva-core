const clean = (value, max = 240) => String(value ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

export function knowledgeSourceType(sourceUrl = '') {
  try {
    const url = new URL(sourceUrl), host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)instagram\.com$/.test(host) && /^\/(?:reels?|tv)\//i.test(url.pathname)) return 'video';
    if (/(^|\.)tiktok\.com$/.test(host) || ['youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com'].includes(host)) return 'video';
  } catch {}
  return 'page';
}

// This is a provisional source label. The importer replaces it with a title
// derived from the actual readable content after extraction.
export function deriveKnowledgeTitle(input = {}) {
  const explicit = clean(input.title);
  if (explicit) return explicit;
  const firstLine = String(input.content || '').split(/\r?\n/).map(line => clean(line.replace(/^\s*#{1,6}\s+/, '').replace(/<[^>]+>/g, ''), 120)).find(Boolean);
  if (firstLine && !/^https?:\/\/\S+$/i.test(firstLine)) return firstLine;
  const documentName = clean(input.documentName).split(/[\\/]/).at(-1)?.replace(/\.(?:pdf|txt|md)$/i, '');
  if (documentName) return clean(documentName);
  try {
    const url = new URL(String(input.sourceUrl || ''));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean);
    const shortId = value => clean(value, 36);
    if (/(^|\.)instagram\.com$/.test(host)) {
      const kind = /^(?:reels?|tv)$/i.test(parts[0] || '') ? 'Instagram-Reel' : parts[0] === 'p' ? 'Instagram-Beitrag' : 'Instagram';
      return `${kind}${parts[1] ? ` · ${shortId(parts[1])}` : ''}`;
    }
    if (/(^|\.)tiktok\.com$/.test(host)) return `TikTok-Video${parts.find(part => part.startsWith('@')) ? ` · ${shortId(parts.find(part => part.startsWith('@')))}` : ''}`;
    if (['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return `YouTube-Video${url.searchParams.get('v') ? ` · ${shortId(url.searchParams.get('v'))}` : ''}`;
    let slug = '';
    try { slug = decodeURIComponent(parts.at(-1) || '').replace(/\.(?:html?|php)$/i, '').replace(/[-_]+/g, ' '); } catch {}
    if (slug && !/^(?:[a-f0-9]{12,}|\d{6,})$/i.test(slug) && slug.length <= 100) return `${clean(slug[0].toUpperCase() + slug.slice(1), 100)} · ${host}`;
    return `Wissen von ${host}`;
  } catch { return ''; }
}
