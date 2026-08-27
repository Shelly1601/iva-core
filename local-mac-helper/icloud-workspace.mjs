import { execFile } from 'node:child_process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ICLOUD_MARKER = '/Library/Mobile Documents/com~apple~CloudDocs/';
const TRANSIENT_CODES = new Set(['EAGAIN', 'EDEADLK', 'ENOENT', 'EBUSY']);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function isTransientIcloudError(error) {
  return TRANSIENT_CODES.has(error?.code)
    || Number(error?.errno) === -11
    || /resource deadlock avoided|temporarily unavailable|not downloaded/i.test(String(error?.message || error || ''));
}

export function isIcloudWorkspace(workspace) {
  return path.resolve(String(workspace || '')).includes(ICLOUD_MARKER);
}

async function readWithRetry(file, { attempts, read, waitFn, readTimeoutMs }) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let timer;
      const value = await Promise.race([read(file), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('iCloud-Dateizugriff hat das Zeitlimit erreicht')), readTimeoutMs); })]).finally(() => clearTimeout(timer));
      return { file, bytes: value.length, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isTransientIcloudError(error) || attempt === attempts) break;
      await waitFn(Math.min(750 * attempt, 4_000));
    }
  }
  throw new Error(`iCloud-Datei blieb nach ${attempts} Versuchen nicht lesbar (${file}): ${lastError?.message || lastError}`);
}

export async function materializeIcloudWorkspace({
  workspace,
  attempts = 3,
  readTimeoutMs = 5000,
  exec = execFileAsync,
  read = readFile,
  waitFn = wait,
} = {}) {
  const root = path.resolve(String(workspace || ''));
  if (!isIcloudWorkspace(root)) return { workspace: root, iCloud: false, materialized: false, probes: [] };

  const download = await exec('/usr/bin/brctl', ['download', root], {
    timeout: 8_000,
    maxBuffer: 256 * 1024,
  }).then(() => ({ requested: true, error: '' })).catch(error => ({
    requested: false,
    error: String(error?.message || error).slice(0, 300),
  }));

  const probes = [];
  const fileDownloads = [];
  for (const file of [
    path.join(root, '..', 'AGENTS.md'),
    path.join(root, 'package.json'),
    path.join(root, 'local-mac-helper', 'device-agent.mjs'),
    path.join(root, '.git', 'HEAD'),
  ]) {
    // Der Ordner-Download materialisiert keine danebenliegende AGENTS.md.
    // Fordere deshalb jede tatsächlich benötigte Datei gezielt an, bevor ein
    // EAGAIN-Placeholder fälschlich als dauerhafter Blocker gewertet wird.
    fileDownloads.push(await exec('/usr/bin/brctl', ['download', file], {
      timeout: 8_000,
      maxBuffer: 256 * 1024,
    }).then(() => ({ file, requested: true, error: '' })).catch(error => ({
      file,
      requested: false,
      error: String(error?.message || error).slice(0, 300),
    })));
    probes.push(await readWithRetry(file, { attempts, read, waitFn, readTimeoutMs }));
  }

  return {
    workspace: root,
    iCloud: true,
    materialized: true,
    download,
    fileDownloads,
    probes,
  };
}
