import crypto from 'node:crypto';
export function hasMacMiniCockpitAccess(headers = {}, token = process.env.MACMINI_COCKPIT_TOKEN) {
  const expected = Buffer.from(String(token || ''));
  const actual = Buffer.from(String(headers['x-iva-macmini-cockpit'] || ''));
  return expected.length >= 48 && actual.length === expected.length && crypto.timingSafeEqual(expected, actual);
}
export function macMiniAccessMiddleware(req, res, next) {
  // Device routes use a separate, newly issued credential and hardware binding.
  if (req.path.startsWith('/device-agent/')) return next();
  if (req.path === '/health' || req.path === '/') return res.status(200).json({service:'IVA', mode:'mac-mini-only'});
  if (hasMacMiniCockpitAccess(req.headers)) return next();
  res.set('Cache-Control', 'no-store');
  const message = 'IVA ist nur auf dem freigegebenen Mac Mini verfügbar. iMac, MacBook und andere Geräte sind gesperrt. Öffne IVA am Mac Mini über http://127.0.0.1:4318/cockpit.';
  if (req.path.startsWith('/api/') || req.method !== 'GET') return res.status(403).json({error:message,code:'IVA_MAC_MINI_ONLY'});
  return res.status(403).type('html').send(`<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>IVA · Nur Mac Mini</title><body style="background:#081226;color:#eff5ff;font:18px system-ui;padding:12vh 8vw"><h1>IVA · Nur Mac Mini</h1><p>${message}</p></body></html>`);
}
