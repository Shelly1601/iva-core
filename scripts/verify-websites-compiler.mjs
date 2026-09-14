import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { compileWebsite } from '../websites/compiler.js';

const file = (path, content) => ({ path, content, encoding: 'utf8' });
const reactPackage = file('package.json', JSON.stringify({ scripts: { build: 'touch /tmp/IVA_MUST_NOT_EXECUTE' }, dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' } }));
const reactHtml = file('index.html', '<!doctype html><html><head><title>React</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>');

test('static website embeds its local styles, scripts, and binary assets with restrictive preview policy', async () => {
  const output = await compileWebsite([
    file('index.html', '<!doctype html><html><head><link rel="stylesheet" href="./style.css"></head><body><img src="./logo.svg"><button onclick="hello()">Test</button><script src="./script.js"></script></body></html>'),
    file('style.css', 'body { color: #123; background: url(./logo.svg) }'),
    file('script.js', 'function hello() { document.body.dataset.checked = "yes"; }'),
    file('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'),
  ]);
  assert.equal(output.status, 'ready');
  assert.deepEqual(output.errors, []);
  assert.match(output.html, /function hello/);
  assert.match(output.html, /data:image\/svg\+xml;base64/);
  assert.match(output.html, /color: #123/);
  assert.match(output.html, /Content-Security-Policy/);
  assert.match(output.html, /object-src 'none'/);
  assert.doesNotMatch(output.html, /src="\.\/script\.js"/);
});

test('React/Vite TSX compiles in memory and pins declared browser dependencies', async () => {
  const output = await compileWebsite([
    reactPackage, reactHtml,
    file('vite.config.ts', 'throw new Error("CONFIG MUST NEVER RUN");'),
    file('src/main.tsx', 'import { createRoot } from "react-dom/client"; import App from "@/App"; import "./style.css"; createRoot(document.getElementById("root")!).render(<App/>);'),
    file('src/App.tsx', 'export default function App(){ return <main><h1>Browser-Test</h1><img src="/logo.svg"/></main> }'),
    file('src/style.css', 'main{display:grid;color:rgb(20,30,40)}'),
    file('public/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
  ]);
  assert.equal(output.status, 'ready');
  assert.match(output.html, /https:\/\/esm\.sh\/react-dom@18\.3\.1\/client/);
  assert.match(output.html, /https:\/\/esm\.sh\/react@18\.3\.1\/jsx-runtime/);
  assert.match(output.html, /Browser-Test/);
  assert.match(output.html, /data:image\/svg\+xml;base64/);
  assert.doesNotMatch(output.html, /CONFIG MUST NEVER RUN|IVA_MUST_NOT_EXECUTE|process\.env\.IVA/);
  assert.ok(output.warnings.some(value => value.includes('Buildkonfigurationen')));
});

test('filesystem paths, Node modules, missing virtual files and undeclared packages cannot fall through to host resolution', async () => {
  for (const imported of ['node:fs', 'fs', '/etc/passwd', '../../package.json', 'file:///etc/passwd', 'esbuild', 'unconfigured-package', 'https://user:password@example.com/file.js']) {
    await assert.rejects(compileWebsite([reactHtml, reactPackage, file('src/main.tsx', `import value from ${JSON.stringify(imported)}; window.value = value;`)]), error => error.code === 'WEBSITE_COMPILE_ERROR', imported);
  }
});

test('public browser bundles preserve optional CommonJS fallbacks without requiring a source package manifest', async () => {
  // This shape is emitted by Framer Motion in the imported Goals & Concepts
  // production bundle. The optional package is absent in the original browser.
  const output = await compileWebsite([
    file('index.html', '<html><head></head><body><script type="module" src="./assets/index-built.js"></script></body></html>'),
    file('assets/index-built.js', 'let accepts=()=>true;function setValidator(value){if(value)accepts=value}try{setValidator(require("@emotion/is-prop-valid").default)}catch{}globalThis.optionalFallbackWorks=accepts("data-website");'),
  ]);
  assert.equal(output.status, 'ready');
  assert.doesNotMatch(output.html, /esm\.sh\/@emotion|type="importmap"/);
  const script = output.html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  const browser = {};
  runInNewContext(script, browser, { timeout: 1000 });
  assert.equal(browser.optionalFallbackWorks, true);
});

test('optional require fallback cannot load installed host packages and required or Node imports stay rejected', async () => {
  const html = file('index.html', '<script type="module" src="./entry.js"></script>');
  const guarded = await compileWebsite([
    html,
    file('entry.js', 'try{globalThis.loadedHostPackage=!!require("express")}catch{globalThis.loadedHostPackage=false}'),
  ]);
  const browser = {};
  runInNewContext(guarded.html.match(/<script type="module">([\s\S]*?)<\/script>/)[1], browser, { timeout: 1000 });
  assert.equal(browser.loadedHostPackage, false);
  for (const source of [
    'globalThis.required = require("@emotion/is-prop-valid");',
    'globalThis.required = require("express");',
    'try { globalThis.required = require("node:fs"); } catch {}',
    'try { globalThis.required = require("/etc/passwd"); } catch {}',
    'import required from "@emotion/is-prop-valid"; globalThis.required = required;',
  ]) await assert.rejects(compileWebsite([html, file('entry.js', source)]), error => error.code === 'WEBSITE_COMPILE_ERROR', source);
});

test('scripts and CSS cannot close their embedding element through generated file contents', async () => {
  const output = await compileWebsite([
    file('index.html', '<html><head><link rel="stylesheet" href="/style.css"></head><body><script type="module" src="/entry.js"></script></body></html>'),
    file('entry.js', 'window.payload = "</script><script>window.escaped = true</script>";'),
    file('style.css', 'body::after { content: "</style><script>window.escaped = true</script>" }'),
  ]);
  assert.doesNotMatch(output.html, /<\/style><script>window\.escaped|<\/script><script>window\.escaped/);
  assert.equal((output.html.match(/<script type="module">/g) || []).length, 1);
  assert.match(output.html, /\\\/script|\\x3c\/script/);
});

test('embedded JavaScript preserves replacement tokens and React $$typeof through every insertion pass', async () => {
  const tokens = ['$$', '$&', "$'", '$`', '$1', '$<name>'];
  const code = `globalThis.values=${JSON.stringify(tokens)};globalThis.reactShape={"$$typeof":"react-element"};`;
  for (const [script, entry] of [
    ['<script type="module" src="/entry.js"></script>', file('entry.js', code)],
    ['<script src="/entry.js"></script>', file('entry.js', code)],
    [`<script type="module">${code}</script>`, null],
    [`<script>${code}</script>`, null],
  ]) {
    const output = await compileWebsite([
      file('index.html', `<html><head><title>Prefix sentinel</title></head><body>${script}<p>Suffix sentinel</p></body></html>`),
      ...(entry ? [entry] : []),
    ]);
    const scripts = [...output.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    const browser = {};
    runInNewContext(scripts[0][1], browser, { timeout: 1000 });
    assert.deepEqual(JSON.parse(JSON.stringify(browser.values)), tokens);
    assert.equal(browser.reactShape.$$typeof, 'react-element');
    assert.equal((output.html.match(/Prefix sentinel/g) || []).length, 1);
    assert.equal((output.html.match(/Suffix sentinel/g) || []).length, 1);
  }
});

test('inline CSS and rewritten asset tags keep literal replacement metacharacters', async () => {
  const tokens = ['$$', '$&', "$'", '$`'];
  const literal = tokens.join('|');
  const output = await compileWebsite([
    file('index.html', `<html><head><link rel="icon" data-markers="${literal}" href="/logo.svg"><style>body::after { content: "${literal}"; }</style></head><body>Suffix sentinel</body></html>`),
    file('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
  ]);
  const style = output.html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert(style.includes(literal));
  assert(output.html.includes(`data-markers="${literal}"`));
  assert.equal((output.html.match(/Suffix sentinel/g) || []).length, 1);
  assert.equal((output.html.match(/<style>/g) || []).length, 1);
});

test('unsupported server frameworks and invalid JSX fail instead of returning a fabricated preview', async () => {
  await assert.rejects(compileWebsite([reactHtml, file('package.json', '{"dependencies":{"next":"15.0.0"}}')]), /isolierten Framework-Build/);
  await assert.rejects(compileWebsite([reactHtml, reactPackage, file('src/main.tsx', 'export const App = () => <div>broken')]), error => error.status === 422);
  await assert.rejects(compileWebsite([file('src/App.tsx', 'export default 1')]), /index\.html/);
  await assert.rejects(compileWebsite([reactHtml, file('package.json', '{"dependencies":{"react":"latest"}}'), file('src/main.tsx', 'import React from "react"; window.r=React;')]), /konkrete Browser-Paketversion/);
});

test('environment definitions reveal no host secrets and imports of data assets are inlined', async () => {
  process.env.IVA_COMPILER_TEST_SECRET = 'must-not-appear-in-website';
  try {
    const output = await compileWebsite([
      file('index.html', '<head></head><body><script type="module" src="/entry.js"></script></body>'),
      file('entry.js', 'import logo from "./logo.svg"; window.asset=logo; window.mode=import.meta.env.MODE; window.secret=import.meta.env.IVA_COMPILER_TEST_SECRET;'),
      file('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    ]);
    assert.doesNotMatch(output.html, /must-not-appear-in-website/);
    assert.match(output.html, /production/);
    assert.match(output.html, /data:image\/svg\+xml/);
    assert.ok(output.warnings.some(value => value.includes('Umgebungsvariablen')));
  } finally { delete process.env.IVA_COMPILER_TEST_SECRET; }
});

test('refresh and base tags cannot redirect the trusted preview container', async () => {
  const output = await compileWebsite([file('index.html', '<head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/"></head><body>Safe</body>')]);
  assert.doesNotMatch(output.html, /<base|http-equiv="refresh"|evil\.example/);
});

test('Tailwind utility CSS and shadcn semantic colors compile without executing project configuration', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iva-tailwind-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = path.join(root, 'unsafe.cjs');
  await writeFile(config, 'globalThis.__ivaUnsafeTailwindConfig = true; throw new Error("UNSAFE CONFIG RAN");');
  delete globalThis.__ivaUnsafeTailwindConfig;
  const output = await compileWebsite([
    file('index.html', '<html><head><link rel="stylesheet" href="/style.css"></head><body class="bg-background text-foreground"><div class="flex p-4 text-2xl bg-primary">Tailwind</div></body></html>'),
    file('style.css', `@config ${JSON.stringify(config)}; @tailwind base; @tailwind components; @tailwind utilities; :root { --background: 0 0% 100%; --foreground: 0 0% 10%; --primary: 222 60% 50%; --radius: 0.5rem; } .custom { @apply p-4; }`),
    file('tailwind.config.js', 'globalThis.__ivaUnsafeTailwindConfig=true; throw new Error("UNSAFE CONFIG RAN");'),
  ]);
  assert.equal(output.status, 'ready');
  assert.match(output.html, /\.flex\s*\{\s*display:\s*flex/);
  assert.match(output.html, /\.p-4\s*\{\s*padding:\s*1rem/);
  assert.match(output.html, /hsl\(var\(--primary\)\)/);
  assert.doesNotMatch(output.html, /@config|@tailwind|@apply|UNSAFE CONFIG RAN/);
  assert.equal(globalThis.__ivaUnsafeTailwindConfig, undefined);
  assert.ok(output.warnings.some(value => value.includes('eigene Tailwind-Konfiguration')));
});

test('React Router gets an opaque-preview adapter while published HTTPS routing remains unchanged', async () => {
  const output = await compileWebsite([
    reactHtml,
    file('package.json', JSON.stringify({ dependencies: { react: '18.3.1', 'react-dom': '18.3.1', 'react-router-dom': '6.28.0' } })),
    file('src/main.tsx', 'import { BrowserRouter, Routes, Route } from "react-router-dom"; import { createRoot } from "react-dom/client"; createRoot(document.getElementById("root")!).render(<BrowserRouter><Routes><Route path="/" element={<h1>Routing works</h1>}/></Routes></BrowserRouter>);'),
  ]);
  assert.match(output.html, /MemoryRouter/);
  assert.match(output.html, /window\.location\.protocol/);
  assert.match(output.html, /https:\/\/esm\.sh\/react-router-dom@6\.28\.0/);
  assert.ok(output.warnings.some(value => value.includes('Speicherverlauf')));
});

async function bundledHistoryFixture(native) {
  const output = await compileWebsite([
    file('index.html', '<html><body><script type="module" src="/assets/built.js"></script></body></html>'),
    file('assets/built.js', 'globalThis.__reactRouterVersion="6";globalThis.routerWindow=document.defaultView;globalThis.initialRoute=document.defaultView.location.pathname;'),
  ]);
  const browser = { window: native, URL, Symbol, structuredClone };
  runInNewContext(output.html.match(/<script type="module">([\s\S]*?)<\/script>/)[1], browser, { timeout: 1000 });
  assert(output.warnings.some(value => value.includes('gebündelter React Router')));
  return browser;
}

test('already bundled React Router gets memory history inside an opaque srcdoc without relaxing origin access', async () => {
  const events = [];
  const native = {
    location: new URL('about:srcdoc'),
    get history() { throw new Error('Native opaque history must not be read'); },
    get parent() { throw new Error('Parent remains inaccessible'); },
    get localStorage() { throw new Error('Storage remains inaccessible'); },
    PopStateEvent: class { constructor(type, value) { this.type = type; this.state = value.state; } },
    DOMException,
    dispatchEvent(event) { events.push(event); },
  };
  const browser = await bundledHistoryFixture(native);
  const target = browser.routerWindow;
  assert.equal(browser.initialRoute, '/');
  target.history.replaceState({ idx: 0 }, '');
  target.history.pushState({ idx: 1, usr: { selected: true } }, '', '/services?mode=detail#contact');
  assert.equal(target.location.pathname, '/services');
  assert.equal(target.location.search, '?mode=detail');
  assert.equal(target.location.hash, '#contact');
  assert.equal(target.history.state.usr.selected, true);
  target.history.back();
  assert.equal(target.location.pathname, '/');
  assert.equal(events[0].type, 'popstate');
  assert.equal(events[0].state.idx, 0);
  target.history.forward();
  assert.equal(target.location.pathname, '/services');
  assert.equal(native.location.href, 'about:srcdoc');
  assert.throws(() => target.history.pushState({}, '', 'https://outside.example/'), error => error.name === 'SecurityError');
  assert.throws(() => target.parent, /inaccessible/);
  assert.throws(() => target.localStorage, /inaccessible/);
});

test('already bundled React Router preserves the public site mount on native history writes', async () => {
  const mount = '/s/11111111-1111-4111-8111-111111111111';
  const writes = [];
  const native = {
    location: new URL('https://websites.example.org' + mount + '/'),
    history: { state: null, length: 1,
      replaceState(state, _title, url) { this.state = state; if (url) native.location = new URL(url); writes.push(['replace', url]); },
      pushState(state, _title, url) { this.state = state; native.location = new URL(url); this.length++; writes.push(['push', url]); },
    },
    DOMException,
  };
  const browser = await bundledHistoryFixture(native);
  assert.equal(browser.initialRoute, '/');
  const target = browser.routerWindow;
  target.history.replaceState({ idx: 0 }, '');
  target.history.pushState({ idx: 1 }, '', '/services?mode=detail#contact');
  assert.equal(target.location.pathname, '/services');
  assert.equal(native.location.pathname, mount + '/services');
  assert.equal(native.location.search, '?mode=detail');
  assert.equal(native.location.hash, '#contact');
  assert.equal(writes[1][0], 'push');
  assert.throws(() => target.history.replaceState({}, '', 'https://outside.example/'), error => error.name === 'SecurityError');
});

test('bundled history adaptation leaves standalone custom-domain roots on their native browser window', async () => {
  const native = { location: new URL('https://customer.example.org/services'), history: { state: { idx: 1 } } };
  const browser = await bundledHistoryFixture(native);
  assert.equal(browser.routerWindow, native);
  assert.equal(browser.initialRoute, '/services');
});
