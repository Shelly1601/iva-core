import { readFileSync } from 'node:fs';

export const FUNDING_DOCUMENTS = Object.freeze({
  signed_offer: 'Unterschriebenes Angebot',
  identity_card: 'Personalausweis (Vorder- und Rückseite gemeinsam in einer PDF)',
  registration_certificate: 'Meldebescheinigung (nicht älter als 3 Monate)',
  land_register: 'Vollständiger und leserlicher Grundbuchauszug (ca. 10 Seiten)',
  tax_assessment_2023: 'Einkommensteuerbescheid 2023',
  tax_assessment_2024: 'Einkommensteuerbescheid 2024',
  kfw_account_confirmation: 'Bestätigung, dass das KfW-Konto angelegt und der Aktivierungslink bestätigt wurde',
});

export const FUNDING_SENDER_EMAIL = 'foerderung@heat-hero.com';
export const FUNDING_PRIMARY_RECIPIENT_EMAIL = 'p.germer@heat-hero.com';
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

export function resolveFundingRecipients(input = {}) {
  const suppliedTo = Array.isArray(input.to) ? input.to.map(extractEmailAddress).filter(Boolean) : [];
  if (suppliedTo.length && (suppliedTo.length !== 1 || suppliedTo[0] !== FUNDING_PRIMARY_RECIPIENT_EMAIL)) {
    throw new Error(`Förderentwürfe dürfen im An-Feld ausschließlich an ${FUNDING_PRIMARY_RECIPIENT_EMAIL} adressiert werden.`);
  }

  const suppliedCc = Array.isArray(input.cc) ? input.cc.map(extractEmailAddress).filter(Boolean) : [];
  if (suppliedCc.length > 1) throw new Error('Für einen Förderentwurf darf höchstens ein eindeutig zugeordneter Vertriebspartner im CC stehen.');
  const vpName = clean(input.vpName || input.vertriebspartnerName);
  const rawVpEmail = input.vpEmail || input.vertriebspartnerEmail || suppliedCc[0] || extractEmailAddress(vpName);
  const vpEmail = extractEmailAddress(rawVpEmail);
  if (suppliedCc.length && vpEmail && suppliedCc[0] !== vpEmail) {
    throw new Error('Die übergebene CC-Adresse stimmt nicht mit der erkannten Vertriebspartner-E-Mail überein.');
  }
  const vpFirstName = firstNameFromContactName(input.vpFirstName || vpName);
  const warnings = [];
  if (rawVpEmail && !vpEmail) warnings.push('Die Vertriebspartner-E-Mail ist nicht eindeutig gültig und wurde nicht ins CC übernommen.');
  if (!vpEmail) warnings.push('Keine eindeutige Vertriebspartner-E-Mail vorhanden; der Entwurf geht nur an Patrick.');

  return {
    to: [FUNDING_PRIMARY_RECIPIENT_EMAIL],
    cc: vpEmail && vpEmail !== FUNDING_PRIMARY_RECIPIENT_EMAIL ? [vpEmail] : [],
    vpName,
    vpFirstName,
    vpEmail: vpEmail || null,
    greeting: vpFirstName ? `Hallo Patrick, hallo ${vpFirstName},` : 'Hallo Patrick,',
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

  const missingDocuments = missingDocumentIds.map(id => ({ id, label: FUNDING_DOCUMENTS[id] }));
  const greeting = recipients.greeting;
  const list = missingDocuments.map(item => `- ${item.label}`).join('\n');
  const identityLines = [
    `Kunde: ${customerName}`,
    ...(orderNumber ? [`Angebots-/Auftragsnummer: ${orderNumber}`] : []),
    ...(!orderNumber && location ? [`Ort: ${location}`] : []),
  ];
  const identityHtml = [
    `<strong>Kunde:</strong> ${html(customerName)}`,
    ...(orderNumber ? [`<strong>Angebots-/Auftragsnummer:</strong> ${html(orderNumber)}`] : []),
    ...(!orderNumber && location ? [`<strong>Ort:</strong> ${html(location)}`] : []),
  ].join('<br>');
  const subject = `${reference.text} - fehlende Unterlagen`;
  const body = `${greeting}

bei der Überprüfung der Förderunterlagen ist uns aufgefallen, dass für den folgenden Kunden noch Unterlagen fehlen:

${identityLines.join('\n')}

Noch benötigte Unterlagen:

${list}

Bitte sende alle Unterlagen gesammelt in einer E-Mail an foerderung@heat-hero.com.

Wichtig:
- Jede Unterlage bitte als separate PDF-Datei anhängen.
- Vorder- und Rückseite des Personalausweises bitte gemeinsam in einer PDF einreichen.
- Bitte nicht sämtliche unterschiedlichen Unterlagen in einer einzigen PDF zusammenfassen.
- Die PDF-Dateien bitte eindeutig benennen, beispielsweise „Personalausweis“, „Grundbuchauszug“ oder „Steuerbescheid 2023“.
- Bitte darauf achten, dass alle Dokumente vollständig und gut lesbar sind.

So können wir die Unterlagen schnell zuordnen, beim Kunden hinterlegen und den Förderprozess ohne zusätzliche Verzögerungen weiterbearbeiten.

Vielen Dank!

${renderFundingSignaturePlain()}`;
  const htmlBody = `<div style="font-family: Aptos, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1f1f1f;">
  <p>${html(greeting)}</p>
  <p>bei der Überprüfung der Förderunterlagen ist uns aufgefallen, dass für den folgenden Kunden noch Unterlagen fehlen:</p>
  <p>${identityHtml}</p>
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
  <p>So können wir die Unterlagen schnell zuordnen, beim Kunden hinterlegen und den Förderprozess ohne zusätzliche Verzögerungen weiterbearbeiten.</p>
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
