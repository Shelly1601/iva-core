#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { renderFundingMissingDocumentsEmail, withFundingSender } from './funding.mjs';
import { createOutlookDraft, diagnoseOutlook, normalizeDraftPayload } from './outlook.mjs';
import { startMacHelperServer } from './server.mjs';

async function readJson(filePath) {
  if (!filePath) throw new Error('Pfad zu einer JSON-Datei fehlt.');
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function compose(input) {
  const fundingInput = withFundingSender(input);
  const rendered = renderFundingMissingDocumentsEmail(fundingInput);
  return normalizeDraftPayload({ ...fundingInput, subject: rendered.subject, body: rendered.body, html: rendered.html });
}

async function main() {
  const [command, filePath, confirmation] = process.argv.slice(2);
  if (command === 'doctor') return console.log(JSON.stringify(await diagnoseOutlook(), null, 2));
  if (command === 'serve') return startMacHelperServer();
  if (command === 'preview-funding') return console.log(JSON.stringify(compose(await readJson(filePath)), null, 2));
  if (command === 'create-funding-draft') {
    if (confirmation !== '--commit') throw new Error('Entwurf wurde nicht erstellt. Zum Bestätigen --commit anhängen.');
    return console.log(JSON.stringify(await createOutlookDraft(compose(await readJson(filePath))), null, 2));
  }
  console.log(`IVA Mac Helper

  node local-mac-helper/cli.mjs doctor
  node local-mac-helper/cli.mjs preview-funding /pfad/fall.json
  node local-mac-helper/cli.mjs create-funding-draft /pfad/fall.json --commit
  IVA_MAC_HELPER_TOKEN=<mindestens-32-zeichen> node local-mac-helper/cli.mjs serve`);
}

main().catch(error => { console.error('Fehler:', error.message); process.exitCode = 1; });
