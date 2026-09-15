import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The child imports the production route modules and the exact /api auth,
// project-access wrapper and job-route blocks from index.js. Only integration
// providers and the project catalog are fixtures; no real index timers run.
const bootstrap = String.raw`
  import fs from 'node:fs/promises';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  import { createRequire } from 'node:module';
  const root = process.argv[1], require = createRequire(path.join(root, 'index.js'));
  const express = require('express');
  const module = name => import(pathToFileURL(path.join(root, name)).href);
  const [{createProjectProviderStore,registerProjectProviderRoutes},{createProjectMarketingService},{registerProjectMarketingRoutes},{createHiggsfieldClient},{createOpportunityJobs},{macMiniAccessMiddleware,hasMacMiniCockpitAccess}] = await Promise.all([
    module('integrations/project-providers.js'),module('marketing/project-service.js'),module('marketing/project-routes.js'),module('marketing/higgsfield.js'),module('opportunities/jobs.js'),module('device-control/macmini-access.js')
  ]);
  globalThis.fetch = async () => { throw Error('External network disabled in isolated growth HTTP verification.'); };
  const source = await fs.readFile(path.join(root,'index.js'),'utf8');
  function block(start,end) { const first=source.indexOf(start),last=source.indexOf(end,first);if(first<0||last<0)throw Error('Production wiring block unavailable: '+start);return source.slice(first,last); }
  const enabled = new Set(['alpha']);
  const getProject = async id => ['alpha','beta'].includes(id)?{id,name:'Fixture '+id}:null;
  const listProjects = async () => [await getProject('alpha'),await getProject('beta')];
  const projectAccess = {getProjectAccess:async id=>({modules:enabled.has(id)?['marketing']:[]})};
  const requireMarketingProject = new Function('getProject','projectAccess',block('async function requireMarketingProject(', '\nconst projectMarketing =')+'; return requireMarketingProject;')(getProject,projectAccess);
  const projectProviders = createProjectProviderStore({dataDir:process.env.DATA_DIR,getProject,env:process.env,verifiers:{higgsfield:async()=>({verified:true})}});
  const stats={paid:0,generated:0,radar:0}; let releasedGeneration=false,releasedRadar=false; const generationWaiters=[],radarWaiters=[];
  const provider={prepare:createHiggsfieldClient().prepare,estimate:async()=>({usd:'0.25',credits:'2'}),submit:async()=>{stats.paid++;return{requestId:'12345678-1234-4321-8123-123456789abc',status:'queued'};},status:async()=>({requestId:'12345678-1234-4321-8123-123456789abc',status:'queued'})};
  const factory=options=>createProjectMarketingService({...options,env:{},higgsfield:provider,collect:async()=>({sources:[{id:'fixture-source',status:'read',text:'Actual fixture source'}],coverage:{read:1}}),generate:async()=>{stats.generated++;if(!releasedGeneration)await new Promise(r=>generationWaiters.push(r));return{summary:'Fixture generated result',items:[{title:'Fixture',script:'No external call'}]};}});
  const projectMarketing = new Function('createProjectMarketingService','DATA_DIR','requireMarketingProject','listProjects','projectAccess','projectProviders','readMediaEvidence','searchEvidence',block('const projectMarketing =','\nconst opportunityJobs =')+'; return projectMarketing;')(factory,process.env.DATA_DIR,requireMarketingProject,listProjects,projectAccess,projectProviders,async()=>({}),async()=>[]);
  const opportunityJobs = createOpportunityJobs({dataDir:process.env.DATA_DIR,handlers:{'check-link':async(input,context)=>{stats.radar++;if(!releasedRadar)await new Promise(r=>radarWaiters.push(r));context.signal.throwIfAborted();return{status:'complete',url:input.url,source:'offline-fixture'};},scout:async()=>({}), 'market-research':async()=>({})},env:process.env});
  const app=express();app.use(macMiniAccessMiddleware);app.use(express.json({limit:'2mb'}));
  new Function('app','hasMacMiniCockpitAccess',block('const CORS =','\ninvestment.registerRoutes(app);'))(app,hasMacMiniCockpitAccess);
  registerProjectProviderRoutes(app,projectProviders);
  registerProjectMarketingRoutes(app,{service:projectMarketing,authorizeProject:requireMarketingProject});
  new Function('app','opportunityJobs',block("app.post('/api/opportunities/jobs'","app.get('/api/opportunities/settings'"))(app,opportunityJobs);
  app.post('/api/fixture/module/:id',(q,r)=>{if(q.body.enabled)enabled.add(q.params.id);else enabled.delete(q.params.id);r.json({ok:true});});
  app.post('/api/fixture/release/:kind',async(q,r)=>{if(q.params.kind==='generation'){releasedGeneration=true;generationWaiters.splice(0).forEach(fn=>fn());await projectMarketing.waitForIdle('alpha');}else{releasedRadar=true;radarWaiters.splice(0).forEach(fn=>fn());}r.json({ok:true});});
  app.get('/api/fixture/stats',(_q,r)=>r.json(stats));
  app.use((error,_q,r,_next)=>r.status(error.status||500).json({error:'Fixture request rejected'}));
  const server=app.listen(0,'127.0.0.1',()=>process.stdout.write('GROWTH_HTTP_PORT='+server.address().port+'\n'));
`;

test('growth HTTP wiring protects project providers, enforces module revocation and exposes async jobs', { timeout: 16000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'iva-growth-http-'));
  const token = randomBytes(32).toString('hex'), secret = 'fixture-secret-' + randomBytes(16).toString('hex');
  await mkdir(path.join(temporary, 'home'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap, root], { cwd: temporary, env: { PATH: path.dirname(process.execPath), HOME: path.join(temporary, 'home'), TMPDIR: temporary, NODE_ENV: 'test', TZ: 'Europe/Berlin', DATA_DIR: path.join(temporary, 'data'), API_TOKEN: token, IVA_PROJECT_CONNECTIONS_KEY: randomBytes(32).toString('base64') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', finished = false;
  const closed = new Promise(resolve => child.once('close', () => { finished = true; resolve(); }));
  const kill = setTimeout(() => child.kill('SIGKILL'), 13000);
  try {
    const port = await new Promise((resolve,reject) => {
      const collect=chunk=>{output=(output+chunk.toString()).slice(-15000);const match=output.match(/GROWTH_HTTP_PORT=(\d+)/);if(match)resolve(Number(match[1]));};
      child.stdout.on('data',collect);child.stderr.on('data',collect);child.once('error',reject);child.once('exit',code=>reject(Error('Isolated growth HTTP server ended before startup: '+code+' '+output.replaceAll(token,'[token]').slice(-1500))));
    });
    const origin = `http://127.0.0.1:${port}`;
    const call = (route, options = {}, authorized = true) => fetch(origin+route,{...options,headers:{...(authorized?{Authorization:'Bearer '+token}:{}),...options.headers},signal:AbortSignal.timeout(3000)});
    const json = async (route, options = {}, expected = 200) => { const response=await call(route,options);const body=await response.json();assert.equal(response.status,expected,route+': '+JSON.stringify(body).slice(0,400));return body; };
    const post = (route,body={},expected=200) => json(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},expected);
    const eventually = async predicate => { for(let i=0;i<80;i++){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Expected async state was not reached.'); };

    await t.test('provider and job data require actual cockpit credentials', async()=>{
      for(const route of ['/api/projects/alpha/providers','/api/marketing/projects/alpha','/api/opportunities/jobs']) {
        assert.equal((await call(route,{},false)).status,401);
        assert.equal((await call(route,{headers:{Cookie:'iva_project_session=customer-fixture'}},false)).status,401);
        assert.equal((await call(route,{headers:{Authorization:'Bearer customer-session-fixture'}},false)).status,401);
      }
      assert.equal((await call('/api/projects/alpha/providers',{headers:{'x-iva-macmini-cockpit':'invalid'}},false)).status,401);
    });
    await t.test('saved provider credentials are project-specific, encrypted, and absent from public responses',async()=>{
      const saved=await post('/api/projects/alpha/providers/higgsfield',{credentials:{HF_API_KEY_ID:'fixture-key-id',HF_API_KEY_SECRET:secret}});
      assert.equal(saved.status,'saved');assert(!JSON.stringify(saved).includes(secret));
      const a=await json('/api/projects/alpha/providers'),b=await json('/api/projects/beta/providers');
      assert.equal(a.connections.find(c=>c.provider==='higgsfield').configured,true);assert.equal(b.connections.find(c=>c.provider==='higgsfield').configured,false);
      assert(!JSON.stringify(a).includes(secret));
      const response=await call('/api/projects/alpha/providers');assert.equal(response.headers.get('cache-control'),'no-store');
      assert(!(await readFile(path.join(temporary,'data','project-providers.json'),'utf8')).includes(secret));
      assert.equal((await post('/api/projects/alpha/providers/higgsfield/verify')).status,'verified');
      await json('/api/projects/missing/providers',{},404);
    });
    await t.test('the actual shared project wrapper filters lists and denies disabled marketing modules',async()=>{
      assert.deepEqual((await json('/api/marketing/projects')).map(p=>p.id),['alpha']);
      await json('/api/marketing/projects/beta',{},403);
      await post('/api/marketing/projects/beta/profile',{offer:'Must not save'},403);
      await post('/api/marketing/projects/beta/drafts',{},403);
      await json('/api/marketing/projects/missing',{},404);
      await post('/api/marketing/projects/alpha/profile',{name:'Alpha',offer:'Solarberatung',audience:'Hausbesitzer'});
    });
    await t.test('binary logo route preserves parser ordering and validates image content',async()=>{
      const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=','base64');
      await json('/api/marketing/projects/alpha/logo',{method:'POST',headers:{'Content-Type':'image/png'},body:png});
      const response=await call('/api/marketing/projects/alpha/logo');assert.equal(response.status,200);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
      await json('/api/marketing/projects/alpha/logo',{method:'POST',headers:{'Content-Type':'image/png'},body:Buffer.from('<svg onload="x">')},413);
    });
    await t.test('an asynchronous marketing job cannot commit generated content after module revocation',async()=>{
      const job=await post('/api/marketing/projects/alpha/drafts',{},202);assert.equal(job.status,'running');assert(job.recordId);
      await eventually(async()=> (await json('/api/fixture/stats')).generated===1);
      await post('/api/marketing/projects/alpha/drafts',{},409);
      await post('/api/fixture/module/alpha',{enabled:false});await json('/api/marketing/projects/alpha',{},403);
      await post('/api/fixture/release/generation');await post('/api/fixture/module/alpha',{enabled:true});
      // The fixture release waits for the terminal transition while access is
      // still revoked, before the next request restores the module.
      const state=await eventually(async()=>{const row=await json('/api/marketing/projects/alpha');return !row.activeJob&&row;});
      const record=state.drafts.find(row=>row.id===job.recordId);
      assert.equal(record.status,'failed');assert.equal(record.result,undefined);
    });
    await t.test('video generation requires an explicit cost confirmation and the owning project',async()=>{
      const quote=await post('/api/marketing/projects/alpha/videos/quote',{model:'veo-3.1',prompt:'Eine ruhige Filmszene mit Solardach.'},201);
      await post('/api/marketing/projects/alpha/videos',{quoteId:quote.id},400);
      await post('/api/fixture/module/beta',{enabled:true});
      await post('/api/marketing/projects/beta/videos',{quoteId:quote.id,confirmCost:true},404);
      const stats=await json('/api/fixture/stats');assert.equal(stats.paid,0);
      const video=await post('/api/marketing/projects/alpha/videos',{quoteId:quote.id,confirmCost:true},202);
      assert.equal(video.status,'queued');await post('/api/marketing/projects/alpha/videos',{quoteId:quote.id,confirmCost:true},409);
      assert.equal((await json('/api/fixture/stats')).paid,1);
    });
    await t.test('the exact index job routes return 202, deduplicate pending work and preserve retrievable completion',async()=>{
      const input={kind:'check-link',input:{url:'https://example.com/idea'}};
      const first=await post('/api/opportunities/jobs',input,202);assert(['queued','running'].includes(first.job.status));
      const repeated=await post('/api/opportunities/jobs',input,202);assert.equal(repeated.job.id,first.job.id);
      const pending=await json('/api/opportunities/jobs/'+first.job.id);assert.notEqual(pending.job.status,'completed');
      await post('/api/fixture/release/radar');
      const finished=await eventually(async()=>{const result=await json('/api/opportunities/jobs/'+first.job.id);return result.job.status==='completed'&&result;});
      assert.equal(finished.job.result.source,'offline-fixture');assert.equal((await json('/api/fixture/stats')).radar,1);
      assert((await json('/api/opportunities/jobs')).jobs.some(row=>row.id===first.job.id));
      await post('/api/opportunities/jobs',{kind:'unsupported',input:{}},400);
      await json('/api/opportunities/jobs/00000000-0000-0000-0000-000000000000',{},404);
    });
    t.diagnostic('Production route modules, actual index authentication/project wrapper/jobs blocks, isolated stores, no external provider calls.');
  } finally {
    clearTimeout(kill);if(!finished)child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),500);await closed;clearTimeout(force);await rm(temporary,{recursive:true,force:true});
  }
});
