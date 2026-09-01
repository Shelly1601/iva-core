import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';

const execAsync = promisify(execFile);
export const CENTRAL_RUNTIME_VERSION = 'imac-central-v8';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const allowedPath = value => /^local-mac-helper\/[a-z0-9-]+\.mjs$/.test(value)
  || /^local-mac-helper\/macos\/[a-z0-9-]+\.swift$/.test(value)
  || ['local-mac-helper/runtime-package.json', 'local-mac-helper/manufacturer-lead-config.json', 'local-mac-helper/assets/heat-hero-logo.png', 'operations/customer-scheduling.js', 'projects/dewarmte.js', 'projects/dewarmte-material-standard.js'].includes(value);

// Only deployed source files, never .env, credentials, customer files or outputs.
export async function buildCentralRuntimeBundle(repo) {
  const names = (await readdir(path.join(repo, 'local-mac-helper')))
    .map(name => `local-mac-helper/${name}`).filter(allowedPath);
  names.push('local-mac-helper/macos/iva-ax.swift', 'local-mac-helper/macos/iva-whatsapp-probe.swift',
    'local-mac-helper/assets/heat-hero-logo.png', 'operations/customer-scheduling.js', 'projects/dewarmte.js', 'projects/dewarmte-material-standard.js');
  const files = [];
  for (const name of names.sort()) {
    const bytes = await readFile(path.join(repo, name));
    files.push({ path: name, sha256: digest(bytes), content: bytes.toString('base64') });
  }
  return { version: CENTRAL_RUNTIME_VERSION, revision: digest(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 })))), files };
}

export function validateCentralRuntimeBundle(bundle) {
  if (bundle?.version !== CENTRAL_RUNTIME_VERSION || !Array.isArray(bundle.files) || bundle.files.length > 150) throw new Error('Unbekanntes IVA-Laufzeitpaket.');
  const names = new Set();
  let size = 0;
  for (const file of bundle.files) {
    if (!allowedPath(file.path) || names.has(file.path)) throw new Error('Unzulässiger oder doppelter Laufzeitpfad.');
    names.add(file.path);
    const bytes = Buffer.from(file.content || '', 'base64');
    size += bytes.length;
    if (size > 12 * 1024 * 1024 || digest(bytes) !== file.sha256) throw new Error('IVA-Laufzeitpaket hat die Inhaltsprüfung nicht bestanden.');
  }
  for (const required of ['local-mac-helper/device-agent-runner.mjs', 'local-mac-helper/device-agent.mjs', 'local-mac-helper/central-runtime.mjs', 'local-mac-helper/runtime-package.json', 'operations/customer-scheduling.js', 'projects/dewarmte-material-standard.js']) {
    if (!names.has(required)) throw new Error(`IVA-Laufzeitpaket unvollständig: ${required}`);
  }
  const revision = digest(JSON.stringify(bundle.files.map(({ path, sha256 }) => ({ path, sha256 }))));
  if (revision !== bundle.revision) throw new Error('IVA-Laufzeitrevision stimmt nicht.');
  return bundle;
}

export function centralRuntimeRoot() {
  return path.join(process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'), 'runtime', 'central');
}

export async function prepareCentralRuntime(bundle, { root = centralRuntimeRoot(), exec = execAsync, dependencyRoot } = {}) {
  validateCentralRuntimeBundle(bundle);
  const target = path.join(root, 'releases', bundle.revision);
  const installed = await readFile(path.join(target, 'release.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (installed?.revision === bundle.revision) return target;
  const staging = `${target}.staging-${crypto.randomUUID()}`;
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of bundle.files) {
      const destination = path.join(staging, file.path);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, Buffer.from(file.content, 'base64'), { mode: 0o600 });
    }
    const packageBytes = await readFile(path.join(staging, 'local-mac-helper/runtime-package.json'));
    await writeFile(path.join(staging, 'package.json'), packageBytes);
    const previousPackage = dependencyRoot && await readFile(path.join(dependencyRoot, 'package.json')).catch(() => null);
    // Resolve the dependency directory before linking it into the immutable
    // release. `dependencyRoot` may be the moving `current` symlink; keeping
    // that unresolved would turn node_modules into a self-referential loop as
    // soon as the new release becomes current.
    const reusableNodeModules = previousPackage?.equals(packageBytes)
      ? await realpath(path.join(dependencyRoot, 'node_modules')).catch(() => null)
      : null;
    if (reusableNodeModules) {
      await symlink(reusableNodeModules, path.join(staging, 'node_modules'));
    } else {
      await exec(path.join(path.dirname(process.execPath), 'npm'), ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: staging, timeout: 180_000, maxBuffer: 1024 * 1024 });
    }
    for (const file of bundle.files.filter(file => /\.(mjs|js)$/.test(file.path))) {
      await exec(process.execPath, ['--check', path.join(staging, file.path)], { timeout: 15_000, maxBuffer: 256 * 1024 });
    }
    await exec(process.execPath, ['--input-type=module', '-e', 'await Promise.all([import("./local-mac-helper/device-agent.mjs"),import("./local-mac-helper/codex-tasks.mjs"),import("./local-mac-helper/planbar.mjs")])'], { cwd: staging, timeout: 30_000, maxBuffer: 256 * 1024 });
    await writeFile(path.join(staging, 'release.json'), JSON.stringify({ revision: bundle.revision, version: bundle.version, installedAt: new Date().toISOString() }));
    await rename(staging, target);
    return target;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function activateCentralRuntime(target, { root = centralRuntimeRoot() } = {}) {
  if (path.dirname(path.resolve(target)) !== path.join(path.resolve(root), 'releases')) throw new Error('Laufzeit liegt außerhalb des IVA-Installationsordners.');
  const temporary = path.join(root, `.current-${crypto.randomUUID()}`);
  await symlink(target, temporary);
  await rename(temporary, path.join(root, 'current'));
}
