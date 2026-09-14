import path from 'node:path';
import { builtinModules } from 'node:module';
import * as esbuild from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { normalizeWebsiteFiles, websiteFileBytes } from './archive.js';

const BUILTINS = new Set(builtinModules.flatMap(name => [name, name.replace(/^node:/, '')]));
const LOADERS = { '.js': 'jsx', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx', '.ts': 'ts', '.tsx': 'tsx', '.json': 'json', '.css': 'css' };
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.json': 'application/json', '.txt': 'text/plain', '.pdf': 'application/pdf' };
const CSP = "default-src 'none'; script-src 'unsafe-inline' https: blob: data:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https: data:; worker-src blob:; frame-src https:; object-src 'none'; base-uri 'none'; form-action https:";

function compileError(message) { return Object.assign(new Error(message), { code: 'WEBSITE_COMPILE_ERROR', status: 422, statusCode: 422 }); }
function textOf(file) { return websiteFileBytes(file).toString('utf8'); }
function escapeAttribute(text) { return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function scriptText(text) { return String(text).replace(/<\/script/gi, '<\\/script'); }
function styleText(text) { return String(text).replace(/<\/style/gi, '<\\/style'); }
function stripQuery(value) { return value.split(/[?#]/, 1)[0]; }
function external(value) { return /^https:\/\//i.test(value) || /^data:/i.test(value) || value.startsWith('#'); }
function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) values[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  return values;
}
function packageParts(specifier) {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = parts.slice(specifier.startsWith('@') ? 2 : 1).join('/');
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name) || subpath.split('/').some(part => part === '..' || part === '.') || /[?#\\:\s]/.test(subpath)) throw compileError(`Nicht unterstützter Paketimport: ${specifier.slice(0, 120)}`);
  return { name, subpath };
}
function pinnedVersion(version, name) {
  const match = typeof version === 'string' && version.trim().match(/^[~^]?(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/);
  if (!match) throw compileError(`Für ${name} wird eine konkrete Browser-Paketversion benötigt (z. B. 1.2.3).`);
  return match[1];
}

export async function compileWebsite(input) {
  const files = normalizeWebsiteFiles(input);
  const byPath = new Map(files.map(file => [file.path, file]));
  const warnings = [];
  const imported = new Set();
  const browserImports = {};
  const cssCache = new Map();
  let packageJson = {};
  if (byPath.has('package.json')) {
    try { packageJson = JSON.parse(textOf(byPath.get('package.json'))); }
    catch { throw compileError('package.json enthält kein gültiges JSON.'); }
    if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) throw compileError('Ungültiges package.json.');
  }
  const dependencies = { ...(packageJson.devDependencies || {}), ...(packageJson.dependencies || {}) };
  if (dependencies.next || dependencies.nuxt || dependencies['@sveltejs/kit'] || dependencies.astro || [...byPath.keys()].some(name => /\.(?:vue|svelte)$/.test(name))) throw compileError('Dieses Projekt benötigt einen isolierten Framework-Build. Direkt unterstützt werden statische Websites und React/Vite ohne Server-Rendering.');
  const entryFile = byPath.get('index.html');
  if (!entryFile) throw compileError('Die Website benötigt eine index.html im Hauptordner.');
  let html = textOf(entryFile);
  if (!html.trim()) throw compileError('index.html ist leer.');
  if (files.some(file => /(?:^|\/)(?:vite|tailwind|postcss)\.config\./.test(file.path))) warnings.push('Projekt-Buildkonfigurationen werden nicht ausgeführt. IVA verwendet einen eigenen Browser-Build.');
  if (files.some(file => /import\.meta\.env\.[A-Z_]|process\.env\.[A-Z_]/.test(textOf(file)))) warnings.push('Projekt-Umgebungsvariablen und Backend-Zugänge sind nicht eingerichtet. Server-Geheimnisse werden nicht in die Website übernommen.');

  async function prepareCss(contents) {
    if (!/@(?:tailwind|apply|config|plugin|source)\b/.test(contents)) return contents;
    if (cssCache.has(contents)) return cssCache.get(contents);
    const pending = (async () => {
      const ast = postcss.parse(contents, { from: undefined });
      ast.walkAtRules(rule => {
        // Tailwind's @config directive can load executable configuration. Strip
        // it from the parsed AST before the trusted Tailwind plugin sees it.
        if (['config', 'plugin', 'source'].includes(rule.name.toLowerCase())) {
          warnings.push('Zusätzliche CSS-Konfigurationen und Plugins werden nicht ausgeführt; IVA verwendet eine eigene Tailwind-Konfiguration.');
          rule.remove();
        }
      });
      const semantic = name => `hsl(var(--${name}))`;
      const paired = name => ({ DEFAULT: semantic(name), foreground: semantic(`${name}-foreground`) });
      const config = {
        darkMode: ['class'],
        content: files.filter(file => /\.(?:html|jsx?|tsx?|mjs)$/.test(file.path) && !/(?:^|\/)(?:vite|tailwind|postcss)\.config\./.test(file.path)).map(file => ({ raw: textOf(file), extension: path.posix.extname(file.path).slice(1) })),
        theme: {
          container: { center: true, padding: '2rem', screens: { '2xl': '1400px' } },
          extend: {
            colors: { border: semantic('border'), input: semantic('input'), ring: semantic('ring'), background: semantic('background'), foreground: semantic('foreground'), primary: paired('primary'), secondary: paired('secondary'), destructive: paired('destructive'), muted: paired('muted'), accent: paired('accent'), popover: paired('popover'), card: paired('card'), sidebar: { ...paired('sidebar-background'), foreground: semantic('sidebar-foreground'), primary: semantic('sidebar-primary'), 'primary-foreground': semantic('sidebar-primary-foreground'), accent: semantic('sidebar-accent'), 'accent-foreground': semantic('sidebar-accent-foreground'), border: semantic('sidebar-border'), ring: semantic('sidebar-ring') } },
            borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
            keyframes: { 'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } }, 'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } } },
            animation: { 'accordion-down': 'accordion-down 0.2s ease-out', 'accordion-up': 'accordion-up 0.2s ease-out' },
          },
        },
        plugins: [],
      };
      const result = await postcss([tailwindcss(config)]).process(ast, { from: undefined, map: false });
      warnings.push(...result.warnings().map(warning => warning.text));
      return result.css;
    })();
    cssCache.set(contents, pending);
    return pending;
  }

  function resolveFile(specifier, importer = 'index.html', allowExtension = false) {
    if (/[\x00-\x1f\\]/.test(specifier) || /^(?:file|node|https?|data|javascript):/i.test(specifier) || specifier.startsWith('//') || /^[A-Za-z]:/.test(specifier)) throw compileError(`Ungültiger lokaler Website-Verweis: ${specifier.slice(0, 120)}`);
    let clean = stripQuery(specifier);
    try { clean = decodeURIComponent(clean); } catch { throw compileError('Ein Website-Verweis enthält ungültige URL-Kodierung.'); }
    if (/[\x00-\x1f\\:]/.test(clean)) throw compileError('Ungültiger Website-Verweis.');
    let candidate = clean.startsWith('@/') ? `src/${clean.slice(2)}` : clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(importer), clean);
    candidate = path.posix.normalize(candidate);
    if (!candidate || candidate === '..' || candidate.startsWith('../') || candidate.startsWith('/')) throw compileError('Dateiverweise dürfen den Website-Ordner nicht verlassen.');
    const candidates = [candidate];
    if (allowExtension) candidates.push(...['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json', '.css'].map(extension => `${candidate}${extension}`), ...['index.tsx', 'index.ts', 'index.jsx', 'index.js'].map(name => `${candidate}/${name}`));
    if (clean.startsWith('/')) candidates.push(`public/${candidate}`);
    const found = candidates.find(name => byPath.has(name));
    if (!found) throw compileError(`Website-Datei fehlt: ${candidate.slice(0, 180)}`);
    return found;
  }
  function dataUrl(name) {
    const file = byPath.get(name);
    return `data:${MIME[path.posix.extname(name).toLowerCase()] || 'application/octet-stream'};base64,${websiteFileBytes(file).toString('base64')}`;
  }
  function assetUrl(value, importer) {
    if (external(value)) return value;
    return dataUrl(resolveFile(value, importer));
  }
  function cssAssets(css, importer = 'index.html') {
    return css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, _quote, value) => `url("${assetUrl(value.trim(), importer)}")`);
  }
  async function classicScript(contents) {
    try {
      const result = await esbuild.transform(contents, { loader: 'js', target: 'es2020', legalComments: 'none', logLevel: 'silent' });
      return `<script>${scriptText(result.code)}</script>`;
    } catch (error) { throw compileError(error.errors?.map(item => item.text).slice(0, 4).join('\n') || error.message); }
  }
  function browserPackage(specifier) {
    if (specifier.startsWith('node:') || BUILTINS.has(specifier)) throw compileError(`Node.js-Modul ${specifier} kann nicht in einer Browser-Website ausgeführt werden.`);
    const { name, subpath } = packageParts(specifier);
    if (['next', 'nuxt', 'astro', 'vite', 'esbuild', 'typescript', 'tailwindcss', 'postcss'].includes(name)) throw compileError(`Build-Paket ${name} darf nicht als Browser-Code importiert werden.`);
    const version = pinnedVersion(dependencies[name], name);
    imported.add(name);
    const suffix = subpath ? `/${subpath}` : '';
    // Shared peers stay bare inside CDN modules and resolve through one import
    // map, so hooks do not see separate copies of the React runtime.
    const peers = ['react', 'react-dom', 'three'].filter(peer => peer !== name && dependencies[peer]);
    browserImports[specifier] = `https://esm.sh/${name}@${version}${suffix}${peers.length ? `?external=${peers.join(',')}` : ''}`;
    for (const peer of ['react', 'react-dom', 'three'].filter(peer => dependencies[peer])) {
      const peerVersion = pinnedVersion(dependencies[peer], peer);
      const peerSuffix = peer === 'react-dom' && dependencies.react ? '?external=react' : '';
      browserImports[peer] ||= `https://esm.sh/${peer}@${peerVersion}${peerSuffix}`;
      if (peer === 'react') {
        browserImports['react/jsx-runtime'] = `https://esm.sh/react@${peerVersion}/jsx-runtime?external=react`;
        browserImports['react/jsx-dev-runtime'] = `https://esm.sh/react@${peerVersion}/jsx-dev-runtime?external=react`;
      }
      if (peer === 'three') browserImports['three/'] = `https://esm.sh/three@${peerVersion}/`;
    }
    return specifier;
  }
  function rewriteAssetLiterals(contents, importer) {
    // Vite public assets also occur in JSX attributes and fetch()/URL() strings.
    return contents.replace(/(["'])(\/[^"'\n]+)\1/g, (match, quote, value) => {
      try {
        const name = resolveFile(value, importer);
        if (['.js', '.jsx', '.ts', '.tsx', '.css', '.html', '.json'].includes(path.posix.extname(name))) return match;
        return `${quote}${dataUrl(name)}${quote}`;
      } catch { return match; }
    }).replace(/new\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g, (_match, _quote, value) => `new URL(${JSON.stringify(assetUrl(value, importer))})`);
  }
  async function bundle(entry, kind = 'js') {
    const virtual = new Map();
    let entryName = entry.path;
    if (entry.contents != null) { entryName = `__iva_inline_${cryptoId()}.${kind}`; virtual.set(entryName, entry.contents); }
    const plugin = { name: 'iva-memory-only', setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        try {
          if (args.kind === 'entry-point' && (virtual.has(args.path) || byPath.has(args.path))) return { path: args.path, namespace: 'iva-website' };
          if (args.path.startsWith('node:') || BUILTINS.has(args.path)) throw compileError(`Node.js-Modul ${args.path} ist für diese Website nicht erlaubt.`);
          if (/^https:\/\//i.test(args.path)) {
            const parsed = new URL(args.path);
            if (parsed.username || parsed.password) throw compileError('Paket-URLs dürfen keine Zugangsdaten enthalten.');
            return { path: args.path, external: true };
          }
          if (/^data:/i.test(args.path) && args.kind === 'url-token') return { path: args.path, external: true };
          if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(args.path) || args.path.startsWith('//')) throw compileError('Nur lokale Website-Dateien und HTTPS-Browserpakete sind erlaubt.');
          if (args.path.startsWith('.') || args.path.startsWith('/') || args.path.startsWith('@/') || args.kind === 'url-token' || args.kind === 'import-rule') {
            const importer = virtual.has(args.importer) ? entry.importer || 'index.html' : args.importer || 'index.html';
            if (/[?&]react(?:&|$)/.test(args.path)) throw compileError('SVG-React-Plugins sind nicht eingerichtet. Importiere SVGs als Bild-URL oder verwende direktes JSX.');
            return { path: resolveFile(args.path, importer, true), namespace: 'iva-website', pluginData: { raw: /[?&](?:raw|inline)(?:&|$)/.test(args.path), url: /[?&]url(?:&|$)/.test(args.path) } };
          }
          if (args.path === 'react-router-dom') {
            browserPackage(args.path);
            const original = JSON.stringify(browserImports[args.path]);
            const adapter = '__iva_preview_router_adapter.js';
            virtual.set(adapter, `import * as Router from ${original}; import * as React from 'react'; export * from ${original};
const preview = () => typeof window !== 'undefined' && ['about:', 'data:'].includes(window.location.protocol);
const publicBase = () => typeof window !== 'undefined' ? (window.location.pathname.match(/^\\/s\\/[a-f0-9-]{36}(?:\\/|$)/)?.[0].replace(/\\/$/, '') || '/') : '/';
const memoryOptions = (props = {}) => ({ ...props, initialEntries: props.initialEntries || [props.basename || '/'] });
const browserOptions = (props = {}) => ({ ...props, basename: props.basename || publicBase() });
export function BrowserRouter(props) { return React.createElement(preview() ? Router.MemoryRouter : Router.BrowserRouter, preview() ? memoryOptions(props) : browserOptions(props)); }
export function HashRouter(props) { return React.createElement(preview() ? Router.MemoryRouter : Router.HashRouter, preview() ? memoryOptions(props) : props); }
export function createBrowserRouter(routes, options) { return preview() ? Router.createMemoryRouter(routes, memoryOptions(options)) : Router.createBrowserRouter(routes, browserOptions(options)); }
export function createHashRouter(routes, options) { return preview() ? Router.createMemoryRouter(routes, memoryOptions(options)) : Router.createHashRouter(routes, options); }`);
            warnings.push('Die eingebettete Vorschau nutzt für React Router einen Speicherverlauf. Auf der veröffentlichten HTTPS-Website bleibt der reguläre URL-Verlauf erhalten.');
            return { path: adapter, namespace: 'iva-website' };
          }
          return { path: browserPackage(args.path), external: true };
        } catch (error) { return { errors: [{ text: error.message }] }; }
      });
      build.onLoad({ filter: /.*/ }, async args => {
        if (args.namespace !== 'iva-website') return { errors: [{ text: 'Zugriff außerhalb der virtuellen Website ist gesperrt.' }] };
        if (virtual.has(args.path)) return { contents: kind === 'css' ? await prepareCss(virtual.get(args.path)) : virtual.get(args.path), loader: kind === 'css' ? 'css' : 'jsx' };
        const file = byPath.get(args.path);
        if (!file) return { errors: [{ text: 'Die Website-Datei wurde nicht bereitgestellt.' }] };
        if (args.pluginData?.raw) return { contents: `export default ${JSON.stringify(textOf(file))};`, loader: 'js' };
        if (args.pluginData?.url) return { contents: `export default ${JSON.stringify(dataUrl(args.path))};`, loader: 'js' };
        const extension = path.posix.extname(args.path).toLowerCase();
        const loader = LOADERS[extension] || 'dataurl';
        if (loader === 'css') {
          return { contents: await prepareCss(textOf(file)), loader };
        }
        return { contents: loader === 'dataurl' ? websiteFileBytes(file) : rewriteAssetLiterals(textOf(file), args.path), loader };
      });
    } };
    let context;
    let timeout;
    try {
      context = await esbuild.context({ entryPoints: [entryName], bundle: true, write: false, absWorkingDir: '/__iva_virtual_website__', outfile: `/__iva_virtual_website__/bundle.${kind}`, platform: 'browser', format: 'esm', target: ['es2020'], jsx: 'automatic', jsxImportSource: 'react', tsconfigRaw: { compilerOptions: { experimentalDecorators: false } }, logLevel: 'silent', legalComments: 'none', minify: false, plugins: [plugin], define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true', 'import.meta.env.MODE': '"production"', 'import.meta.env.BASE_URL': '"./"', 'import.meta.env': '{}' } });
      const result = await Promise.race([context.rebuild(), new Promise((_, reject) => { timeout = setTimeout(() => { void context.cancel(); reject(compileError('Der Website-Build hat das Zeitlimit von 20 Sekunden erreicht.')); }, 20_000); })]);
      warnings.push(...(result.warnings || []).map(item => item.text));
      return { js: result.outputFiles.find(file => file.path.endsWith('.js'))?.text || '', css: result.outputFiles.find(file => file.path.endsWith('.css'))?.text || '' };
    } catch (error) {
      throw compileError(error.errors?.map(item => item.text).slice(0, 6).join('\n') || error.message);
    } finally { clearTimeout(timeout); await context?.dispose(); }
  }

  // Remove document controls that could redirect a preview or override its base.
  html = html.replace(/<base\b[^>]*>/gi, '').replace(/<meta\b[^>]*>/gi, tag => /^(?:content-security-policy|refresh)$/i.test(attributes(tag)['http-equiv'] || '') ? '' : tag);
  const styles = [];
  const linkMatches = [...html.matchAll(/<link\b[^>]*>/gi)];
  for (const match of linkMatches) {
    const attr = attributes(match[0]);
    if (attr.rel?.toLowerCase() === 'stylesheet' && attr.href && !external(attr.href)) {
      const result = await bundle({ path: resolveFile(attr.href) }, 'css');
      styles.push(result.css);
      html = html.replace(match[0], '');
    } else if (attr.href && /^(?:icon|shortcut icon|apple-touch-icon)$/i.test(attr.rel || '') && !external(attr.href)) html = html.replace(match[0], match[0].replace(attr.href, escapeAttribute(assetUrl(attr.href, 'index.html'))));
  }
  const scriptMatches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  for (const match of scriptMatches) {
    const attr = attributes(match[1]);
    if (attr.type && !/^(?:module|text\/javascript|application\/javascript)$/i.test(attr.type)) continue;
    if (attr.src && external(attr.src)) continue;
    let replacement;
    if (attr.type?.toLowerCase() === 'module') {
      const result = await bundle(attr.src ? { path: resolveFile(attr.src) } : { contents: match[2], importer: 'index.html' });
      replacement = `<script type="module">${scriptText(result.js)}</script>`;
      if (result.css) styles.push(result.css);
    } else if (attr.src) {
      const name = resolveFile(attr.src);
      if (!/\.(?:m?js|cjs)$/i.test(name)) throw compileError('Klassische Script-Dateien müssen JavaScript enthalten.');
      replacement = await classicScript(rewriteAssetLiterals(textOf(byPath.get(name)), name));
    } else replacement = await classicScript(match[2]);
    html = html.replace(match[0], replacement);
  }
  const protectedScripts = [];
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, script => { const marker = `<!--IVA-COMPILED-SCRIPT-${cryptoId()}-->`; protectedScripts.push([marker, script]); return marker; });
  html = html.replace(/<(?:img|source|video|audio|input)\b[^>]*>/gi, tag => tag.replace(/\b(src|poster)\s*=\s*(["'])([^"']+)\2/gi, (match, name, quote, value) => external(value) ? match : `${name}=${quote}${escapeAttribute(assetUrl(value, 'index.html'))}${quote}`));
  html = html.replace(/<(?:img|source)\b[^>]*>/gi, tag => tag.replace(/\bsrcset\s*=\s*(["'])([^"']+)\1/gi, (match, quote, value) => {
    if (/data:/i.test(value)) return match;
    const urls = value.split(',').map(item => { const parts = item.trim().split(/\s+/); parts[0] = assetUrl(parts[0], 'index.html'); return parts.join(' '); });
    return `srcset=${quote}${escapeAttribute(urls.join(', '))}${quote}`;
  }));
  const inlineStyles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)];
  for (const [tag, css] of inlineStyles) html = html.replace(tag, tag.replace(css, styleText(cssAssets(await prepareCss(css)))));
  html = html.replace(/<[a-z][^>]*>/gi, tag => tag.replace(/\bstyle\s*=\s*(["'])([^"']+)\1/gi, (_match, quote, css) => `style=${quote}${escapeAttribute(cssAssets(css))}${quote}`));
  const importMap = Object.keys(browserImports).length ? `<script type="importmap">${scriptText(JSON.stringify({ imports: browserImports }))}</script>` : '';
  const head = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(CSP)}"><meta name="referrer" content="no-referrer">${importMap}${styles.length ? `<style>${styleText(styles.join('\n'))}</style>` : ''}`;
  if (/<head\b[^>]*>/i.test(html)) html = html.replace(/<head\b[^>]*>/i, tag => `${tag}${head}`);
  else if (/<html\b[^>]*>/i.test(html)) html = html.replace(/<html\b[^>]*>/i, tag => `${tag}<head>${head}</head>`);
  else if (/<!doctype\b[^>]*>/i.test(html)) html = html.replace(/<!doctype\b[^>]*>/i, tag => `${tag}<head>${head}</head>`);
  else html = `<head>${head}</head>${html}`;
  for (const [marker, script] of protectedScripts) html = html.replace(marker, script);
  if (imported.size) warnings.push(`Browser-Pakete werden über HTTPS von esm.sh geladen: ${[...imported].join(', ')}.`);
  if (Buffer.byteLength(html) > 20 * 1024 * 1024) throw compileError('Die fertige Website überschreitet 20 MiB.');
  return { html, status: 'ready', errors: [], warnings: [...new Set(warnings)].slice(0, 30) };
}

let inlineSequence = 0;
function cryptoId() { inlineSequence += 1; return inlineSequence.toString(36); }
