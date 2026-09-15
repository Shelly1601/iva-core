import { calculateFinancialPlan, FINANCIAL_PLAN_FIELDS } from './advice-finance.js';
import { parseAdviceNumber } from './advice-calculators.js';
import { INSURANCE_CRITERIA_PROFILES, appendInsuranceCriteria } from './advice-criteria.js';
const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
const state = { catalog: null, record: null, projects: [], customers: [], documents: new Map(), dirty: false };
let filing = false;
const money = value => value === null || value === undefined ? 'offen' : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
const node = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const message = text => $('message').textContent = text;
const headers = () => ({ Authorization: 'Bearer ' + (localStorage.getItem('iva_token') || ''), 'Content-Type': 'application/json' });
const base = '/api/advice/workbench';
const url = path => base + path + (path.includes('?') ? '&' : '?') + new URLSearchParams({ projectId: $('project').value });
async function request(path, options = {}) { const projectId = $('project').value; const res = await fetch(url(path), { ...options, headers: headers() }); const result = await res.json().catch(() => ({})); if (!res.ok) throw new Error(result.error || `HTTP ${res.status}`); if (projectId !== $('project').value) throw new Error('Projekt wurde gewechselt. Bitte die aktuelle Auswahl laden.'); return result; }
async function external(path) { const res = await fetch(path, { headers: headers() }); if (!res.ok) throw new Error('Projekt-/Kundenübersicht konnte nicht geladen werden.'); return res.json(); }
const act = fn => async event => { try { await fn(event); } catch (error) { message(error.message); } };
function button(text, fn, primary = false) { const b = node('button', text, primary ? 'primary' : ''); b.type = 'button'; b.addEventListener('click', act(fn)); return b; }
function input(root, label, value, change, { type = 'text', options, hint } = {}) {
  const wrap = node('label', label), element = node(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  if (!options && type !== 'textarea') element.type = type;
  if (options) for (const option of options) { const o = node('option', option.label); o.value = option.value; element.append(o); }
  if (type === 'checkbox') element.checked = value === true; else element.value = value ?? '';
  element.addEventListener(options || type === 'checkbox' ? 'change' : 'input', () => { change(type === 'checkbox' ? element.checked : element.value); state.dirty = true; });
  wrap.append(element); if (hint) wrap.append(node('small', hint)); root.append(wrap); return element;
}
function selectRows(element, rows, placeholder, selected) { element.replaceChildren(); const empty = node('option', placeholder); empty.value = ''; element.append(empty); for (const row of rows) { const option = node('option', row.name || row.title || row.id); option.value = row.id; element.append(option); } element.value = selected || ''; }
async function loadProject() {
  state.record = null; state.documents.clear(); $('editor').replaceChildren(node('h2', 'Beratung auswählen')); $('result').replaceChildren(); $('actions').hidden = true;
  if (!$('project').value) return;
  const [catalog, customers] = await Promise.all([request('/catalog'), request('/context')]);
  state.catalog = catalog; state.customers = Array.isArray(customers) ? customers : customers.customers || [];
  selectRows($('customer'), state.customers, 'Kunde wählen', params.get('customerId'));
  await refreshCases(); renderProviders();
}
async function refreshCases() { const result = await request('/cases'); $('cases').replaceChildren(); for (const row of result.cases) $('cases').append(button(row.title, () => openCase(row.id))); if (!result.cases.length) $('cases').append(node('p', 'Noch keine Beratung in diesem Projekt.', 'muted')); }
async function openCase(id) { state.record = await request('/cases/' + encodeURIComponent(id)); state.dirty = false; state.documents.clear(); $('customer').value = state.record.customerId; renderEditor(); renderResult(); $('actions').hidden = false; message('Gespeicherte Fassung ' + state.record.revision + ' geladen.'); }
function renderProviders() {
  $('providers').replaceChildren();
  for (const provider of state.catalog.providers) {
    const details = node('details'), summary = node('summary', provider.label); details.append(summary, node('p', provider.status === 'portal-link-only' ? 'Originalportal hinterlegt; kein geprüfter Live-Tarifrücklauf.' : 'Projektzugang noch zuordnen.', 'muted'));
    const local = { portalUrl: provider.portalUrl || '', accountLabel: provider.accountLabel || '', brokerReference: provider.brokerReference || '' };
    input(details, 'Original-Portaladresse', local.portalUrl, value => local.portalUrl = value); input(details, 'Kontobezeichnung (kein Passwort)', local.accountLabel, value => local.accountLabel = value); input(details, 'Vermittlerzuordnung', local.brokerReference, value => local.brokerReference = value);
    details.append(button('Projektzuordnung speichern', async () => { await request('/providers/' + provider.id, { method: 'PUT', body: JSON.stringify(local) }); state.catalog = await request('/catalog'); renderProviders(); message('Portalzuordnung gespeichert. Ein Live-Vergleich wurde nicht aktiviert.'); }));
    if (provider.portalUrl) { const link = node('a', 'Originalportal öffnen', 'button'); link.href = provider.portalUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link); }
    const steps = node('ol'); provider.steps.forEach(step => steps.append(node('li', step))); details.append(steps); $('providers').append(details);
  }
}
function renderEditor() {
  const r = state.record, root = $('editor'); root.replaceChildren(node('h2', r.title));
  root.append(node('p', `${r.kind === 'finance' ? 'Finanzplanung' : 'Versicherungsvergleich'} · Fassung ${r.revision}`, 'muted'));
  input(root, 'Titel der Beratung', r.title, value => r.title = value);
  if (r.kind === 'finance') {
    root.append(node('p', 'Renditen, Inflation und Steuer sind veränderbare Annahmen. Die Rechnung macht keine Aussage über einen konkreten Tarif oder eine garantierte Entwicklung.', 'notice'));
    const grid = node('div', undefined, 'grid');
    for (const [key, label, unit] of FINANCIAL_PLAN_FIELDS) input(grid, `${label} (${unit})`, String(r.financeInput[key]).replace('.', ','), value => { r.financeInput[key] = value; renderResult(); }); root.append(grid);
  } else renderInsurance(root);
  input(root, 'Beratungsnotizen', r.notes, value => r.notes = value, { type: 'textarea' });
}
function evidenceEditor(root, initial, change) {
  const proof = { documentId: '', locator: '', excerpt: '', reviewed: false, ...(initial || {}) };
  const details = node('details'), title = node('summary', proof.documentId ? 'Nachweis bearbeiten' : 'Nachweis aus Originalunterlage zuordnen'); details.append(title);
  const update = () => change(proof.documentId && proof.excerpt ? { ...proof } : null);
  input(details, 'Originaldokument', proof.documentId, value => { proof.documentId = value; update(); }, { options: [{ value: '', label: 'Dokument wählen' }, ...state.record.documents.map(d => ({ value: d.id, label: d.filename }))] });
  input(details, 'Fundstelle, z. B. Seite 3 / Abschnitt 2', proof.locator, value => { proof.locator = value; update(); });
  input(details, 'Wortlaut exakt aus dem eingelesenen Dokument', proof.excerpt, value => { proof.excerpt = value; update(); }, { type: 'textarea' });
  input(details, 'Inhalt, Kontext und zugeordneten Wert geprüft', proof.reviewed, value => { proof.reviewed = value; update(); }, { type: 'checkbox' }); root.append(details);
}
function renderCriteriaLibrary(root) {
  const r = state.record, profiles = INSURANCE_CRITERIA_PROFILES.filter(profile => profile.category === r.category);
  const details = node('details'); details.append(node('summary', 'Kriterienbibliothek · relevante Prüffragen auswählen'));
  details.append(node('p', 'Nur benötigte Fragen auswählen. „Ja“ bedeutet später: Der belegte Leistungsumfang erfüllt den konkret besprochenen Bedarf. Die Vorlage verspricht keine Tarifleistung und ändert keine vorhandenen Nachweise.', 'muted'));
  const label = node('label', 'Leistungsprofil'), select = node('select'); select.setAttribute('aria-label', 'Leistungsprofil');
  for (const profile of profiles) { const option = node('option', profile.label); option.value = profile.id; select.append(option); } label.append(select); details.append(label);
  const choices = node('div'), selected = new Set();
  const renderChoices = () => {
    selected.clear(); choices.replaceChildren();
    const profile = profiles.find(item => item.id === select.value);
    for (const item of profile?.criteria || []) {
      const present = r.criteria.some(existing => existing.id === item.id || existing.label.trim().toLocaleLowerCase('de-DE') === item.label.toLocaleLowerCase('de-DE'));
      const choice = node('label'), check = node('input'); check.type = 'checkbox'; check.disabled = present;
      check.addEventListener('change', () => check.checked ? selected.add(item.id) : selected.delete(item.id));
      choice.append(check, document.createTextNode(item.label + (present ? ' · bereits vorhanden' : ''))); choices.append(choice);
    }
  };
  select.addEventListener('change', renderChoices); renderChoices(); details.append(choices);
  details.append(button('Ausgewählte Prüffragen ergänzen', () => {
    const before = r.criteria.length; r.criteria = appendInsuranceCriteria(r.criteria, { category: r.category, profileId: select.value, criterionIds: [...selected] });
    const added = r.criteria.length - before;
    if (added) { state.dirty = true; renderEditor(); renderResult(); }
    message(added ? `${added} Prüffragen ergänzt. Bestehende Kriterien und Nachweise bleiben erhalten. Bitte Gewichte und Ziele prüfen und speichern.` : 'Diese Prüffragen sind bereits vorhanden.');
  })); root.append(details);
}
function renderInsurance(root) {
  const r = state.record;
  root.append(node('p', '1. Originalunterlagen hochladen. 2. Altvertrag und Angebote mit Fundstellen erfassen. 3. Kriterien gewichten und auswerten. Unbekannte Leistungen bleiben offen.', 'notice'));
  const upload = node('div', undefined, 'row'), file = node('input'); file.type = 'file'; file.accept = 'application/pdf,text/plain';
  upload.append(file, button('Originalunterlage einlesen', async () => {
    if (!file.files[0]) throw new Error('Bitte PDF oder Textdatei auswählen.'); if (state.dirty) await save();
    const item = file.files[0]; if (item.size > 8e6) throw new Error('Die Datei darf höchstens 8 MB groß sein.');
    const data = new Uint8Array(await item.arrayBuffer()); let binary = ''; for (let i = 0; i < data.length; i += 16384) binary += String.fromCharCode(...data.subarray(i, i + 16384));
    state.record = await request(`/cases/${r.id}/documents`, { method: 'POST', body: JSON.stringify({ filename: item.name, contentType: item.type || (item.name.endsWith('.txt') ? 'text/plain' : 'application/pdf'), base64: btoa(binary), expectedRevision: state.record.revision }) }); state.dirty = false; renderEditor(); renderResult(); message('Dokument eingelesen. Fundstellen und Vorschläge können geprüft werden.');
  })); root.append(upload);
  for (const d of r.documents) root.append(button(d.filename + ' · Text & Formular', () => openDocument(d.id)));
  input(root, 'Kundenrisiko / gewünschter Umfang', r.riskProfile, value => r.riskProfile = value, { type: 'textarea' });
  renderCriteriaLibrary(root);
  const criteria = node('details'); criteria.open = false; criteria.append(node('summary', 'Bewertungskriterien und Gewichtung'));
  r.criteria.forEach(c => {
    const row = node('div', undefined, 'grid'); input(row, 'Kriterium', c.label, value => c.label = value); input(row, 'Gewicht (0 bis 100)', c.weight, value => c.weight = parseAdviceNumber(value));
    input(row, 'Bewertung', c.type, value => { c.type = value; c.target ||= 1; c.unit ||= 'EUR'; renderEditor(); }, { options: [{ value: 'boolean', label: 'Ja erfüllt das Ziel' }, { value: 'higher', label: 'Höherer Wert bis zum Ziel' }, { value: 'lower', label: 'Niedrigerer Wert bis zum Ziel' }] });
    input(row, 'Muss-Kriterium', c.mandatory, value => c.mandatory = value, { type: 'checkbox' });
    if (c.type !== 'boolean') { input(row, 'Zielwert', c.target, value => c.target = parseAdviceNumber(value)); input(row, 'Einheit', c.unit, value => c.unit = value); }
    row.append(button('Aus Bewertung nehmen · Nachweise behalten', () => { if (!r.criteria.some(other => other.id !== c.id && other.weight > 0)) throw new Error('Mindestens ein Kriterium muss ein positives Gewicht behalten.'); c.weight = 0; c.mandatory = false; state.dirty = true; renderEditor(); renderResult(); message('Kriterium hat jetzt Gewicht 0; Werte und Nachweise sind unverändert.'); })); criteria.append(row);
  });
  criteria.append(button('Kriterium ergänzen', () => { if (r.criteria.length >= 30) throw new Error('Maximal 30 Kriterien pro Vergleich.'); r.criteria.push({ id: crypto.randomUUID(), label: 'Eigenes Kriterium', type: 'boolean', weight: 10, mandatory: false }); state.dirty = true; renderEditor(); })); root.append(criteria);
  if (!r.oldContract) root.append(button('Altvertrag erfassen', () => { r.oldContract = newContract(); state.dirty = true; renderEditor(); })); else contractEditor(root, r.oldContract, true);
  r.offers.forEach(offer => contractEditor(root, offer, false));
  root.append(button('Dokumentangebot ergänzen', () => { r.offers.push(newContract()); state.dirty = true; renderEditor(); }));
  const preparation = node('details'); preparation.append(node('summary', 'Anbieterübergabe vorbereiten'));
  for (const provider of state.catalog.providers.filter(p => p.categories.includes(r.category))) preparation.append(button(provider.label + ': Übergabedaten herunterladen', async () => { if (state.dirty) await save(); const result = await request(`/cases/${r.id}/preparation/${provider.id}`); download(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), 'anbieter-vorbereitung.json'); message('Übergabedaten lokal heruntergeladen. Nichts eingereicht.'); })); root.append(preparation);
}
const newContract = () => ({ id: crypto.randomUUID(), provider: '', tariff: '', issuedAt: null, validUntil: null, origin: 'document', premium: null, facts: {}, riskConfirmed: false, notes: '' });
function contractEditor(root, c, old) {
  const details = node('details'); details.open = !c.provider; details.append(node('summary', `${old ? 'Altvertrag' : 'Angebot'}: ${c.provider || 'Versicherer ergänzen'} ${c.tariff || ''}`));
  const grid = node('div', undefined, 'grid'); input(grid, 'Versicherer', c.provider, value => c.provider = value); input(grid, 'Tarif und Tarifstand', c.tariff, value => c.tariff = value);
  if (!old) {
    for (const [key, label] of [['issuedAt', 'Angebot vom'], ['validUntil', 'Gültig bis']]) input(grid, label, c[key] ? new Date(Date.parse(c[key]) - new Date(c[key]).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '', value => c[key] = value ? new Date(value).toISOString() : null, { type: 'datetime-local' });
    input(grid, 'Datenart', c.origin, value => c.origin = value, { options: [{ value: 'document', label: 'Originalangebot manuell erfasst' }, { value: 'scenario', label: 'Unverbindliches Szenario' }] }); input(grid, 'Dieses Angebot gehört zu genau diesem Kundenrisiko', c.riskConfirmed, value => c.riskConfirmed = value, { type: 'checkbox' });
  } details.append(grid);
  const premium = c.premium || { amount: null, frequency: 'annual', annualFees: 0, includesTax: false, feesConfirmed: false, evidence: null };
  const setPremium = () => c.premium = premium.amount !== null ? premium : null;
  const prices = node('div', undefined, 'grid'); input(prices, 'Bruttobeitrag je Zahlperiode', premium.amount, value => { premium.amount = parseAdviceNumber(value); setPremium(); }); input(prices, 'Zahlweise', premium.frequency, value => { premium.frequency = value; setPremium(); }, { options: [{ value: 'annual', label: 'Jährlich' }, { value: 'monthly', label: 'Monatlich' }, { value: 'quarterly', label: 'Vierteljährlich' }, { value: 'half-yearly', label: 'Halbjährlich' }] }); input(prices, 'Weitere jährliche Kosten', premium.annualFees, value => { premium.annualFees = parseAdviceNumber(value); setPremium(); }); input(prices, 'Gesamtpreis einschließlich aller Steuern geprüft', premium.includesTax, value => { premium.includesTax = value; setPremium(); }, { type: 'checkbox' }); input(prices, 'Weitere Kosten (auch 0 €) anhand der Unterlage geprüft', premium.feesConfirmed, value => { premium.feesConfirmed = value; setPremium(); }, { type: 'checkbox' }); details.append(prices); evidenceEditor(details, premium.evidence, value => { premium.evidence = value; setPremium(); });
  for (const criterion of state.record.criteria) {
    const fact = c.facts[criterion.id] || { value: null, evidence: null }, fieldset = node('details'); fieldset.append(node('summary', criterion.label));
    input(fieldset, criterion.type === 'boolean' ? 'Leistung erfüllt das Ziel?' : `Wert (${criterion.unit})`, fact.value === null ? '' : String(fact.value), value => { fact.value = value === '' ? null : criterion.type === 'boolean' ? value === 'true' : parseAdviceNumber(value); c.facts[criterion.id] = fact; }, criterion.type === 'boolean' ? { options: [{ value: '', label: 'Unbekannt' }, { value: 'true', label: 'Ja' }, { value: 'false', label: 'Nein' }] } : {});
    evidenceEditor(fieldset, fact.evidence, value => { fact.evidence = value; c.facts[criterion.id] = fact; }); details.append(fieldset);
  }
  input(details, 'Hinweise / Einschränkungen', c.notes, value => c.notes = value, { type: 'textarea' });
  if (!old) details.append(button('Als Projektfavorit merken', async () => { await request('/favorites', { method: 'PUT', body: JSON.stringify({ category: state.record.category, provider: c.provider, tariff: c.tariff, favorite: true }) }); state.catalog = await request('/catalog'); message('Projektfavorit gespeichert. Die Bewertung bleibt unverändert.'); }));
  details.append(button(old ? 'Altvertrag aus dieser Gegenüberstellung entfernen' : 'Angebot aus Vergleich entfernen', () => { if (old) state.record.oldContract = null; else state.record.offers = state.record.offers.filter(row => row.id !== c.id); state.dirty = true; renderEditor(); })); root.append(details);
}
async function openDocument(id) {
  const doc = await request(`/cases/${state.record.id}/documents/${id}`); state.documents.set(id, doc);
  const card = node('section', undefined, 'card'); card.append(node('h2', doc.filename), node('p', 'Vorschläge sind aus dem Text erkannt und noch nicht bestätigt. Bruttostatus, Fundstelle und Vertragsbezug bitte prüfen.', 'muted'));
  for (const candidate of doc.suggestions) {
    card.append(node('p', `${candidate.label}: ${money(candidate.value)} · „${candidate.evidence.excerpt}“`));
    if (candidate.field === 'premium') card.append(button('Als Altvertragsbeitrag vormerken', () => {
      state.record.oldContract ||= newContract(); state.record.oldContract.premium = { amount: candidate.value, frequency: candidate.frequency, annualFees: 0, includesTax: false, feesConfirmed: false, evidence: candidate.evidence }; state.dirty = true; renderEditor(); message('Beitrag und Wortlaut übernommen. Versicherer, Tarif, Fundstelle, Steuern und Zusatzkosten bleiben zu prüfen.');
    }));
  }
  card.append(node('pre', doc.text)); const preview = node('details'); preview.append(node('summary', 'Interaktive Original-PDF vorbereiten'));
  if (doc.contentType === 'application/pdf') {
    preview.append(button('Originalfelder laden', async () => {
      const result = await request(`/cases/${state.record.id}/documents/${id}/form-fields`), values = {};
      const fields = node('div', undefined, 'grid');
      for (const f of result.fields.filter(f => !f.readOnly && f.type !== 'PDFSignature')) input(fields, f.name, f.type === 'PDFCheckBox' ? false : '', value => values[f.name] = value, f.type === 'PDFCheckBox' ? { type: 'checkbox' } : f.options ? { options: [{ value: '', label: 'Unverändert lassen' }, ...f.options.map(value => ({ value, label: value }))] } : {});
      const caseId = state.record.id;
      preview.append(fields, button('Befüllte PDF herunterladen', async () => { if (state.dirty) await save(); const res = await fetch(url(`/cases/${state.record.id}/documents/${id}/prepare.pdf`), { method: 'POST', headers: headers(), body: JSON.stringify({ expectedRevision: state.record.revision, values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')) }) }); if (!res.ok) throw new Error((await res.json()).error); download(await res.blob(), 'versicherer-formular-vorbereitet.pdf'); message('Originalformular vorbereitet. Nicht eingereicht.'); }), button('Befüllte PDF in Kundenakte ablegen', event => fileInCustomerRecord(event, { kind: 'form', docId: id, values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '')) }, caseId)));
    })); card.append(preview);
  }
  card.append(button('Ansicht schließen', () => card.remove())); $('result').prepend(card);
}
function renderResult() {
  if (!state.record) return;
  const result = state.record.kind === 'finance' ? calculateFinancialPlan(state.record.financeInput) : state.record.evaluation, root = $('result'); root.replaceChildren();
  const card = node('section', undefined, 'card'); card.append(node('h2', 'Auswertung'));
  if (state.record.kind === 'finance') {
    if (result.status !== 'scenario') { card.append(node('p', result.issues.map(i => i.message).join(' '), 'notice')); root.append(card); return; }
    const grid = node('div', undefined, 'grid'); for (const [label, value] of [['Kapital nach Ansparen', result.summary.accumulationCapital], ['Kapital zum Planende', result.summary.finalCapital], ['Heutige Kaufkraft', result.summary.finalRealCapital], ['Einzahlungen gesamt', result.summary.paidIn]]) { const metric = node('div', label, 'metric'); metric.append(node('strong', money(value))); grid.append(metric); } card.append(grid);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 600 190'); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Kapitalentwicklung: Türkis nominal, Blau heutige Kaufkraft.');
    const max = Math.max(1, ...result.points.flatMap(p => [p.balance, p.realBalance]));
    for (const [key, color] of [['balance', '#79d9c7'], ['realBalance', '#84aaf2']]) { const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', result.points.map(p => `${15 + p.month / Math.max(1, result.summary.months) * 570},${175 - p[key] / max * 160}`).join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', color); line.setAttribute('stroke-width', '3'); svg.append(line); } card.append(svg, node('p', 'Türkis: Kapital · Blau: heutige Kaufkraft. Vollständiger Verlauf und Annahmen im Kunden-PDF.', 'muted'));
    result.warnings.forEach(w => card.append(node('p', w, 'notice'))); const more = node('details'); more.append(node('summary', 'Rechenannahmen anzeigen')); result.assumptions.forEach(a => more.append(node('p', a))); card.append(more);
  } else {
    if (state.dirty) card.append(node('p', 'Änderungen speichern, um den Vergleich neu auszuwerten.', 'notice'));
    card.append(node('p', result?.status === 'document-comparison' ? 'Dokumentvergleich verfügbar. Kein Live-Tarifrücklauf.' : 'Noch nicht vollständig belegt.', 'notice'));
    for (const offer of result?.ranking || []) card.append(node('p', `${offer.rank}. ${offer.provider} · ${offer.tariff} — ${offer.score.toFixed(1)} Punkte · ${money(offer.annualGross)} pro Jahr${offer.favorite ? ' · Projektfavorit' : ''}`));
    for (const offer of (result?.offers || []).filter(o => !o.eligible)) { const details = node('details'); details.append(node('summary', `${offer.provider} · ${offer.tariff}: noch offen`)); offer.reasons.forEach(reason => details.append(node('p', reason))); card.append(details); }
    const matrix = node('details'); matrix.append(node('summary', 'Kriterienmatrix und Nachweise'));
    for (const offer of [result?.oldContract, ...(result?.offers || [])].filter(Boolean)) { matrix.append(node('h3', `${offer.provider} · ${offer.tariff}`)); const table = node('table'); for (const row of offer.rows) { const tr = node('tr'); tr.append(node('td', row.label), node('td', row.score === null ? 'Unbekannt / ungeprüft' : `${row.score.toFixed(1)} Punkte`), node('td', row.evidence?.locator || 'Kein Nachweis')); table.append(tr); } matrix.append(table); } card.append(matrix, node('p', result?.method, 'muted'));
  } root.append(card);
}
async function save() {
  if (!state.record) return; const r = state.record;
  const body = { expectedRevision: r.revision, title: r.title, notes: r.notes, ...(r.kind === 'finance' ? { financeInput: r.financeInput } : { criteria: r.criteria, oldContract: r.oldContract, offers: r.offers, riskProfile: r.riskProfile }) };
  state.record = await request('/cases/' + r.id, { method: 'PATCH', body: JSON.stringify(body) }); state.dirty = false; renderEditor(); renderResult(); await refreshCases(); message('Fassung ' + state.record.revision + ' gespeichert und ausgewertet.');
}
function download(blob, name) { const objectUrl = URL.createObjectURL(blob), a = node('a'); a.href = objectUrl; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 30000); }
async function fileInCustomerRecord(event, payload, caseId = state.record?.id) {
  if (filing) return; if (!caseId || state.record?.id !== caseId) throw new Error('Bitte zuerst die zugehörige Beratungsakte laden.');
  const projectId = $('project').value, trigger = event?.currentTarget; filing = true; if (trigger) trigger.disabled = true;
  try {
    if (state.dirty) await save();
    if (state.record?.id !== caseId || $('project').value !== projectId) throw new Error('Die Beratungsakte wurde gewechselt. Bitte die aktuelle Auswahl prüfen.');
    const receipt = await request(`/cases/${encodeURIComponent(caseId)}/file`, { method: 'POST', body: JSON.stringify({ ...payload, expectedRevision: state.record.revision }) });
    if (!receipt.fileId) throw new Error('Dateiablage nicht bestätigt. Bitte zuerst in der Kundenakte prüfen.');
    message(`In der Kundenakte abgelegt: ${receipt.file?.name || receipt.fileId} · Fassung ${receipt.revision}. Nicht eingereicht.`);
  } catch (error) { message(`${error.message} Es wird nicht automatisch erneut abgelegt; bei unklarer Verbindung zuerst die Kundenakte prüfen.`); }
  finally { filing = false; if (trigger) trigger.disabled = false; }
}
$('actions').append(button('Kunden-PDF in Kundenakte ablegen', event => fileInCustomerRecord(event, { kind: 'report' })));
$('kind').addEventListener('change', () => $('categoryLabel').hidden = $('kind').value !== 'insurance');
$('project').addEventListener('change', act(loadProject));
$('create').addEventListener('click', act(async () => { if (!$('project').value || !$('customer').value) throw new Error('Bitte Projekt und zugeordneten Kunden auswählen.'); const record = await request('/cases', { method: 'POST', body: JSON.stringify({ kind: $('kind').value, category: $('category').value, title: $('newTitle').value || ($('kind').value === 'finance' ? 'Finanzplanung' : 'Versicherungsvergleich'), customerId: $('customer').value }) }); await refreshCases(); await openCase(record.id); }));
$('save').addEventListener('click', act(save)); $('reload').addEventListener('click', act(() => openCase(state.record.id)));
$('pdf').addEventListener('click', act(async () => { if (state.dirty) await save(); const res = await fetch(url(`/cases/${state.record.id}/report.pdf`), { headers: headers() }); if (!res.ok) throw new Error((await res.json()).error); download(await res.blob(), 'IVA-Beratung.pdf'); }));
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
if (['finance', 'insurance'].includes(params.get('kind'))) { $('kind').value = params.get('kind'); $('categoryLabel').hidden = $('kind').value !== 'insurance'; }
try { const result = await external(base + '/context'); state.projects = result.projects || []; selectRows($('project'), state.projects, 'Projekt wählen', params.get('projectId')); if ($('project').value) await loadProject(); } catch (error) { message(error.message); }
