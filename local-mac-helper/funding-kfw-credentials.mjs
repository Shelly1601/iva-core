const allowedKeys = new Set(['scope', 'dealId', 'customerPersonId', 'sourceIdentityVerified', 'email', 'password']);
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

// Customer KfW access is authorized for the matching deal only. This explicit
// structure accepts neither system/keychain credentials nor one-time codes.
export function validateKfwCustomerCredentials(input = {}, dealId) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowedKeys.has(key))
    || input.scope !== 'customer-kfw' || input.sourceIdentityVerified !== true)
    throw new Error('Nur ausdrücklich zugeordnete KfW-Kundenzugangsdaten sind erlaubt; keine Systempasswörter oder Einmalcodes.');
  if (!/^\d+$/.test(String(dealId || '')) || String(input.dealId) !== String(dealId) || !/^\d+$/.test(String(input.customerPersonId || '')))
    throw new Error('KfW-Kundenzugang, Deal und zugehöriger Kundenkontakt müssen eindeutig übereinstimmen.');
  if (typeof input.email !== 'string' || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(input.email) || input.email.length > 254
    || typeof input.password !== 'string' || input.password.length < 3 || !input.password.trim() || input.password.length > 1000 || /[\r\n\0]/.test(input.password))
    throw new Error('Das vollständige KfW-Kundenzugangspaar ist nicht gültig angegeben.');
  return { ...input, dealId: String(dealId), customerPersonId: String(input.customerPersonId) };
}

export function renderKfwCustomerCredentialsNote(input, dealId) {
  const credentials = validateKfwCustomerCredentials(input, dealId);
  const heading = 'KfW-Kundenzugang';
  const text = `${heading}\nKfW-E-Mail: ${credentials.email}\nKfW-Passwort: ${credentials.password}`;
  const content = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p><p>(Notiz von Nadine)</p>`;
  return { heading, text, content, containsCustomerCredentials: true };
}

export function kfwCredentialNoteHasPair(text) {
  const value = String(text || '');
  if (!/kfw/i.test(value) || /\b(?:macos|windows|apple[- ]?id|systempasswort|administratorpasswort|otp|totp|einmalcode)\b/i.test(value)) return false;
  const email = value.match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (!email) return false;
  const labeled = value.match(/(?:passwort|kennwort)[ \t]*[:=\-][ \t]*([^\r\n]+)/i)?.[1]?.replace(/\s*\(Notiz von Nadine(?: via KI)?\)\s*$/i, '').trim();
  if (labeled?.length >= 3 && !/^(?:\[(?:ausgeblendet|redacted|maskiert)\]|\*{3,}(?:\s|$)|(?:ausgeblendet|redacted|maskiert|vorhanden|gespeichert|hinterlegt|gepr[üu]ft|fehlt|unbekannt|nicht|erfolgreich|g[üu]ltig|gueltig|best[äa]tigt|bestaetigt|korrekt|funktioniert|getestet|ok|aktiv|wurde|wird|login|anmeldung|pr[üu]fung)\b)/i.test(labeled)) return true;
  // Legacy notes may contain only the account email followed by one password
  // token. Additional status prose is not proof of an actual stored password.
  const following = value.slice(email.index + email[0].length).replace(/\s*\(Notiz von Nadine(?: via KI)?\)\s*$/i, '').trim();
  return /kfw.{0,30}konto/i.test(value) && /^\S{6,}$/.test(following) && /[A-Za-z]/.test(following) && /\d/.test(following);
}

export function hasStoredKfwCustomerCredentials(snapshot = {}) {
  return snapshot.kfwAccountConfirmedByCredentials === true && Array.isArray(snapshot.kfwCredentialEvidenceNoteIds)
    && snapshot.kfwCredentialEvidenceNoteIds.length > 0 && snapshot.kfwCredentialEvidenceNoteIds.every(id => /^\d+$/.test(String(id)));
}
