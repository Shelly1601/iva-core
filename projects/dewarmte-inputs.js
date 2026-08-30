import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || '/data';
const INPUT_DIR = path.join(DATA_DIR, 'dewarmte-inputs');
const MAX_BYTES = 15 * 1024 * 1024;
export const DEWARMTE_INPUT_RETENTION_MS = 3 * 24 * 60 * 60_000;

function safeId(value) {
  const id = String(value || '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Ungültige DeWarmte-Zusatzdatei.');
  return id;
}

function safeName(value) {
  const name = path.basename(String(value || '').replace(/\u0000/g, '').trim()).slice(0, 240);
  return name && /\.pdf$/i.test(name) ? name : 'DeWarmte_Zusatzinformation.pdf';
}

function pathsFor(id) {
  const safe = safeId(id);
  return { meta: path.join(INPUT_DIR, `${safe}.json`), pdf: path.join(INPUT_DIR, `${safe}.pdf`) };
}

async function removeInput(id) {
  const files = pathsFor(id);
  await Promise.all([fs.rm(files.meta, { force: true }), fs.rm(files.pdf, { force: true })]);
}

export async function storeDewarmteSupplementPdf({ name, buffer, now = Date.now() } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.length > MAX_BYTES
    || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Als Zusatzdatei ist genau eine gültige PDF bis 15 MB erlaubt.');
  }
  const id = crypto.randomUUID();
  const files = pathsFor(id);
  const createdAt = new Date(now).toISOString();
  const meta = {
    id,
    name: safeName(name),
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    createdAt,
    expiresAt: new Date(now + DEWARMTE_INPUT_RETENTION_MS).toISOString(),
  };
  await fs.mkdir(INPUT_DIR, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(files.pdf, buffer, { mode: 0o600 });
    await fs.writeFile(files.meta, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await removeInput(id);
    throw error;
  }
  return meta;
}

export async function readDewarmteSupplementPdf(id, { now = Date.now() } = {}) {
  const files = pathsFor(id);
  const meta = JSON.parse(await fs.readFile(files.meta, 'utf8'));
  if (Date.parse(meta.expiresAt) <= now) {
    await removeInput(id);
    return null;
  }
  const buffer = await fs.readFile(files.pdf);
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Gespeicherte DeWarmte-Zusatzdatei ist keine gültige PDF.');
  return { meta, buffer };
}

export async function getDewarmteSupplementPdfMeta(id, options = {}) {
  try { return (await readDewarmteSupplementPdf(id, options))?.meta || null; }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}

export async function cleanupExpiredDewarmteSupplementPdfs({ now = Date.now() } = {}) {
  const entries = await fs.readdir(INPUT_DIR, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const ids = new Set(entries.filter(item => item.isFile() && /^[a-f0-9-]{36}\.(?:json|pdf)$/i.test(item.name))
    .map(item => item.name.replace(/\.(?:json|pdf)$/i, '')));
  let removed = 0;
  for (const id of ids) {
    const files = pathsFor(id);
    let expired = false;
    try {
      const meta = JSON.parse(await fs.readFile(files.meta, 'utf8'));
      expired = !(Date.parse(meta.expiresAt) > now);
    } catch {
      const info = await fs.stat(files.pdf).catch(() => fs.stat(files.meta).catch(() => null));
      expired = Boolean(info && now - info.mtimeMs >= DEWARMTE_INPUT_RETENTION_MS);
    }
    if (!expired) continue;
    await removeInput(id);
    removed += 1;
  }
  return { removed, retentionDays: 3 };
}
