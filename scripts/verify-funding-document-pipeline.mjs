import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractImages, getDocumentProxy } from 'unpdf';
import { prepareFundingAttachments } from '../local-mac-helper/funding-document-pipeline.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

for (const [label, names] of [
  ['same stem with different image extensions', ['Personalausweis.jpg', 'Personalausweis.png']],
  ['different image names with the same sanitized stem', ['Personalausweis-Vorderseite.png', 'Personalausweis_Vorderseite.png']],
]) {
  test(`PDF conversion preserves distinct pages for ${label}`, { skip: process.platform !== 'darwin' }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'iva-funding-image-test-'));
    let pdf;
    try {
      const inputDirectory = path.join(root, 'input');
      await mkdir(inputDirectory);
      const sourceHashes = [];
      for (const [index, name] of names.entries()) {
        // Synthetic colored pixels contain no customer documents or identity data.
        const pixels = Buffer.alloc(32 * 32 * 3);
        for (let offset = 0; offset < pixels.length; offset += 3) pixels[offset + (index === 0 ? 0 : 2)] = 255;
        const ppm = path.join(root, `${index}.ppm`);
        await writeFile(ppm, Buffer.concat([Buffer.from('P6\n32 32\n255\n'), pixels]));
        const output = path.join(inputDirectory, name);
        await exec('/usr/bin/sips', ['-s', 'format', name.endsWith('.jpg') ? 'jpeg' : 'png', ppm, '--out', output]);
        sourceHashes.push(hash(await readFile(output)));
      }
      const result = await prepareFundingAttachments({ inputDirectory, outputDirectory: path.join(root, 'prepared'), orderNumber: 'TEST-42' });
      assert.equal(result.inputCount, 2);
      assert.equal(result.outputCount, 1);
      const document = result.outputs[0];
      assert.equal(document.type, 'identity_card');
      assert.equal(document.pageCount, 2);
      assert.deepEqual(document.sourceFiles, names);
      assert.deepEqual(document.sourceHashes, sourceHashes);
      assert.equal(document.autoUploadSafe, false, 'unreadable test pixels cannot prove an identity document');
      pdf = await getDocumentProxy(new Uint8Array(await readFile(document.outputPath)));
      const first = (await extractImages(pdf, 1))[0];
      const second = (await extractImages(pdf, 2))[0];
      assert.ok(first?.data?.length && second?.data?.length);
      assert.notEqual(hash(first.data), hash(second.data), 'the front page must not be overwritten by the second conversion');
      assert.ok(first.data[0] > first.data[2] + 100, 'the first page retains the red source image');
      assert.ok(second.data[2] > second.data[0] + 100, 'the second page retains the blue source image');
    } finally {
      await pdf?.destroy();
      await rm(root, { recursive: true, force: true });
    }
  });
}
