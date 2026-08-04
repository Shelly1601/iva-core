import { createSuiteItem, listSuiteItems, suiteCounts, updateSuiteItem } from './suite-store.js';

const clean = (value, max = 5000) => String(value || '').trim().slice(0, max);
const allowedChannels = new Set(['instagram', 'facebook', 'linkedin', 'email', 'whatsapp']);
const allowedFormats = new Set(['reel', 'image', 'carousel', 'story', 'email']);

function addDays(date, days) { const value = new Date(date); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10); }

function buildSlots({ startDate, weeks, postsPerWeek, channels, formats }) {
  const total = Math.min(40, Math.max(1, weeks * postsPerWeek)); const slots = [];
  const spacing = 7 / postsPerWeek;
  for (let index = 0; index < total; index++) slots.push({
    number: index + 1, date: addDays(startDate, Math.floor(index * spacing)),
    channel: channels[index % channels.length], format: formats[index % formats.length], status: 'draft', approval: 'pending',
  });
  return slots;
}

export async function createContentPlan(input = {}, { campaigns, brands, generateContent } = {}) {
  const campaign = await campaigns.getCampaign(clean(input.campaignId, 120));
  if (!campaign) throw new Error('Kampagne nicht gefunden');
  const brand = campaign.brandId ? await brands.getBrand(campaign.brandId) : null;
  const weeks = Math.max(1, Math.min(8, Number(input.weeks) || 4)); const postsPerWeek = Math.max(1, Math.min(7, Number(input.postsPerWeek) || 3));
  const channels = [...new Set((input.channels || ['instagram']).filter(item => allowedChannels.has(item)))];
  const formats = [...new Set((input.formats || ['reel', 'image']).filter(item => allowedFormats.has(item)))];
  if (!channels.length || !formats.length) throw new Error('Mindestens ein Kanal und Format wählen');
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(input.startDate || '') ? input.startDate : new Date().toISOString().slice(0, 10);
  const slots = buildSlots({ startDate, weeks, postsPerWeek, channels, formats });
  const primaryFormat = formats.includes('reel') ? 'reel' : formats.includes('email') ? 'email' : 'image';
  const generated = await generateContent(campaign, brand, { briefing: clean(input.briefing, 4000), count: Math.min(12, slots.length), format: primaryFormat });
  const qualityGate = {
    status: 'needs-review', score: 0,
    checks: [
      { id: 'brand', label: 'Marke, Zielgruppe und Tonalität hinterlegt', passed: Boolean((brand?.name || campaign.brand) && (brand?.audience || campaign.tone)) },
      { id: 'research', label: 'Aktuelle Quellen-/Wettbewerbsanalyse verknüpft', passed: Boolean(campaign.analysis || input.researchRunId) },
      { id: 'claims', label: 'Fachliche Aussagen und Werbeversprechen geprüft', passed: false },
      { id: 'human', label: 'Finale Sichtprüfung vor Veröffentlichung', passed: false },
    ],
  };
  qualityGate.score = Math.round(qualityGate.checks.filter(check => check.passed).length / qualityGate.checks.length * 100);
  return createSuiteItem('contentPlans', {
    campaignId: campaign.id, campaignName: campaign.name, brandId: brand?.id || campaign.brandId || '', brandName: brand?.name || campaign.brand || '',
    researchRunId: clean(input.researchRunId, 120), objective: clean(input.objective || input.briefing, 1000), startDate, weeks, postsPerWeek,
    channels, formats, slots, draft: generated?.content || '', generation: { ok: Boolean(generated?.ok), format: primaryFormat, count: Math.min(12, slots.length) },
    qualityGate, status: 'draft', publishing: { enabled: false, reason: 'Freigabe und Plattform-Connector erforderlich' },
  });
}

export async function createEmailCampaign(input = {}) {
  const audienceStatus = ['opted-in', 'existing-customers', 'b2b-review-required'].includes(input.audienceStatus) ? input.audienceStatus : 'b2b-review-required';
  return createSuiteItem('emailCampaigns', {
    campaignId: clean(input.campaignId, 120), name: clean(input.name, 180) || 'Neue E-Mail-Kampagne',
    subject: clean(input.subject, 300), preview: clean(input.preview, 300), body: clean(input.body, 20_000), cta: clean(input.cta, 500),
    audience: clean(input.audience, 1000), audienceStatus, legalBasis: clean(input.legalBasis, 1000), sender: clean(input.sender, 300),
    status: 'draft', sendApproval: 'pending', delivery: { enabled: false, reason: 'Absenderdomain, Empfängerliste, Rechtsgrundlage und finale Freigabe erforderlich' },
  });
}

export function evaluateAdMetrics(metrics = {}, targets = {}) {
  const spend = Number(metrics.spend || 0), impressions = Number(metrics.impressions || 0), clicks = Number(metrics.clicks || 0), leads = Number(metrics.leads || 0), purchases = Number(metrics.purchases || 0), revenue = Number(metrics.revenue || 0), frequency = Number(metrics.frequency || 0);
  const ctr = impressions ? clicks / impressions * 100 : 0, cpc = clicks ? spend / clicks : 0, cpl = leads ? spend / leads : 0, cpa = purchases ? spend / purchases : 0, roas = spend ? revenue / spend : 0;
  const suggestions = [];
  if (!spend) suggestions.push({ severity: 'info', action: 'Noch keine belastbare Optimierung', why: 'Kein Spend im gewählten Zeitraum.' });
  if (impressions >= 1000 && ctr < Number(targets.minCtr || 1)) suggestions.push({ severity: 'high', action: 'Hook und Creative testen', why: `CTR ${ctr.toFixed(2)} % liegt unter Ziel ${Number(targets.minCtr || 1).toFixed(2)} %.` });
  if (leads && Number(targets.maxCpl) > 0 && cpl > Number(targets.maxCpl)) suggestions.push({ severity: 'high', action: 'Landingpage, Angebot und Zielgruppe prüfen', why: `CPL ${cpl.toFixed(2)} EUR liegt über Ziel ${Number(targets.maxCpl).toFixed(2)} EUR.` });
  if (frequency > Number(targets.maxFrequency || 3.5)) suggestions.push({ severity: 'medium', action: 'Creative-Rotation vorbereiten', why: `Frequenz ${frequency.toFixed(2)} deutet auf mögliche Anzeigenmüdigkeit.` });
  if (revenue && roas < Number(targets.minRoas || 2)) suggestions.push({ severity: 'high', action: 'Budgeterhöhung sperren und Funnel prüfen', why: `ROAS ${roas.toFixed(2)} liegt unter Ziel ${Number(targets.minRoas || 2).toFixed(2)}.` });
  if (spend && !suggestions.length) suggestions.push({ severity: 'good', action: 'Weiter beobachten', why: 'Die hinterlegten Zielwerte werden aktuell nicht verletzt.' });
  return { derived: { ctr, cpc, cpl, cpa, roas }, suggestions, decision: 'suggest-only', notice: 'IVA verändert Budget, Zielgruppe oder Anzeige erst nach separater Bestätigung.' };
}

export async function recordAdSnapshot(input = {}) {
  const metrics = Object.fromEntries(['spend', 'impressions', 'clicks', 'leads', 'purchases', 'revenue', 'frequency'].map(key => [key, Math.max(0, Number(input.metrics?.[key] || 0))]));
  const targets = { minCtr: Number(input.targets?.minCtr || 1), maxCpl: Number(input.targets?.maxCpl || 0), maxFrequency: Number(input.targets?.maxFrequency || 3.5), minRoas: Number(input.targets?.minRoas || 2) };
  return createSuiteItem('adSnapshots', {
    campaignId: clean(input.campaignId, 120), adSet: clean(input.adSet, 300), period: clean(input.period, 100) || 'manuell', source: clean(input.source, 100) || 'manual',
    metrics, targets, evaluation: evaluateAdMetrics(metrics, targets), approval: { status: 'pending', action: '', confirmedAt: null }, status: 'reviewed',
  });
}

export async function approveAdRecommendation(snapshotId, input = {}) {
  if (clean(input.confirmation, 200) !== 'Ja, Ads-Änderung freigeben') throw new Error('Exakte Bestätigung fehlt: Ja, Ads-Änderung freigeben');
  return updateSuiteItem('adSnapshots', snapshotId, { approval: { status: 'approved-for-manual-implementation', action: clean(input.action, 1000), confirmedAt: new Date().toISOString() } });
}

export async function createMarketingReport({ period = 'morning' } = {}) {
  const [researchRuns, contentPlans, emailCampaigns, adSnapshots, counts] = await Promise.all([
    listSuiteItems('researchRuns', { limit: 10 }), listSuiteItems('contentPlans', { limit: 20 }), listSuiteItems('emailCampaigns', { limit: 20 }), listSuiteItems('adSnapshots', { limit: 20 }), suiteCounts(),
  ]);
  const latestAds = adSnapshots.slice(0, 5); const high = latestAds.flatMap(item => item.evaluation?.suggestions || []).filter(item => item.severity === 'high');
  const text = [
    '**Marketing-Report**',
    `- Marktanalysen: ${counts.researchRuns} (${researchRuns.filter(item => item.status === 'complete').length} zuletzt vollständig)`,
    `- Content-Pläne: ${counts.contentPlans} · ${contentPlans.filter(item => item.status === 'draft').length} Entwürfe warten auf Freigabe`,
    `- E-Mail-Kampagnen: ${counts.emailCampaigns} · Versand bleibt bis Freigabe gesperrt`,
    `- Ads-Snapshots: ${counts.adSnapshots} · ${high.length} dringende Optimierungshinweise`,
    high.length ? '**Ads – Handlungsbedarf**\n' + high.slice(0, 5).map(item => `- ${item.action}: ${item.why}`).join('\n') : '- Keine dringende Ads-Abweichung in den gespeicherten Daten.',
  ].join('\n');
  return createSuiteItem('reports', { period, text, counts, highlights: high.slice(0, 10), status: 'generated' });
}

export async function listMarketingCollection(collection, options = {}) { return listSuiteItems(collection, options); }
