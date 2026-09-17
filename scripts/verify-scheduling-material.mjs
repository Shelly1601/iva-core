import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
const root = await mkdtemp(path.join(os.tmpdir(), 'iva-material-'));
process.env.DATA_DIR = root;
const { addCustomerSchedulingRequest, getProject } = await import('../projects/store.js');
const { listDeviceCommands } = await import('../device-control/store.js');
const { buildPlanbarSchedulingExtras, materialAnswerLabel } = await import('../operations/customer-scheduling.js');
const { validatePublicSchedulingInput } = await import('../heat-hero/public-scheduling.js');
const app = express();
app.use(express.json());
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const route = indexSource.slice(indexSource.indexOf("app.post('/api/projects/:id/customer-scheduling-requests'"), indexSource.indexOf("app.post('/api/projects/:id/folders'"));
vm.runInNewContext(route, { app, addCustomerSchedulingRequest });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening',resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/api/projects/heat-hero/customer-scheduling-requests`;
try {
  for (const materialDeliverySpace of [true, false, 'not-asked']) {
    for (const theftWeatherProtected of [true, false, 'not-asked']) {
      const input = { customerName: `Fixture ${String(materialDeliverySpace)} ${String(theftWeatherProtected)}`, partnerId: 'heat-hero', isoYear: 2026, week: 42, materialDeliverySpace, theftWeatherProtected };
      const response = await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
      assert.equal(response.status,202);
      const posted = await response.json();
      const saved = (await getProject('heat-hero')).customerSchedulingRequests.find(item => item.id === posted.customerSchedulingRequests[0].id);
      const command = (await listDeviceCommands()).find(item => item.id === saved.commandId);
      for (const value of [saved, command.payload]) {
        assert.equal(value.materialDeliverySpace, materialDeliverySpace);
        assert.equal(value.theftWeatherProtected, theftWeatherProtected);
      }
      assert.deepEqual(saved.planbarDescriptionExtras, [
        `Materialannahme einige Tage vor Montagebeginn: ${materialAnswerLabel(materialDeliverySpace)}`,
        `Diebstahl- und wettersicher: ${materialAnswerLabel(theftWeatherProtected)}`,
      ]);
      assert.deepEqual(buildPlanbarSchedulingExtras(command.payload), saved.planbarDescriptionExtras);
      assert(saved.command.includes(saved.planbarDescriptionExtras.join('\n')));
    }
  }
  for (const value of [null, undefined, 'false', 'unknown', 0]) {
    await assert.rejects(addCustomerSchedulingRequest('heat-hero', { customerName: 'Fixture Invalid', isoYear: 2026, week: 42, materialDeliverySpace: value, theftWeatherProtected: true }));
  }
  for (const field of ['materialDeliverySpace','theftWeatherProtected']) {
    assert.throws(() => validatePublicSchedulingInput({firstName:'Fixture',lastName:'Customer',objectLocation:'12345 Testort',isoYear:2026,week:42,materialDeliverySpace:true,theftWeatherProtected:false,[field]:'not-asked'}, Date.parse('2026-09-17')));
  }
  const source = await readFile(new URL('../public/projects.js', import.meta.url), 'utf8');
  const context = vm.createContext({document:{getElementById:()=>null}, Date, Intl, URL, setTimeout, clearTimeout});
  vm.runInContext(source.slice(0,source.indexOf('function dewarmteJobRows')),context);
  const markup = vm.runInContext("customerSchedulingSection({id:'heat-hero'})",context);
  assert.match(markup, /id="customerSchedulingDisclosure" open/);
  for (const id of ['scheduleMaterialDeliverySpace','scheduleTheftWeatherProtected']) {
    const select = markup.match(new RegExp(`<select id="${id}"[^>]*>(.*?)</select>`))[1];
    for (const [value,label] of [['true','Ja'],['false','Nein'],['not-asked','Nicht abgefragt']]) assert(select.includes(`value="${value}">${label}</option>`));
  }
  console.log('PASS all nine material combinations, persistence, dispatch, Planbar lines, legacy booleans, public Yes/No boundary and initial UI');
} finally { await new Promise(resolve=>server.close(resolve)); await rm(root,{recursive:true,force:true}); }
