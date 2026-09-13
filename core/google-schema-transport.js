// Gemini's JSON Schema field supports boolean enums, type unions and tuples.
// The installed AI SDK emits these in the older OpenAPI-only parameters field.
// Keep the original Zod execution validation; adapt only the wire format.
function jsonSchema(value) {
  if (!value || typeof value !== 'object') return value;
  const {nullable,...rest}=value;
  const schema={...rest};
  if(schema.properties) schema.properties=Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,jsonSchema(v)]));
  for(const key of ['anyOf','allOf','oneOf']) if(Array.isArray(schema[key]))schema[key]=schema[key].map(jsonSchema);
  if(Array.isArray(schema.items)) {
    schema.prefixItems=schema.items.map(jsonSchema);
    schema.minItems=schema.items.length;
    schema.maxItems=schema.items.length;
    schema.items=false;
  } else if(schema.items && typeof schema.items==='object')schema.items=jsonSchema(schema.items);
  return nullable ? {anyOf:[schema,{type:'null'}]} : schema;
}
export function googleSchemaRequest(body) {
  for (const tool of Array.isArray(body.tools) ? body.tools : body.tools ? [body.tools] : []) {
    for (const declaration of tool.functionDeclarations || []) {
      if (!declaration.parameters) continue;
      declaration.parametersJsonSchema=jsonSchema(declaration.parameters);
      delete declaration.parameters;
    }
  }
  return body;
}
const canonical=value=>JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
const callsKey=parts=>canonical(parts.filter(p=>p.functionCall).map(p=>({name:p.functionCall.name,args:p.functionCall.args||{}})));

function waitForRetry(ms, signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(signal.reason);
    const abort=()=>{clearTimeout(timer);reject(signal.reason)};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
export async function googleRateLimitFetch(fetchImpl,url,init,{wait=waitForRetry,maxRetries=2}={}) {
  for(let attempt=0;;attempt++){
    const response=await fetchImpl(url,init);
    if(response.status!==429||attempt>=maxRetries)return response;
    const data=await response.clone().json().catch(()=>({}));
    const details=data.error?.details||[];
    // A daily/account limit cannot be repaired by a short retry. Preserve the
    // actual provider error instead of keeping a request in an endless loop.
    const violations=details.flatMap(d=>d.violations||[]);
    if(violations.some(v=>/PerDay|PerMonth|Daily/i.test(v.quotaId||'')))return response;
    const delay=details.find(d=>typeof d.retryDelay==='string')?.retryDelay;
    const header=response.headers.get('retry-after');
    const seconds=delay?Number.parseFloat(delay):header?Number(header):NaN;
    if(!Number.isFinite(seconds)||seconds<0||seconds>90)return response;
    await wait(Math.ceil(seconds*1000)+250,init.signal);
    // Repeat only the rejected provider request. Already executed application
    // tools and their original signed results are retained in this body.
  }
}

// Each model instance owns its transport. Retain the exact provider parts of
// each tool turn, including thought signatures the older SDK would discard.
// No signatures are invented, logged or shared between concurrent chat calls.
export function createGoogleSchemaFetch(fetchImpl=fetch, retryOptions={}) {
  const turns=new Map();
  const remember=parts=>{
    if(!parts.some(p=>p.functionCall))return;
    const key=callsKey(parts),entries=turns.get(key)||[];
    entries.push(parts);turns.set(key,entries);
  };
  return async (url,init={})=>{
    if(typeof init.body==='string'){
      const body=googleSchemaRequest(JSON.parse(init.body)),occurrences=new Map();
      for(const content of body.contents||[]){
        if(content.role!=='model'||!content.parts?.some(p=>p.functionCall))continue;
        const key=callsKey(content.parts),occurrence=occurrences.get(key)||0;
        occurrences.set(key,occurrence+1);
        const original=turns.get(key)?.[occurrence];
        if(original)content.parts=original;
      }
      init={...init,body:JSON.stringify(body)};
    }
    const response=await googleRateLimitFetch(fetchImpl,url,init,retryOptions);
    if(!response.ok)return response;
    if(!response.headers.get('content-type')?.includes('text/event-stream')){
      const data=await response.clone().json();remember(data.candidates?.[0]?.content?.parts||[]);return response;
    }
    const parts=[],decoder=new TextDecoder();let pending='';
    const consume=block=>{for(const line of block.split(/\r?\n/)){if(!line.startsWith('data:'))continue;try{const data=JSON.parse(line.slice(5).trim());parts.push(...(data.candidates?.[0]?.content?.parts||[]))}catch{}}};
    const stream=response.body.pipeThrough(new TransformStream({
      transform(chunk,controller){pending+=decoder.decode(chunk,{stream:true});const events=pending.split(/\r?\n\r?\n/);pending=events.pop();events.forEach(consume);controller.enqueue(chunk)},
      flush(){pending+=decoder.decode();if(pending.trim())consume(pending);remember(parts)},
    }));
    return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
