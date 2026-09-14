import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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
