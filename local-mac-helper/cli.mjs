#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { renderFundingMissingDocumentsEmail, withFundingSender } from './funding.mjs';
import { createOutlookDraft, createOutlookForwardDraft, deleteOutlookDrafts, diagnoseOutlook, normalizeDraftPayload, sendVerifiedOutlookPdfMessage, updateOutlookDrafts } from './outlook.mjs';
import {
  createPipedriveFundingRequestNotes,
  createPipedriveFundingInformationNote,
  diagnosePipedriveChrome,
  downloadPipedriveDealFiles,
  markPipedriveFundingDealWon,
  readPipedriveFundingDeal,
  transitionPipedriveFundingStage,
  uploadPipedriveDealFiles,
  updatePipedriveFundingRequestNotes,
} from './chrome-pipedrive.mjs';
import { diagnoseWhatsAppMac, syncDirectSalesRosterFromWhatsApp } from './whatsapp-mac.mjs';
import { loadDirectSalesRosterSync } from './direct-sales-roster.mjs';
import { startMacHelperServer } from './server.mjs';
import { analyzeFundingPdf } from './funding-document-extractor.mjs';
import { loadFundingScan, scanPipedriveFundingBoard } from './funding-scan.mjs';
import { loadFundingMailScan, scanFundingMailbox } from './funding-mail-scan.mjs';
import {
  acknowledgeFundingMessages,
  detectNewFundingMessages,
  fundingMonitorBackgroundReadiness,
  initializeFundingMonitor,
  loadFundingMonitorState,
  recordFundingMonitorOutcome,
} from './funding-monitor-state.mjs';
import { runFundingMonitorOnce } from './funding-monitor-runner.mjs';
import { listFundingReviews } from './funding-review-queue.mjs';
import { prepareFundingAttachments } from './funding-document-pipeline.mjs';
import {
  fundingMonitorLaunchAgentStatus,
  installFundingMonitorLaunchAgent,
  readFundingMonitorLogs,
  uninstallFundingMonitorLaunchAgent,
} from './funding-monitor-launchd.mjs';
import { cleanupCompletedFundingReview, fundingLocalCleanupPolicy } from './funding-local-cleanup.mjs';
import { imacDeviceAgentPolicy, provisionImacDeviceToken, publishDewarmtePdf, runImacDeviceAgentOnce } from './device-agent.mjs';
import {
  imacDeviceAgentLaunchdStatus,
  installImacDeviceAgentLaunchd,
  uninstallImacDeviceAgentLaunchd,
} from './device-agent-launchd.mjs';
import {
  FUNDING_ROLLBACK_CONFIRMATION,
  FundingBatchService,
  attachFundingDraftMarker,
  createJsonFundingStateStore,
} from './funding-batches.mjs';
import {
  buildManufacturerOperationsReport,
  classifyManufacturerLeadAddress,
  getManufacturerLeadReadiness,
  loadManufacturerLeadConfig,
  loadManufacturerLeadState,
  recordManufacturerOperation,
} from './manufacturer-lead-operations.mjs';
import {
  configureCredentialFieldInteractive,
  credentialBrokerPolicy,
  credentialBrokerStatus,
} from './credential-broker.mjs';
import { ensurePortalLogin, portalAuthPolicy } from './portal-auth.mjs';
import { completeFundingMail } from './funding-mail-completion.mjs';
import { ensureAppWindowOnRightDisplay, requireRightDisplayWorkspace } from './display-workspace.mjs';
import { beginDewarmteDelivery, finishDewarmteDelivery } from './dewarmte-delivery-state.mjs';

async function readJson(filePath) {
  if (!filePath) throw new Error('Pfad zu einer JSON-Datei fehlt.');
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function compose(input) {
  const fundingInput = withFundingSender(input);
  const rendered = renderFundingMissingDocumentsEmail(fundingInput);
  return normalizeDraftPayload({
    ...fundingInput,
    subject: rendered.subject,
    body: rendered.body,
    html: rendered.html,
    to: rendered.recipients.to,
    cc: rendered.recipients.cc,
  });
}

const stateFile = path.join(
  process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
  'state.json',
);
const batchService = new FundingBatchService({
  store: createJsonFundingStateStore(stateFile),
  renderDraft: compose,
  createDraft: createOutlookDraft,
  deleteDrafts: deleteOutlookDrafts,
});

async function main() {
  const [command, filePath, confirmation, extra, final, sixth] = process.argv.slice(2);
  if (command === 'credential-policy') return console.log(JSON.stringify({ keychain: credentialBrokerPolicy(), portalLogin: portalAuthPolicy() }, null, 2));
  if (command === 'credential-status') return console.log(JSON.stringify(await credentialBrokerStatus(filePath), null, 2));
  if (command === 'credential-setup') {
    if (extra !== '--commit') throw new Error('Der Schlüsselbund-Eintrag wurde nicht angelegt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await configureCredentialFieldInteractive(filePath, confirmation), null, 2));
  }
  if (command === 'portal-login') return console.log(JSON.stringify(await ensurePortalLogin(filePath), null, 2));
  if (command === 'manufacturer-lead-readiness') {
    const config = await loadManufacturerLeadConfig(filePath);
    return console.log(JSON.stringify(getManufacturerLeadReadiness(config), null, 2));
  }
  if (command === 'manufacturer-lead-classify') {
    if (!filePath) throw new Error('Adresse für die Gebietsprüfung fehlt.');
    const config = await loadManufacturerLeadConfig(confirmation);
    return console.log(JSON.stringify(classifyManufacturerLeadAddress(filePath, config), null, 2));
  }
  if (command === 'manufacturer-operation-record') {
    if (confirmation !== '--commit') throw new Error('Hersteller-/Wattfox-Ergebnis wurde nicht gespeichert. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await recordManufacturerOperation(await readJson(filePath)), null, 2));
  }
  if (command === 'manufacturer-operations-report') {
    const state = await loadManufacturerLeadState();
    const days = Number(confirmation || 1);
    return console.log(JSON.stringify(buildManufacturerOperationsReport(state, { endDate: filePath, days }), null, 2));
  }
  if (command === 'doctor') return console.log(JSON.stringify({
    outlook: await diagnoseOutlook(),
    pipedrive: await diagnosePipedriveChrome(),
    whatsapp: await diagnoseWhatsAppMac(),
  }, null, 2));
  if (command === 'right-display-status') return console.log(JSON.stringify(await requireRightDisplayWorkspace(), null, 2));
  if (command === 'place-app-right') return console.log(JSON.stringify(await ensureAppWindowOnRightDisplay(filePath), null, 2));
  if (command === 'publish-dewarmte-pdf') {
    const language = extra === '--commit' ? '' : extra;
    if ((language ? final : extra) !== '--commit') throw new Error('Die PDF wurde nicht in die DeWarmte-Projektakte hochgeladen. Sprache de|en|nl und --commit anhängen.');
    return console.log(JSON.stringify(await publishDewarmtePdf({ filePath, jobId: confirmation, language }), null, 2));
  }
  if (command === 'revise-dewarmte-pdf') {
    const language = extra === '--commit' ? '' : extra;
    if ((language ? final : extra) !== '--commit') throw new Error('Die neue PDF-Fassung wurde nicht in die DeWarmte-Projektakte hochgeladen. Sprache de|en|nl und --commit anhängen.');
    return console.log(JSON.stringify(await publishDewarmtePdf({ filePath, jobId: confirmation, language, revision: true }), null, 2));
  }
  if (command === 'deliver-dewarmte-pdf-set') {
    if (sixth !== '--commit') throw new Error('Die DeWarmte-Mail wurde nicht erstellt oder versandt. Zum Bestätigen --commit anhängen.');
    const deliveryMode = String(confirmation || 'download');
    if (!['download', 'email-draft', 'email-send'].includes(deliveryMode)) throw new Error('Unbekannte DeWarmte-Ausgabeart.');
    if (deliveryMode === 'download') return console.log(JSON.stringify({ delivered: false, downloadOnly: true }, null, 2));
    const recipientEmail = String(extra || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) throw new Error('Für die DeWarmte-Mail fehlt eine gültige Empfängeradresse.');
    const directory = path.resolve(filePath);
    const names = (await readdir(directory)).filter(name => /_(?:DE|EN|NL)\.pdf$/i.test(name)).sort();
    const byLanguage = language => names.find(name => new RegExp(`_${language}\\.pdf$`, 'i').test(name));
    if (!['DE', 'EN', 'NL'].every(byLanguage) || names.length !== 3) throw new Error('Im Ausgabeordner müssen genau drei DeWarmte-PDFs mit den Endungen _DE, _EN und _NL liegen.');
    const attachments = ['DE', 'EN', 'NL'].map(language => path.join(directory, byLanguage(language)));
    const jobId = String(final || '').trim();
    const subject = 'DeWarmte Materiallisten - Deutsch, English, Nederlands';
    const mail = { from: 'n.sell@heat-hero.com', to: [recipientEmail], cc: [], bcc: [], subject,
      body: 'Hallo,\n\nanbei erhalten Sie die aus dem bereitgestellten Installationsplan erstellte Materialliste auf Deutsch, Englisch und Niederländisch.\n\nViele Grüße\nNadine Sell', attachments };
    await beginDewarmteDelivery({ jobId, deliveryMode, recipientEmail, fileName: attachments.join(';') });
    try {
      const result = deliveryMode === 'email-draft' ? await createOutlookDraft(mail) : await sendVerifiedOutlookPdfMessage(mail);
      const status = deliveryMode === 'email-draft' ? 'draft-created' : result.sentFolderVerified ? 'sent-verified' : 'sent-unverified';
      await finishDewarmteDelivery(jobId, { status, detail: result.sentFolderVerificationError || result.subject || subject });
      if (deliveryMode === 'email-send' && result.sentFolderVerified !== true) {
        const verificationError = new Error('Outlook hat den Versand angestoßen, aber die Nachricht konnte nicht eindeutig im Gesendet-Ordner bestätigt werden. Niemals erneut senden; ausschließlich den Gesendet-Ordner prüfen.');
        verificationError.deliveryRecorded = true;
        throw verificationError;
      }
      return console.log(JSON.stringify({ deliveryMode, attachmentCount: attachments.length, ...result }, null, 2));
    } catch (error) {
      if (!error?.deliveryRecorded) await finishDewarmteDelivery(jobId, { status: 'failed-or-unclear', detail: error.message }).catch(() => {});
      throw error;
    }
  }
  if (command === 'deliver-dewarmte-pdf') {
    if (sixth !== '--commit') throw new Error('Die DeWarmte-Mail wurde nicht erstellt oder versandt. Zum Bestätigen --commit anhängen.');
    const deliveryMode = String(confirmation || 'download');
    if (!['download', 'email-draft', 'email-send'].includes(deliveryMode)) throw new Error('Unbekannte DeWarmte-Ausgabeart.');
    if (deliveryMode === 'download') return console.log(JSON.stringify({ delivered: false, downloadOnly: true }, null, 2));
    const recipientEmail = String(extra || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) throw new Error('Für die DeWarmte-Mail fehlt eine gültige Empfängeradresse.');
    const jobId = String(final || '').trim();
    const subject = `DeWarmte Materialliste - ${path.basename(filePath, path.extname(filePath)).replace(/^DeWarmte[_ -]*/i, '').replace(/[_-]+/g, ' ')}`.slice(0, 240);
    const mail = {
      from: 'n.sell@heat-hero.com', to: [recipientEmail], cc: [], bcc: [], subject,
      body: 'Hallo,\n\nanbei erhalten Sie die aus dem bereitgestellten Installationsplan erstellte Materialliste als PDF.\n\nViele Grüße\nNadine Sell',
      attachments: [path.resolve(filePath)],
    };
    await beginDewarmteDelivery({ jobId, deliveryMode, recipientEmail, fileName: filePath });
    try {
      const result = deliveryMode === 'email-draft' ? await createOutlookDraft(mail) : await sendVerifiedOutlookPdfMessage(mail);
      const status = deliveryMode === 'email-draft' ? 'draft-created' : result.sentFolderVerified ? 'sent-verified' : 'sent-unverified';
      await finishDewarmteDelivery(jobId, { status, detail: result.sentFolderVerificationError || result.subject || subject });
      if (deliveryMode === 'email-send' && result.sentFolderVerified !== true) {
        const verificationError = new Error('Outlook hat den Versand angestoßen, aber die Nachricht konnte nicht eindeutig im Gesendet-Ordner bestätigt werden. Niemals erneut senden; ausschließlich den Gesendet-Ordner prüfen.');
        verificationError.deliveryRecorded = true;
        throw verificationError;
      }
      return console.log(JSON.stringify({ deliveryMode, ...result }, null, 2));
    } catch (error) {
      if (!error?.deliveryRecorded) await finishDewarmteDelivery(jobId, { status: 'failed-or-unclear', detail: error.message }).catch(() => {});
      throw error;
    }
  }
  if (command === 'direct-sales-roster-status') return console.log(JSON.stringify(loadDirectSalesRosterSync(), null, 2));
  if (command === 'sync-direct-sales-roster') {
    if (filePath !== '--commit') throw new Error('Der Direktvertriebs-Abgleich wurde nicht gespeichert. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await syncDirectSalesRosterFromWhatsApp({ persist: true }), null, 2));
  }
  if (command === 'serve') return startMacHelperServer();
  if (command === 'read-pipedrive-deal') return console.log(JSON.stringify(await readPipedriveFundingDeal({ dealId: filePath }), null, 2));
  if (command === 'download-pipedrive-files') {
    const fileIds = String(confirmation || '').split(',').map(value => value.trim()).filter(Boolean);
    return console.log(JSON.stringify(await downloadPipedriveDealFiles({ dealId: filePath, fileIds }), null, 2));
  }
  if (command === 'upload-pipedrive-files') {
    if (extra !== '--commit') throw new Error('Pipedrive-Dateien wurden nicht hochgeladen. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await uploadPipedriveDealFiles({ dealId: filePath, directory: confirmation }), null, 2));
  }
  if (command === 'transition-pipedrive-funding-stage') {
    if (final !== '--commit') throw new Error('Pipedrive-Phase wurde nicht geändert. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await transitionPipedriveFundingStage({
      dealId: filePath,
      fromStage: confirmation,
      toStage: extra,
      confirmApply: true,
    }), null, 2));
  }
  if (command === 'mark-pipedrive-funding-won') {
    if (extra !== '--commit') throw new Error('Der Deal wurde nicht auf „Gewonnen“ gesetzt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await markPipedriveFundingDealWon({
      dealId: filePath,
      approvalFileName: confirmation,
      confirmApply: true,
    }), null, 2));
  }
  if (command === 'complete-funding-mail') {
    if (confirmation !== '--commit') throw new Error('Die Fördermail wurde nicht verschoben. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await completeFundingMail(await readJson(filePath)), null, 2));
  }
  if (command === 'create-funding-escalation-forward') {
    if (confirmation !== '--commit') throw new Error('Der interne Weiterleitungsentwurf wurde nicht erstellt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await createOutlookForwardDraft(await readJson(filePath)), null, 2));
  }
  if (command === 'create-pipedrive-funding-notes') {
    if (confirmation !== '--commit') throw new Error('Pipedrive-Notizen wurden nicht erstellt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await createPipedriveFundingRequestNotes(await readJson(filePath)), null, 2));
  }
  if (command === 'create-pipedrive-funding-info-note') {
    if (confirmation !== '--commit') throw new Error('Die Pipedrive-Information wurde nicht erstellt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await createPipedriveFundingInformationNote(await readJson(filePath)), null, 2));
  }
  if (command === 'update-pipedrive-funding-notes') {
    if (confirmation !== '--commit') throw new Error('Pipedrive-Notizen wurden nicht aktualisiert. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await updatePipedriveFundingRequestNotes(await readJson(filePath)), null, 2));
  }
  if (command === 'scan-funding-board') {
    const report = await scanPipedriveFundingBoard({
      onProgress: ({ processed, total }) => console.error(`Förderprüfung: ${processed}/${total} Fälle gelesen`),
    });
    return console.log(JSON.stringify(report, null, 2));
  }
  if (command === 'latest-funding-scan') return console.log(JSON.stringify(await loadFundingScan(), null, 2));
  if (command === 'scan-funding-mailbox') {
    const report = await scanFundingMailbox({
      onProgress: ({ processed, total }) => console.error(`Förderpostfach: ${processed}/${total} Nachrichten mit Anlagen zur lokalen Dokumentprüfung markiert`),
    });
    return console.log(JSON.stringify(report, null, 2));
  }
  if (command === 'latest-funding-mail-scan') return console.log(JSON.stringify(await loadFundingMailScan(), null, 2));
  if (command === 'initialize-funding-monitor') {
    if (filePath !== '--commit') throw new Error('Der Fördermonitor wurde nicht initialisiert. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await initializeFundingMonitor(), null, 2));
  }
  if (command === 'funding-monitor-status') return console.log(JSON.stringify(await loadFundingMonitorState(), null, 2));
  if (command === 'funding-monitor-background-readiness') return console.log(JSON.stringify(await fundingMonitorBackgroundReadiness(), null, 2));
  if (command === 'funding-monitor-new-mail') return console.log(JSON.stringify(await detectNewFundingMessages(), null, 2));
  if (command === 'run-funding-monitor-once') {
    return console.log(JSON.stringify(await runFundingMonitorOnce({ ignoreIdle: filePath === '--ignore-idle' }), null, 2));
  }
  if (command === 'list-funding-reviews') return console.log(JSON.stringify(await listFundingReviews(), null, 2));
  if (command === 'funding-monitor-launchd-status') return console.log(JSON.stringify(await fundingMonitorLaunchAgentStatus(), null, 2));
  if (command === 'funding-monitor-logs') return console.log(JSON.stringify(await readFundingMonitorLogs(), null, 2));
  if (command === 'funding-cleanup-policy') return console.log(JSON.stringify(fundingLocalCleanupPolicy(), null, 2));
  if (command === 'imac-device-agent-policy') return console.log(JSON.stringify(imacDeviceAgentPolicy(), null, 2));
  if (command === 'imac-device-agent-status') return console.log(JSON.stringify(await imacDeviceAgentLaunchdStatus(), null, 2));
  if (command === 'run-imac-device-agent-once') return console.log(JSON.stringify(await runImacDeviceAgentOnce(), null, 2));
  if (command === 'provision-imac-device-token') {
    if (filePath !== '--commit') throw new Error('Das iMac-Gerätetoken wurde nicht angelegt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await provisionImacDeviceToken(), null, 2));
  }
  if (command === 'install-imac-device-agent') {
    if (filePath !== '--commit') throw new Error('Der iMac-Geräteagent wurde nicht installiert. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await installImacDeviceAgentLaunchd(), null, 2));
  }
  if (command === 'uninstall-imac-device-agent') {
    if (filePath !== '--commit') throw new Error('Der iMac-Geräteagent wurde nicht entfernt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await uninstallImacDeviceAgentLaunchd(), null, 2));
  }
  if (command === 'cleanup-funding-review') {
    if (confirmation !== '--commit') throw new Error('Lokale Förderdateien wurden nicht gelöscht. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await cleanupCompletedFundingReview(filePath), null, 2));
  }
  if (command === 'install-funding-monitor') {
    if (filePath !== '--commit') throw new Error('Der iMac-Fördermonitor wurde nicht installiert. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await installFundingMonitorLaunchAgent({ startNow: true }), null, 2));
  }
  if (command === 'uninstall-funding-monitor') {
    if (filePath !== '--commit') throw new Error('Der iMac-Fördermonitor wurde nicht entfernt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await uninstallFundingMonitorLaunchAgent(), null, 2));
  }
  if (command === 'prepare-funding-attachments') {
    if (!filePath) throw new Error('Eingangsordner für Förderanlagen fehlt.');
    return console.log(JSON.stringify(await prepareFundingAttachments({ inputDirectory: filePath, outputDirectory: confirmation }), null, 2));
  }
  if (command === 'funding-monitor-ack') {
    if (confirmation !== '--commit') throw new Error('Neue Nachrichten wurden nicht als verarbeitet markiert. Zum Bestätigen --commit anhängen.');
    const input = await readJson(filePath);
    return console.log(JSON.stringify(await acknowledgeFundingMessages(input.fingerprints || input), null, 2));
  }
  if (command === 'funding-monitor-record') {
    if (confirmation !== '--commit') throw new Error('Das Monitor-Ergebnis wurde nicht gespeichert. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await recordFundingMonitorOutcome(await readJson(filePath)), null, 2));
  }
  if (command === 'analyze-funding-pdf') return console.log(JSON.stringify(await analyzeFundingPdf(filePath), null, 2));
  if (command === 'preview-funding') return console.log(JSON.stringify(compose(await readJson(filePath)), null, 2));
  if (command === 'create-funding-draft') {
    if (confirmation !== '--commit') throw new Error('Entwurf wurde nicht erstellt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await batchService.create([await readJson(filePath)]), null, 2));
  }
  if (command === 'update-funding-drafts') {
    if (confirmation !== '--commit') throw new Error('Outlook-Entwürfe wurden nicht aktualisiert. Zum Bestätigen --commit anhängen.');
    const input = await readJson(filePath);
    const cases = Array.isArray(input?.cases) ? input.cases : [];
    if (!cases.length || cases.length > 100) throw new Error('Für die Entwurfsaktualisierung werden 1 bis 100 Fälle benötigt.');
    const subjects = new Set();
    const drafts = [];
    for (const item of cases) {
      const marker = String(item?.marker || '').trim();
      const draft = attachFundingDraftMarker(compose(item), marker);
      if (subjects.has(draft.subject)) throw new Error(`Entwurfsaktualisierung abgebrochen: Betreff „${draft.subject}“ ist nicht eindeutig.`);
      subjects.add(draft.subject);
      drafts.push(draft);
    }
    const result = await updateOutlookDrafts(drafts, {
      onProgress: ({ processed, total, subject }) => console.error(`Outlook-Entwürfe: ${processed}/${total} aktualisiert – ${subject}`),
    });
    return console.log(JSON.stringify(result, null, 2));
  }
  if (command === 'preview-funding-batch') {
    const input = await readJson(filePath);
    return console.log(JSON.stringify(batchService.preview(input.cases || input), null, 2));
  }
  if (command === 'create-funding-batch') {
    if (confirmation !== '--commit') throw new Error('Prüflauf wurde nicht erstellt. Zum Bestätigen --commit anhängen.');
    const input = await readJson(filePath);
    return console.log(JSON.stringify(await batchService.create(input.cases || input), null, 2));
  }
  if (command === 'rollback-funding-batch') {
    if (confirmation !== '--confirm-rollback') throw new Error('Rückgängig wurde nicht ausgeführt. Zum Bestätigen --confirm-rollback anhängen.');
    return console.log(JSON.stringify(await batchService.rollback(filePath, FUNDING_ROLLBACK_CONFIRMATION), null, 2));
  }
  if (command === 'rollback-last-funding-batch') {
    if (filePath !== '--confirm-rollback') throw new Error('Rückgängig wurde nicht ausgeführt. Zum Bestätigen --confirm-rollback anhängen.');
    return console.log(JSON.stringify(await batchService.rollback('last', FUNDING_ROLLBACK_CONFIRMATION), null, 2));
  }
  console.log(`IVA Mac Helper

  node local-mac-helper/cli.mjs credential-policy
  node local-mac-helper/cli.mjs credential-status [panasonic|bosch|pipedrive|airtable|planbar]
  node local-mac-helper/cli.mjs credential-setup <portal> <username|password|totp> --commit
  node local-mac-helper/cli.mjs portal-login <panasonic|bosch|pipedrive|airtable|planbar>
  node local-mac-helper/cli.mjs manufacturer-lead-readiness [konfiguration.json]
  node local-mac-helper/cli.mjs manufacturer-lead-classify "Adresse" [konfiguration.json]
  node local-mac-helper/cli.mjs manufacturer-operation-record /pfad/ergebnis.json --commit
  node local-mac-helper/cli.mjs manufacturer-operations-report [JJJJ-MM-TT] [tage]
  node local-mac-helper/cli.mjs doctor
  node local-mac-helper/cli.mjs right-display-status
  node local-mac-helper/cli.mjs place-app-right <bundle-id>
  node local-mac-helper/cli.mjs publish-dewarmte-pdf <pdf-pfad> <job-id> <de|en|nl> --commit
  node local-mac-helper/cli.mjs revise-dewarmte-pdf <pdf-pfad> <job-id> <de|en|nl> --commit
  node local-mac-helper/cli.mjs deliver-dewarmte-pdf-set <pdf-ordner> <email-draft|email-send> <empfaenger> <job-id> --commit
  node local-mac-helper/cli.mjs deliver-dewarmte-pdf <pdf-pfad> <email-draft|email-send> <empfaenger> <job-id> --commit
  node local-mac-helper/cli.mjs direct-sales-roster-status
  node local-mac-helper/cli.mjs sync-direct-sales-roster --commit
  node local-mac-helper/cli.mjs read-pipedrive-deal <deal-id>
  node local-mac-helper/cli.mjs download-pipedrive-files <deal-id> [datei-id,datei-id]
  node local-mac-helper/cli.mjs upload-pipedrive-files <deal-id> <pdf-ordner> --commit
  node local-mac-helper/cli.mjs transition-pipedrive-funding-stage <deal-id> <von-phase> <nach-phase> --commit
  node local-mac-helper/cli.mjs mark-pipedrive-funding-won <deal-id> <zusagedateiname.pdf> --commit
  node local-mac-helper/cli.mjs complete-funding-mail /pfad/abschluss.json --commit
  node local-mac-helper/cli.mjs create-funding-escalation-forward /pfad/weiterleitung.json --commit
  node local-mac-helper/cli.mjs create-pipedrive-funding-notes /pfad/notizen.json --commit
  node local-mac-helper/cli.mjs create-pipedrive-funding-info-note /pfad/notiz.json --commit
  node local-mac-helper/cli.mjs update-pipedrive-funding-notes /pfad/notizen.json --commit
  node local-mac-helper/cli.mjs scan-funding-board
  node local-mac-helper/cli.mjs latest-funding-scan
  node local-mac-helper/cli.mjs scan-funding-mailbox
  node local-mac-helper/cli.mjs latest-funding-mail-scan
  node local-mac-helper/cli.mjs initialize-funding-monitor --commit
  node local-mac-helper/cli.mjs funding-monitor-status
  node local-mac-helper/cli.mjs funding-monitor-background-readiness
  node local-mac-helper/cli.mjs funding-monitor-new-mail
  node local-mac-helper/cli.mjs run-funding-monitor-once [--ignore-idle]
  node local-mac-helper/cli.mjs list-funding-reviews
  node local-mac-helper/cli.mjs funding-monitor-launchd-status
  node local-mac-helper/cli.mjs funding-monitor-logs
  node local-mac-helper/cli.mjs funding-cleanup-policy
  node local-mac-helper/cli.mjs imac-device-agent-policy
  node local-mac-helper/cli.mjs imac-device-agent-status
  node local-mac-helper/cli.mjs run-imac-device-agent-once
  node local-mac-helper/cli.mjs provision-imac-device-token --commit
  node local-mac-helper/cli.mjs install-imac-device-agent --commit
  node local-mac-helper/cli.mjs uninstall-imac-device-agent --commit
  node local-mac-helper/cli.mjs cleanup-funding-review <nachrichten-fingerprint> --commit
  node local-mac-helper/cli.mjs install-funding-monitor --commit
  node local-mac-helper/cli.mjs uninstall-funding-monitor --commit
  node local-mac-helper/cli.mjs prepare-funding-attachments <eingangsordner> [ausgabeordner]
  node local-mac-helper/cli.mjs funding-monitor-ack /pfad/fingerprints.json --commit
  node local-mac-helper/cli.mjs funding-monitor-record /pfad/ergebnis.json --commit
  node local-mac-helper/cli.mjs analyze-funding-pdf /pfad/dokument.pdf
  node local-mac-helper/cli.mjs preview-funding /pfad/fall.json
  node local-mac-helper/cli.mjs create-funding-draft /pfad/fall.json --commit
  node local-mac-helper/cli.mjs update-funding-drafts /pfad/faelle.json --commit
  node local-mac-helper/cli.mjs preview-funding-batch /pfad/faelle.json
  node local-mac-helper/cli.mjs create-funding-batch /pfad/faelle.json --commit
  node local-mac-helper/cli.mjs rollback-funding-batch <batch-id> --confirm-rollback
  node local-mac-helper/cli.mjs rollback-last-funding-batch --confirm-rollback
  IVA_MAC_HELPER_TOKEN=<mindestens-32-zeichen> node local-mac-helper/cli.mjs serve`);
}

main().catch(error => { console.error('Fehler:', error.message); process.exitCode = 1; });
