import { generateText } from 'ai';
import { chooseModel, recordUsage, checkBudget } from '../core/router.js';
import { getCampaign } from '../marketing/campaigns.js';
import { getQonektoCustomerDetail, listQonektoCustomers } from './qonekto-customers.js';
import {
  appendWhatsAppMessages,
  createOrUpdateWhatsAppHandoff,
  createOrUpdateClaimIntake,
  getWhatsAppConversation,
  resolveWhatsAppProfile,
} from './whatsapp-store.js';

function digits(value) { return String(value || '').replace(/\D/g, ''); }
function phoneMatches(left, right) {
  const a = digits(left); const b = digits(right);
  if (a.length < 7 || b.length < 7) return false;
  return a === b || a.endsWith(b.slice(-10)) || b.endsWith(a.slice(-10));
}

export function classifyWhatsAppIntent(text = '') {
  const normalized = String(text).toLowerCase();
  return {
    claim: /\b(schaden|unfall|beschädigt|beschaedigt|gestohlen|einbruch|wasserschaden|brand|hagel|sturm|haftpflichtfall)\b/i.test(normalized),
    coverage: /\b(versichert|abgedeckt|gedeckt|deckung|übernimmt|uebernimmt|mitversichert|ausschluss)\b/i.test(normalized),
    appointment: /\b(termin|beratung|kalender|sprechen|rückruf|rueckruf)\b/i.test(normalized),
    human: /\b(mensch|persönlich|persoenlich|mitarbeiter|nadine|berater|anrufen)\b/i.test(normalized),
  };
}

function publicCustomer(customer = {}) {
  return { id: customer.id, name: customer.name, firstName: customer.firstName, lastName: customer.lastName, zip: customer.zip, city: customer.city };
}

function publicContract(contract = {}) {
  return {
    id: contract.id,
    category: contract.category,
    company: contract.company,
    policyNumber: contract.policyNumber,
    status: contract.status,
    start: contract.start,
    end: contract.end,
    paymentFrequency: contract.paymentFrequency,
    netPremium: contract.netPremium,
    risk: contract.risk,
  };
}

async function resolveCustomerBySender(sender) {
  let result = await listQonektoCustomers({ search: sender, limit: 100 });
  let matches = (result.customers || []).filter(customer => phoneMatches(sender, customer.mobile) || phoneMatches(sender, customer.phone));
  if (!matches.length && (result.customers || []).length < 100) {
    result = await listQonektoCustomers({ limit: 100 });
    matches = (result.customers || []).filter(customer => phoneMatches(sender, customer.mobile) || phoneMatches(sender, customer.phone));
  }
  if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'not-found', matches: [] };
  const detail = await getQonektoCustomerDetail(matches[0].id);
  return { status: 'matched', customer: publicCustomer(detail.customer), contracts: (detail.contracts || []).map(publicContract), availability: detail.availability };
}

function answerKnowledge(profile) {
  return (profile.answers || []).map(item => `Frage: ${item.question}\nFreigegebene Antwort: ${item.answer}${item.source ? `\nQuelle: ${item.source}` : '\nQuelle: nicht hinterlegt – keine konkrete Fach-/Deckungsbehauptung daraus ableiten'}${item.verifiedAt ? `\nGeprueft am: ${item.verifiedAt}` : ''}`).join('\n\n');
}

function compactHistory(conversation) {
  return (conversation.messages || []).slice(-10).map(item => `${item.role === 'assistant' ? 'Bot' : 'Kunde'}: ${item.text}`).join('\n');
}

function exactCoverageGuard(intent, customerContext) {
  if (!intent.coverage) return '';
  if (customerContext?.status !== 'matched') {
    return 'Die Frage betrifft konkreten Versicherungsschutz, aber der Absender ist nicht eindeutig einer Kundenakte zugeordnet. Keine Vertragsdetails nennen. Identitätsprüfung oder persönliche Übergabe anbieten.';
  }
  return 'Die vorhandenen Daten sind nur Vertragsstammdaten, keine vollständigen Versicherungsbedingungen oder Police. Deshalb niemals behaupten, ein konkreter Schaden oder Sachverhalt sei versichert oder ausgeschlossen. Erkläre vorhandene Stammdaten, sage für die konkrete Deckungsfrage klar, dass du sie anhand der vorliegenden Daten nicht belastbar bestätigen kannst, und leite zur persönlichen Prüfung weiter.';
}

function deterministicCoverageReply(profile, customerContext) {
  if (customerContext?.status !== 'matched') {
    return `Ich kann diese Telefonnummer gerade nicht eindeutig einer Kundenakte zuordnen. Deshalb nenne ich aus Datenschutzgründen keine Vertragsdetails und gebe die Deckungsfrage persönlich weiter. ${profile.handoffText}`.slice(0, 1200);
  }
  const contracts = (customerContext.contracts || []).slice(0, 4)
    .map(contract => [contract.category, contract.company].filter(Boolean).join(' bei '))
    .filter(Boolean).join(', ');
  return `Ich sehe in deiner Kundenakte${contracts ? ` folgende Vertragsstammdaten: ${contracts}` : ' Vertragsstammdaten'}, aber keine vollständige Police oder Versicherungsbedingungen als belastbaren Deckungsbeleg. Deshalb kann ich nicht sicher bestätigen, ob dieser konkrete Fall versichert oder ausgeschlossen ist. ${profile.handoffText}`.slice(0, 1200);
}

export async function buildWhatsAppReply({ profile, sender, text, conversation, customerContext, campaign, claimIntake, simulate = false }) {
  const intent = classifyWhatsAppIntent(text);
  const routed = chooseModel({ task: 'whatsapp' });
  await checkBudget(routed);
  const modeRules = profile.mode === 'lead'
    ? `Du bist ein flexibler Erstkontakt für die Kampagne. Beantworte Fragen mit den freigegebenen Fakten. Führe freundlich und ohne Druck auf das Ziel "${profile.objective}" hin. Stelle höchstens eine Frage pro Antwort. Wenn es passt, nenne diesen Terminlink: ${profile.appointmentUrl || 'Kein Terminlink hinterlegt – biete persönliche Terminabstimmung an.'}`
    : profile.mode === 'service'
      ? 'Du bist ein Kundenservice-Assistent. Antworte nur aus den übergebenen Kundendaten, Vertragsstammdaten und freigegebenen Antworten. Keine Rechts-, Leistungs- oder Deckungszusage erfinden. Schäden strukturiert aufnehmen, aber weder Deckung bestätigen noch einen Schaden automatisch beim Versicherer einreichen.'
      : `Du kombinierst Erstkontakt und Kundenservice. Bei Interessenten arbeitest du auf "${profile.objective}" hin; bei Bestandskunden gelten die strengen Service- und Deckungsregeln.`;
  const system = `Du antwortest als WhatsApp-Assistent von ${profile.businessName || 'IVA'} auf Deutsch. Kurz, natürlich und hilfreich, maximal 700 Zeichen. Keine Markdown-Tabellen. Keine internen IDs oder technischen Details nennen. Keine personenbezogenen Daten offenlegen, bevor die Telefonnummer eindeutig einer Kundenakte zugeordnet ist. ${modeRules}\n${exactCoverageGuard(intent, customerContext)}\nWenn eine Aussage nicht belegt ist, sage das klar und nutze diese Übergabeformulierung: ${profile.handoffText}\nEine Schadenaufnahme ist nur eine Erfassung zur persönlichen Prüfung, keine Deckungsentscheidung und keine Einreichung.`;
  const prompt = `Aktuelles Profil:\n${JSON.stringify({ mode: profile.mode, objective: profile.objective, appointmentUrl: profile.appointmentUrl })}\n\nKampagne:\n${JSON.stringify(campaign ? { name: campaign.name, brand: campaign.brand, tone: campaign.tone, type: campaign.type } : null)}\n\nFreigegebene Antworten:\n${answerKnowledge(profile) || 'Keine hinterlegt.'}\n\nEindeutig zugeordnete Kunden-/Vertragsdaten:\n${JSON.stringify(customerContext?.status === 'matched' ? customerContext : { status: customerContext?.status || 'nicht geprüft' })}\n\nSchadenaufnahme:\n${JSON.stringify(claimIntake ? { status: claimIntake.status, statements: claimIntake.statements } : null)}\n\nBisheriger Verlauf:\n${compactHistory(conversation) || 'Noch leer.'}\n\nNeue Nachricht:\n${text}\n\nSchreibe jetzt nur die WhatsApp-Antwort. ${simulate ? 'Dies ist ein Testchat, erwähne das nicht.' : ''}`;
  const { text: reply, usage } = await generateText({ model: routed.model, system, prompt, temperature: 0.25, maxTokens: 350 });
  await recordUsage(routed, usage);
  return String(reply || '').trim().slice(0, 1200) || profile.handoffText;
}

export async function handleWhatsAppMessage({ profileId = '', phoneNumberId = '', campaignId = '', sender, text, messageId = '', simulate = false } = {}) {
  const profile = await resolveWhatsAppProfile({ profileId, phoneNumberId, campaignId });
  if (!profile) throw new Error('Kein passendes WhatsApp-Profil konfiguriert.');
  if (!simulate && !profile.enabled) throw new Error('Das WhatsApp-Profil ist nicht aktiv.');
  const conversation = await getWhatsAppConversation(profile.id, sender);
  if (messageId && (conversation.messages || []).some(item => item.messageId === messageId)) {
    return { duplicate: true, reply: '', profile: { id: profile.id, name: profile.name, mode: profile.mode } };
  }
  const intent = classifyWhatsAppIntent(text);
  let customerContext = { status: 'not-required' };
  if (profile.mode !== 'lead') {
    try { customerContext = await resolveCustomerBySender(sender); }
    catch (error) { customerContext = { status: 'unavailable', error: error.message }; }
  }
  let claimIntake = null;
  if (intent.claim || conversation.claimIntakeId) {
    claimIntake = await createOrUpdateClaimIntake({
      id: conversation.claimIntakeId,
      profileId: profile.id,
      sender,
      customerId: customerContext?.customer?.id || conversation.customerId,
      text,
    });
  }
  const campaign = profile.campaignId ? await getCampaign(profile.campaignId) : (campaignId ? await getCampaign(campaignId) : null);
  const reply = intent.coverage
    ? deterministicCoverageReply(profile, customerContext)
    : await buildWhatsAppReply({ profile, sender, text, conversation, customerContext, campaign, claimIntake, simulate });
  const handoffReasons = [intent.human && 'human-request', intent.coverage && 'coverage-review', (intent.claim || claimIntake) && 'claim-review'].filter(Boolean);
  const handoffTicket = handoffReasons.length ? await createOrUpdateWhatsAppHandoff({
    id: conversation.handoffTicketId,
    profileId: profile.id,
    sender,
    customerId: customerContext?.customer?.id || conversation.customerId || '',
    owner: profile.handoffOwner,
    slaMinutes: profile.handoffSlaMinutes,
    reasons: handoffReasons,
    priority: intent.claim || claimIntake ? 'high' : 'normal',
    lastMessage: text,
  }) : null;
  const updated = await appendWhatsAppMessages(profile.id, sender, [
    { role: 'user', text, messageId },
    { role: 'assistant', text: reply },
  ], {
    customerId: customerContext?.customer?.id || conversation.customerId || '',
    claimIntakeId: claimIntake?.id || conversation.claimIntakeId || '',
    handoffTicketId: handoffTicket?.id || conversation.handoffTicketId || '',
    humanHandoff: intent.human || intent.coverage || conversation.humanHandoff,
  });
  return {
    reply,
    profile: { id: profile.id, name: profile.name, mode: profile.mode },
    customerStatus: customerContext.status,
    customer: customerContext.status === 'matched' ? customerContext.customer : null,
    claimIntake: claimIntake ? { id: claimIntake.id, status: claimIntake.status } : null,
    handoffTicket: handoffTicket ? { id: handoffTicket.id, status: handoffTicket.status, owner: handoffTicket.owner, dueAt: handoffTicket.dueAt, reasons: handoffTicket.reasons } : null,
    humanHandoff: updated.humanHandoff,
    safety: {
      coverageEvidenceRequired: intent.coverage,
      coverageDecisionMade: false,
      claimSubmitted: false,
    },
  };
}
