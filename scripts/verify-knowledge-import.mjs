import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-knowledge-import-test-'));
process.env.DATA_DIR = path.join(root, 'server-data');
process.env.IVA_MAC_HELPER_DATA_DIR = path.join(root, 'imac-data');

try {
  const imports = await import(`../knowledge/imports.js?test=${Date.now()}`);
  const job = await imports.createKnowledgeImport({
    entryId: crypto.randomUUID(),
    title: 'Vertriebscoaching',
    category: 'Vertrieb',
    sourceUrl: 'https://www.skool.com/beispiel/about#start',
    mode: 'iva-drive',
  });
  assert.equal(job.mode, 'iva-drive');
  assert.equal(job.sourceUrl, 'https://www.skool.com/beispiel/about');
  assert.match(job.credentialProfileId, /^course-[a-f0-9]{18}$/);
  assert.match(job.archiveFolderUrl, /drive\.google\.com\/drive\/folders\/1cVB6/);
  assert.equal(imports.knowledgeImportPolicy().serverStoresPlaintextCredentials, false);
  const dispatched = await imports.markKnowledgeImportDispatched(job.id, crypto.randomUUID());
  assert.equal(dispatched.progress, 5);
  const running = imports.mergeKnowledgeImportStatus(dispatched, { run: {
    status: 'running', phase: 'Lektionen', progress: 47, detail: '9 von 19 Lektionen geprüft', jobId: crypto.randomUUID(), updatedAt: new Date().toISOString(),
  } });
  assert.equal(running.progress, 47);
  assert.equal(running.active, true);
  const blocked = imports.mergeKnowledgeImportStatus(dispatched, { command: {
    status: 'failed', error: 'Externe Bestätigung erforderlich: captcha',
  } });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.actionRequired, true);
  const recovering = imports.mergeKnowledgeImportStatus(dispatched, { command: {
    status: 'queued', retryAt: new Date(Date.now() + 10_000).toISOString(),
  } });
  assert.equal(recovering.status, 'recovering');

  const envelopeModule = await import(`../local-mac-helper/secret-envelope.mjs?test=${Date.now()}`);
  const metadata = envelopeModule.credentialEnvelopeMetadata();
  const publicKey = crypto.createPublicKey({ key: Buffer.from(metadata.publicKey, 'base64'), type: 'spki', format: 'der' });
  const contentKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv);
  const plaintext = JSON.stringify({ username: 'nadine@example.test', password: 'nicht-protokollieren', totp: 'JBSWY3DPEHPK3PXP' });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  const envelope = {
    version: 1,
    algorithm: 'RSA-OAEP-256+A256GCM',
    wrappedKey: crypto.publicEncrypt({ key: publicKey, oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, contentKey).toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  assert.deepEqual(envelopeModule.decryptCredentialEnvelope(envelope), {
    username: 'nadine@example.test', password: 'nicht-protokollieren', totp: 'JBSWY3DPEHPK3PXP',
  });
  assert.equal(envelopeModule.secretEnvelopePolicy().plaintextOnRailway, false);
  await assert.rejects(async () => envelopeModule.decryptCredentialEnvelope({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -4)}AAAA` }), /nicht sicher entschlüsselt/);

  const importTask = await import(`../local-mac-helper/knowledge-import.mjs?test=${Date.now()}`);
  const prompt = importTask.buildKnowledgeImportPrompt({
    ...job,
    importId: job.id,
    attempt: 1,
  });
  assert.match(prompt, /Inventarisiere zuerst alle sichtbaren Module/);
  assert.match(prompt, /prägnante Originalformulierungen wie konkrete Pitches/);
  assert.match(prompt, /Umgehe keinen Kopier-, Download- oder Zugriffsschutz/);
  assert.match(prompt, /00 Inventar/);
  assert.match(prompt, /knowledge-import-client\.mjs complete/);
  let started = null;
  const task = await importTask.startKnowledgeImportTask({ ...job, importId: job.id, attempt: 1 }, {
    startTask: async request => { started = request; return { jobId: crypto.randomUUID(), status: 'queued' }; },
  });
  assert.equal(task.importId, job.id);
  assert.equal(started.mode, 'operational');
  assert.equal(started.workflowId, `knowledge-import:${job.id}`);
  assert.ok(started.acceptanceCriteria.some(item => /Google-Drive-Lernakte/.test(item)));

  const manifestDir = path.join(process.env.IVA_MAC_HELPER_DATA_DIR, 'codex-tasks', 'test');
  await fs.mkdir(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, 'knowledge-import.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    title: 'Vertriebscoaching', content: 'Eine vollständige Arbeitsfassung mit ausreichend Inhalt für die Prüfung.',
    completedLessons: 19, totalLessons: 19, archiveFolderUrl: 'https://drive.google.com/drive/folders/test',
  }));
  const client = await import(`../local-mac-helper/knowledge-import-client.mjs?test=${Date.now()}`);
  const result = await client.completeKnowledgeImportFromManifest(job.id, manifestPath, {
    report: async (id, body) => ({ id, body, secretValuesReturned: false }),
  });
  assert.equal(result.id, job.id);
  assert.equal(result.body.completedLessons, 19);
  assert.equal(result.secretValuesReturned, false);
  await assert.rejects(() => client.completeKnowledgeImportFromManifest(job.id, path.join(root, 'outside.json'), { report: async () => ({}) }), /außerhalb/);

  const credentialSource = await fs.readFile(new URL('../local-mac-helper/course-credentials.mjs', import.meta.url), 'utf8');
  assert.match(credentialSource, /macOS-login-keychain/);
  assert.match(credentialSource, /stdin: value, sensitive: true/);
  assert.doesNotMatch(credentialSource, /'-w',\s*value/);

  console.log('PASS IVA-Wissensimport: Zielmodi, Fortschritt, sichere iMac-Verschlüsselung, Kursauftrag und Abschlussmanifest geprüft.');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
