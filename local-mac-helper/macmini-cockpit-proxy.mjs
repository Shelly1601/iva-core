import http from 'node:http';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {assertImacExecutionHost} from './imac-host-guard.mjs';
const exec = promisify(execFile);
export function isLocalCockpitRequest(req, port = 4318) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  if (!hosts.includes(String(req.headers.host || ''))) return false;
  if (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}
export function createCockpitProxy({token, port = 4318, upstream = 'https://iva-core-production.up.railway.app'} = {}) {
  if (String(token || '').length < 48) throw new Error('Der lokale Cockpit-Zugang fehlt.');
  const target = new URL(upstream);
  if (target.protocol !== 'https:') throw new Error('IVA benötigt eine geprüfte HTTPS-Verbindung.');
  return http.createServer((req, res) => {
    if (!isLocalCockpitRequest(req, port) || !req.url.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'}).end('IVA ist ausschließlich lokal auf diesem Mac Mini verfügbar.'); return;
    }
    if (req.url === '/local-health') {
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({mode:'mac-mini-only',deviceId:'macmini-nadine',local:true})); return;
    }
    const headers = {...req.headers,host:target.host,'x-iva-macmini-cockpit':token};
    delete headers.connection; delete headers['proxy-authorization']; delete headers['x-forwarded-for'];
    const remote = https.request({hostname:target.hostname,port:target.port || 443,path:req.url,method:req.method,headers}, response => {
      const incoming={...response.headers,'cache-control':'no-store'};
      delete incoming['access-control-allow-origin'];
      if(incoming.location?.startsWith(target.origin))incoming.location=incoming.location.slice(target.origin.length)||'/';
      res.writeHead(response.statusCode,incoming); response.pipe(res);
    });
    remote.on('error', () => {if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'IVA-Verbindung wird wiederhergestellt. Bereits angenommene Aufträge bleiben gespeichert.'}))});
    req.on('aborted',()=>remote.destroy());
    req.pipe(remote);
  });
}
if(process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url){
  assertImacExecutionHost();
  const {stdout}=await exec('/usr/bin/security',['find-generic-password','-a','macmini-nadine','-s','de.iva.macmini-cockpit','-w']);
  createCockpitProxy({token:stdout.trim()}).listen(4318,'127.0.0.1',()=>console.log('IVA Cockpit: http://127.0.0.1:4318/cockpit · ausschließlich dieser Mac Mini'));
}
