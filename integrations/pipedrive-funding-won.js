import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFundingFileLock } from '../local-mac-helper/funding-intake-state.mjs';

// Official API v2 fields: label_ids and status, verified 2026-09-15.
// https://developers.pipedrive.com/docs/api/v1/Deals#updateDeal
const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const idOf = value => String(value?.value ?? value?.id ?? value ?? '');
const fault = (code, message) => Object.assign(new Error(message), { code });
export function missingFundingRequiredFields(snapshot = {}) {
  return [['customerEmail', 'E-Mail'], ['phoneNumber', 'Telefonnummer'], ['plant', 'Anlage'], ['orderNumber', 'Auftragsnummer']]
    .filter(([key]) => !String(snapshot[key] ?? '').trim()).map(([, label]) => label);
}

const labels = deal => {
  if (deal.label_ids === null) return [];
  if (!Array.isArray(deal.label_ids) || deal.label_ids.some(value => !Number.isSafeInteger(Number(value)) || Number(value) < 1)) throw fault('FUNDING_LABELS_UNREAD', 'Die Deal-Labels sind noch nicht eindeutig rückgelesen.');
  return [...new Set(deal.label_ids.map(Number))].sort((a, b) => a - b);
};

export async function completePipedriveFundingWon(input, { request, readSnapshot, missingFields = missingFundingRequiredFields, dataDir = process.env.DATA_DIR || '/data', wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const id = String(input.dealId || '').trim(), filename = path.basename(String(input.approvalFileName || input.approvalEvidence?.filename || '').trim());
  if (!/^\d+$/.test(id) || !/\.pdf$/i.test(filename) || !/(?:kfw.{0,40}zusage|zusage.{0,40}kfw|zuschuss.{0,20}(?:zusage|bescheid))/i.test(filename)) throw fault('FUNDING_APPROVAL_REQUIRED', 'Für Gewonnen fehlt der eindeutig bezeichnete KfW-Zusagebeleg.');
  const file = path.join(path.resolve(dataDir), 'funding-won', `${id}.json`);
  return withFundingFileLock(file, async () => {
    let receipt = null;
    try { const metadata = await fs.lstat(file); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 100000) throw fault('FUNDING_RECEIPT_INVALID', 'Der Förderabschluss-Beleg ist nicht sicher lesbar.'); receipt = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const save = async () => {
      receipt.updatedAt = new Date(now()).toISOString();
      const temporary = `${file}.${randomUUID()}.tmp`, handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(receipt, null, 2)); await handle.sync(); } finally { await handle.close(); }
      try { await fs.rename(temporary, file); } finally { await fs.unlink(temporary).catch(() => {}); }
    };
    const source = await readSnapshot(id);
    const current = (await request(`/api/v2/deals/${id}`)).data || {};
    if (String(current.id) !== id || source.dealId !== id) throw fault('FUNDING_SOURCE_MISMATCH', 'Der gelesene Quell-Deal stimmt nicht mit dem Auftrag überein.');
    const personId = idOf(current.person_id), orderNumber = String(source.orderNumber || '').trim();
    if (!/^\d+$/.test(personId) || personId !== String(source.customerPersonId || '') || !orderNumber) throw fault('FUNDING_IDENTITY_UNCLEAR', 'Person und Auftragsnummer sind für die Montageübergabe nicht eindeutig.');
    if (receipt && (receipt.dealId !== id || receipt.customerPersonId !== personId || receipt.orderNumber !== orderNumber || receipt.approvalFileName !== filename)) throw fault('FUNDING_RECEIPT_MISMATCH', 'Der vorhandene Förderabschluss-Beleg gehört zu einem anderen Auftrag.');
    if (!receipt) {
      const proof = input.approvalEvidence;
      if (!proof || String(proof.dealId) !== id || proof.filename !== filename || proof.officialApproval !== true || proof.identityVerified !== true || proof.readable !== true
        || !Number.isFinite(Date.parse(proof.checkedAt)) || Date.parse(proof.checkedAt) > now() + 60000
        || !(source.fileRecords || []).some(item => item.id === String(proof.fileId) && path.basename(item.name) === filename)) throw fault('FUNDING_APPROVAL_UNVERIFIED', 'Die offizielle KfW-Zusage muss inhaltlich im richtigen Deal und anhand ihrer Datei-ID verifiziert sein.');
      receipt = { version: 1, dealId: id, customerPersonId: personId, orderNumber, approvalFileName: filename, approvalFileId: String(proof.fileId), approvalCheckedAt: proof.checkedAt,
        labelsVerified: false, wonVerified: false, targetVerified: false, status: 'pending', createdAt: new Date(now()).toISOString() };
      await save();
    }
    let mutated = false;
    const output = () => ({ dealId: id, approvalFileName: filename, approvalFileId: receipt.approvalFileId, changed: mutated, mutated,
      alreadyPresent: normalize(current.status) === 'won', verified: receipt.status === 'completed', fullyVerified: receipt.status === 'completed', pending: receipt.status !== 'completed',
      status: receipt.wonVerified ? 'won' : normalize(current.status), labelsVerified: receipt.labelsVerified, statusVerified: receipt.wonVerified,
      followUpStageVerified: receipt.targetVerified, labelsRemoved: receipt.labelsVerified, requiredFieldsVerified: receipt.targetVerified && receipt.sourceFieldsVerified === true, targetDealId: receipt.targetDealId || null, targetMissingFields: receipt.targetMissingFields || [],
      remainingActions: receipt.remainingActions || [], errorCode: receipt.errorCode || null, receiptFile: path.basename(file),
      deletedFromPipedrive: false, source: 'iva-core-pipedrive-api' });
    try {
      if (Number(current.pipeline_id) !== 1 || Number(current.stage_id) !== 18 || normalize(source.stage) !== 'förderung beantragen') throw fault('FUNDING_SOURCE_STAGE_CHANGED', 'Der Quell-Deal steht nicht mehr in der verifizierten Förderphase 18. Zielzustand prüfen, nicht erneut abschließen.');
      const missing = missingFields(source);
      if (missing.length) { receipt.remainingActions = missing.map(field => `Quell-Deal: ${field}`); throw fault('FUNDING_SOURCE_FIELDS_MISSING', 'Der Quell-Deal besitzt noch unvollständige Montage-Pflichtfelder.'); }
      receipt.sourceFieldsVerified = true;
      if (!(source.fileRecords || []).some(item => item.id === receipt.approvalFileId && path.basename(item.name) === filename)) throw fault('FUNDING_APPROVAL_CHANGED', 'Die zuvor geprüfte KfW-Datei ist im Quell-Deal nicht mehr eindeutig vorhanden.');
      const currentLabels = labels(current);
      if (currentLabels.length) {
        if (receipt.labelsAttemptedAt || receipt.labelsVerified) throw fault('FUNDING_LABELS_PENDING', 'Der Labelzustand hat sich seit dem Bearbeitungsversuch verändert; zunächst gezielt rücklesen.');
        receipt.originalLabelIds = currentLabels; receipt.labelsAttemptedAt = new Date(now()).toISOString(); await save();
        await request(`/api/v2/deals/${id}`, { method: 'PATCH', body: { label_ids: [] }, write: true }); mutated = true;
      }
      let after = (await request(`/api/v2/deals/${id}`)).data || {};
      if (String(after.id) !== id || idOf(after.person_id) !== personId || labels(after).length) throw fault('FUNDING_LABELS_PENDING', 'Die entfernten Labels wurden am richtigen Deal noch nicht rückgelesen.');
      receipt.labelsVerified = true; await save();
      const freshSource = await readSnapshot(id);
      const freshMissing = missingFields(freshSource);
      if (String(freshSource.dealId) !== id || String(freshSource.customerPersonId) !== personId || String(freshSource.orderNumber || '').trim() !== orderNumber
        || normalize(freshSource.stage) !== 'förderung beantragen' || freshMissing.length) {
        receipt.sourceFieldsVerified = false;
        if (freshMissing.length) receipt.remainingActions = freshMissing.map(field => `Quell-Deal: ${field}`);
        throw fault('FUNDING_SOURCE_CHANGED', 'Auftrag, Person oder Pflichtfelder des Quell-Deals haben sich geändert; vor Gewonnen neu prüfen.');
      }
      if (normalize(after.status) !== 'won') {
        if (normalize(after.status) !== 'open' || Number(after.stage_id) !== 18 || Number(after.pipeline_id) !== 1 || receipt.wonAttemptedAt) throw fault('FUNDING_WON_PENDING', 'Der Gewonnen-Ausgang ist offen oder der Quell-Deal wurde verändert. Kein erneutes Setzen auf Verdacht.');
        receipt.wonAttemptedAt = new Date(now()).toISOString(); await save();
        await request(`/api/v2/deals/${id}`, { method: 'PATCH', body: { status: 'won' }, write: true }); mutated = true;
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await wait(1000);
        after = (await request(`/api/v2/deals/${id}`)).data || {};
        if (String(after.id) === id && normalize(after.status) === 'won') break;
      }
      if (String(after.id) !== id || normalize(after.status) !== 'won') throw fault('FUNDING_WON_PENDING', 'Der Gewonnen-Status ist noch nicht bestätigt.');
      if (idOf(after.person_id) !== personId || labels(after).length) { receipt.labelsVerified = false; throw fault('FUNDING_SOURCE_CHANGED', 'Person oder Labels des Quell-Deals haben sich während des Abschlusses geändert; gezielt rücklesen.'); }
      receipt.wonVerified = true; receipt.wonVerifiedAt = new Date(now()).toISOString(); await save();
      let matches = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await wait(1000);
        const candidates = await request(`/api/v2/deals?pipeline_id=2&stage_id=8&person_id=${encodeURIComponent(personId)}&status=open&limit=100`);
        if (candidates.additionalData?.next_cursor || !Array.isArray(candidates.data) || candidates.data.length > 30) throw fault('FUNDING_TARGET_AMBIGUOUS', 'Die Montage-Zieldeals konnten nicht vollständig und eindeutig eingegrenzt werden.');
        matches = [];
        for (const candidate of candidates.data) {
          if (!/^\d+$/.test(String(candidate.id)) || String(candidate.id) === id || idOf(candidate.person_id) !== personId || Number(candidate.pipeline_id) !== 2 || Number(candidate.stage_id) !== 8 || normalize(candidate.status) !== 'open') continue;
          const target = await readSnapshot(String(candidate.id));
          if (String(target.customerPersonId) === personId && normalize(target.orderNumber) === normalize(orderNumber) && normalize(target.stage) === 'montage einplanen') matches.push(target);
        }
        if (matches.length) break;
      }
      if (matches.length !== 1 || receipt.targetDealId && receipt.targetDealId !== matches[0].dealId) throw fault('FUNDING_TARGET_AMBIGUOUS', 'Der offene Montage-Zieldeal fehlt oder ist nicht eindeutig. Gewonnen wird nicht wiederholt.');
      receipt.targetDealId = matches[0].dealId;
      const freshTarget = await readSnapshot(receipt.targetDealId);
      if (String(freshTarget.customerPersonId) !== personId || normalize(freshTarget.orderNumber) !== normalize(orderNumber) || normalize(freshTarget.stage) !== 'montage einplanen') throw fault('FUNDING_TARGET_CHANGED', 'Der Montage-Zieldeal wurde während der Prüfung verändert.');
      receipt.targetMissingFields = missingFields(freshTarget);
      if (receipt.targetMissingFields.length) { receipt.remainingActions = receipt.targetMissingFields.map(field => `Montage-Zieldeal ${receipt.targetDealId}: ${field} ergänzen und rücklesen`); throw fault('FUNDING_TARGET_FIELDS_MISSING', 'Der Montage-Zieldeal muss aus den vorhandenen Primärbelegen vervollständigt werden.'); }
      receipt.targetVerified = true; receipt.targetVerifiedAt = new Date(now()).toISOString(); receipt.status = 'completed'; receipt.remainingActions = []; receipt.errorCode = null;
    } catch (error) {
      receipt.status = 'pending'; receipt.errorCode = /^FUNDING_[A-Z_]+$/.test(error.code || '') ? error.code : 'FUNDING_TECHNICAL_RECHECK';
      if (!receipt.remainingActions?.length) receipt.remainingActions = ['Gespeicherten Quell- und Zielzustand gezielt rücklesen; keine erneute Gewonnen-Aktion auf Verdacht.'];
    }
    await save(); return output();
  });
}
