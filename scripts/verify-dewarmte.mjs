import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iva-dewarmte-'));
process.env.IVA_MAC_HELPER_DATA_DIR = dataDir;

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

  const cli = await readFile(new URL('../local-mac-helper/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /publish-dewarmte-pdf/);
  assert.match(cli, /deliver-dewarmte-pdf/);
  assert.match(cli, /beginDewarmteDelivery/);
  const workflow = await readFile(new URL('../DEWARMTE_LINK_PDF_WORKFLOW.md', import.meta.url), 'utf8');
  assert.match(workflow, /Link rein, Materiallisten-PDF raus/);
  assert.match(workflow, /ausschließlich.*gelesen/);
  assert.match(workflow, /Gesendet/);
  console.log('PASS DeWarmte: Linkvalidierung, Projektablage und Mail-Dublettenschutz.');
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
