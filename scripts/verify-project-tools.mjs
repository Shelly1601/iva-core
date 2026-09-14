import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectSkill } from '../projects/tools.js';
import { prepareIvaTool } from '../core/tool-discovery.js';
import { filterProjectTools } from '../core/project-scope.js';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-project-tool-test-'));
process.env.DATA_DIR = directory;
const { createProject, getProject, storeProjectFile, readProjectFile, addProjectNote } = await import('../projects/store.js');
after(() => fs.rm(directory, { recursive: true, force: true }));
const alpha = await createProject({ name: 'Alpha Test Project', description: 'Alpha only' });
const beta = await createProject({ name: 'Beta Test Project', description: 'Beta only' });
const alphaFile = await storeProjectFile(alpha.id, { name: 'alpha.txt', mime: 'text/plain', buffer: Buffer.from('Alpha own source.') });
const betaFile = await storeProjectFile(beta.id, { name: 'beta.txt', mime: 'text/plain', buffer: Buffer.from('Beta private source.') });
const connectionCalls = [];
const tools = projectSkill({ projectId: alpha.id, getProject, readProjectFile, addProjectNote, connections: { list: async id => { connectionCalls.push(id); return { items: [{ provider: 'instagram', configured: false }] }; } } });
const bound = filterProjectTools({}, { projectId: alpha.id, projectTools: tools });

test('actual project store prevents reading a valid file ID belonging to another project', async () => {
  const own = await bound.readCurrentProjectFile.execute({ fileId: alphaFile.id });
  assert.equal(own.ok, true); assert.equal(own.projectId, alpha.id); assert.equal(own.text, 'Alpha own source.');
  assert.match(own.source, new RegExp(`/projects/${alpha.id}/files/${alphaFile.id}`));
  const foreign = await bound.readCurrentProjectFile.execute({ fileId: betaFile.id });
  assert.equal(foreign.ok, false); assert.doesNotMatch(JSON.stringify(foreign), /Beta private source/);
  assert.equal(await readProjectFile(alpha.id, betaFile.id), null);
});

test('project manifest, connections and saved notes stay in their bound project', async () => {
  const current = await bound.getCurrentProject.execute({});
  assert.equal(current.id, alpha.id); assert.ok(current.files.some(file => file.id === alphaFile.id));
  assert.ok(!current.files.some(file => file.id === betaFile.id));
  assert.doesNotMatch(JSON.stringify(current), /storageName/);
  await bound.listCurrentProjectConnections.execute({}); assert.deepEqual(connectionCalls, [alpha.id]);
  const result = await bound.addCurrentProjectNote.execute({ text: 'Alpha scoped result.' });
  assert.equal(result.saved, true); assert.equal(result.projectId, alpha.id);
  assert.ok((await getProject(alpha.id)).notes.some(note => note.text === 'Alpha scoped result.'));
  assert.ok(!(await getProject(beta.id)).notes.some(note => note.text === 'Alpha scoped result.'));
  await assert.rejects(() => bound.addCurrentProjectNote.execute({ text: 'Attempt to switch', projectId: beta.id }));
});

test('file reader enforces byte/text caps and marks unsupported formats without false results', async () => {
  const base = { projectId: alpha.id, getProject: async () => alpha, addProjectNote, connections: { list: async () => ({ items: [] }) } };
  const big = projectSkill({ ...base, readProjectFile: async () => ({ meta: { name: 'huge.txt', mime: 'text/plain' }, buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }) });
  assert.equal((await big.readCurrentProjectFile.execute({ fileId: 'big' })).ok, false);
  const text = projectSkill({ ...base, readProjectFile: async () => ({ meta: { name: 'long.txt', mime: 'text/plain' }, buffer: Buffer.from('x'.repeat(19000)) }) });
  const long = await text.readCurrentProjectFile.execute({ fileId: 'long' });
  assert.equal(long.text.length, 18000); assert.equal(long.truncated, true);
  const image = projectSkill({ ...base, readProjectFile: async () => ({ meta: { name: 'scan.png', mime: 'image/png' }, buffer: Buffer.from('image bytes') }) });
  const unsupported = await image.readCurrentProjectFile.execute({ fileId: 'scan' });
  assert.equal(unsupported.ok, false); assert.equal(unsupported.text, undefined);
});

test('prepared project tool schemas enforce required IDs and note length before storage', async () => {
  let writes = 0;
  const original = projectSkill({ projectId: alpha.id, getProject: async () => alpha, readProjectFile, addProjectNote: async () => { writes++; return alpha; }, connections: { list: async () => ({}) } });
  await assert.rejects(() => prepareIvaTool(original.readCurrentProjectFile).execute({ fileId: null }));
  await assert.rejects(() => prepareIvaTool(original.readCurrentProjectFile).execute({ fileId: 'x'.repeat(101) }));
  await assert.rejects(() => prepareIvaTool(original.addCurrentProjectNote).execute({ text: '' }));
  await assert.rejects(() => prepareIvaTool(original.addCurrentProjectNote).execute({ text: 'x'.repeat(6001) }));
  assert.equal(writes, 0);
});

test('failed or vanished project writes cannot be reported as saved', async () => {
  const original = projectSkill({ projectId: alpha.id, getProject: async () => alpha, readProjectFile, addProjectNote: async () => null, connections: { list: async () => ({}) } });
  let output;
  try { output = await original.addCurrentProjectNote.execute({ text: 'Unstored note' }); }
  catch { return; }
  assert.notEqual(output?.saved, true);
  assert.notEqual(output?.ok, true);
});

test('LLM connection status distinguishes provider catalog, metadata and configured project accounts', async () => {
  const cases = [
    { name: 'catalog-only', items: [], connectionCount: 0, configuredAccountCount: 0 },
    { name: 'metadata-only', items: [{ provider: 'instagram', label: 'Alpha planned account', handle: 'alpha_profile', configured: false, hasToken: false, status: 'missing_connection' }], connectionCount: 1, configuredAccountCount: 0 },
    { name: 'configured-account', items: [{ provider: 'instagram', label: 'Alpha configured account', handle: 'alpha_profile', configured: true, hasToken: true, status: 'configured', verifiedAt: null }], connectionCount: 1, configuredAccountCount: 1 },
  ];
  for (const fixture of cases) {
    const requestedProjects = [];
    const original = projectSkill({
      projectId: alpha.id, getProject: async () => alpha, readProjectFile, addProjectNote,
      connections: { list: async projectId => {
        requestedProjects.push(projectId);
        assert.equal(projectId, alpha.id);
        return {
          items: fixture.items,
          providers: [{ id: 'instagram', label: 'CATALOG_IS_NOT_A_CONNECTED_ACCOUNT', configured: true }],
          encryptionReady: true,
        };
      } },
    });
    const scoped = filterProjectTools({}, { projectId: alpha.id, projectTools: original });
    const output = await prepareIvaTool(scoped.listCurrentProjectConnections).execute({});
    assert.deepEqual(requestedProjects, [alpha.id], fixture.name);
    assert.equal(output.projectId, alpha.id, fixture.name);
    assert.equal(output.connectionCount, fixture.connectionCount, fixture.name);
    assert.equal(output.configuredAccountCount, fixture.configuredAccountCount, fixture.name);
    assert.deepEqual(output.connections, fixture.items, fixture.name);
    assert.equal(output.providers, undefined, fixture.name);
    assert.equal(output.encryptionReady, undefined, fixture.name);
    assert.doesNotMatch(JSON.stringify(output), /CATALOG_IS_NOT_A_CONNECTED_ACCOUNT/, fixture.name);
    assert.equal(typeof output.summary, 'string', fixture.name);
    assert.ok(output.summary.trim(), fixture.name);
    if (fixture.configuredAccountCount === 0) assert.match(output.summary, /kein|nicht|fehl|vorgemerkt|noch|\b0\b/i, fixture.name);
    if (fixture.name === 'catalog-only') assert.deepEqual(output.connections, []);
    if (fixture.name === 'configured-account') assert.equal(output.connections[0].verifiedAt, null, 'Configured must not become verified.');
  }
});
