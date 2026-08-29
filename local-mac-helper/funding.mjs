import { readFileSync } from 'node:fs';
import { loadDirectSalesRosterSync, matchDirectSalesPartner } from './direct-sales-roster.mjs';

export const FUNDING_DOCUMENTS = Object.freeze({
  signed_offer: 'Unterschriebenes Angebot',
  identity_card: 'Personalausweis (Vorder- und Rückseite)',
  registration_certificate: 'Meldebescheinigung (so aktuell wie möglich)',
  land_register: 'Vollständiger und leserlicher Grundbuchauszug (ca. 10 Seiten)',
  tax_assessment_2023: 'Einkommensteuerbescheid 2023',
  tax_assessment_2024: 'Einkommensteuerbescheid 2024',
  kfw_account_confirmation: 'Zugangsdaten des bestätigten KfW-Kontos',
});

export const FUNDING_SENDER_EMAIL = 'foerderung@heat-hero.com';
export const FUNDING_PRIMARY_RECIPIENT_EMAIL = 'p.germer@heat-hero.com';
export const FUNDING_SUPERVISORS = Object.freeze({
  default: Object.freeze({ route: 'default', name: 'Patrick Germer', firstName: 'Patrick', email: 'p.germer@heat-hero.com' }),
  ekd: Object.freeze({ route: 'ekd', name: 'Florian Bolz', firstName: 'Florian', email: 'f.bolz@heat-hero.com' }),
  direct_sales: Object.freeze({ route: 'direct_sales', name: 'Noah Zielinski', firstName: 'Noah', email: 'n.zielinski@heat-hero.com' }),
});
export const FUNDING_SIGNATURE = Object.freeze({
  name: 'Nadine Sell',
  title: 'Sales Operations Manager',
  company: 'HEAT HERO GmbH',
  email: 'n.sell@heat-hero.com',
  phone: '0421 40885189',
  street: 'Fritz-Thiele-Str. 3',
  postalCity: '28279 Bremen',
  website: 'https://www.heat-hero.com',
});
export const FUNDING_ESCALATION_RECIPIENTS = Object.freeze({
  ekd: Object.freeze({ name: 'Kati Bolz', email: 'k.bolz@heat-hero.com' }),
  default: Object.freeze({ name: 'Patrick Germer', email: 'p.germer@heat-hero.com' }),
});
export const FUNDING_ESCALATION_DELAY_DAYS = 7;

const signatureLogoDataUri = `data:image/png;base64,${readFileSync(new URL('./assets/heat-hero-logo.png', import.meta.url)).toString('base64')}`;

export function withFundingSender(input = {}) {
  const supplied = String(input.from || '').trim().toLowerCase();
  if (supplied && supplied !== FUNDING_SENDER_EMAIL) {
    throw new Error(`Förderentwürfe dürfen ausschließlich über ${FUNDING_SENDER_EMAIL} angelegt werden.`);
  }
  return { ...input, from: FUNDING_SENDER_EMAIL };
}

const clean = (value, max = 220) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const normalizeEmail = value => String(value || '').trim().toLowerCase();
const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/i;
const html = value => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export function extractEmailAddress(value) {
  return normalizeEmail(String(value || '').match(emailPattern)?.[0]);
}

export function firstNameFromContactName(value) {
  const contactName = clean(value);
  if (!contactName || contactName.includes('@')) return '';
  const ignored = new Set(['herr', 'frau', 'dr', 'dr.', 'prof', 'prof.', 'professor']);
  const tokens = contactName.split(/\s+/).filter(Boolean);
  while (tokens.length && ignored.has(tokens[0].toLowerCase())) tokens.shift();
  const candidate = String(tokens[0] || '').replace(/[^\p{L}\p{M}'’\-]/gu, '');
  return candidate.length >= 2 ? candidate : '';
}

export function buildFundingCaseReference(input = {}) {
  const customerName = clean(input.customerName);
  const orderNumber = clean(input.orderNumber || input.offerNumber);
  const location = clean(input.location || input.city || input.customerCity);
  if (!customerName) throw new Error('Kundenname fehlt.');
  const suffix = orderNumber || location;
  return {
    text: suffix ? `${customerName} - ${suffix}` : customerName,
    customerName,
    orderNumber: orderNumber || null,
    location: location || null,
    identifierSource: orderNumber ? 'order_number' : location ? 'location' : 'customer_name',
  };
}

export function resolveFundingSupervisor(input = {}) {
  const routeEvidence = [
    input.fundingRoute,
    input.route,
    input.dealTitle,
    input.sourceText,
    input.vpName,
    input.vertriebspartnerName,
    input.vpEmail,
    input.vertriebspartnerEmail,
  ].map(value => clean(value)).join(' ');
  if (/^(?:direct_sales|direktvertrieb)$/i.test(clean(input.fundingRoute || input.route))) return FUNDING_SUPERVISORS.direct_sales;
  const rosterMatch = matchDirectSalesPartner({
    vpName: input.vpName || input.vertriebspartnerName,
    vpEmail: input.vpEmail || input.vertriebspartnerEmail,
  }, input.directSalesRoster || loadDirectSalesRosterSync());
  if (rosterMatch.matched) return { ...FUNDING_SUPERVISORS.direct_sales, rosterMatch };
  if (/(?:^|\W)ekd(?:\W|$)|@ekd-solar\.de\b/i.test(routeEvidence)) return { ...FUNDING_SUPERVISORS.ekd, rosterMatch };
  return { ...FUNDING_SUPERVISORS.default, rosterMatch };
}

export function resolveFundingNoResponseEscalationRecipient(input = {}) {
  const evidence = [input.salesStructure, input.vertriebsstruktur, input.fundingRoute, input.route, input.vpEmail, input.vertriebspartnerEmail]
    .map(value => clean(value, 300)).join(' ');
  return /(?:^|\W)ekd(?:\W|$)|@[a-z0-9.-]*ekd[a-z0-9.-]*\.[a-z]{2,}\b/i.test(evidence)
    ? { route: 'ekd', ...FUNDING_ESCALATION_RECIPIENTS.ekd }
    : { route: 'default', ...FUNDING_ESCALATION_RECIPIENTS.default };
}

export function assessFundingNoResponseEscalation(input = {}, now = new Date()) {
  const requestSentAt = new Date(input.requestSentAt);
  const checkedAt = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(requestSentAt.getTime())) throw new Error('Für die 7-Tage-Prüfung fehlt der echte Versandzeitpunkt der Fehlunterlagen-Mail.');
  if (Number.isNaN(checkedAt.getTime())) throw new Error('Für die 7-Tage-Prüfung fehlt ein gültiger Prüfzeitpunkt.');
  const customerEmail = extractEmailAddress(input.customerEmail);
  const vpEmail = extractEmailAddress(input.vpEmail || input.vertriebspartnerEmail);
  const validSenders = new Set([customerEmail, vpEmail].filter(Boolean));
  const responses = (Array.isArray(input.responses) ? input.responses : []).map(item => ({
    senderEmail: extractEmailAddress(item?.senderEmail || item?.from),
    receivedAt: new Date(item?.receivedAt || item?.date),
    role: clean(item?.role, 40).toLowerCase(),
  })).filter(item => !Number.isNaN(item.receivedAt.getTime()) && item.receivedAt > requestSentAt);
  const response = responses.find(item => validSenders.has(item.senderEmail) || ['customer', 'kunde', 'vp', 'vertriebspartner'].includes(item.role));
  const dueAt = new Date(requestSentAt.getTime() + FUNDING_ESCALATION_DELAY_DAYS * 24 * 60 * 60 * 1000);
  return {
    status: response ? 'answered' : checkedAt >= dueAt ? 'due' : 'waiting',
    requestSentAt: requestSentAt.toISOString(),
    dueAt: dueAt.toISOString(),
    checkedAt: checkedAt.toISOString(),
    answeredAt: response?.receivedAt.toISOString() || null,
    eligible: !response && checkedAt >= dueAt,
  };
}

export function renderFundingNoResponseEscalationDraft(input = {}, now = new Date()) {
  const assessment = assessFundingNoResponseEscalation(input, now);
  if (!assessment.eligible) throw new Error(assessment.status === 'answered'
    ? 'Keine Eskalation: Kunde oder VP hat auf die Fehlunterlagen-Mail reagiert.'
    : 'Keine Eskalation: Die Frist von sieben vollen Tagen ist noch nicht abgelaufen.');
  const reference = buildFundingCaseReference(input);
  if (!reference.orderNumber) throw new Error('Für die interne Eskalation fehlt die Angebots-/Auftragsnummer.');
  const dealId = clean(input.dealId, 100);
  if (!dealId) throw new Error('Für die interne Eskalation fehlt die eindeutige Pipedrive-Deal-ID.');
  const originalSubject = clean(input.originalSubject || input.subject, 240);
  if (!originalSubject) throw new Error('Für die interne Eskalation fehlt der Betreff der ursprünglich versandten Fehlunterlagen-Mail.');
  const recipient = resolveFundingNoResponseEscalationRecipient(input);
  const subject = /^\s*(?:WG|FW|FWD)\s*:/i.test(originalSubject) ? originalSubject : `WG: ${originalSubject}`;
  const body = `Hallo ${recipient.name.split(/\s+/)[0]},

auf die am ${new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium' }).format(new Date(assessment.requestSentAt))} versandte Fehlunterlagen-Mail zu ${reference.customerName}, Angebots-/Auftragsnummer ${reference.orderNumber}, liegt nach sieben vollen Tagen weder vom Kunden noch vom Vertriebspartner eine Antwort vor.

Bitte übernimm die weitere Nachverfolgung.

Deal-ID: ${dealId}
Ursprünglicher Betreff: ${originalSubject}`;
  return {
    from: FUNDING_SENDER_EMAIL,
    to: [recipient.email],
    cc: [],
    subject,
    body,
    originalSubject,
    requestSentAt: assessment.requestSentAt,
    dealId,
    customerEmail: extractEmailAddress(input.customerEmail || input.email || input.kundenEmail) || null,
    vpEmail: extractEmailAddress(input.vpEmail || input.vertriebspartnerEmail) || null,
    originalMessageMustBeForwarded: true,
    draftOnly: true,
    sent: false,
    recipient,
    assessment,
    deduplicationKey: `${dealId}:${reference.orderNumber}:${assessment.requestSentAt}`.toLowerCase(),
  };
}

export function resolveFundingRecipients(input = {}) {
  const customerEmail = extractEmailAddress(input.customerEmail || input.email || input.kundenEmail);
  if (!customerEmail) throw new Error('Für den Förderentwurf fehlt die eindeutige Kunden-E-Mail-Adresse aus den Dealinformationen oder der TMB.');
  const suppliedTo = Array.isArray(input.to) ? input.to.map(extractEmailAddress).filter(Boolean) : [];
  if (suppliedTo.length && (suppliedTo.length !== 1 || suppliedTo[0] !== customerEmail)) {
    throw new Error(`Der Förderentwurf muss im An-Feld ausschließlich an den Kunden ${customerEmail} adressiert werden.`);
  }

  const suppliedCc = Array.isArray(input.cc) ? input.cc.map(extractEmailAddress).filter(Boolean) : [];
  if (suppliedCc.length > 1) throw new Error('Für einen Förderentwurf darf höchstens ein eindeutig zugeordneter Vertriebspartner im CC stehen.');
  const vpName = clean(input.vpName || input.vertriebspartnerName);
  const rawVpEmail = input.vpEmail || input.vertriebspartnerEmail || suppliedCc[0] || extractEmailAddress(vpName);
  const vpEmail = extractEmailAddress(rawVpEmail);
  if (suppliedCc.length && vpEmail && suppliedCc[0] !== vpEmail) {
    throw new Error('Die übergebene CC-Adresse stimmt nicht mit der erkannten Vertriebspartner-E-Mail überein.');
  }
  const warnings = [];
  if (rawVpEmail && !vpEmail) warnings.push('Die Vertriebspartner-E-Mail ist nicht eindeutig gültig und wurde nicht ins CC übernommen.');
  if (!vpEmail) warnings.push('Keine eindeutige Vertriebspartner-E-Mail vorhanden; der Entwurf bleibt ohne CC und muss kontrolliert werden.');
  const salutation = /^(herr|frau)$/i.test(clean(input.customerSalutation || input.salutation))
    ? `${clean(input.customerSalutation || input.salutation)} `
    : '';
  const customerName = clean(input.customerName);

  return {
    to: [customerEmail],
    cc: vpEmail && vpEmail !== customerEmail ? [vpEmail] : [],
    customerEmail,
    vpName,
    vpEmail: vpEmail || null,
    greeting: `Guten Tag ${salutation}${customerName},`,
    warnings,
  };
}

export function renderFundingSignaturePlain() {
  return `Bei weiteren Fragen stehe ich gerne zur Verfügung.

Beste Grüße
${FUNDING_SIGNATURE.name} - ${FUNDING_SIGNATURE.title}

${FUNDING_SIGNATURE.company}
E-Mail: ${FUNDING_SIGNATURE.email}
Tel.: ${FUNDING_SIGNATURE.phone}
Adresse: ${FUNDING_SIGNATURE.street},
${FUNDING_SIGNATURE.postalCity}

www.heat-hero.com`;
}

export function renderFundingSignatureHtml() {
  return `<div style="margin-top: 24px; font-family: Aptos, Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #1f1f1f;">
  <p style="margin: 0 0 12px;">Bei weiteren Fragen stehe ich gerne zur Verfügung.</p>
  <p style="margin: 0 0 14px;">Beste Grüße</p>
  <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: collapse;">
    <tr>
      <td style="padding: 0 18px 0 0; vertical-align: top;"><img src="${signatureLogoDataUri}" width="155" alt="HEAT HERO Wärmepumpen" style="display: block; width: 155px; height: auto; border: 0;"></td>
      <td style="padding: 2px 0 0; vertical-align: top; border-left: 3px solid #29ef69; padding-left: 16px;">
        <div style="font-weight: 700;">${html(FUNDING_SIGNATURE.name)} - ${html(FUNDING_SIGNATURE.title)}</div>
        <div style="margin-top: 8px; font-weight: 700;">${html(FUNDING_SIGNATURE.company)}</div>
        <div>E-Mail: <a href="mailto:${html(FUNDING_SIGNATURE.email)}" style="color: #1f1f1f; text-decoration: none;">${html(FUNDING_SIGNATURE.email)}</a></div>
        <div>Tel.: <a href="tel:+4942140885189" style="color: #1f1f1f; text-decoration: none;">${html(FUNDING_SIGNATURE.phone)}</a></div>
        <div>Adresse: ${html(FUNDING_SIGNATURE.street)},<br>${html(FUNDING_SIGNATURE.postalCity)}</div>
        <div style="margin-top: 8px;"><a href="${FUNDING_SIGNATURE.website}" style="color: #138c41; font-weight: 700;">www.heat-hero.com</a></div>
      </td>
    </tr>
  </table>
</div>`;
}

export function renderFundingMissingDocumentsEmail(input = {}) {
  const reference = buildFundingCaseReference(input);
  const { customerName, orderNumber, location } = reference;
  const recipients = resolveFundingRecipients(input);
  const vpName = recipients.vpName;

  const missingDocumentIds = [...new Set(Array.isArray(input.missingDocumentIds) ? input.missingDocumentIds.map(String) : [])];
  const unknown = missingDocumentIds.filter(id => !FUNDING_DOCUMENTS[id]);
  if (unknown.length) throw new Error(`Unbekannte Förderunterlage: ${unknown.join(', ')}`);
  if (!missingDocumentIds.length) throw new Error('Es fehlen keine Unterlagen; deshalb wird kein Entwurf erzeugt.');
  if (!orderNumber) throw new Error('Für den Förderentwurf fehlt die Angebots-/Auftragsnummer. Sie muss zuerst aus dem unterschriebenen Angebot oder den Dealinformationen übernommen werden.');

  const missingDocuments = missingDocumentIds.map(id => ({ id, label: FUNDING_DOCUMENTS[id] }));
  const greeting = recipients.greeting;
  const list = missingDocuments.map(item => `- ${item.label}`).join('\n');
  const subject = `${reference.text} - fehlende Unterlagen`;
  const body = `${greeting}

bei der Überprüfung der Förderunterlagen ist uns aufgefallen, dass für Ihren Förderantrag zu Angebots-/Auftragsnummer: ${orderNumber} noch folgende Unterlagen fehlen:

Noch benötigte Unterlagen:

${list}

Bitte sende alle Unterlagen gesammelt in einer E-Mail an foerderung@heat-hero.com.

Wichtig:
- Jede Unterlage bitte als separate PDF-Datei anhängen.
- Vorder- und Rückseite des Personalausweises bitte gemeinsam in einer PDF einreichen.
- Bitte nicht sämtliche unterschiedlichen Unterlagen in einer einzigen PDF zusammenfassen.
- Die PDF-Dateien bitte eindeutig benennen, beispielsweise „Personalausweis“, „Grundbuchauszug“ oder „Steuerbescheid 2023“.
- Bitte darauf achten, dass alle Dokumente vollständig und gut lesbar sind.

So können wir die Unterlagen schnell zuordnen, hinterlegen und den Förderprozess ohne zusätzliche Verzögerungen weiterbearbeiten.

Vielen Dank!

${renderFundingSignaturePlain()}`;
  const htmlBody = `<div style="font-family: Aptos, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1f1f1f;">
  <p>${html(greeting)}</p>
  <p>bei der Überprüfung der Förderunterlagen ist uns aufgefallen, dass für Ihren Förderantrag zu <strong>Angebots-/Auftragsnummer:</strong> ${html(orderNumber)} noch folgende Unterlagen fehlen:</p>
  <p><strong>Noch benötigte Unterlagen:</strong></p>
  <ul>${missingDocuments.map(item => `<li>${html(item.label)}</li>`).join('')}</ul>
  <p>Bitte sende alle Unterlagen gesammelt in einer E-Mail an <strong>foerderung@heat-hero.com</strong>.</p>
  <p><strong>Wichtig:</strong></p>
  <ul>
    <li>Jede Unterlage bitte als separate PDF-Datei anhängen.</li>
    <li>Vorder- und Rückseite des Personalausweises bitte gemeinsam in einer PDF einreichen.</li>
    <li>Bitte nicht sämtliche unterschiedlichen Unterlagen in einer einzigen PDF zusammenfassen.</li>
    <li>Die PDF-Dateien bitte eindeutig benennen, beispielsweise „Personalausweis“, „Grundbuchauszug“ oder „Steuerbescheid 2023“.</li>
    <li>Bitte darauf achten, dass alle Dokumente vollständig und gut lesbar sind.</li>
  </ul>
  <p>So können wir die Unterlagen schnell zuordnen, hinterlegen und den Förderprozess ohne zusätzliche Verzögerungen weiterbearbeiten.</p>
  <p>Vielen Dank!</p>
  ${renderFundingSignatureHtml()}
</div>`;

  return {
    subject,
    body,
    html: htmlBody,
    customerName,
    orderNumber,
    location,
    reference,
    vpName,
    recipients,
    missingDocuments,
  };
}

export function renderFundingMinorChildrenQuestionEmail(input = {}) {
  const reference = buildFundingCaseReference(input);
  if (!reference.orderNumber) throw new Error('Für die Rückfrage zu minderjährigen Kindern fehlt die Angebots-/Auftragsnummer.');
  const recipients = resolveFundingRecipients(input);
  const subject = `${reference.text} - kurze Rückfrage zur Förderberechnung`;
  const body = `${recipients.greeting}

für die korrekte Berechnung Ihrer möglichen KfW-Förderung benötigen wir noch eine kurze Angabe:

Lebt in der selbst genutzten Wohneinheit mindestens ein Kind unter 18 Jahren, für das in Ihrem Haushalt eine Kindergeldberechtigung besteht?

Bitte antworten Sie kurz mit „Ja“ oder „Nein“. Bei „Ja“ benötigen wir für die spätere Prüfung zusätzlich einen aktuellen Meldenachweis des Kindes und den Nachweis der Kindergeldberechtigung.

Vielen Dank!

${renderFundingSignaturePlain()}`;
  const htmlBody = `<div style="font-family: Aptos, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1f1f1f;">
  <p>${html(recipients.greeting)}</p>
  <p>für die korrekte Berechnung Ihrer möglichen KfW-Förderung benötigen wir noch eine kurze Angabe:</p>
  <p><strong>Lebt in der selbst genutzten Wohneinheit mindestens ein Kind unter 18 Jahren, für das in Ihrem Haushalt eine Kindergeldberechtigung besteht?</strong></p>
  <p>Bitte antworten Sie kurz mit „Ja“ oder „Nein“. Bei „Ja“ benötigen wir für die spätere Prüfung zusätzlich einen aktuellen Meldenachweis des Kindes und den Nachweis der Kindergeldberechtigung.</p>
  <p>Vielen Dank!</p>
  ${renderFundingSignatureHtml()}
</div>`;
  return { subject, body, html: htmlBody, recipients, reference };
}
