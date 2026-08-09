import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { classifyFundingDocumentName } from './funding-document-extractor.mjs';
import { FUNDING_BASE_REQUIRED_DOCUMENTS, loadFundingScan } from './funding-scan.mjs';
import {
  openOutlookAccountFolder,
  runMacUiBridge,
} from './macos-ui.mjs';

const FUNDING_MAILBOX = 'foerderung@heat-hero.com';

function normalized(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactReference(value) {
  return normalized(value).replace(/\s+/g, '');
}

function nameParts(customerName) {
  const tokens = normalized(customerName).split(' ').filter(Boolean);
  const meaningful = tokens.filter(token => !['und', 'von', 'van', 'der'].includes(token));
  return {
    full: normalized(customerName),
    tokens: meaningful,
    first: meaningful[0] || '',
    surname: meaningful.at(-1) || '',
  };
}

export function correlateFundingMessages(cases, messageDescriptions) {
  const prepared = cases.map(item => ({ ...item, name: nameParts(item.customerName) }));
  const surnameCounts = new Map();
  for (const item of prepared) surnameCounts.set(item.name.surname, (surnameCounts.get(item.name.surname) || 0) + 1);
  const result = new Map(prepared.map(item => [String(item.dealId), []]));

  for (const description of messageDescriptions) {
    const haystack = normalized(description);
    const compactHaystack = compactReference(description);
    const scored = [];
    for (const item of prepared) {
      const order = compactReference(item.orderNumber);
      if (order && compactHaystack.includes(order)) {
        scored.push({ item, score: 100, matchedBy: 'order_number' });
        continue;
      }
      if (item.name.full && haystack.includes(item.name.full)) {
        scored.push({ item, score: 90, matchedBy: 'full_name' });
        continue;
      }
      const hasSurname = item.name.surname.length >= 4 && haystack.split(' ').includes(item.name.surname);
      const hasFirst = item.name.first.length >= 3 && haystack.split(' ').includes(item.name.first);
      if (hasSurname && hasFirst) {
        scored.push({ item, score: 80, matchedBy: 'first_and_surname' });
        continue;
      }
      if (hasSurname && surnameCounts.get(item.name.surname) === 1) {
        scored.push({ item, score: 60, matchedBy: 'unique_surname' });
      }
    }
    if (!scored.length) continue;
    const best = Math.max(...scored.map(entry => entry.score));
    const winners = scored.filter(entry => entry.score === best);
    if (winners.length !== 1) continue;
    const winner = winners[0];
    result.get(String(winner.item.dealId)).push({
      description,
      matchedBy: winner.matchedBy,
      hasAttachments: /hat dateien/i.test(description),
    });
  }
  return result;
}

function extractSubject(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/Betreff:\s*(.*?)(?:,\s+(?:Neueste Nachricht:\s*)?\d{2}\.\d{2}\.\d{2}|,\s+(?:Gestern|Heute)\b|,\s+Hat Dateien|,\s+Nachrichtenvorschau:)/i);
  return String(match?.[1] || '').trim().slice(0, 240) || null;
}

function attachmentFileName(description) {
  const text = String(description || '').trim();
  return text.match(/^(.+?\.(?:pdf|png|jpe?g|heic|tiff?|docx?))(?:,\s+.*)?$/i)?.[1]?.trim() || null;
}

function positiveTextEvidence(text) {
  const value = normalized(text);
  const evidence = new Set();
  const missingNear = keyword => new RegExp(`(?:fehlt|fehlen|nicht vorhanden|noch nicht|sucht|nachreichen|benotigt|brauchen).{0,80}${keyword}|${keyword}.{0,80}(?:fehlt|fehlen|nicht vorhanden|noch nicht|sucht|nachreichen)`, 'i').test(value);
  if (!missingNear('angebot') && /unterschrieben(?:es|e|en)? angebot|angebot unterschrieben/.test(value)) evidence.add('signed_offer');
  if (!missingNear('(?:personalausweis|ausweis|perso)') && /personalausweis|\bausweis(?:e)?\b|\bperso\b/.test(value)) evidence.add('identity_card');
  if (!missingNear('meldebescheinigung') && /meldebescheinigung/.test(value)) evidence.add('registration_certificate');
  if (!missingNear('grundbuch') && /grundbuch(?:auszug)?/.test(value)) evidence.add('land_register');
  if (!missingNear('kfw') && /kfw.{0,80}(?:zugangsdaten|konto.{0,20}(?:angelegt|aktiviert|bestatigt)|aktivierungslink.{0,20}bestatigt|zusage)|(?:zugangsdaten|aktivierungslink).{0,80}kfw/.test(value)) evidence.add('kfw_account_confirmation');
  if (/steuerbescheid.{0,30}2023|2023.{0,30}steuerbescheid/.test(value)) evidence.add('tax_assessment_2023');
  if (/steuerbescheid.{0,30}2024|2024.{0,30}steuerbescheid/.test(value)) evidence.add('tax_assessment_2024');
  return [...evidence];
}

function incomeBonusEvidence(text) {
  const value = normalized(text);
  if (/kein(?:en|e)? einkommensbonus|einkommensbonus.{0,30}(?:nicht|kein)|steuerbescheid.{0,40}(?:nicht benotigt|nicht erforderlich)/.test(value)) return false;
  if (/einkommensbonus|steuerbescheid.{0,30}202[34]/.test(value)) return true;
  return null;
}

function expectedAttachmentCount(grid) {
  return Number(String(grid?.description || '').match(/\d+/)?.[0] || 0);
}

export function defaultFundingMailScanFile() {
  return path.join(
    process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
    'funding-mail-scan.json',
  );
}

async function saveReport(report, filePath = defaultFundingMailScanFile()) {
  const absoluteFile = path.resolve(filePath);
  const temporary = `${absoluteFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(absoluteFile), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
    await rename(temporary, absoluteFile);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return absoluteFile;
}

export async function loadFundingMailScan(filePath = defaultFundingMailScanFile()) {
  return JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
}

export async function scanFundingMailbox({ fundingScan, persist = true, onProgress } = {}) {
  const startedAt = new Date().toISOString();
  const pipedrive = fundingScan || await loadFundingScan();
  await openOutlookAccountFolder({ from: FUNDING_MAILBOX, folder: 'Posteingang' });
  const inbox = await runMacUiBridge(['find', 'AXCell'], { timeoutMs: 30000 });
  const messageDescriptions = inbox.matches
    .map(item => String(item.description || ''))
    .filter(description => /(?:Betreff:|Kein Betreff)/i.test(description));
  const correlated = correlateFundingMessages(pipedrive.cases, messageDescriptions);
  const attachmentMessages = [...correlated.values()].flat().filter(item => item.hasAttachments);
  for (const [index, message] of attachmentMessages.entries()) {
    // Outlook virtualisiert die Nachrichtenliste. Anlagen aus nicht sichtbaren
    // Zeilen duerfen deshalb niemals ueber AX einer Mail zugeordnet werden.
    // Eine Anlage zaehlt erst nach lokaler Inhaltspruefung und verifiziertem
    // Upload in Pipedrive als vorhanden.
    message.inspection = null;
    message.inspectionError = 'attachment_requires_local_content_verification';
    onProgress?.({ processed: index + 1, total: attachmentMessages.length });
  }

  const cases = pipedrive.cases.map(item => {
    const messages = correlated.get(String(item.dealId)) || [];
    const mailEvidence = new Set();
    let incomeBonusRequested = item.incomeBonusRequested ?? null;
    const mailSummaries = messages.map(message => {
      const attachmentFileNames = [];
      const attachmentDocuments = [];
      for (const documentId of positiveTextEvidence(message.description)) mailEvidence.add(documentId);
      const bonusEvidence = incomeBonusEvidence(message.description);
      if (bonusEvidence != null) incomeBonusRequested = bonusEvidence;
      const expectedCount = expectedAttachmentCount(message.inspection?.attachmentGrid);
      return {
        subject: extractSubject(message.description),
        matchedBy: message.matchedBy,
        hasAttachments: message.hasAttachments,
        attachmentFileNames,
        attachmentDocuments,
        expectedAttachmentCount: expectedCount,
        extractedAttachmentCount: attachmentFileNames.length,
        attachmentInspectionComplete: false,
        inspectionError: message.inspectionError || null,
      };
    });
    const currentPipedriveDocuments = item.files.map(classifyFundingDocumentName);
    const currentPipedriveEvidence = currentPipedriveDocuments
      .filter(document => document.confidence >= 0.9 && document.type !== 'unknown')
      .map(document => document.type);
    const presentDocumentIds = [...new Set(currentPipedriveEvidence)];
    const missingBaseDocumentIds = FUNDING_BASE_REQUIRED_DOCUMENTS.filter(id => !presentDocumentIds.includes(id));
    const ambiguousMailAttachments = mailSummaries.some(message => message.hasAttachments);
    return {
      ...item,
      pipedriveDocuments: currentPipedriveDocuments,
      unknownFiles: currentPipedriveDocuments.filter(document => document.type === 'unknown').map(document => document.fileName),
      incomeBonusRequested,
      mailMessageCount: messages.length,
      mailEvidenceDocumentIds: [...mailEvidence],
      presentDocumentIds,
      missingBaseDocumentIds,
      mailReviewRequired: ambiguousMailAttachments,
      messages: mailSummaries,
    };
  });
  const report = {
    version: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    source: 'outlook-funding-inbox-and-pipedrive-scan',
    readOnly: true,
    messagesScanned: messageDescriptions.length,
    attachmentMessagesInspected: attachmentMessages.length,
    summary: {
      cases: cases.length,
      casesWithMatchedMail: cases.filter(item => item.mailMessageCount > 0).length,
      casesWithMailDocumentEvidence: cases.filter(item => item.mailEvidenceDocumentIds.length > 0).length,
      casesWithMissingBaseDocuments: cases.filter(item => item.missingBaseDocumentIds.length > 0).length,
      casesRequiringMailReview: cases.filter(item => item.mailReviewRequired).length,
      casesSafeForDraft: cases.filter(item => item.missingBaseDocumentIds.length > 0 && !item.mailReviewRequired).length,
      casesCompleteByAvailableEvidence: cases.filter(item => item.missingBaseDocumentIds.length === 0).length,
    },
    cases,
  };
  const savedTo = persist ? await saveReport(report) : null;
  return { ...report, savedTo };
}
