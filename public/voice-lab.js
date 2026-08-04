const $ = id => document.getElementById(id);
const TOKEN_KEY = 'iva_token';
const state = { summary: null, phrases: [], phraseIndex: 0, media: null, stream: null, chunks: [], blob: null, recording: false, rating: null, timings: {}, answer: '', transcript: '' };
const tagOptions = [
  ['misunderstood','falsch verstanden'],['too_slow','zu langsam'],['too_long','zu lang'],
  ['unnatural','unnatürlich'],['wrong_answer','inhaltlich falsch'],['wrong_action','falsche Aktion'],['good','richtig gut'],
];

function token(){ return localStorage.getItem(TOKEN_KEY) || ''; }
function esc(value){ return String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char])); }
function ms(value){ return Number.isFinite(Number(value)) ? Math.round(Number(value)) + ' ms' : '–'; }
function pct(value){ return Number.isFinite(Number(value)) ? Number(value).toLocaleString('de-DE',{maximumFractionDigits:1}) + ' %' : '–'; }
function setStatus(kind, text){ $('status').className = 'status' + (kind ? ' ' + kind : ''); $('status').querySelector('span').textContent = text; }
async function api(path, options = {}){
  const headers = { Authorization:'Bearer ' + token(), ...(options.headers || {}) };
  if (options.body && !(options.body instanceof Blob) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || 'HTTP ' + response.status);
  return payload;
}

function renderMetrics(){
  const s = state.summary || {};
  const values = [
    [s.samples ?? 0,'Sprachdialoge',''],
    [s.averageRating == null ? '–' : s.averageRating + ' / 5','Ø Bewertung',s.averageRating >= 4 ? 'good' : ''],
    [pct(s.averageWordErrorRate),'Wortfehler',s.averageWordErrorRate != null && s.averageWordErrorRate <= 12 ? 'good' : 'warn'],
    [ms(s.medianFirstTextMs),'erste Antwort',s.medianFirstTextMs != null && s.medianFirstTextMs <= 1500 ? 'good' : ''],
    [ms(s.medianFirstAudioMs),'erste Stimme',s.medianFirstAudioMs != null && s.medianFirstAudioMs <= 2400 ? 'good' : ''],
    [pct(s.spokenReadyRate),'sprechfertig',s.spokenReadyRate >= 85 ? 'good' : ''],
  ];
  $('metrics').innerHTML = values.map(([value,label,kind]) => `<div class="metric ${kind}"><b>${esc(value)}</b><small>${esc(label)}</small></div>`).join('');
}

function renderPhrases(){
  $('phraseSelect').innerHTML = state.phrases.map((item,index) => `<option value="${index}">${esc(item.category)} · ${esc(item.text.slice(0,50))}</option>`).join('');
  choosePhrase(state.phraseIndex);
}
function choosePhrase(index){
  state.phraseIndex = Math.max(0, Math.min(state.phrases.length - 1, Number(index) || 0));
  $('phraseSelect').value = String(state.phraseIndex);
  $('phraseText').textContent = state.phrases[state.phraseIndex]?.text || 'Freier Test';
  resetTest();
}
function resetTest(){
  state.blob = null; state.rating = null; state.timings = {}; state.answer = ''; state.transcript = '';
  $('transcript').value = ''; $('correction').value = state.phrases[state.phraseIndex]?.text || '';
  $('answer').textContent = 'Noch kein Test durchgeführt.'; $('answer').className = 'answer muted';
  $('askIva').disabled = true; $('saveEvaluation').disabled = true; $('preview').hidden = true;
  $('mTranscribe').textContent = $('mFirstText').textContent = $('mFirstAudio').textContent = '–';
  $('notes').value = ''; document.querySelectorAll('#rating button').forEach(button => button.classList.remove('on'));
  document.querySelectorAll('#tags input').forEach(input => { input.checked = false; });
  $('testState').textContent = ''; $('saveState').textContent = '';
}

function renderControls(){
  $('rating').innerHTML = [1,2,3,4,5].map(value => `<button type="button" data-rating="${value}">${value}</button>`).join('');
  $('rating').addEventListener('click', event => {
    const value = Number(event.target.dataset.rating); if (!value) return;
    state.rating = value; document.querySelectorAll('#rating button').forEach(button => button.classList.toggle('on', Number(button.dataset.rating) === value));
  });
  $('tags').innerHTML = tagOptions.map(([value,label]) => `<label><input type="checkbox" value="${value}">${label}</label>`).join('');
}

async function startRecording(){
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true } });
    const preferred = ['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type => window.MediaRecorder?.isTypeSupported?.(type));
    state.chunks = [];
    state.media = preferred ? new MediaRecorder(state.stream,{mimeType:preferred}) : new MediaRecorder(state.stream);
    state.media.ondataavailable = event => { if (event.data.size) state.chunks.push(event.data); };
    state.media.onstop = finishRecording;
    state.media.start(250); state.recording = true;
    $('record').classList.add('live'); $('record').textContent = '■'; $('recordCopy').textContent = 'IVA hört zu · zum Stoppen tippen';
  } catch (error) { $('testState').textContent = 'Mikrofonfehler: ' + error.message; }
}
function stopRecording(){ if (state.media?.state === 'recording') state.media.stop(); state.stream?.getTracks().forEach(track => track.stop()); state.recording = false; $('record').classList.remove('live'); $('record').classList.add('busy'); $('record').textContent = '…'; $('recordCopy').textContent = 'IVA transkribiert …'; }
async function finishRecording(){
  state.blob = new Blob(state.chunks,{type:state.media?.mimeType || 'audio/webm'});
  const localUrl = URL.createObjectURL(state.blob); $('preview').src = localUrl; $('preview').hidden = false;
  const started = performance.now();
  try {
    const result = await api('/api/voice/transcribe',{method:'POST',headers:{'Content-Type':state.blob.type || 'audio/webm','X-File-Name':'voice-lab.' + ((state.blob.type || '').includes('mp4')?'m4a':'webm')},body:state.blob});
    state.timings.transcriptionMs = Math.round(performance.now() - started);
    state.transcript = result.text || ''; $('transcript').value = state.transcript;
    $('mTranscribe').textContent = ms(state.timings.transcriptionMs); $('askIva').disabled = !state.transcript;
    $('recordCopy').textContent = state.transcript ? 'Transkript ist da · jetzt IVA testen' : 'Nichts verstanden · erneut aufnehmen';
    $('testState').textContent = result.audioStored === false ? 'Audio verworfen.' : '';
  } catch (error) { $('testState').textContent = error.message; $('recordCopy').textContent = 'Aufnahme erneut versuchen'; }
  finally { $('record').classList.remove('busy'); $('record').textContent = '●'; }
}

async function askIva(){
  const message = $('transcript').value.trim(); if (!message) return;
  $('askIva').disabled = true; $('answer').className = 'answer'; $('answer').textContent = '';
  $('testState').textContent = 'IVA denkt …'; const started = performance.now(); let first = null; let full = '';
  try {
    const response = await fetch('/api/chat/stream',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify({message,sessionId:'voice-lab',voice:true})});
    if (!response.ok) throw new Error('Chat HTTP ' + response.status);
    const reader = response.body.getReader(); const decoder = new TextDecoder();
    while (true) { const {done,value} = await reader.read(); if (done) break; const chunk = decoder.decode(value,{stream:true}); if (!first && chunk) { first = performance.now(); state.timings.firstTextMs = Math.round(first-started); $('mFirstText').textContent = ms(state.timings.firstTextMs); } full += chunk; $('answer').textContent += chunk; }
    state.timings.brainTotalMs = Math.round(performance.now()-started); state.answer = full;
    $('testState').textContent = 'Stimme wird vorbereitet …'; const ttsStart = performance.now();
    const audioResponse = await fetch('/api/speak',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify({text:full})});
    if (audioResponse.ok) { const audio = await audioResponse.arrayBuffer(); state.timings.ttsRequestMs = Math.round(performance.now()-ttsStart); state.timings.firstAudioMs = state.timings.brainTotalMs + state.timings.ttsRequestMs; state.timings.totalMs = state.timings.firstAudioMs; $('mFirstAudio').textContent = ms(state.timings.firstAudioMs); const url = URL.createObjectURL(new Blob([audio],{type:'audio/mpeg'})); const player = new Audio(url); player.onended = () => URL.revokeObjectURL(url); await player.play().catch(()=>{}); }
    $('testState').textContent = 'Bitte Antwort bewerten.'; $('saveEvaluation').disabled = false;
  } catch (error) { $('answer').textContent = 'Fehler: ' + error.message; $('testState').textContent = 'Test fehlgeschlagen.'; }
  finally { $('askIva').disabled = false; }
}

async function saveEvaluation(){
  const tags = [...document.querySelectorAll('#tags input:checked')].map(input => input.value);
  $('saveEvaluation').disabled = true; $('saveState').textContent = 'speichert …';
  try {
    await api('/api/voice-lab/evaluations',{method:'POST',body:JSON.stringify({source:'voice-lab',phraseId:state.phrases[state.phraseIndex]?.id,expectedText:state.phrases[state.phraseIndex]?.text,transcript:$('transcript').value,correctedTranscript:$('correction').value,answer:state.answer,rating:state.rating,tags,notes:$('notes').value,timings:state.timings})});
    $('saveState').textContent = 'Gespeichert. Audio wurde nicht behalten.'; await loadDashboard();
  } catch (error) { $('saveState').textContent = error.message; $('saveEvaluation').disabled = false; }
}

function renderHistory(items){
  $('history').innerHTML = items.length ? items.slice(0,20).map(item => `<div class="history-item"><span class="source">${esc(item.source)}</span><div><b>${esc(item.transcript || item.expectedText || 'Sprachtest')}</b><small>${esc((item.answer || 'Noch ohne Antwort').slice(0,180))}</small><small>${new Date(item.createdAt).toLocaleString('de-DE')} · erste Antwort ${ms(item.timings?.firstTextMs)} · Audio ${ms(item.timings?.firstAudioMs)}</small></div><div class="score">${item.rating ? '★ '.repeat(item.rating).trim() : item.response?.spokenReady ? '✓ sprechfertig' : 'noch offen'}</div></div>`).join('') : '<div class="empty">Noch keine Sprachtests. Der erste echte Test legt die Basis.</div>';
}
async function loadDashboard(){
  if (!token()) { setStatus('err','API-Token fehlt'); return; }
  try {
    const [summary,items] = await Promise.all([api('/api/voice-lab/summary'),api('/api/voice-lab/evaluations?limit=40')]);
    state.summary = summary; state.phrases = summary.testPhrases || []; renderMetrics(); if (!$('phraseSelect').options.length) renderPhrases(); renderHistory(items);
    setStatus(summary.configured?.groq && summary.configured?.elevenLabs ? 'on' : '', summary.configured?.groq && summary.configured?.elevenLabs ? 'bereit' : 'Anbindung unvollständig');
  } catch (error) { setStatus('err',error.message); }
}

$('record').addEventListener('click',()=> state.recording ? stopRecording() : startRecording());
$('phraseSelect').addEventListener('change',event=>choosePhrase(event.target.value));
$('nextPhrase').addEventListener('click',()=>choosePhrase((state.phraseIndex+1)%Math.max(1,state.phrases.length)));
$('askIva').addEventListener('click',askIva); $('saveEvaluation').addEventListener('click',saveEvaluation);
$('saveToken').addEventListener('click',()=>{localStorage.setItem(TOKEN_KEY,$('token').value.trim());loadDashboard();});
$('ivaHelper').addEventListener('click',()=>location.href='/cockpit'); $('token').value=token(); renderControls(); loadDashboard();
