import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export function createWebsiteConnections({ dataDir, env = process.env, fetchImpl = fetch }) {
  const filename = path.join(dataDir, 'website-connections.json');
  let queue = Promise.resolve();
  function key() {
    const bytes = Buffer.from(env.IVA_PROJECT_CONNECTIONS_KEY || '', 'base64');
    if (bytes.length !== 32) throw fail('Die verschlüsselte Ablage für Website-Zugänge ist noch nicht eingerichtet.', 503);
    return bytes;
  }
  async function resolveEnv() {
    let record;
    try { record = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { GITHUB_TOKEN: env.GITHUB_TOKEN || env.GH_TOKEN || '' }; throw fail('Website-Verbindung konnte nicht gelesen werden.', 503); }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(record.iv, 'base64'));
      decipher.setAAD(Buffer.from('iva-website-github-v1'));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
      return { GITHUB_TOKEN: Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()]).toString('utf8') };
    } catch { throw fail('Website-Verbindung konnte nicht entschlüsselt werden.', 503); }
  }
  async function status() {
    const configured = Boolean((await resolveEnv()).GITHUB_TOKEN);
    let record = null;
    try { record = JSON.parse(await fs.readFile(filename, 'utf8')); } catch {}
    return { configured, status: configured ? record?.verifiedAt ? 'verified' : 'configured' : 'missing_connection', login: configured ? record?.login || null : null, verifiedAt: configured ? record?.verifiedAt || null : null };
  }
  async function save({ githubToken }) {
    key();
    if (typeof githubToken !== 'string' || githubToken.length < 20 || githubToken.length > 4096 || /\s|[\x00-\x1f]/.test(githubToken)) throw fail('Bitte einen gültigen GitHub-Zugang eingeben.');
    let response;
    try { response = await fetchImpl('https://api.github.com/user', { headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'IVA-Website-Studio' }, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('GitHub konnte zur Prüfung des Zugangs nicht erreicht werden.', 502); }
    if (!response.ok) throw fail('GitHub hat den Zugang nicht bestätigt. Konto und Berechtigungen prüfen.', 400);
    const user = await response.json();
    if (!/^[a-z\d-]{1,39}$/i.test(user.login || '')) throw fail('GitHub lieferte keine gültige Kontoidentität.', 502);
    const previous = queue;
    queue = previous.catch(() => {}).then(async () => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
      cipher.setAAD(Buffer.from('iva-website-github-v1'));
      const data = Buffer.concat([cipher.update(githubToken, 'utf8'), cipher.final()]);
      const record = { version: 1, login: user.login, verifiedAt: new Date().toISOString(), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, filename);
      return { configured: true, status: 'verified', login: user.login, verifiedAt: record.verifiedAt };
    });
    return queue;
  }
  return { resolveEnv, status, save };
}
