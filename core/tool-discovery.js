import {tool,jsonSchema,zodSchema} from 'ai';
import {z} from 'zod';
import {rankIvaTools,recordToolOutcome,describeIvaTool,toolRoutingStatus} from './tool-routing.js';

const acceptsNull=s=>s?.type==='null'||(Array.isArray(s?.type)&&s.type.includes('null'))||(s?.anyOf||s?.oneOf||[]).some(acceptsNull);

function normalize(value,schema) {
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map((v,i)=>normalize(v,Array.isArray(schema?.items)?schema.items[i]:schema?.items));
  const out={};
  for(const [key,entry] of Object.entries(value)){
    if(entry===null&&schema?.properties?.[key]&&!schema.required?.includes(key)&&!acceptsNull(schema.properties[key]))continue;
    out[key]=normalize(entry,schema?.properties?.[key]);
  }
  return out;
}
function nullableOptionals(schema) {
  if(!schema||typeof schema!=='object')return schema;
  const out={...schema};
  if(out.properties)out.properties=Object.fromEntries(Object.entries(out.properties).map(([k,v])=>{
    const nested=nullableOptionals(v);
    return[k,out.required?.includes(k)?nested:{anyOf:[nested,{type:'null'}]}];
  }));
  if(out.items)out.items=Array.isArray(out.items)?out.items.map(nullableOptionals):nullableOptionals(out.items);
  return out;
}
export function prepareIvaTool(original) {
  const schema=zodSchema(original.parameters).jsonSchema;
  const parse=value=>original.parameters.safeParse(normalize(value,schema));
  return {...original,parameters:jsonSchema(nullableOptionals(schema),{validate:value=>{
    const result=parse(value);return result.success?{success:true,value:result.data}:{success:false,error:result.error};
  }}),execute:async(value,options)=>{
    const parsed=parse(value);if(!parsed.success)throw parsed.error;
    return original.execute(parsed.data,options);
  }};
}

// Load only relevant schemas instead of sending every business integration
// with every sentence. Original tool validation and access scope are retained.
export function compactIvaTools(all, options = {}) {
  const tools={}, accessible=new Set(Object.keys(all));
  let writeQueue=Promise.resolve();
  const execute=async(name,args,executionOptions)=>{
    if(!accessible.has(name))throw new Error('Dieses Werkzeug ist für die aktuelle Rolle und das aktuelle Projekt nicht verfügbar.');
    const invoke=async()=>{
      if(executionOptions?.abortSignal?.aborted)throw new Error('Werkzeugauftrag abgebrochen.');
      const started=Date.now();
      let result,error;
      try { result=await prepareIvaTool(all[name]).execute(args,executionOptions); return result; }
      catch(e){error=e;throw e;}
      finally {
        const receipt=recordToolOutcome(name,result,Date.now()-started,Boolean(error));
        try { await options.onExecution?.({...receipt,projectId:options.projectId||'',runId:options.runId||''}); } catch {}
      }
    };
    if(describeIvaTool(name,all[name],options).readOnly)return invoke();
    const pending=writeQueue.then(invoke,invoke);
    writeQueue=pending.catch(()=>{});
    return pending;
  };
  for(const name of ['sendCommandToImac','runTaskOnImac','getImacCommandStatus','getImacTaskStatus','startIvaBuild','delegateIvaTasks','getIvaAgentRoster'])if(all[name])tools[name]=prepareIvaTool({...all[name],execute:(args,opts)=>execute(name,args,opts)});
  const matches=query=>rankIvaTools(all,{...options,query}).map(row=>({...row,parameters:nullableOptionals(zodSchema(all[row.name].parameters).jsonSchema)}));
  tools.findIvaTools=tool({
    description:'Findet ausführbare IVA-Werkzeuge mit Eingabefeldern, Projektfreigabe, passender Fachrolle und aktuellem Verbindungsstatus. Exakter Name oder konkrete Aufgabe/System. configured ist noch kein verifizierter Zugriff; fehlende Verbindungen zuerst ergänzen. Gefundenes Werkzeug mit executeIvaTool ausführen.',
    parameters:z.object({query:z.string().min(1).max(300)}),
    execute:async({query})=>matches(query),
  });
  tools.planIvaToolUse=tool({
    description:'Wählt passende API-, MCP-, Recherche- oder Mac-Mini-Werkzeuge aus IVAs tatsächlich registrierten Fähigkeiten. Liefert begründete Reihenfolge und alternative Wege. Keine Aktion wird hier ausgeführt. Bei schreibenden Aktionen vor Wiederholung nach Fehler den Zielzustand prüfen.',
    parameters:z.object({task:z.string().min(1).max(300)}),
    execute:async({task})=>({projectId:options.projectId||'',routes:matches(task),policy:'Nutze für belegbare Daten die passende eingerichtete Schnittstelle. Nach Lese-Fehler darf ein passender unabhängiger Weg versucht werden; jede Quelle und Lücke belegen. Browseraufträge brauchen einen bestätigten Endstatus.'}),
  });
  tools.getIvaConnectionStatus=tool({
    description:'Zeigt die im aktuellen Rollen- und Projektkontext verfügbaren Werkzeuge und fehlenden Anbindungen, ohne Zugangsdaten. Konfiguration ist kein erfolgreicher Verbindungstest.',
    parameters:z.object({}),execute:async()=>toolRoutingStatus(all,options),
  });
  tools.executeIvaTool=tool({
    description:'Führt genau ein zuvor gefundenes freigegebenes IVA-Werkzeug aus. name und arguments nach findIvaTools verwenden. Alle ursprünglichen Pflichtfelder, Freigaben und Ausführungsprüfungen bleiben verbindlich. Ergebnisse mit Fehlern oder pending/queued sind keine Erledigung.',
    parameters:z.object({name:z.string(),arguments:z.record(z.unknown())}),
    execute:async({name,arguments:args},executionOptions)=>execute(name,args,executionOptions),
  });
  return tools;
}
