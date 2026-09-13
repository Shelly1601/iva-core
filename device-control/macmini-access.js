import crypto from 'node:crypto';
import path from 'node:path';
import {realpathSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
export function hasRemoteCockpitAccess(headers = {}, token = process.env.API_TOKEN) {
  const expected = Buffer.from(String(token || ''));
  const actual = Buffer.from(String(headers.authorization || '').replace(/^Bearer\s+/i, ''));
  return expected.length >= 24 && actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
}
function isPublicCockpitFile(requestPath) {
  try {
    const decoded = decodeURIComponent(requestPath);
    if (!decoded.startsWith('/') || decoded.startsWith('//')) return false;
    const relative = decoded === '/pv-schnellrechner' ? 'pv-calculator.html' : decoded.slice(1);
    for (const name of [relative, `${relative}.html`]) {
      const candidate = path.resolve(publicRoot, name);
      if (!candidate.startsWith(publicRoot)) continue;
      try {
        const resolved = realpathSync(candidate);
        if (resolved.startsWith(publicRoot) && statSync(resolved).isFile()) return true;
      } catch {}
    }
  } catch {}
  return false;
}
export function hasMacMiniCockpitAccess(headers = {}, token = process.env.MACMINI_COCKPIT_TOKEN) {
  const expected = Buffer.from(String(token || ''));
  const actual = Buffer.from(String(headers['x-iva-macmini-cockpit'] || ''));
  return expected.length >= 48 && actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
}
export function macMiniAccessMiddleware(req, res, next) {
  // Device routes use a separate, newly issued credential and hardware binding.
  if (req.path.startsWith('/device-agent/')) return next();
  if (req.path === '/health') return res.status(200).json({service:'IVA', mode:'remote-cockpit-mac-mini-execution'});
  if (req.path === '/' && ['GET', 'HEAD'].includes(req.method)) return res.redirect('/cockpit');
  if (hasMacMiniCockpitAccess(req.headers) || hasRemoteCockpitAccess(req.headers)) return next();
  // Only the application shell is public. Data and commands still require the
  // cockpit credential; it can never authenticate a device-agent connection.
  if (['GET', 'HEAD'].includes(req.method) && isPublicCockpitFile(req.path)) return next();
  if (req.path.startsWith('/api/') && req.method === 'OPTIONS') return next();
  res.set('Cache-Control', 'no-store');
  return res.status(req.path.startsWith('/api/') ? 401 : 403).json({error:'Für IVA-Daten und Aufträge ist dein Cockpit-Zugang erforderlich. Das Cockpit ist von überall erreichbar; Rechneraktionen führt ausschließlich der Mac Mini aus.',code:'IVA_COCKPIT_AUTH_REQUIRED'});
}
