#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { renderFundingMissingDocumentsEmail, withFundingSender } from './funding.mjs';
import { createOutlookDraft, deleteOutlookDrafts, diagnoseOutlook, normalizeDraftPayload } from './outlook.mjs';
import {
  createPipedriveFundingRequestNotes,
  diagnosePipedriveChrome,
  readPipedriveFundingDeal,
  uploadPipedriveDealFiles,
} from './chrome-pipedrive.mjs';
import { diagnoseWhatsAppMac } from './whatsapp-mac.mjs';
import { startMacHelperServer } from './server.mjs';
import { analyzeFundingPdf } from './funding-document-extractor.mjs';
import { loadFundingScan, scanPipedriveFundingBoard } from './funding-scan.mjs';
import { loadFundingMailScan, scanFundingMailbox } from './funding-mail-scan.mjs';
import {
  acknowledgeFundingMessages,
  detectNewFundingMessages,
  initializeFundingMonitor,
  loadFundingMonitorState,
  recordFundingMonitorOutcome,
} from './funding-monitor-state.mjs';
import {
  FUNDING_ROLLBACK_CONFIRMATION,
  FundingBatchService,
  createJsonFundingStateStore,
} from './funding-batches.mjs';

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
  const [command, filePath, confirmation, extra] = process.argv.slice(2);
  if (command === 'doctor') return console.log(JSON.stringify({
    outlook: await diagnoseOutlook(),
    pipedrive: await diagnosePipedriveChrome(),
    whatsapp: await diagnoseWhatsAppMac(),
  }, null, 2));
  if (command === 'serve') return startMacHelperServer();
  if (command === 'read-pipedrive-deal') return console.log(JSON.stringify(await readPipedriveFundingDeal({ dealId: filePath }), null, 2));
  if (command === 'upload-pipedrive-files') {
    if (extra !== '--commit') throw new Error('Pipedrive-Dateien wurden nicht hochgeladen. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await uploadPipedriveDealFiles({ dealId: filePath, directory: confirmation }), null, 2));
  }
  if (command === 'create-pipedrive-funding-notes') {
    if (confirmation !== '--commit') throw new Error('Pipedrive-Notizen wurden nicht erstellt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await createPipedriveFundingRequestNotes(await readJson(filePath)), null, 2));
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
  if (command === 'funding-monitor-new-mail') return console.log(JSON.stringify(await detectNewFundingMessages(), null, 2));
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

  node local-mac-helper/cli.mjs doctor
  node local-mac-helper/cli.mjs read-pipedrive-deal <deal-id>
  node local-mac-helper/cli.mjs upload-pipedrive-files <deal-id> <pdf-ordner> --commit
  node local-mac-helper/cli.mjs create-pipedrive-funding-notes /pfad/notizen.json --commit
  node local-mac-helper/cli.mjs scan-funding-board
  node local-mac-helper/cli.mjs latest-funding-scan
  node local-mac-helper/cli.mjs scan-funding-mailbox
  node local-mac-helper/cli.mjs latest-funding-mail-scan
  node local-mac-helper/cli.mjs initialize-funding-monitor --commit
  node local-mac-helper/cli.mjs funding-monitor-status
  node local-mac-helper/cli.mjs funding-monitor-new-mail
  node local-mac-helper/cli.mjs funding-monitor-ack /pfad/fingerprints.json --commit
  node local-mac-helper/cli.mjs funding-monitor-record /pfad/ergebnis.json --commit
  node local-mac-helper/cli.mjs analyze-funding-pdf /pfad/dokument.pdf
  node local-mac-helper/cli.mjs preview-funding /pfad/fall.json
  node local-mac-helper/cli.mjs create-funding-draft /pfad/fall.json --commit
  node local-mac-helper/cli.mjs preview-funding-batch /pfad/faelle.json
  node local-mac-helper/cli.mjs create-funding-batch /pfad/faelle.json --commit
  node local-mac-helper/cli.mjs rollback-funding-batch <batch-id> --confirm-rollback
  node local-mac-helper/cli.mjs rollback-last-funding-batch --confirm-rollback
  IVA_MAC_HELPER_TOKEN=<mindestens-32-zeichen> node local-mac-helper/cli.mjs serve`);
}

main().catch(error => { console.error('Fehler:', error.message); process.exitCode = 1; });
