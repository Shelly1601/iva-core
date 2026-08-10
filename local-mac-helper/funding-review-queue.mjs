import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';

function dataRoot() {
  return process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper');
}

export function defaultFundingReviewDirectory() {
  return path.join(dataRoot(), 'funding-reviews');
}

function validFingerprint(value) {
  const fingerprint = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('Förder-Prüfobjekt besitzt keinen gültigen Nachrichten-Fingerprint.');
  return fingerprint;
}

export function fundingReviewFile(fingerprint, directory = defaultFundingReviewDirectory()) {
  return path.join(path.resolve(directory), `${validFingerprint(fingerprint)}.json`);
}

export async function saveFundingReview(review, { directory = defaultFundingReviewDirectory() } = {}) {
  const fingerprint = validFingerprint(review?.messageFingerprint);
  const target = fundingReviewFile(fingerprint, directory);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const value = {
    version: 1,
    createdAt: review.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...review,
    messageFingerprint: fingerprint,
    sent: false,
  };
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { ...value, savedTo: target };
}

export async function loadFundingReview(fingerprint, { directory = defaultFundingReviewDirectory() } = {}) {
  return JSON.parse(await readFile(fundingReviewFile(fingerprint, directory), 'utf8'));
}

export async function fundingReviewExists(fingerprint, { directory = defaultFundingReviewDirectory() } = {}) {
  try { await readFile(fundingReviewFile(fingerprint, directory), 'utf8'); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

export async function listFundingReviews({ directory = defaultFundingReviewDirectory() } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = (await readdir(directory)).filter(name => /^[0-9a-f]{64}\.json$/i.test(name)).sort();
  const reviews = [];
  for (const file of files) {
    try { reviews.push(JSON.parse(await readFile(path.join(directory, file), 'utf8'))); }
    catch (error) { reviews.push({ file, status: 'invalid_review_file', error: String(error.message || error).slice(0, 240) }); }
  }
  return reviews.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}
