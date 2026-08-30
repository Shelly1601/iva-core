import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iva-dewarmte-'));
process.env.IVA_MAC_HELPER_DATA_DIR = dataDir;
process.env.IVA_CODEX_TASK_ROOT = path.join(dataDir, 'codex-tasks');
process.env.DATA_DIR = path.join(dataDir, 'server-data');
process.env.IVA_DEVICE_WORKSPACE = path.join(dataDir, 'workspace');

try {
  const { beginDewarmteDelivery, finishDewarmteDelivery, readDewarmteDelivery } = await import('../local-mac-helper/dewarmte-delivery-state.mjs');
  const jobId = '12345678-1234-4123-8123-123456789012';
  const started = await beginDewarmteDelivery({
    jobId, deliveryMode: 'email-send', recipientEmail: 'kunde@example.com', fileName: '/tmp/DeWarmte_Materialliste.pdf',
  });
  assert.equal(started.status, 'send-attempting');
  await assert.rejects(beginDewarmteDelivery({
    jobId, deliveryMode: 'email-send', recipientEmail: 'kunde@example.com', fileName: '/tmp/DeWarmte_Materialliste.pdf',
  }), /kein zweiter Entwurf oder Versand/);
  const finished = await finishDewarmteDelivery(jobId, { status: 'sent-verified', detail: 'Gesendet-Ordner geprüft.' });
  assert.equal(finished.status, 'sent-verified');
  assert.equal((await readDewarmteDelivery(jobId)).status, 'sent-verified');

  const { summarizeDewarmteLinkPdfJobs, validateDewarmteLinkPdfInput } = await import('../projects/dewarmte.js');
  const validated = validateDewarmteLinkPdfInput({
    sourceUrl: 'https://example.com/installation.pdf', deliveryMode: 'download',
    supplementaryText: 'Stahl/Kupfer bevorzugen.\nPressen statt Klemmen.',
    supplementaryPdfId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', supplementaryPdfName: 'Startvoorraad.pdf',
  });
  assert.match(validated.supplementaryText, /Pressen statt Klemmen/);
  assert.equal(validated.supplementaryPdfName, 'Startvoorraad.pdf');

  const { DEWARMTE_MATERIAL_STANDARD } = await import('../projects/dewarmte-material-standard.js');
  assert.deepEqual(DEWARMTE_MATERIAL_STANDARD.cover, {
    source: 'installation-planning', sourcePage: 1, resultPage: 1, preserveUnchanged: true,
    title: 'Deckblatt aus der Installationsplanung',
  });
  assert.deepEqual(DEWARMTE_MATERIAL_STANDARD.sections.map(section => section.title), ['DeWarmte Material', 'HEAT|Hero Material']);
  assert.deepEqual(DEWARMTE_MATERIAL_STANDARD.sections[1].items, [
    'Erdleitung / Schutzrohr',
    'Heizungsrohrleitung Pomp MP',
    'Adapter und Fittings Pomp MP',
    'Pufferspeicher 20 Liter mit Bypass',
    'Magnetfilter',
    'Warmwasserrohr Pomp T',
    'Heizungs-/Quellrohr Pomp T',
    'Anschlussmaterial Warmwasser-Zirkulation',
    'Elektroanschluss Pomp MP',
  ]);

  const runningJob = summarizeDewarmteLinkPdfJobs([{
    id: 'command-progress', action: 'project.workflow.run', status: 'completed', createdAt: '2026-08-30T08:00:00Z',
    result: { jobId }, payload: { projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', deliveryMode: 'download' },
  }], [], [], [{
    projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', jobId,
    status: 'running', phase: 'testing', progress: 50, updatedAt: '2026-08-30T08:03:00Z', resultPreview: 'PDF wird geprüft.',
  }])[0];
  assert.equal(runningJob.progress, 50);
  assert.equal(runningJob.phase, 'PDF wird gerendert und visuell geprüft');
  assert.equal(runningJob.active, true);

  const { cleanupExpiredDewarmteSupplementPdfs, readDewarmteSupplementPdf, storeDewarmteSupplementPdf } = await import('../projects/dewarmte-inputs.js');
  const serverInput = await storeDewarmteSupplementPdf({ name: 'Startvoorraad.pdf', buffer: Buffer.from('%PDF-test') });
  assert.equal((await readDewarmteSupplementPdf(serverInput.id)).meta.name, 'Startvoorraad.pdf');
  assert.deepEqual(await cleanupExpiredDewarmteSupplementPdfs({ now: Date.now() + 4 * 24 * 60 * 60_000 }), { removed: 1, retentionDays: 3 });
  assert.equal(await readDewarmteSupplementPdf(serverInput.id).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), null);

  const { cleanupExpiredDewarmteLocalData, storeDewarmteLocalSupplement } = await import('../local-mac-helper/dewarmte-local-retention.mjs');
  const localInput = await storeDewarmteLocalSupplement({ jobId, name: 'Startvoorraad.pdf', buffer: Buffer.from('%PDF-test') });
  const taskDir = path.join(process.env.IVA_CODEX_TASK_ROOT, jobId);
  const outputDir = path.join(process.env.IVA_DEVICE_WORKSPACE, 'output', 'pdf');
  const tempDir = path.join(process.env.IVA_DEVICE_WORKSPACE, 'tmp', 'pdfs', `dewarmte-${jobId}`);
  await mkdir(taskDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await writeFile(path.join(taskDir, 'request.json'), JSON.stringify({ projectId: 'dewarmte', createdAt: new Date().toISOString() }));
  const localOutput = path.join(outputDir, 'DeWarmte_Materialliste_Test.pdf');
  await writeFile(localOutput, '%PDF-test');
  await writeFile(path.join(tempDir, 'page-1.png'), 'render');
  const localCleanup = await cleanupExpiredDewarmteLocalData({ now: Date.now() + 4 * 24 * 60 * 60_000 });
  assert.equal(localCleanup.removedInputs, 1);
  assert.equal(localCleanup.removedTasks, 1);
  assert.equal(localCleanup.removedOutputs, 1);
  assert.equal(localCleanup.removedTemps, 1);
  await assert.rejects(access(localInput), /ENOENT/);
  await assert.rejects(access(localOutput), /ENOENT/);

  const { cleanupExpiredDewarmteCommandInputs, enqueueDeviceCommand, listDeviceCommands } = await import('../device-control/store.js');
  await enqueueDeviceCommand({ action: 'project.workflow.run', payload: {
    projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', sourceUrl: 'https://example.com/plan.pdf',
    supplementaryText: 'temporär', supplementaryPdfId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', supplementaryPdfName: 'Startvoorraad.pdf',
  } });
  assert.equal((await cleanupExpiredDewarmteCommandInputs({ now: Date.now() + 4 * 24 * 60 * 60_000 })).redacted, 1);
  const redacted = (await listDeviceCommands({ limit: 10 })).find(item => item.payload?.projectId === 'dewarmte');
  assert.equal(redacted.payload.supplementaryText, undefined);
  assert.ok(redacted.inputPurgedAt);

  const cli = await readFile(new URL('../local-mac-helper/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /publish-dewarmte-pdf/);
  assert.match(cli, /deliver-dewarmte-pdf/);
  assert.match(cli, /beginDewarmteDelivery/);
  const server = await readFile(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(server, /\/api\/projects\/dewarmte\/supplement-pdfs/);
  assert.match(server, /cleanupExpiredDewarmteCommandInputs/);
  const deviceAgent = await readFile(new URL('../local-mac-helper/device-agent.mjs', import.meta.url), 'utf8');
  assert.match(deviceAgent, /fetchDewarmteSupplementPdf/);
  assert.match(deviceAgent, /cleanupExpiredDewarmteLocalData/);
  const workflow = await readFile(new URL('../DEWARMTE_LINK_PDF_WORKFLOW.md', import.meta.url), 'utf8');
  assert.match(workflow, /Link rein, Materiallisten-PDF raus/);
  assert.match(workflow, /ausschließlich.*gelesen/);
  assert.match(workflow, /Gesendet/);
  assert.match(workflow, /spätestens drei Tage/);
  assert.match(workflow, /DeWarmte Material/);
  assert.match(workflow, /HEAT\|Hero Material/);
  console.log('PASS DeWarmte: Fortschritt, festes Grundgerüst, Zusatzdaten-Löschung und Mail-Dublettenschutz.');
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
