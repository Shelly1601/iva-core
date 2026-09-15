import { fail, clean } from './store.js';
export const MAX_COACH_AUDIO_BYTES = 20 * 1024 * 1024;
export const DIARIZATION_MODEL = 'gpt-4o-transcribe-diarize';
export function coachTranscriptionStatus(env = process.env) {
  const requested=env.IVA_COACH_TRANSCRIPTION_PROVIDER,provider=requested==='elevenlabs'||requested==='openai'?requested:env.OPENAI_API_KEY?'openai':'elevenlabs';
  const ready=Boolean(provider==='openai'?env.OPENAI_API_KEY:env.ELEVENLABS_API_KEY);
  return {ready,provider,model:provider==='openai'?DIARIZATION_MODEL:'scribe_v2',diarization:true,realtimeDiarization:false,audioStored:false,maxAudioBytes:MAX_COACH_AUDIO_BYTES,verified:false,detail:ready?'Zugang hinterlegt; Modellzugriff und Hörqualität werden erst bei einer echten Aufnahme bestätigt.':'Für Sprechertrennung fehlt ein passender OpenAI- oder ElevenLabs-Zugang. Normale Whisper-Transkription ersetzt keine Diarisierung.'};
}
export function normalizeDiarizedTranscript(payload) {
  if(!Array.isArray(payload?.segments))throw fail('Der Anbieter hat keine Sprechersegmente geliefert.',502);
  const speakers=new Map();const segments=payload.segments.slice(0,5000).map((segment,index)=>{
    const text=clean(segment.text,12000),start=Number(segment.start),end=Number(segment.end),raw=clean(segment.speaker,100);
    if(!text)return null;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start)throw fail('Die Zeitmarken der Transkription sind ungültig.',502);
    if(raw&&!speakers.has(raw))speakers.set(raw,'speaker-'+(speakers.size+1));
    return {id:'segment-'+(index+1),speakerId:raw?speakers.get(raw):'unassigned',start,end,text};
  }).filter(Boolean);
  if(payload.segments.length>5000)throw fail('Die Aufnahme enthält zu viele Segmente. Bitte in kleinere Dateien teilen.',422);
  const text=segments.map(row=>row.text).join(' ');
  if(text.length>100000)throw fail('Das Transkript ist zu groß. Bitte kleinere Aufnahmen verwenden.',422);
  return {text,segments,speakers:[...speakers.values()].map((id,index)=>({id,label:'Sprecher '+(index+1),name:'',confirmed:false})),durationSeconds:segments.reduce((max,row)=>Math.max(max,row.end),0),speakerIdentity:'unconfirmed',audioStored:false};
}
export function normalizeScribeTranscript(payload) {
  if(!Array.isArray(payload?.words))throw fail('Der Anbieter hat keine zeitmarkierten Sprecherwörter geliefert.',502);
  const segments=[];let current=null;
  for(const word of payload.words){if(word.type==='spacing'){if(current)current.text+=' ';continue;}if(word.type&&word.type!=='word')continue;const text=clean(word.text,12000);if(!text)continue;const speaker=clean(word.speaker_id,100),start=Number(word.start),end=Number(word.end);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start)throw fail('Die Zeitmarken der Transkription sind ungültig.',502);if(!current||current.speaker!==speaker||end-current.start>25){current={speaker,start,end,text};segments.push(current);}else{current.text+=(/\s$/.test(current.text)||/^[,.;:!?]/.test(text)?'':' ')+text;current.end=end;}}
  return normalizeDiarizedTranscript({segments});
}
export async function transcribeCoachAudio(buffer,{mime='audio/webm',fileName='',signal}={}, {fetchImpl=fetch,env=process.env}={}) {
  if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>MAX_COACH_AUDIO_BYTES)throw fail('Bitte eine Audiodatei zwischen 1 Byte und 20 MB verwenden.',413);
  if(!/^audio\/(?:webm|mp4|m4a|x-m4a|mpeg|mp3|wav|x-wav|ogg)(?:;|$)/i.test(mime))throw fail('Unterstützt werden WebM, M4A/MP4, MP3, WAV und OGG als Audio.',415);
  const configured=coachTranscriptionStatus(env);if(!configured.ready)throw fail('Für Sprechertrennung fehlt der passende Anbieterzugang.',503,'TRANSCRIPTION_NOT_CONFIGURED');
  signal?.throwIfAborted();const form=new FormData();form.append('file',new Blob([buffer],{type:mime}),clean(fileName,120).replace(/[^a-zA-Z0-9._-]/g,'_')||'recording.webm');
  let endpoint,headers;
  if(configured.provider==='elevenlabs'){form.append('model_id','scribe_v2');form.append('diarize','true');form.append('tag_audio_events','false');form.append('language_code','deu');endpoint='https://api.elevenlabs.io/v1/speech-to-text';headers={'xi-api-key':env.ELEVENLABS_API_KEY};}
  else{form.append('model',DIARIZATION_MODEL);form.append('response_format','diarized_json');form.append('chunking_strategy','auto');form.append('language','de');endpoint='https://api.openai.com/v1/audio/transcriptions';headers={Authorization:'Bearer '+env.OPENAI_API_KEY};}
  // Select one configured provider before dispatch. No retry or paid fallback.
  const response=await fetchImpl(endpoint,{method:'POST',headers,body:form,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000)});
  if(!response.ok){await response.body?.cancel?.().catch(()=>{});throw fail(`Sprechertranskription nicht bestätigt (Anbieterstatus ${response.status}). Keine automatische Wiederholung.`,502,'TRANSCRIPTION_PROVIDER_ERROR');}
  const payload=await response.json();return {...(configured.provider==='elevenlabs'?normalizeScribeTranscript(payload):normalizeDiarizedTranscript(payload)),provider:configured.provider,model:configured.model,audioBytes:buffer.length};
}
