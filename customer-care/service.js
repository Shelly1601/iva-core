import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createCustomerCareStore, careError, careId } from './store.js';
import { DEFAULT_CARE_SETTINGS, DEFAULT_CHECKUP_QUESTIONS, normalizeSettings, normalizeCustomerCare, normalizeContract, normalizeCampaign, matchingCustomer, dueAnnual, annualDate, contractCareDates, addDays, berlinDate, usableQuote, validateAnswers, email, cleanCareText } from './rules.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const scopeOf = scope => ({ projectId: careId(scope?.projectId, 'Projekt'), workspaceId: scope?.workspaceId ? careId(scope.workspaceId, 'Arbeitsbereich') : '', customerId: scope?.customerId ? careId(scope.customerId, 'Kunde') : '' });
const campaignRevision = campaign => hash(JSON.stringify([campaign.subject, campaign.body, campaign.schedule, campaign.topics, campaign.recipientIds, campaign.workspaceId, campaign.enabled]));
const customerKey = customer => `${customer.workspaceId || ''}:${customer.id}`;
const cleanOutbox = row => ({ id: row.id, outboxId: row.id, projectId: row.projectId, customerId: row.customerId, workspaceId: row.workspaceId, kind: row.kind, status: row.status, queueId: row.queueId || null, createdAt: row.createdAt, sentAt: row.receipt?.sentAt || null, reason: row.reason || null, tokenId: row.tokenId || null });
const timestamp = now => new Date(now()).toISOString();

export function createCustomerCareService({ dataDir, getCustomers, getProject = async id => ({ id, name: 'Kundenbetreuung' }), deliver, getOptimizationQuote, publicOrigin = '', now = Date.now } = {}) {
  if (typeof getCustomers !== 'function') throw careError('Die autoritative Kundenquelle fehlt.');
  const store = createCustomerCareStore({ dataDir });
  async function projectFor(scope) { const project = await getProject(scope.projectId); if (!project || project.id && String(project.id) !== scope.projectId) throw careError('Projekt nicht gefunden.', 404); return project; }
  async function customersFor(scope, projectState) {
    const result = await getCustomers(scope); const rows = Array.isArray(result) ? result : result?.customers;
    if (!Array.isArray(rows) || rows.length > 10000) throw careError('Die Kundenquelle ist nicht vollständig verfügbar.', 503);
    const seen = new Set();
    return rows.map(row => {
      if (row.projectId && row.projectId !== scope.projectId) throw careError('Die Kundenquelle gehört zu einem anderen Projekt.', 403);
      const id = careId(row.id, 'Kunde'), workspaceId = row.workspaceId ? careId(row.workspaceId, 'Arbeitsbereich') : '';
      const key = customerKey({ id, workspaceId }); if (seen.has(key)) throw careError('Die Kundenquelle ist mehrdeutig.', 409); seen.add(key);
      const care = normalizeCustomerCare({}, { ...row.care, ...projectState.customers[key] });
      const customer = { id, workspaceId, name: cleanCareText(row.name, 200), email: '', care, topics: Array.isArray(projectState.customers[key]?.topics) ? projectState.customers[key].topics : care.topics.length ? care.topics : Array.isArray(row.topics) ? row.topics.map(String) : [] };
      try { customer.email = email(row.email); } catch {}
      customer.emailAuthorized = care.emailAuthorized ?? row.emailAuthorized === true;
      return customer;
    }).filter(row => (!scope.workspaceId || row.workspaceId === scope.workspaceId || row.id === scope.workspaceId) && (!scope.customerId || row.id === scope.customerId));
  }
  async function context(input) { const scope = scopeOf(input); const project = await projectFor(scope), state = await store.read(scope.projectId); const customers = await customersFor(scope, state); return { scope, project, state, customers, settings: state.settings || structuredClone(DEFAULT_CARE_SETTINGS) }; }
  function oneCustomer(ctx) { if (ctx.customers.length !== 1 || !ctx.scope.customerId && !ctx.scope.workspaceId) throw careError('Bitte genau einen Kunden auswählen.', 409); return ctx.customers[0]; }
  async function deliveryContext(outboxId, scope) {
    const found = await store.findDelivery(careId(outboxId)); if (!found || scope?.projectId && found.projectId !== scope.projectId) throw careError('Versandvorgang nicht gefunden.', 404);
    const ctx = await context({ projectId: found.projectId }); const row = ctx.state.outbox.find(item => item.id === outboxId);
    const customer = ctx.customers.find(item => item.id === row.customerId && (item.workspaceId || '') === row.workspaceId);
    return { ...ctx, row, customer };
  }
  function deliveryValidity(ctx) {
    const { row, customer, state, settings } = ctx, today = berlinDate(now());
    if (!settings.enabled) return 'Das Projekt ist nicht mehr aktiv.';
    if (row.kind === 'monthly-summary') return settings.monthlySummary?.enabled && settings.advisorEmail === row.recipient && settings.senderEmail === row.sender && row.month === today.slice(0, 7) ? '' : 'Monatsübersicht, Empfänger oder Zeitraum wurde geändert.';
    if (!customer) return 'Der Kunde ist nicht mehr verfügbar.';
    if (row.kind === 'advisor-interest') return settings.advisorEmail === row.recipient && settings.senderEmail === row.sender ? '' : 'Die Berateradresse wurde geändert.';
    if (!customer.care.enabled || !customer.emailAuthorized || !customer.email || customer.email !== row.recipient || settings.senderEmail !== row.sender) return 'Kundenfreigabe, Empfänger oder Absender wurde geändert.';
    if (row.kind === 'annual-checkup' && (!settings.annualCheckup.enabled || customer.care.annualCheckupEnabled === false)) return 'Der Jahrescheck wurde deaktiviert.';
    if (row.kind === 'optimization') {
      const contract = state.contracts.find(item => item.id === row.contractId && item.customerId === customer.id && item.workspaceId === customer.workspaceId);
      if (!settings.optimization.enabled || customer.care.optimizationEnabled === false || !contract || contract.renewalDate !== row.renewalDate || today > contractCareDates(contract, settings.optimization.leadDays).deadline || !usableQuote(row.quote && { ...row.quote, contractId: contract.id, customerId: customer.id }, contract, customer, now())) return 'Vertrag oder Anbieterangebot ist nicht mehr aktuell.';
    }
    if (row.campaignId) {
      const campaign = state.campaigns.find(item => item.id === row.campaignId);
      if (!campaign?.enabled || !matchingCustomer(customer, campaign) || campaignRevision(campaign) !== row.campaignRevision || campaign.schedule.from && today < campaign.schedule.from || campaign.schedule.to && today > campaign.schedule.to) return 'Kampagne, Auswahl oder Zeitfenster wurde geändert.';
      if (campaign.schedule.type === 'contract') { const contract = state.contracts.find(item => item.id === row.contractId && item.customerId === customer.id && item.workspaceId === customer.workspaceId); if (!contract || contract.renewalDate !== row.renewalDate || today > contractCareDates(contract, campaign.schedule.leadDays).deadline) return 'Die Vertragsfrist dieser Kampagne ist nicht mehr aktuell.'; }
    }
    if (row.tokenId) { const token = state.tokens.find(item => item.id === row.tokenId); if (!token || token.revokedAt || Date.parse(token.expiresAt) <= now()) return 'Die persönliche Einladung ist nicht mehr gültig.'; }
    return '';
  }
  function envelope(row) { return { id: row.id, outboxId: row.id, projectId: row.projectId, from: row.sender, to: [row.recipient], subject: row.subject, body: row.body, idempotencyKey: row.id }; }
  function addOutbox(state, data) {
    const existing = state.outbox.find(item => item.key === data.key); if (existing) return existing;
    if (state.outbox.length >= 20000) throw careError('Das Versandjournal ist voll; vorhandene Nachweise bleiben erhalten.', 507);
    const row = { ...data, id: randomUUID(), projectId: state.id, status: 'pending', createdAt: timestamp(now) }; state.outbox.push(row); return row;
  }
  function invitation(state, customer, settings, kind, key, extra = {}) {
    if (state.outbox.some(item => item.key === key)) return;
    let origin; try { origin = new URL(publicOrigin); } catch { throw careError('Die öffentliche Checkup-Adresse ist nicht eingerichtet.', 503); }
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw careError('Die öffentliche Checkup-Adresse ist ungültig.', 503);
    const raw = randomBytes(32).toString('base64url'), token = { id: randomUUID(), hash: hash(raw), customerId: customer.id, workspaceId: customer.workspaceId, kind, expiresAt: new Date(now() + 30 * 86400000).toISOString(), createdAt: timestamp(now), questions: structuredClone(DEFAULT_CHECKUP_QUESTIONS), contractId: extra.contractId || null, renewalDate: extra.renewalDate || null, offer: extra.quote || null, intro: kind === 'campaign' ? 'Ihre persönliche Nachricht und Kontakteinstellungen.' : kind === 'optimization' ? 'Prüfen Sie Ihr aktuelles Anbieterangebot und teilen Sie uns Ihren Beratungswunsch mit.' : 'Mit wenigen Antworten bereiten wir Ihr persönliches Jahresgespräch vor.' };
    state.tokens.push(token);
    const url = settings.landingUrl ? `${settings.landingUrl.split('#')[0]}#${raw}` : `${origin.origin}/checkup/${raw}`;
    const offer = extra.quote ? `\n${extra.quote.sourceLabel}: ${extra.quote.provider}, ${extra.quote.monthlyCost.toFixed(2)} EUR monatlich; gültig bis ${berlinDate(extra.quote.expiresAt)}.\nWeitere Vertragsbedingungen werden im Beratungsgespräch geprüft.` : '';
    addOutbox(state, { key, kind, customerId: customer.id, workspaceId: customer.workspaceId, recipient: customer.email, sender: settings.senderEmail, tokenId: token.id,
      subject: extra.campaignSubject || (kind === 'optimization' ? 'Ihr Vertrag: aktuelle Möglichkeit zur Optimierung' : 'Ihr persönlicher Jahrescheck'),
      body: `${extra.campaignBody || `Guten Tag ${customer.name},\n\n${token.intro}${offer}`}\n\nIhr persönlicher Checkup und Abmeldung: ${url}\n\n${settings.signature || 'Ihr Beratungsteam'}${settings.imprint ? `\n\n${settings.imprint}` : ''}`, ...extra });
  }
  async function cancel(row, reason) { return store.transaction(row.projectId, state => { const current = state.outbox.find(item => item.id === row.id); if (current && !['sent', 'sending', 'uncertain'].includes(current.status)) { current.status = 'cancelled'; current.reason = reason; } return current && cleanOutbox(current); }); }
  const api = {
    async getDashboard(input) {
      const ctx = await context(input), { scope, state, customers, settings } = ctx, selected = scope.customerId || scope.workspaceId ? oneCustomer(ctx) : null;
      const selectedRows = rows => rows.filter(row => (!selected || row.customerId === selected.id && row.workspaceId === selected.workspaceId) && (!scope.workspaceId || !row.workspaceId || row.workspaceId === scope.workspaceId || row.customerId === scope.workspaceId));
      const readiness = [{ id: 'customer-source', ready: true, label: `${customers.length} Kunden verfügbar` }, { id: 'sender', ready: Boolean(settings.senderEmail), label: settings.senderEmail ? 'Absender eingerichtet' : 'Absender fehlt' }, { id: 'delivery', ready: typeof deliver === 'function', label: typeof deliver === 'function' ? 'Versandadapter eingerichtet' : 'Versand nicht angebunden' }, { id: 'public-checkup', ready: Boolean(publicOrigin), label: publicOrigin ? 'Checkup eingerichtet' : 'Öffentliche Checkup-Adresse fehlt' }, { id: 'quotes', ready: typeof getOptimizationQuote === 'function', label: typeof getOptimizationQuote === 'function' ? 'Angebotsprüfung verfügbar' : 'Aktuelle Anbieterangebote fehlen' }];
      const today = berlinDate(now()), selectedMonth = input.month || today.slice(0, 7);
      if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(selectedMonth)) throw careError('Der ausgewählte Monat ist ungültig.');
      const year = Number(selectedMonth.slice(0, 4)), month = Number(selectedMonth.slice(5, 7));
      const contracts = selectedRows(state.contracts), monthly = [];
      for (let offset = 0; offset < 12; offset++) {
        const date = new Date(Date.UTC(year, month - 1 + offset, 1)), id = date.toISOString().slice(0, 7), items = [];
        for (const customer of customers) {
          const care = customer.care, checkMonth = care.preferredMonth || settings.annualCheckup.month;
          if (settings.annualCheckup.enabled && care.enabled && care.annualCheckupEnabled !== false && checkMonth === date.getUTCMonth() + 1) items.push({ id: `annual:${customerKey(customer)}:${date.getUTCFullYear()}`, kind: 'annual-checkup', customerId: customer.id, customerName: customer.name, date: annualDate(date.getUTCFullYear(), checkMonth, settings.annualCheckup.day), status: customer.emailAuthorized ? 'planned' : 'authorization-missing', title: 'Jahrescheck einladen' });
        }
        for (const contract of contracts) { const due = contractCareDates(contract, settings.optimization.leadDays).due; if (due.startsWith(id)) items.push({ id: `contract:${contract.id}`, kind: 'optimization', contractId: contract.id, renewalDate: contract.renewalDate, customerId: contract.customerId, customerName: customers.find(customer => customer.id === contract.customerId && customer.workspaceId === contract.workspaceId)?.name || '', date: due, status: 'quote-required', title: `${contract.product || contract.topic}: Anbieterangebot prüfen` }); }
        for (const item of items) { const key = item.kind === 'annual-checkup' ? item.id : `optimization:${item.contractId}:${item.renewalDate}`; const delivery = state.outbox.find(row => row.key === key); if (delivery) { item.status = delivery.status; item.reason = delivery.reason || null; item.sentAt = delivery.receipt?.sentAt || null; item.outboxId = delivery.id; } }
        monthly.push({ month: id, label: new Intl.DateTimeFormat('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date), count: items.length, items });
      }
      return { settings, customer: selected ? { id: selected.id, name: selected.name, care: { ...selected.care, topics: selected.topics, emailAuthorized: selected.emailAuthorized } } : null, readiness, contracts, monthly,
        responses: selectedRows(state.tokens.filter(item => item.submittedAt)).map(item => ({ id: item.id, customerId: item.customerId, workspaceId: item.workspaceId, customerName: customers.find(customer => customer.id === item.customerId && customer.workspaceId === item.workspaceId)?.name || '', submittedAt: item.submittedAt, questions: item.questions, answers: item.answers, interest: item.interest === true, bookingRequested: item.bookingRequested === true })),
        notifications: selectedRows(state.notifications).map(item => ({ ...item })), recent: selectedRows(state.outbox).slice(-100).reverse().map(cleanOutbox), campaigns: state.campaigns.filter(item => !scope.workspaceId || !item.workspaceId || item.workspaceId === scope.workspaceId) };
    },
    async updateSettings(input, patch) { const ctx = await context(input); return store.transaction(ctx.scope.projectId, state => { const previous = state.settings || ctx.settings, settings = normalizeSettings(patch, previous); state.settings = { ...settings, activatedAt: settings.enabled && !previous.enabled ? timestamp(now) : previous.activatedAt || timestamp(now) }; return state.settings; }); },
    async updateCustomerCare(input, patch) { const ctx = await context(input), customer = oneCustomer(ctx); return store.transaction(ctx.scope.projectId, state => { const care = normalizeCustomerCare(patch, state.customers[customerKey(customer)] || customer.care); state.customers[customerKey(customer)] = care; return { id: customer.id, name: customer.name, care }; }); },
    async addContract(input, data) { const ctx = await context(input), customer = oneCustomer(ctx), contract = normalizeContract(data, customer, now()), key = data.idempotencyKey ? careId(data.idempotencyKey, 'Vorgangskennung') : null, digest = hash(JSON.stringify({ ...contract, id: data.id || null, createdAt: null })); return store.transaction(ctx.scope.projectId, state => { if (key) { const previous = state.contracts.find(item => item.idempotencyKey === key); if (previous) { if (previous.commandDigest !== digest) throw careError('Die Vorgangskennung gehört zu anderen Vertragsdaten.',409); return previous; } } if (state.contracts.some(item => item.id === contract.id)) throw careError('Diese Vertragskennung ist bereits vergeben.', 409); if (!contract.product || !contract.provider) throw careError('Produkt und Anbieter fehlen.'); state.contracts.push({ ...contract, idempotencyKey: key, commandDigest: digest }); return contract; }); },
    async createCampaign(input, data) { const ctx = await context(input), campaign = normalizeCampaign({ ...data, workspaceId: ctx.scope.workspaceId || data.workspaceId }, now()), key = data.idempotencyKey ? careId(data.idempotencyKey, 'Vorgangskennung') : null, digest = hash(JSON.stringify({ ...campaign, id: null, createdAt: null, updatedAt: null })); return store.transaction(ctx.scope.projectId, state => { if (key) { const previous = state.campaigns.find(item => item.idempotencyKey === key); if (previous) { if (previous.commandDigest !== digest) throw careError('Die Vorgangskennung gehört zu anderen Kampagnendaten.',409); return previous; } } const saved = { ...campaign, idempotencyKey: key, commandDigest: digest }; state.campaigns.push(saved); return saved; }); },
    async updateCampaign(input, id, patch) { const ctx = await context(input); return store.transaction(ctx.scope.projectId, state => { const index = state.campaigns.findIndex(item => item.id === id && (!ctx.scope.workspaceId || item.workspaceId === ctx.scope.workspaceId)); if (index < 0) throw careError('Kampagne nicht gefunden.', 404); state.campaigns[index] = { ...normalizeCampaign(patch, now(), state.campaigns[index]), idempotencyKey: state.campaigns[index].idempotencyKey, commandDigest: state.campaigns[index].commandDigest, ...(state.campaigns[index].audienceCapturedAt ? { audienceCapturedAt: state.campaigns[index].audienceCapturedAt, audienceSnapshot: state.campaigns[index].audienceSnapshot } : {}) }; return state.campaigns[index]; }); },
    async runDue(input) {
      const ctx = await context(input), { state, settings, customers } = ctx;
      if (!settings.enabled) return { status: 'disabled', planned: 0, delivered: 0 };
      if (!settings.senderEmail || typeof deliver !== 'function') return { status: 'not-ready', planned: 0, delivered: 0, reason: 'Absender oder Versandadapter fehlt.' };
      const authorized = customers.filter(customer => customer.care.enabled && customer.emailAuthorized && customer.email), planned = [], quoteGaps = [], quoteChecks = [];
      const today = berlinDate(now());
      state.campaigns = await store.transaction(ctx.scope.projectId, current => {
        for (const campaign of current.campaigns) {
          const schedule = campaign.schedule;
          if (campaign.enabled && schedule.type === 'once' && !campaign.audienceCapturedAt && Date.parse(schedule.at) <= now()
            && (!schedule.from || today >= schedule.from) && (!schedule.to || today <= schedule.to)) {
            campaign.audienceSnapshot = authorized.filter(customer => matchingCustomer(customer, campaign)).map(customerKey);
            campaign.audienceCapturedAt = timestamp(now);
          }
        }
        return current.campaigns;
      });
      for (const customer of authorized) {
        if (settings.annualCheckup.enabled && customer.care.annualCheckupEnabled !== false) {
          const due = dueAnnual(now(), customer.care.preferredMonth || settings.annualCheckup.month, settings.annualCheckup.day, settings.activatedAt);
          if (due) planned.push({ customer, kind: 'annual-checkup', key: `annual:${customerKey(customer)}:${due.key}` });
        }
        const contracts = state.contracts.filter(contract => contract.customerId === customer.id && contract.workspaceId === customer.workspaceId);
        for (const contract of contracts) {
          const { due, deadline } = contractCareDates(contract, settings.optimization.leadDays), key = `optimization:${contract.id}:${contract.renewalDate}`;
          if (settings.optimization.enabled && customer.care.optimizationEnabled !== false && due <= today && today <= deadline && !state.outbox.some(row => row.key === key)) {
            const fingerprint = hash(JSON.stringify(contract)), previousCheck = state.quoteChecks?.[contract.id], providerReady = typeof getOptimizationQuote === 'function';
            const cachedGap = previousCheck?.fingerprint === fingerprint && previousCheck.providerReady === providerReady && Date.parse(previousCheck.retryAt) > now();
            let quote; if (!cachedGap) { try { quote = usableQuote(await getOptimizationQuote?.({ projectId: ctx.scope.projectId, customer, contract }), contract, customer, now()); } catch {} }
            if (quote) planned.push({ customer, kind: 'optimization', key, extra: { contractId: contract.id, renewalDate: contract.renewalDate, quote } });
            else { const retryAt = cachedGap ? previousCheck.retryAt : new Date(now() + 15 * 60000).toISOString(); quoteGaps.push({ contractId: contract.id, customerId: customer.id, workspaceId: customer.workspaceId, retryAt }); quoteChecks.push({ id: contract.id, fingerprint, providerReady, retryAt }); }
          }
        }
        for (const campaign of state.campaigns.filter(item => item.enabled && matchingCustomer(customer, item))) {
          const schedule = campaign.schedule; if (schedule.from && today < schedule.from || schedule.to && today > schedule.to) continue;
          const events = schedule.type === 'once' ? Date.parse(schedule.at) <= now() ? [{ key: 'once' }] : []
            : schedule.type === 'annual' ? [dueAnnual(now(), schedule.month, schedule.day, campaign.createdAt)].filter(Boolean)
              : contracts.filter(contract => campaign.topics.length === 0 || campaign.topics.includes(contract.topic)).filter(contract => { const dates = contractCareDates(contract, schedule.leadDays); return dates.due <= today && today <= dates.deadline; }).map(contract => ({ key: `${contract.id}:${contract.renewalDate}`, contractId: contract.id, renewalDate: contract.renewalDate }));
          for (const event of events) planned.push({ customer, campaign, event, key: `campaign:${campaign.id}:${customerKey(customer)}:${event.key}` });
        }
      }
      const summaryMonth = today.slice(0, 7), summary = settings.monthlySummary?.enabled && settings.advisorEmail && Number(today.slice(8)) >= settings.monthlySummary.day ? (await api.getDashboard({ projectId: ctx.scope.projectId, month: summaryMonth })).monthly[0] : null;
      const newOutbox = await store.transaction(ctx.scope.projectId, current => {
        const previousCount = current.outbox.length; current.quoteChecks ||= {}; for (const check of quoteChecks) current.quoteChecks[check.id] = check;
        if (summary) addOutbox(current, { key: `monthly:${summaryMonth}`, kind: 'monthly-summary', customerId: null, workspaceId: '', month: summaryMonth, sender: settings.senderEmail, recipient: settings.advisorEmail, subject: `Kundenbetreuung: Monatsübersicht ${summaryMonth}`, body: summary.items.length ? summary.items.map(item => `${item.date}: ${item.customerName || item.customerId} – ${item.title}`).join('\n') : 'Für diesen Monat sind derzeit keine fälligen Betreuungsanlässe vorhanden.' });
        for (const plan of planned) {
          if (plan.campaign) invitation(current, plan.customer, settings, 'campaign', plan.key, { campaignId: plan.campaign.id, campaignRevision: campaignRevision(plan.campaign), contractId: plan.event?.contractId || null, renewalDate: plan.event?.renewalDate || null, campaignSubject: plan.campaign.subject, campaignBody: plan.campaign.body });
          else invitation(current, plan.customer, settings, plan.kind, plan.key, plan.extra);
        }
        for (const gap of quoteGaps) if (!current.notifications.some(item => item.kind === 'quote-required' && item.contractId === gap.contractId && item.status === 'open')) current.notifications.push({ id: randomUUID(), ...gap, kind: 'quote-required', priority: 'normal', status: 'open', title: 'Aktuelles Anbieterangebot fehlt', createdAt: timestamp(now) });
        return current.outbox.length - previousCount;
      });
      const candidates = (await store.read(ctx.scope.projectId)).outbox.filter(row => row.status === 'pending'); let dispatched = 0, sent = 0, queued = 0;
      for (const row of candidates) {
        const fresh = await deliveryContext(row.id), reason = deliveryValidity(fresh); if (reason) { await cancel(row, reason); continue; }
        const claimed = await store.transaction(ctx.scope.projectId, current => { const item = current.outbox.find(value => value.id === row.id); if (item.status !== 'pending') return false; item.status = 'dispatching'; item.claimedAt = timestamp(now); return true; });
        if (!claimed) continue;
        try {
          const result = await deliver(envelope(fresh.row));
          if (result?.status === 'sent') { await api.completeDelivery(row.id, result); sent++; }
          else if (result?.status === 'queued' && cleanCareText(result.queueId || result.commandId, 200)) { queued++; await store.transaction(ctx.scope.projectId, current => { const item = current.outbox.find(value => value.id === row.id); item.queueId = cleanCareText(result.queueId || result.commandId, 200); if (item.status === 'dispatching') item.status = 'queued'; }); }
          else throw careError('Der Versandausgang ist noch nicht belegt.', 409);
          dispatched++;
        } catch { await store.transaction(ctx.scope.projectId, current => { const item = current.outbox.find(value => value.id === row.id); if (item.status !== 'sent') { item.status = 'uncertain'; item.reason = 'Versandausgang offen. Vor erneutem Versand Gesendet anhand der Vorgangskennung prüfen.'; } }); }
      }
      return { status: 'processed', planned: newOutbox, dispatched, queued, sent, delivered: sent, quoteGaps: quoteGaps.length };
    },
    async listPendingDeliveries(input = {}) { const ids = input.projectId ? [careId(input.projectId)] : await store.listProjectIds(); const result = []; for (const id of ids) result.push(...(await store.read(id)).outbox.filter(row => ['dispatching', 'queued', 'sending', 'uncertain'].includes(row.status)).map(cleanOutbox)); return result; },
    async getDeliveryEnvelope(outboxId, input = {}) {
      let ctx = await deliveryContext(outboxId, input), reason = deliveryValidity(ctx);
      if (!reason && ctx.row.kind === 'optimization') {
        const contract = ctx.state.contracts.find(item => item.id === ctx.row.contractId), savedQuote = ctx.row.quote;
        let freshQuote;
        try { freshQuote = usableQuote(await getOptimizationQuote?.({ projectId: ctx.scope.projectId, customer: ctx.customer, contract }), contract, ctx.customer, now()); } catch {}
        if (!freshQuote || freshQuote.id !== savedQuote.id || freshQuote.sourceSha256 !== savedQuote.sourceSha256 || freshQuote.expiresAt !== savedQuote.expiresAt || freshQuote.monthlyCost !== savedQuote.monthlyCost || freshQuote.provider !== savedQuote.provider || freshQuote.conditions !== savedQuote.conditions) reason = 'Das aktuelle Originalangebot oder die Anbieterbestätigung ist nicht mehr unverändert verfügbar.';
        if (!reason) { ctx = await deliveryContext(outboxId, input); reason = deliveryValidity(ctx); }
      }
      if (reason) { await cancel(ctx.row, reason); throw careError(reason, 409, 'CUSTOMER_CARE_DELIVERY_CANCELLED'); }
      if (!['queued', 'dispatching', 'sending', 'uncertain'].includes(ctx.row.status)) throw careError('Der Versand ist abgeschlossen oder nicht zur Zustellung eingeplant.', 409, 'CUSTOMER_CARE_DELIVERY_RECHECK');
      return envelope(ctx.row);
    },
    async completeDelivery(outboxId, receipt, input = {}) {
      const ctx = await deliveryContext(outboxId, input), row = ctx.row;
      if (['uncertain', 'cancelled', 'canceled'].includes(receipt?.status)) {
        if (receipt.queueId && row.queueId && receipt.queueId !== row.queueId) throw careError('Der Geräteauftrag stimmt nicht überein.',409);
        return store.transaction(ctx.scope.projectId, current => {
          const item = current.outbox.find(value => value.id === outboxId);
          if (item.status === 'sent') return cleanOutbox(item);
          if (!['dispatching','queued','sending','uncertain','cancelled'].includes(item.status)) throw careError('Für diesen Vorgang wurde kein Versand begonnen.',409);
          item.status = receipt.status === 'uncertain' ? 'uncertain' : 'cancelled';
          item.reason = item.status === 'uncertain' ? 'Versandausgang offen. Ausschließlich Gesendet rücklesen, nicht erneut senden.' : 'Geräteauftrag hat den Versand vor Ausführung verworfen.';
          return cleanOutbox(item);
        });
      }
      if (!receipt || receipt.status !== 'sent' || receipt.verified !== true || !cleanCareText(receipt.messageId, 300) || email(receipt.recipient || receipt.to?.[0]) !== row.recipient
        || email(receipt.from) !== row.sender || !Number.isFinite(Date.parse(receipt.sentAt)) || Date.parse(receipt.sentAt) < Date.parse(row.createdAt) || Date.parse(receipt.sentAt) > now() + 60000
        || receipt.queueId && row.queueId && receipt.queueId !== row.queueId) throw careError('Der tatsächliche Versand wurde für diesen Vorgang nicht eindeutig rückgelesen.', 409);
      return store.transaction(ctx.scope.projectId, current => {
        const item = current.outbox.find(value => value.id === outboxId);
        if (item.status === 'sent') { if (item.receipt.messageId !== receipt.messageId) throw careError('Abweichender Versandbeleg.', 409); return cleanOutbox(item); }
        if (!['dispatching', 'queued', 'sending', 'uncertain'].includes(item.status)) throw careError('Für diesen Vorgang wurde kein Versand begonnen.', 409);
        if (current.outbox.some(other => other.id !== item.id && other.receipt?.messageId === receipt.messageId && other.sender === row.sender)) throw careError('Dieser Versandbeleg gehört bereits zu einem anderen Vorgang.', 409);
        item.status = 'sent'; item.receipt = { messageId: cleanCareText(receipt.messageId, 300), sentAt: receipt.sentAt, verified: true }; item.reason = null;
        return cleanOutbox(item);
      });
    },
    async getPublicCheckup(rawToken) {
      const resolved = await publicContext(rawToken), { token, project, settings } = resolved;
      return { status: token.unsubscribedAt || resolved.customer.emailAuthorized === false ? 'unsubscribed' : token.submittedAt ? 'submitted' : 'active', project: { name: cleanCareText(project.name, 160), accentColor: /^#[0-9a-f]{6}$/i.test(project.accentColor || '') ? project.accentColor : '#19ad83' }, intro: token.intro, kind: token.kind, questions: token.submittedAt || token.unsubscribedAt || resolved.customer.emailAuthorized === false ? [] : token.questions, offer: token.offer && token.contractId && resolved.state.contracts.some(contract => contract.id === token.contractId && contract.customerId === resolved.customer.id && contract.workspaceId === resolved.customer.workspaceId && contract.renewalDate === token.renewalDate) && usableQuote({ ...token.offer, contractId: token.contractId, customerId: resolved.customer.id }, { id: token.contractId }, resolved.customer, now()) ? token.offer : null, interest: token.interest === true, bookingRequested: token.bookingRequested === true, bookingUrl: token.submittedAt && token.bookingRequested && settings.bookingUrl ? settings.bookingUrl : undefined };
    },
    async submitPublicCheckup(rawToken, input = {}) {
      const resolved = await publicContext(rawToken), { projectId, token, customer, settings } = resolved;
      const idempotencyKey = cleanCareText(input.idempotencyKey, 160); if (!/^[a-zA-Z0-9_.:-]{8,160}$/.test(idempotencyKey)) throw careError('Die eindeutige Antwortkennung fehlt.');
      if (input.unsubscribe === true) return store.transaction(projectId, state => {
        const current = state.tokens.find(item => item.id === token.id);
        if (current.revokedAt || Date.parse(current.expiresAt) <= now()) throw careError('Diese Einladung ist nicht mehr aktiv.', 410);
        state.customers[customerKey(customer)] = normalizeCustomerCare({ emailAuthorized: false }, state.customers[customerKey(customer)] || customer.care);
        current.unsubscribedAt ||= timestamp(now);
        for (const row of state.outbox) if (row.customerId === customer.id && row.workspaceId === customer.workspaceId && row.kind !== 'advisor-interest' && ['pending','dispatching','queued'].includes(row.status)) { row.status = 'cancelled'; row.reason = 'Der Kunde hat sich von E-Mails abgemeldet.'; }
        return { status: 'unsubscribed', unsubscribed: true };
      });
      if (customer.emailAuthorized === false) throw careError('Der Kunde hat sich bereits abgemeldet.', 409);
      if (input.interest !== undefined && typeof input.interest !== 'boolean' || input.bookingRequested !== undefined && typeof input.bookingRequested !== 'boolean') throw careError('Der Beratungswunsch ist ungültig.');
      const answers = validateAnswers(token.questions, input.answers), interest = input.interest === true || input.bookingRequested === true || answers.interest === 'yes';
      const digest = hash(JSON.stringify({ answers, interest, bookingRequested: input.bookingRequested === true }));
      return store.transaction(projectId, state => {
        const current = state.tokens.find(item => item.id === token.id);
        if (current.revokedAt || Date.parse(current.expiresAt) <= now()) throw careError('Diese Einladung ist nicht mehr aktiv.', 410);
        if (current.submittedAt) { if (current.answerDigest !== digest || current.idempotencyHash !== hash(idempotencyKey)) throw careError('Diese Einladung wurde bereits beantwortet.', 409); return { status: 'submitted', bookingUrl: current.bookingRequested && settings.bookingUrl ? settings.bookingUrl : undefined }; }
        current.answers = answers; current.answerDigest = digest; current.idempotencyHash = hash(idempotencyKey); current.submittedAt = timestamp(now); current.interest = interest; current.bookingRequested = input.bookingRequested === true;
        if (interest) {
          const notification = { id: randomUUID(), customerId: customer.id, workspaceId: customer.workspaceId, tokenId: current.id, kind: 'advisor-interest', priority: 'high', status: 'open', title: `${customer.name}: Beratung gewünscht`, createdAt: timestamp(now), bookingRequested: current.bookingRequested };
          state.notifications.push(notification);
          if (settings.advisorEmail && settings.senderEmail) addOutbox(state, { key: `advisor:${current.id}`, kind: 'advisor-interest', customerId: customer.id, workspaceId: customer.workspaceId, recipient: settings.advisorEmail, sender: settings.senderEmail, subject: 'Priorität: Kunde wünscht Beratung', body: `${customer.name} hat im persönlichen Checkup Interesse an einer Beratung angegeben.${current.bookingRequested ? '\nEin Termin wurde ausdrücklich angefragt.' : ''}\nBitte den aktuellen Kundenvorgang in IVA öffnen.` });
        }
        return { status: 'submitted', bookingUrl: current.bookingRequested && settings.bookingUrl ? settings.bookingUrl : undefined };
      });
    },
    async revokePublicCheckup(input, tokenId) { const scope = scopeOf(input); await projectFor(scope); return store.transaction(scope.projectId, state => { const token = state.tokens.find(item => item.id === tokenId && (!scope.customerId || item.customerId === scope.customerId) && (!scope.workspaceId || item.workspaceId === scope.workspaceId)); if (!token) throw careError('Einladung nicht gefunden.', 404); token.revokedAt = timestamp(now); return { id: token.id, revoked: true }; }); },
  };
  async function publicContext(raw) {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) throw careError('Einladung nicht gefunden.', 404);
    const found = await store.findToken(hash(raw)); if (!found) throw careError('Einladung nicht gefunden.', 404);
    const ctx = await context({ projectId: found.projectId }), token = ctx.state.tokens.find(item => item.id === found.token.id), customer = ctx.customers.find(item => item.id === token.customerId && item.workspaceId === token.workspaceId);
    if (!ctx.settings.enabled || !customer?.care.enabled || token.revokedAt || Date.parse(token.expiresAt) <= now()) throw careError('Diese Einladung ist nicht mehr aktiv.', 410);
    return { ...ctx, projectId: found.projectId, token, customer };
  }
  return api;
}
