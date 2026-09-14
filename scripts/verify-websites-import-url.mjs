import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createWebsiteUrlImporter, isPublicWebsiteAddress, validateWebsiteUrl } from '../websites/import-url.js';

const PUBLIC_IP = '93.184.216.34';
function fixture(routes, { dns, timeout = 3000 } = {}) {
  const calls = [], dnsCalls = [];
  const importer = createWebsiteUrlImporter({
    requestTimeoutMs: timeout,
    operationTimeoutMs: timeout,
    lookupImpl: async (hostname, options) => { dnsCalls.push({ hostname, options }); return dns ? dns(hostname) : [{ address: PUBLIC_IP, family: 4 }]; },
    requestImpl(url, options, handler) {
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = () => {
        calls.push({ url: url.href, options });
        queueMicrotask(() => {
          options.lookup(url.hostname, {}, (error, address, family) => {
            assert.equal(error, null); assert.equal(address, PUBLIC_IP); assert.equal(family, 4);
          });
          const route = routes[url.href];
          if (route?.hang) return;
          if (!route) { request.emit('error', new Error('Not found')); return; }
          const response = Readable.from([Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body || '')]);
          response.statusCode = route.status || 200;
          response.headers = { 'content-type': route.type || 'text/html', ...route.headers, ...(route.location ? { location: route.location } : {}) };
          handler(response);
        });
      };
      return request;
    },
  });
  return { ...importer, calls, dnsCalls };
}

test('URL validation blocks schemes, credentials, local targets, reserved addresses and nonstandard ports', () => {
  for (const url of ['http://example.com', 'file:///etc/passwd', 'https://localhost/', 'https://x.local/', 'https://example.com:8443/', 'https://secret@example.com/', 'https://127.0.0.1', 'https://2130706433', 'https://0x7f000001', 'https://169.254.169.254/latest', 'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[2001:db8::1]', 'https://example.com./']) {
    assert.throws(() => validateWebsiteUrl(url), undefined, url);
  }
  assert.equal(validateWebsiteUrl('https://example.com/path#heading').href, 'https://example.com/path');
  assert.equal(validateWebsiteUrl('https://[2606:4700:4700::1111]/').protocol, 'https:');
});

test('address validation excludes private and reserved IPv4/IPv6', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.1.1.1', '172.16.1.1', '192.168.1.1', '192.0.2.1', '198.18.1.1', '198.51.100.1', '203.0.113.1', '224.1.1.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '3fff::1', '::ffff:127.0.0.1']) assert.equal(isPublicWebsiteAddress(address), false, address);
  for (const address of [PUBLIC_IP, '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicWebsiteAddress(address), true, address);
});

test('fresh DNS result is pinned into request without forwarding cookies or credentials', async () => {
  const f = fixture({ 'https://example.com/': { body: '<html><title>Reference</title><body>Hello world</body></html>' } });
  const result = await f.readWebsiteReference('https://example.com/');
  assert.equal(result.title, 'Reference');
  assert.match(result.text, /Hello world/);
  assert.equal(f.dnsCalls.length, 1);
  assert.equal(f.calls[0].options.agent, false);
  assert.equal(Object.keys(f.calls[0].options.headers).some(name => /cookie|authorization/i.test(name)), false);
});

test('mixed public and private DNS answers block before network request', async () => {
  const f = fixture({}, { dns: () => [{ address: PUBLIC_IP, family: 4 }, { address: '10.0.0.1', family: 4 }] });
  await assert.rejects(f.readWebsiteReference('https://example.com'), { code: 'WEBSITE_PRIVATE_NETWORK' });
  assert.equal(f.calls.length, 0);
});

test('redirect targets are DNS-checked again and private redirects blocked', async () => {
  const f = fixture({ 'https://example.com/': { status: 302, location: 'https://private.example.com/' } }, { dns: host => [{ address: host === 'private.example.com' ? '192.168.0.1' : PUBLIC_IP, family: 4 }] });
  await assert.rejects(f.readWebsiteReference('https://example.com/'), { code: 'WEBSITE_PRIVATE_NETWORK' });
  assert.equal(f.calls.length, 1);
  assert.equal(f.dnsCalls.length, 2);
});

test('redirect chains are bounded at three', async () => {
  const routes = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`https://example.com/${index}`, { status: 302, location: `/${index + 1}` }]));
  const f = fixture(routes);
  await assert.rejects(f.readWebsiteReference('https://example.com/0'), { code: 'WEBSITE_REDIRECT_LIMIT' });
  assert.equal(f.calls.length, 4);
});

test('snapshot copies same-origin HTML, CSS, scripts and binary assets, rewrites nested references', async () => {
  const binary = Buffer.from([0, 255, 2]);
  const f = fixture({
    'https://example.com/': { body: '<html><head><title>Site</title><link rel="stylesheet" href="/style.css"></head><body><img src="/hero.png"><script type="module" src="/app.js"></script><img src="https://cdn.example.org/image.png"></body></html>' },
    'https://example.com/style.css': { type: 'text/css', body: 'body { background: url("./texture.png"); }' },
    'https://example.com/hero.png': { type: 'image/png', body: binary },
    'https://example.com/texture.png': { type: 'image/png', body: binary },
    'https://example.com/app.js': { type: 'application/javascript', body: 'import { show } from "./part.js"; show();' },
    'https://example.com/part.js': { type: 'application/javascript', body: 'export function show() {}' },
  });
  const result = await f.importWebsiteUrl('https://example.com/');
  assert.equal(result.files.length, 6);
  assert.equal(result.source.type, 'public-snapshot');
  assert.equal(result.source.url, 'https://example.com/');
  assert.match(result.files[0].content, /src="\.\/assets\/[a-f0-9]+-hero.png"/);
  assert.equal(f.calls.every(call => new URL(call.url).origin === 'https://example.com'), true);
  const hero = result.files.find(file => file.path.endsWith('-hero.png'));
  assert.equal(hero.encoding, 'base64');
  assert.deepEqual(Buffer.from(hero.content, 'base64'), binary);
  assert.match(result.files.find(file => file.path.endsWith('-style.css')).content, /url\("\.\/[a-f0-9]+-texture.png"\)/);
  assert.match(result.files.find(file => file.path.endsWith('-app.js')).content, /from "\.\/[a-f0-9]+-part.js"/);
  assert.match(result.warnings.join(' '), /Originale React-Quellen/);
  assert.match(result.warnings.join(' '), /Externe Dateien/);
});

test('asset redirects cannot pull another origin and are recorded as incomplete', async () => {
  const f = fixture({ 'https://example.com/': { body: '<html><img src="/image.png"></html>' }, 'https://example.com/image.png': { status: 302, location: 'https://cdn.example.org/image.png' } });
  const result = await f.importWebsiteUrl('https://example.com/');
  assert.equal(result.files.length, 1);
  assert.match(result.warnings.join(' '), /1 Dateiverweise/);
  assert.equal(f.calls.length, 2);
});

test('maximum single-file size is enforced before accepting a response', async () => {
  const f = fixture({ 'https://example.com/': { headers: { 'content-length': String(3 * 1024 * 1024 + 1) }, body: '<html></html>' } });
  await assert.rejects(f.importWebsiteUrl('https://example.com/'), { code: 'WEBSITE_IMPORT_SIZE' });
});

test('HTML reference removes executable content and limits extracted text', async () => {
  const f = fixture({ 'https://example.com/': { body: '<html><title>Test &amp; Site</title><script>PRIVATE SCRIPT TEXT</script><style>STYLE TEXT</style><body><h1>Readable</h1>' + 'a'.repeat(20000) + '</body></html>' } });
  const result = await f.readWebsiteReference('https://example.com/');
  assert.equal(result.title, 'Test & Site');
  assert.equal(result.text.includes('PRIVATE SCRIPT'), false);
  assert.equal(result.text.includes('STYLE TEXT'), false);
  assert.equal(result.text.length, 12000);
});

test('aborted or nonresponsive operations terminate without executing page scripts', async () => {
  const f = fixture({ 'https://example.com/': { hang: true } }, { timeout: 5 });
  await assert.rejects(f.importWebsiteUrl('https://example.com/'), { code: 'WEBSITE_IMPORT_ABORTED' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.importWebsiteUrl('https://example.com/', { signal: controller.signal }), { code: 'WEBSITE_IMPORT_ABORTED' });
});
