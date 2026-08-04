const $ = id => document.getElementById(id);
const state = { status: null, brands: [], campaigns: [], research: [], companies: [], contentPlans: [], emails: [], ads: [], reports: [] };
const titles = {
  overview: ['Marketing-Zentrale', 'Vom Marktverständnis bis zum messbaren Kampagnenkreislauf.'], research: ['Marktanalyse', 'Wettbewerber, Content-Muster, Ad-Library-Spuren und echte Quellen.'],
  companies: ['Firmenfinder', 'Öffentliche Unternehmensdaten als Recherchebasis – noch keine Versandfreigabe.'], campaigns: ['Marken & Kampagnen', 'Jede Marke bekommt Zielgruppe, Tonalität, Kanäle, Budget und eigene Lernkurve.'],
  content: ['Content & UGC', 'Research-basierte Pläne, Reels, Captions, Hashtags und Video-Vorbereitung.'], email: ['E-Mail-Kampagnen', 'Entwürfe, Zielgruppen und Freigaben – Versand erst nach sauberer Einrichtung.'],
  ads: ['Ads & Optimierung', 'Kennzahlen bewerten, Chancen erkennen, Änderungen kontrolliert freigeben.'], reports: ['Marketing-Reporting', 'Regelmäßige Entscheidungsberichte statt unübersichtlicher Rohdaten.'], setup: ['Anbindungen', 'Was bereits läuft und welche Zugänge für den Vollbetrieb noch fehlen.'],
};

function esc(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function lines(value) { return String(value || '').split('\n').map(item => item.trim()).filter(Boolean); }
function selectedChecks(id) { return [...$(id).querySelectorAll('input:checked')].map(input => input.value); }
function headers() { return { Authorization: 'Bearer ' + (localStorage.getItem('iva_token') || ''), 'Content-Type': 'application/json' }; }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers || {}) } }); const json = await response.json().catch(() => null); if (!response.ok) throw new Error(json?.error || `HTTP ${response.status}`); return json; }
function setBusy(button, busy, text) { if (!button) return; if (!button.dataset.label) button.dataset.label = button.textContent; button.disabled = busy; button.textContent = busy ? text : button.dataset.label; }
function pill(status) { const warning = /partial|draft|pending|running/i.test(status); const off = /failed|off|false/i.test(status); return `<span class="pill ${off ? 'off' : warning ? 'warn' : ''}">${esc(status)}</span>`; }

function switchView(name) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === 'view-' + name));
  document.querySelectorAll('#nav button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
  $('pageTitle').textContent = titles[name][0]; $('pageIntro').textContent = titles[name][1];
}
document.querySelectorAll('#nav button').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));

function renderMetrics() {
  const counts = state.status?.counts || {}; const values = [
    ['Analysen', counts.researchRuns || 0], ['Unternehmen', counts.companies || 0], ['Kampagnen', state.campaigns.length], ['Content-Pläne', counts.contentPlans || 0], ['Ads-Checks', counts.adSnapshots || 0], ['Connectoren', `${state.status?.connectors?.ready || 0}/${state.status?.connectors?.total || 0}`],
  ];
  $('metrics').innerHTML = values.map(([label, value]) => `<div class="metric"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}
function connectorHtml(connector, compact = false) {
  return `<div class="connector"><span class="dot ${connector.configured ? 'on' : ''}"></span><div><b>${esc(connector.label)} ${pill(connector.configured ? 'bereit' : 'offen')}</b><small>${esc(connector.capabilities.join(' · '))}</small>${compact ? '' : `<small class="code">Railway: ${esc(connector.requires.join(' · '))}</small>`}</div></div>`;
}
function renderConnectors() {
  const connectors = state.status?.connectors?.connectors || [];
  $('readyText').textContent = `${state.status?.connectors?.ready || 0} von ${state.status?.connectors?.total || 0} Verbindungen sind einsatzbereit.`;
  $('overviewConnectors').innerHTML = connectors.slice(0, 4).map(item => connectorHtml(item, true)).join('');
  $('connectorList').innerHTML = connectors.map(item => connectorHtml(item)).join('');
  const byId = id => connectors.find(item => item.id === id) || { label: id, configured: false, capabilities: [], requires: [] };
  $('ugcStatus').innerHTML = connectorHtml(byId('heygen'), true); $('emailConnector').innerHTML = connectorHtml(byId('email'), true); $('metaConnector').innerHTML = connectorHtml(byId('meta'), true);
}
function renderBrands() {
  $('brandList').innerHTML = state.brands.length ? state.brands.map(brand => `<div class="item"><b>${esc(brand.name)}</b><small>${esc(brand.audience || 'Zielgruppe noch offen')}</small></div>`).join('') : '<div class="empty">Noch keine Marke angelegt.</div>';
  const options = '<option value="">Keine Marke</option>' + state.brands.map(brand => `<option value="${esc(brand.id)}">${esc(brand.name)}</option>`).join(''); $('campaignBrand').innerHTML = options;
}
function campaignOptions() { return '<option value="">Kampagne wählen</option>' + state.campaigns.map(campaign => `<option value="${esc(campaign.id)}">${esc(campaign.name)} · ${esc(campaign.type)}</option>`).join(''); }
function renderCampaigns() {
  $('campaignList').innerHTML = state.campaigns.length ? state.campaigns.map(campaign => `<div class="item"><div class="item-head"><div><b>${esc(campaign.name)}</b><small>${esc(campaign.brand || 'Ohne Marke')} · ${esc(campaign.targetChannel || 'Zielkanal offen')}</small></div>${pill(campaign.type)}</div><small>Autonomie: ${esc(campaign.autonomy)} · Budget-Cap: ${Number(campaign.config?.budgetCap || 0).toFixed(2)} EUR · Freigabe ${campaign.config?.approvalRequired === false ? 'aus' : 'an'}</small></div>`).join('') : '<div class="empty">Noch keine Kampagne angelegt.</div>';
  document.querySelectorAll('.campaign-select').forEach(select => { const value = select.value; select.innerHTML = campaignOptions(); if ([...select.options].some(option => option.value === value)) select.value = value; });
}

function completenessHtml(item) {
  const quality = item.result?.completeness; if (!quality) return '';
  return `<small>Quellenqualität: ${esc(quality.grade)} · ${quality.score} %</small><div class="quality"><i style="width:${quality.score}%"></i></div>`;
}
function renderResearch() {
  $('researchList').innerHTML = state.research.length ? state.research.map(item => `<button class="item" data-research="${esc(item.id)}" style="color:inherit;text-align:left;cursor:pointer"><div class="item-head"><div><b>${esc(item.industry)}</b><small>${esc(item.region)} · ${new Date(item.createdAt).toLocaleDateString('de-DE')}</small></div>${pill(item.status)}</div>${completenessHtml(item)}</button>`).join('') : '<div class="empty">Noch keine Marktanalyse.</div>';
  document.querySelectorAll('[data-research]').forEach(button => button.addEventListener('click', () => showResearch(state.research.find(item => item.id === button.dataset.research))));
}
function showResearch(item) {
  if (!item?.result) { $('researchResult').textContent = item?.progress || 'Noch kein Ergebnis.'; return; }
  const summary = item.result.summary || {}; const quality = item.result.completeness || {};
  const competitors = (summary.competitors || []).map(value => `• ${value.name}${value.sizeSignal ? ' — ' + value.sizeSignal : ''}\n  ${value.positioning || ''}`).join('\n');
  const patterns = (summary.winningPatterns || []).map(value => `• ${value.pattern}\n  Beleg: ${value.evidence || 'offen'}\n  Nutzung: ${value.howToUse || ''}`).join('\n');
  const gaps = (summary.marketGaps || []).map(value => `• ${value.gap}: ${value.opportunity}`).join('\n');
  const actions = (summary.nextActions || []).map(value => `• ${value}`).join('\n');
  $('researchResult').textContent = `QUELLENQUALITÄT · ${quality.score || 0} % · ${quality.grade || 'vorläufig'}\n\nMANAGEMENT-SUMMARY\n${summary.executiveSummary || ''}\n\nWETTBEWERBER\n${competitors || 'Noch keine belastbaren Wettbewerberdaten.'}\n\nERFOLGSMUSTER\n${patterns || 'Social-Postdaten noch offen.'}\n\nMARKTLÜCKEN\n${gaps || 'Noch nicht belastbar ableitbar.'}\n\nNÄCHSTE SCHRITTE\n${actions || 'Quellen ergänzen.'}`;
}
function renderCompanies() {
  if (!state.companies.length) { $('companyTable').innerHTML = '<div class="empty">Noch keine Firmenrecherche. Starte zuerst eine Marktanalyse.</div>'; return; }
  $('companyTable').innerHTML = `<table class="company-table"><thead><tr><th>Unternehmen</th><th>Öffentliche Kontakte</th><th>Größensignale</th><th>Quellen</th></tr></thead><tbody>${state.companies.map(company => {
    const contacts = company.publicContacts || {}; const emails = (contacts.emails || []).slice(0, 2).join(', '); const phones = (contacts.phones || []).slice(0, 2).join(', '); const executives = (contacts.executives || []).slice(0, 2).join(', ');
    return `<tr><td><b>${esc(company.name)}</b><small>${esc(company.address || company.region || '')}</small>${pill(company.outreach?.approved ? 'freigegeben' : 'research-only')}</td><td>${emails ? `<div>${esc(emails)}</div>` : ''}${phones ? `<div>${esc(phones)}</div>` : ''}${executives ? `<small>GF/Inhaber: ${esc(executives)}</small>` : '<small>Keine öffentliche Geschäftsführung gefunden</small>'}</td><td>${company.rating ? `${Number(company.rating).toFixed(1)} ★` : '–'}<small>${Number(company.reviewCount || 0)} Bewertungen</small></td><td>${company.website ? `<a href="${esc(company.website)}" target="_blank" rel="noopener">Website</a> · ` : ''}<a href="${esc(company.adLibraryUrl)}" target="_blank" rel="noopener">Ad Library</a></td></tr>`;
  }).join('')}</tbody></table>`;
}
function renderContentPlans() {
  $('contentPlans').innerHTML = state.contentPlans.length ? state.contentPlans.map(plan => `<div class="item"><div class="item-head"><div><b>${esc(plan.campaignName)}</b><small>${esc(plan.startDate)} · ${plan.slots?.length || 0} Slots · ${esc((plan.channels || []).join(', '))}</small></div>${pill(plan.status)}</div>${plan.qualityGate ? `<small>Quality Gate ${plan.qualityGate.score} %</small><div class="quality"><i style="width:${plan.qualityGate.score}%"></i></div>` : ''}<details><summary>Entwürfe anzeigen</summary><div class="result">${esc(plan.draft || '')}</div></details></div>`).join('') : '<div class="empty">Noch kein Content-Plan.</div>';
}
function renderEmails() {
  $('emailList').innerHTML = state.emails.length ? state.emails.map(item => `<div class="item"><div class="item-head"><div><b>${esc(item.name)}</b><small>${esc(item.subject || 'Betreff offen')} · ${esc(item.audienceStatus)}</small></div>${pill(item.status)}</div><small>Versand: ${esc(item.delivery?.reason || 'gesperrt')}</small></div>`).join('') : '<div class="empty">Noch keine E-Mail-Kampagne.</div>';
}
function renderAds() {
  $('adsList').innerHTML = state.ads.length ? state.ads.map(item => `<div class="item"><div class="item-head"><div><b>${esc(item.adSet || 'Ads-Snapshot')}</b><small>Spend ${Number(item.metrics?.spend || 0).toFixed(2)} EUR · CTR ${Number(item.evaluation?.derived?.ctr || 0).toFixed(2)} % · CPL ${Number(item.evaluation?.derived?.cpl || 0).toFixed(2)} EUR · ROAS ${Number(item.evaluation?.derived?.roas || 0).toFixed(2)}</small></div>${pill(item.approval?.status || 'pending')}</div><div class="list">${(item.evaluation?.suggestions || []).map(suggestion => `<div><b>${esc(suggestion.action)}</b><small>${esc(suggestion.why)}</small></div>`).join('')}</div></div>`).join('') : '<div class="empty">Noch keine Ads-Kennzahlen gespeichert.</div>';
}
function renderReports() {
  $('reportList').innerHTML = state.reports.length ? state.reports.map(report => `<div class="item"><div class="item-head"><b>${new Date(report.createdAt).toLocaleString('de-DE')}</b>${pill(report.period)}</div><div class="result">${esc(report.text)}</div></div>`).join('') : '<div class="empty">Noch kein Marketing-Report.</div>';
}
function renderAll() { renderMetrics(); renderConnectors(); renderBrands(); renderCampaigns(); renderResearch(); renderCompanies(); renderContentPlans(); renderEmails(); renderAds(); renderReports(); }

async function loadAll() {
  const data = await Promise.all([
    api('/api/marketing/status'), api('/api/brands'), api('/api/campaigns'), api('/api/marketing/research?limit=100'), api('/api/marketing/companies?limit=250'), api('/api/marketing/content-plans?limit=100'), api('/api/marketing/email-campaigns?limit=100'), api('/api/marketing/ads?limit=100'), api('/api/marketing/reports?limit=30'),
  ]);
  [state.status, state.brands, state.campaigns, state.research, state.companies, state.contentPlans, state.emails, state.ads, state.reports] = data; renderAll();
}

$('reload').addEventListener('click', () => loadAll().catch(error => { $('pageIntro').textContent = error.message; }));
$('ivaHelper').addEventListener('click', () => window.open('/cockpit', '_blank', 'noopener'));
$('createBrand').addEventListener('click', async () => {
  const button = $('createBrand'); setBusy(button, true, 'speichert …'); $('brandState').textContent = '';
  try { await api('/api/brands', { method: 'POST', body: JSON.stringify({ name: $('brandName').value, website: $('brandWebsite').value, audience: $('brandAudience').value, tone: $('brandTone').value, type: 'own' }) }); $('brandState').textContent = 'Marke gespeichert.'; await loadAll(); } catch (error) { $('brandState').textContent = error.message; } finally { setBusy(button, false); }
});
$('createCampaign').addEventListener('click', async () => {
  const button = $('createCampaign'); setBusy(button, true, 'speichert …'); $('campaignState').textContent = '';
  try { const brand = state.brands.find(item => item.id === $('campaignBrand').value); await api('/api/campaigns', { method: 'POST', body: JSON.stringify({ name: $('campaignName').value, brandId: brand?.id || '', brand: brand?.name || '', type: $('campaignType').value, autonomy: $('campaignAutonomy').value, targetChannel: $('campaignTarget').value, config: { objective: $('campaignObjective').value, budgetCap: Number($('campaignBudget').value || 0), approvalRequired: true } }) }); $('campaignState').textContent = 'Kampagne gespeichert.'; await loadAll(); } catch (error) { $('campaignState').textContent = error.message; } finally { setBusy(button, false); }
});
$('runResearch').addEventListener('click', async () => {
  const button = $('runResearch'); setBusy(button, true, 'analysiert · bitte warten …'); $('researchState').textContent = 'Google, Websites und Social-Quellen werden geprüft.';
  try { const result = await api('/api/marketing/research', { method: 'POST', body: JSON.stringify({ industry: $('researchIndustry').value, region: $('researchRegion').value, seedAccounts: lines($('researchAccounts').value), seedUrls: lines($('researchUrls').value), platforms: selectedChecks('researchPlatforms') }) }); $('researchState').textContent = `Fertig · Quellenqualität ${result.result?.completeness?.score || 0} %`; await loadAll(); showResearch(result); } catch (error) { $('researchState').textContent = error.message; } finally { setBusy(button, false); }
});
$('createContentPlan').addEventListener('click', async () => {
  const button = $('createContentPlan'); setBusy(button, true, 'Content wird erzeugt …'); $('contentState').textContent = 'Research und Marke werden berücksichtigt.';
  try { await api('/api/marketing/content-plans', { method: 'POST', body: JSON.stringify({ campaignId: $('contentCampaign').value, startDate: $('contentStart').value, weeks: Number($('contentWeeks').value), postsPerWeek: Number($('contentFrequency').value), channels: selectedChecks('contentChannels'), formats: selectedChecks('contentFormats'), briefing: $('contentBriefing').value }) }); $('contentState').textContent = 'Plan als Entwurf gespeichert.'; await loadAll(); } catch (error) { $('contentState').textContent = error.message; } finally { setBusy(button, false); }
});
$('createEmail').addEventListener('click', async () => {
  const button = $('createEmail'); setBusy(button, true, 'speichert …');
  try { await api('/api/marketing/email-campaigns', { method: 'POST', body: JSON.stringify({ campaignId: $('emailCampaignId').value, name: $('emailName').value, audience: $('emailAudience').value, audienceStatus: $('emailAudienceStatus').value, sender: $('emailSender').value, subject: $('emailSubject').value, body: $('emailBody').value, legalBasis: $('emailLegal').value }) }); $('emailState').textContent = 'Entwurf gespeichert, Versand gesperrt.'; await loadAll(); } catch (error) { $('emailState').textContent = error.message; } finally { setBusy(button, false); }
});
$('analyzeAds').addEventListener('click', async () => {
  const button = $('analyzeAds'); setBusy(button, true, 'wertet aus …');
  try { await api('/api/marketing/ads', { method: 'POST', body: JSON.stringify({ campaignId: $('adsCampaign').value, adSet: $('adsName').value, metrics: { spend: $('adsSpend').value, impressions: $('adsImpressions').value, clicks: $('adsClicks').value, leads: $('adsLeads').value, purchases: $('adsPurchases').value, revenue: $('adsRevenue').value, frequency: $('adsFrequency').value }, targets: { maxCpl: $('adsTargetCpl').value } }) }); $('adsState').textContent = 'Analyse gespeichert. Keine Änderung wurde ausgeführt.'; await loadAll(); } catch (error) { $('adsState').textContent = error.message; } finally { setBusy(button, false); }
});
$('syncMetaAds').addEventListener('click', async () => {
  const button = $('syncMetaAds'); setBusy(button, true, 'synchronisiert …');
  try { const result = await api('/api/marketing/ads/sync-meta', { method: 'POST', body: JSON.stringify({ datePreset: 'yesterday', level: 'adset', targets: { maxCpl: $('adsTargetCpl').value } }) }); $('adsState').textContent = `${result.saved?.length || 0} Meta-Datensätze geprüft.`; await loadAll(); } catch (error) { $('adsState').textContent = error.message; } finally { setBusy(button, false); }
});
$('generateReport').addEventListener('click', async () => {
  const button = $('generateReport'); setBusy(button, true, 'erstellt …');
  try { await api('/api/marketing/reports', { method: 'POST', body: JSON.stringify({ period: 'manual' }) }); $('reportState').textContent = 'Report erstellt.'; await loadAll(); } catch (error) { $('reportState').textContent = error.message; } finally { setBusy(button, false); }
});

$('contentStart').value = new Date().toISOString().slice(0, 10);
loadAll().catch(error => { $('pageIntro').textContent = `Marketing-Zentrale konnte nicht geladen werden: ${error.message}. Prüfe den API-Token im Cockpit.`; });
