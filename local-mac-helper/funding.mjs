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

export function withFundingSender(input = {}) {
  const supplied = String(input.from || '').trim().toLowerCase();
  if (supplied && supplied !== FUNDING_SENDER_EMAIL) {
    throw new Error(`Förderentwürfe dürfen ausschließlich über ${FUNDING_SENDER_EMAIL} angelegt werden.`);
  }
  return { ...input, from: FUNDING_SENDER_EMAIL };
}

const clean = (value, max = 220) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
const html = value => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export function renderFundingMissingDocumentsEmail(input = {}) {
  const customerName = clean(input.customerName);
  const orderNumber = clean(input.orderNumber);
  const vpName = clean(input.vpName);
  if (!customerName) throw new Error('Kundenname fehlt.');
  if (!orderNumber) throw new Error('Angebots-/Auftragsnummer fehlt.');

  const missingDocumentIds = [...new Set(Array.isArray(input.missingDocumentIds) ? input.missingDocumentIds.map(String) : [])];
  const unknown = missingDocumentIds.filter(id => !FUNDING_DOCUMENTS[id]);
  if (unknown.length) throw new Error(`Unbekannte Förderunterlage: ${unknown.join(', ')}`);
  if (!missingDocumentIds.length) throw new Error('Es fehlen keine Unterlagen; deshalb wird kein Entwurf erzeugt.');

  const missingDocuments = missingDocumentIds.map(id => ({ id, label: FUNDING_DOCUMENTS[id] }));
  const greeting = vpName ? `Hallo Patrick, hallo ${vpName},` : 'Hallo Patrick,';
  const list = missingDocuments.map(item => `- ${item.label}`).join('\n');
  const subject = `${customerName} - ${orderNumber} - fehlende Unterlagen`;
  const body = `${greeting}

bei der Überprüfung der Förderunterlagen ist uns aufgefallen, dass für den folgenden Kunden noch Unterlagen fehlen:

Kunde: ${customerName}
Angebots-/Auftragsnummer: ${orderNumber}

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

Vielen Dank!`;
  const htmlBody = `<div style="font-family: Aptos, Arial, sans-serif; font-size: 11pt; line-height: 1.5; color: #1f1f1f;">
  <p>${html(greeting)}</p>
  <p>bei der Überprüfung der Förderunterlagen ist uns aufgefallen, dass für den folgenden Kunden noch Unterlagen fehlen:</p>
  <p><strong>Kunde:</strong> ${html(customerName)}<br><strong>Angebots-/Auftragsnummer:</strong> ${html(orderNumber)}</p>
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
</div>`;

  return {
    subject,
    body,
    html: htmlBody,
    customerName,
    orderNumber,
    vpName,
    missingDocuments,
  };
}
