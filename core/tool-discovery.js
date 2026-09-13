import {tool,jsonSchema,zodSchema} from 'ai';
import {z} from 'zod';

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
export function compactIvaTools(all) {
  const tools={};
  for(const name of ['sendCommandToImac','runTaskOnImac','getImacCommandStatus','getImacTaskStatus','startIvaBuild'])if(all[name])tools[name]=prepareIvaTool(all[name]);
  const accessible=new Set(Object.keys(all));
  tools.findIvaTools=tool({
    description:'Findet alle weiteren freigegebenen IVA-Fachwerkzeuge einschließlich ihrer vollständigen Eingabefelder. Suche nach dem exakten Werkzeugnamen aus den Arbeitsregeln oder nach Aufgabe/System; führe das gefundene Werkzeug anschließend mit executeIvaTool aus.',
    parameters:z.object({query:z.string().min(1).max(300)}),
    execute:async({query})=>{
      const words=query.toLocaleLowerCase('de-DE').split(/[^\p{L}\p{N}]+/u).filter(w=>w.length>1);
      return Object.entries(all).map(([name,t])=>({name,t,score:name.toLowerCase()===query.toLowerCase()?1000:words.reduce((n,w)=>n+(name.toLowerCase().includes(w)?20:0)+(String(t.description).toLowerCase().includes(w)?1:0),0)}))
        .filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,5)
        .map(({name,t})=>({name,description:t.description,parameters:nullableOptionals(zodSchema(t.parameters).jsonSchema)}));
    },
  });
  tools.executeIvaTool=tool({
    description:'Führt genau ein zuvor gefundenes freigegebenes IVA-Werkzeug aus. name und arguments nach findIvaTools verwenden. Alle ursprünglichen Pflichtfelder, Freigaben und Ausführungsprüfungen bleiben verbindlich.',
    parameters:z.object({name:z.string(),arguments:z.record(z.unknown())}),
    execute:async({name,arguments:args},options)=>{
      if(!accessible.has(name))throw new Error('Dieses Werkzeug ist für die aktuelle Rolle nicht verfügbar.');
      return prepareIvaTool(all[name]).execute(args,options);
    },
  });
  return tools;
}
