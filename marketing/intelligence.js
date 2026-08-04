import { generateText } from 'ai';
import { chooseModel, recordUsage, checkBudget } from '../core/router.js';
import { createSuiteItem, listSuiteItems, updateSuiteItem } from './suite-store.js';
import { crawlPublicBusinessContacts, discoverGoogleBusinesses, marketingConnectorStatus, metaAdLibrarySearchUrl } from './connectors.js';

const PLATFORMS = new Set(['google', 'website', 'instagram', 'facebook', 'linkedin', 'meta-ads']);
const clean = (value, max = 1000) => String(value || '').trim().slice(0, max);
const unique = values => [...new Set(values.map(value => clean(value, 1000)).filter(Boolean))];
function publicUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''; } catch { return ''; } }

function instagramHandle(value) {
  const text = clean(value, 500);
  const match = text.match(/instagram\.com\/([^/?#]+)/i);
  if (match) return '@' + match[1];
  if (/^@?[a-z0-9._]{2,}$/i.test(text)) return '@' + text.replace(/^@/, '');
  return '';
}

function researchCompleteness({ companies, enriched, socialAnalysis, platforms }) {
  const checks = [
    { id: 'company-sample', label: 'Reale Wettbewerber-/Firmenstichprobe', passed: companies.length >= 5, value: companies.length },
    { id: 'website-evidence', label: 'Öffentliche Websites/Impressen geprüft', passed: enriched.length >= 3, value: enriched.length },
    { id: 'social-evidence', label: 'Echte Social-Postdaten ausgewertet', passed: Boolean(socialAnalysis?.ok), value: socialAnalysis?.accounts?.length || 0 },
    { id: 'ads-evidence', label: 'Werbemittel aus der Meta Ad Library geprüft', passed: false, value: platforms.includes('meta-ads') ? 'manueller/Actor-Check offen' : 'nicht gewählt' },
  ];
  const score = Math.round(checks.filter(item => item.passed).length / checks.length * 100);
  return { score, checks, grade: score >= 75 ? 'belastbar' : score >= 50 ? 'brauchbar' : 'vorläufig' };
}

async function synthesizeEvidence({ industry, region, companies, enriched, socialAnalysis, completeness }) {
  const evidence = {
    industry, region, completeness,
    companies: companies.slice(0, 20).map(company => ({ name: company.name, rating: company.rating, reviewCount: company.reviewCount, website: company.website, category: company.category })),
    websites: enriched.slice(0, 12).map(item => ({ name: item.name, website: item.website, excerpts: item.research?.excerpts?.slice(0, 2) || [], socials: item.research?.socials || {} })),
    instagram: socialAnalysis?.ok ? { accounts: socialAnalysis.accounts, profile: socialAnalysis.profile } : null,
  };
  if (!process.env.GEMINI_API_KEY) return {
    executiveSummary: 'Quellen wurden gesammelt. Für die KI-Synthese fehlt noch GEMINI_API_KEY.',
    competitors: companies.slice(0, 8).map(company => ({ name: company.name, sizeSignal: `${company.reviewCount || 0} Google-Bewertungen`, strengths: [], channels: [] })),
    winningPatterns: [], marketGaps: [], contentExamples: [], adAngles: [], nextActions: ['Gemini anbinden', 'Top-Wettbewerber bestätigen', 'Meta-Ad-Library-Beispiele erfassen'], evidenceLimits: ['Keine KI-Synthese ohne Gemini.'],
  };
  const routed = chooseModel({ task: 'marketing-intelligence' }); await checkBudget(routed);
  const { text, usage } = await generateText({
    model: routed.model,
    system: `Du bist ein extrem sorgfältiger Competitive-Intelligence-Analyst. Arbeite AUSSCHLIESSLICH mit den gelieferten Quellen. Erfinde keine Umsätze, Mitarbeiterzahlen, Reichweiten oder Werbeerfolge. Eine Google-Bewertungszahl ist nur ein Größenindikator, keine echte Unternehmensgröße. Gib ausschließlich valides JSON ohne Markdown zurück:
{"executiveSummary":"3-5 Sätze","competitors":[{"name":"","sizeSignal":"nur belegte Signale","positioning":"","strengths":[""],"weaknesses":[""],"channels":[""]}],"winningPatterns":[{"pattern":"","evidence":"","howToUse":""}],"marketGaps":[{"gap":"","opportunity":""}],"contentExamples":[{"hook":"","format":"","why":""}],"adAngles":[{"angle":"","proofNeeded":""}],"nextActions":[""],"evidenceLimits":[""]}`,
    prompt: JSON.stringify(evidence),
  });
  await recordUsage(routed, usage);
  try { return JSON.parse(text.replace(/```json|```/gi, '').trim()); }
  catch { return { executiveSummary: text.trim(), competitors: [], winningPatterns: [], marketGaps: [], contentExamples: [], adAngles: [], nextActions: [], evidenceLimits: ['Antwort ließ sich nicht vollständig strukturieren.'] }; }
}

export async function runMarketIntelligence(input = {}, { analyzeReferences } = {}) {
  const industry = clean(input.industry, 180); const region = clean(input.region || 'Deutschland', 180);
  if (!industry) throw new Error('Branche oder Nische fehlt');
  const platforms = unique(Array.isArray(input.platforms) ? input.platforms : ['google', 'website', 'instagram', 'facebook', 'linkedin', 'meta-ads']).filter(item => PLATFORMS.has(item));
  const seedAccounts = unique(input.seedAccounts || []); const seedUrls = unique(input.seedUrls || []).map(publicUrl).filter(Boolean);
  const run = await createSuiteItem('researchRuns', { industry, region, platforms, seedAccounts, seedUrls, status: 'running', progress: 'Quellen werden gesammelt', result: null });
  try {
    const places = platforms.includes('google') ? await discoverGoogleBusinesses({ industry, region, pageSize: input.pageSize || 20 }) : { ok: false, error: 'Google nicht gewählt', companies: [] };
    const companies = [...places.companies];
    for (const url of seedUrls) companies.push({ name: new URL(url).hostname.replace(/^www\./, ''), website: url, source: 'manual-seed', sourceUrl: url, rating: 0, reviewCount: 0 });
    const enriched = [];
    for (const company of companies.slice(0, 12)) {
      const research = company.website && platforms.includes('website') ? await crawlPublicBusinessContacts(company.website) : null;
      const companyItem = await createSuiteItem('companies', {
        researchRunId: run.id, industry, region, ...company, research,
        publicContacts: research?.ok ? { emails: research.emails, phones: research.phones, executives: research.executives } : { emails: [], phones: company.phone ? [company.phone] : [], executives: [] },
        outreach: { approved: false, legalBasis: '', status: 'research-only' },
        adLibraryUrl: metaAdLibrarySearchUrl(company.name || industry), status: 'researched',
      });
      enriched.push(companyItem);
    }
    const discoveredHandles = enriched.map(item => instagramHandle(item.research?.socials?.instagram)).filter(Boolean);
    const handles = unique([...seedAccounts.map(instagramHandle), ...discoveredHandles]).filter(Boolean).slice(0, 10);
    let socialAnalysis = null;
    if (platforms.includes('instagram') && handles.length && process.env.APIFY_TOKEN && analyzeReferences) {
      socialAnalysis = await analyzeReferences(handles, { brand: input.brand || industry, resultsLimit: Math.max(10, Math.min(40, Number(input.resultsLimit) || 25)) });
    } else if (platforms.includes('instagram')) {
      socialAnalysis = { ok: false, error: handles.length ? 'APIFY_TOKEN fehlt' : 'Keine Instagram-Konten gefunden/angegeben', accounts: [] };
    }
    const completeness = researchCompleteness({ companies, enriched, socialAnalysis, platforms });
    const summary = await synthesizeEvidence({ industry, region, companies, enriched, socialAnalysis, completeness });
    const result = {
      companyCount: companies.length, enrichedCount: enriched.length, companies: enriched.map(item => item.id),
      socialAnalysis, summary, completeness,
      adLibrary: companies.slice(0, 12).map(company => ({ name: company.name, url: metaAdLibrarySearchUrl(company.name || industry), automated: false })),
      sources: { googlePlaces: places.ok, websites: enriched.filter(item => item.research?.ok).length, instagramAccounts: socialAnalysis?.accounts?.length || 0 },
      connectorGaps: marketingConnectorStatus().connectors.filter(item => !item.configured).map(item => item.id),
    };
    return await updateSuiteItem('researchRuns', run.id, { status: completeness.score >= 50 ? 'complete' : 'partial', progress: 'Analyse fertig', result });
  } catch (error) {
    await updateSuiteItem('researchRuns', run.id, { status: 'failed', progress: error.message });
    throw error;
  }
}

export async function listResearchRuns(options = {}) { return listSuiteItems('researchRuns', options); }
export async function listResearchedCompanies(options = {}) { return listSuiteItems('companies', options); }
