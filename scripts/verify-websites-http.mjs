import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createWebsiteZip, readWebsiteZip } from '../websites/archive.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('actual HTTP app protects Studio APIs and supports project-scoped ZIP import, preview and export', { timeout: 18_000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'iva-website-http-'));
  const token = randomBytes(32).toString('hex');
  const publicationKey = randomBytes(32).toString('hex');
  await mkdir(path.join(temporary, 'home'));
  // Run the actual application with isolated storage, no inherited integration
  // credentials and a temporary cwd, so dotenv cannot load the user's .env.
  // Disable cron scheduling in this process and all fetch-based outbound calls.
  const bootstrap = `
    import net from 'node:net';
    import { createRequire } from 'node:module';
    const entry = process.argv[1];
    const require = createRequire(entry);
    const cron = require('node-cron');
    cron.schedule = () => ({ stop() {}, destroy() {} });
    globalThis.fetch = async () => { throw new Error('External network disabled in isolated HTTP verification.'); };
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function(...args) {
      this.once('listening', () => process.stdout.write('IVA_HTTP_TEST_PORT=' + this.address().port + '\\n'));
      return listen.apply(this, [0, '127.0.0.1', ...args.slice(1)]);
    };
    await import(entry);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap, path.join(sourceRoot, 'index.js')], {
    cwd: temporary,
    env: {
      PATH: path.dirname(process.execPath), HOME: path.join(temporary, 'home'), TMPDIR: temporary,
      NODE_ENV: 'test', PORT: '0', TZ: 'Europe/Berlin', DATA_DIR: path.join(temporary, 'data'),
      API_TOKEN: token, IVA_WEBSITE_PUBLISH_KEY: publicationKey,
      IVA_MAC_HELPER_DATA_DIR: path.join(temporary, 'mac-helper'),
      IVA_CODEX_TASK_ROOT: path.join(temporary, 'codex-tasks'),
      IVA_DEVICE_WORKSPACE: path.join(temporary, 'workspace'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let terminal;
  const closed = new Promise(resolve => child.once('close', (code, signal) => { terminal = { code, signal }; resolve(); }));
  // Hard limit is earlier than the application's first 10-second reconciliation.
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 9_000);
  try {
    const port = await new Promise((resolve, reject) => {
      const inspect = chunk => {
        output = (output + chunk.toString()).slice(-20_000);
        const match = output.match(/IVA_HTTP_TEST_PORT=(\d+)/);
        if (match) resolve(Number(match[1]));
      };
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`Isolated HTTP server exited before startup (${code}). ${output.replaceAll(token, '[test-token]').replaceAll(publicationKey, '[test-publication-key]').slice(-2000)}`)));
    });
    const origin = `http://127.0.0.1:${port}`;
    const call = (route, options = {}, authorized = true) => fetch(origin + route, { ...options, headers: { ...(authorized ? { Authorization: `Bearer ${token}` } : {}), ...options.headers }, signal: AbortSignal.timeout(4_000) });
    const json = async (route, options, status = 200) => {
      const response = await call(route, options);
      const body = await response.json();
      assert.equal(response.status, status, `${route}: ${JSON.stringify(body).slice(0, 500)}`);
      return body;
    };
    const post = (route, body, status = 201) => json(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, status);

    const shell = await call('/website-studio', {}, false);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /Website Studio/i);
    assert.equal((await call('/api/website-studio/status', {}, false)).status, 401);
    assert.equal((await call('/_website-published', {}, false)).status, 401);
    assert.equal((await call('/_website-published')).status, 401, 'Core token must not authorize the publication endpoint');
    const status = await json('/api/website-studio/status');
    assert.equal(status.github.configured, false);
    const listed = await json('/api/website-studio/projects');
    assert.ok(Array.isArray(listed));

    const project = await post('/api/projects', { name: 'Isolated Website HTTP Test', description: 'Synthetic HTTP fixture' });
    const other = await post('/api/projects', { name: 'Other Isolated HTTP Project' });
    assert.ok(project.id && other.id && project.id !== other.id);
    const site = await post('/api/website-studio/sites', { projectId: project.id, name: 'HTTP Website Fixture' });
    const scoped = `?projectId=${encodeURIComponent(project.id)}`;
    const endpoint = `/api/website-studio/sites/${site.id}`;
    assert.equal(site.projectId, project.id);
    const listing = await json('/api/website-studio/sites' + scoped);
    assert.ok(listing.some(value => value.id === site.id));

    const files = [
      { path: 'index.html', encoding: 'utf8', content: '<!doctype html><html><head><title>HTTP fixture</title><link rel="stylesheet" href="./style.css"></head><body><h1>Verified HTTP website</h1></body></html>' },
      { path: 'style.css', encoding: 'utf8', content: 'body { color: #112233; background: #f3f5f8; }' },
    ];
    const zip = createWebsiteZip(files);
    const imported = await json(endpoint + '/import-zip' + scoped, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip });
    assert.ok(imported.revision || imported.id || imported.site || imported.revisionId, 'ZIP import should return saved revision evidence');
    const preview = await json(endpoint + '/preview' + scoped);
    assert.equal(preview.status, 'ready');
    assert.match(preview.html, /Verified HTTP website/);
    assert.match(preview.html, /#112233/);
    const exported = await call(endpoint + '/export' + scoped);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get('content-type'), /application\/zip/);
    assert.deepEqual(readWebsiteZip(Buffer.from(await exported.arrayBuffer())), readWebsiteZip(zip));

    for (const suffix of ['', '/preview', '/export']) {
      const response = await call(endpoint + suffix + `?projectId=${encodeURIComponent(other.id)}`);
      assert.equal(response.status, 404, `Other project cannot read ${suffix || 'site'}`);
    }
    const badZip = await call(endpoint + '/import-zip' + scoped, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: Buffer.from('not a zip') });
    assert.equal(badZip.status, 400);
    const manifest = await json('/api/interfaces/access');
    assert.ok(manifest.chatSessionToolManifest?.toolNames.includes('findIvaTools'));
    assert.ok(manifest.chatSessionToolManifest?.toolNames.includes('executeIvaTool'));
    t.diagnostic('Live local HTTP: shell/auth, project isolation, binary ZIP upload, real preview compilation, ZIP export and malformed upload verified; no provider calls.');
  } finally {
    clearTimeout(killTimer);
    if (!terminal) child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 500);
    await closed;
    clearTimeout(force);
    await rm(temporary, { recursive: true, force: true });
  }
});
