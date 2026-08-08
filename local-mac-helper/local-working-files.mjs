import os from 'node:os';
import path from 'node:path';
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, stat, unlink } from 'node:fs/promises';

const DEFAULT_DOWNLOADS_ROOT = path.join(os.homedir(), 'Downloads');
const DEFAULT_WORKING_ROOT = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'IVA Mac Helper',
  'tmp',
  'funding-downloads',
);
const MAX_WORKING_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.heic']);

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeSegment(value, fallback = 'deal') {
  return String(value || fallback).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || fallback;
}

export async function stageFundingWorkingCopy(sourcePath, {
  dealId,
  consumeDownloadedCopy = false,
  downloadsRoot = DEFAULT_DOWNLOADS_ROOT,
  workingRoot = DEFAULT_WORKING_ROOT,
} = {}) {
  const suppliedPath = String(sourcePath || '');
  if (!suppliedPath || !path.isAbsolute(suppliedPath)) throw new Error('Für die lokale Arbeitskopie fehlt ein absoluter Dateipfad.');
  const requestedPath = path.resolve(suppliedPath);
  const source = await realpath(requestedPath);
  const metadata = await stat(source);
  if (!metadata.isFile()) throw new Error('Die lokale Arbeitskopie muss eine reguläre Datei sein.');
  if (metadata.size <= 0 || metadata.size > MAX_WORKING_FILE_BYTES) throw new Error('Die lokale Arbeitskopie ist leer oder größer als 50 MB.');
  const extension = path.extname(source).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('Für Förderunterlagen sind lokal nur PDF- und Bilddateien erlaubt.');
  const resolvedDownloadsRoot = await realpath(downloadsRoot).catch(() => path.resolve(downloadsRoot));
  if (consumeDownloadedCopy && !isInside(resolvedDownloadsRoot, source)) {
    throw new Error('Automatisch entfernt werden ausschließlich ausdrücklich markierte Downloads aus dem Downloads-Ordner.');
  }

  await mkdir(workingRoot, { recursive: true, mode: 0o700 });
  const resolvedWorkingRoot = await realpath(workingRoot);
  const jobDirectory = await mkdtemp(path.join(resolvedWorkingRoot, `${safeSegment(dealId)}-`));
  const workingPath = path.join(jobDirectory, `${safeSegment(path.basename(source, extension), 'dokument')}${extension}`);
  try {
    if (consumeDownloadedCopy) {
      try {
        await rename(source, workingPath);
      } catch (error) {
        if (error?.code !== 'EXDEV') throw error;
        await copyFile(source, workingPath);
        await unlink(source);
      }
    } else {
      await copyFile(source, workingPath);
    }
  } catch (error) {
    await rm(jobDirectory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    sourcePath: source,
    workingPath,
    jobDirectory,
    consumedDownloadedCopy: consumeDownloadedCopy,
  };
}

export async function cleanupFundingWorkingCopy(handle, { workingRoot = DEFAULT_WORKING_ROOT } = {}) {
  if (!handle?.jobDirectory) throw new Error('Bereinigung abgebrochen: Es fehlt ein IVA-Förder-Arbeitsordner.');
  const resolvedWorkingRoot = await realpath(workingRoot);
  const jobDirectory = await realpath(path.resolve(String(handle.jobDirectory)));
  if (!isInside(resolvedWorkingRoot, jobDirectory) || jobDirectory === resolvedWorkingRoot) {
    throw new Error('Bereinigung abgebrochen: Ziel liegt nicht in einem IVA-Förder-Arbeitsordner.');
  }
  await rm(jobDirectory, { recursive: true, force: true });
  return {
    localWorkingCopyDeleted: true,
    consumedDownloadedCopy: Boolean(handle.consumedDownloadedCopy),
    pipedriveFileDeleted: false,
  };
}

export function fundingWorkingFilePolicy() {
  return Object.freeze({
    downloadsRoot: DEFAULT_DOWNLOADS_ROOT,
    workingRoot: DEFAULT_WORKING_ROOT,
    deleteOnlyManagedLocalCopies: true,
    deletePipedriveFiles: false,
  });
}
