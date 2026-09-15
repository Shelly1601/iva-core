(function (global) {
  'use strict';
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function safeHttpsUrl(value) {
    try { const url = new URL(String(value || '')); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; }
  }
  function normalizeQuestions(input) {
    if (!Array.isArray(input) || input.length < 3 || input.length > 5) return null;
    const ids = new Set();
    const questions = input.map(question => {
      if (!question || !/^[a-zA-Z0-9_-]{1,80}$/.test(question.id || '') || ids.has(question.id) || typeof question.label !== 'string' || !question.label.trim()) return null;
      ids.add(question.id);
      if (!['single','multi','text'].includes(question.type)) return null;
      const options = Array.isArray(question.options) ? question.options.map(option => typeof option === 'string' ? {value:option,label:option} : option).filter(option => option && typeof option.value === 'string' && typeof option.label === 'string' && option.label.trim()) : [];
      if (question.type !== 'text' && (!options.length || options.length > 12 || new Set(options.map(option => option.value)).size !== options.length)) return null;
      return {id:question.id,label:question.label,type:question.type,options,required:question.required === true,hint:String(question.hint || ''),placeholder:String(question.placeholder || 'Was möchten Sie uns mitteilen?'),maxLength:Math.max(50,Math.min(Number(question.maxLength) || 1200,2000))};
    });
    return questions.every(Boolean) ? questions : null;
  }
  function validateAnswer(question, answer) {
    if (question.type === 'text') return typeof answer === 'string' && answer.trim().length <= question.maxLength && (!question.required || answer.trim().length > 0);
    const allowed = new Set(question.options.map(option => option.value));
    if (question.type === 'multi') return Array.isArray(answer) && (!question.required || answer.length > 0) && new Set(answer).size === answer.length && answer.every(value => allowed.has(value));
    return typeof answer === 'string' && ((answer === '' && !question.required) || allowed.has(answer));
  }
  function mount({main,projectName,token,fetchImpl = global.fetch.bind(global)} = {}) {
    if (!main || !projectName) throw new Error('Die Check-up-Oberfläche fehlt.');
    const state = {payload:null,questions:[],answers:{},step:-1,interest:false,bookingRequested:false,busy:false,submitted:false,idempotencyKey:global.crypto?.randomUUID?.() || '',unsubscribeKey:global.crypto?.randomUUID?.() || ''};
    let destroyed = false;
    const url = '/public/customer-care/' + encodeURIComponent(token || '');
    const request = async options => {
      const response = await fetchImpl(url,{credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',...options,headers:{'Content-Type':'application/json',...(options?.headers || {})}});
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(payload.message || payload.error || 'Bitte versuchen Sie es gleich noch einmal.'); error.status=response.status; error.code=payload.code || payload.status; throw error; }
      return payload;
    };
    function focusHeading() { const heading = main.querySelector('h1,h2'); if (heading) { heading.setAttribute('tabindex','-1'); heading.focus({preventScroll:true}); } }
    function errorText(message) { const error = main.querySelector('[data-error]'); if (error) error.textContent = message; }
    function invalid(kind='invalid') {
      const copy = {
        expired:['Dieser Check-up ist abgelaufen.','Bitte melden Sie sich bei Ihrer Ansprechperson. Sie erhalten dann einen neuen persönlichen Link.'],
        revoked:['Dieser Link ist nicht mehr aktiv.','Bitte wenden Sie sich für einen aktuellen Check-up an Ihre Ansprechperson.'],
        invalid:['Dieser Link ist nicht verfügbar.','Öffnen Sie bitte den vollständigen Link aus Ihrer persönlichen Einladung.'],
        unavailable:['Ihr Check-up ist gerade nicht erreichbar.','Bitte versuchen Sie es in einem Moment erneut. Ihre Angaben werden erst nach dem Absenden übermittelt.']
      }[kind] || null;
      if (!copy) return invalid();
      main.setAttribute('aria-busy','false');
      main.innerHTML = `<div class="state-icon" aria-hidden="true">${kind==='unavailable'?'↻':'⌁'}</div><p class="eyebrow">Persönlicher Check-up</p><h1>${copy[0]}</h1><p class="intro-copy">${copy[1]}</p>${kind==='unavailable'?'<div class="intro-actions"><button class="button" data-retry>Erneut versuchen</button></div>':''}`;
      main.querySelector('[data-retry]')?.addEventListener('click',load);
      focusHeading();
    }
    function appendEmailPreference() {
      if(!state.payload)return;
      const footer=document.createElement('p');footer.className='email-preference';
      const button=document.createElement('button');button.type='button';button.textContent='Keine weiteren E-Mails zur Kundenbetreuung';button.addEventListener('click',unsubscribe);footer.appendChild(button);main.appendChild(footer);
    }
    async function unsubscribe(event) {
      if(state.busy || !state.unsubscribeKey)return;state.busy=true;event.currentTarget.disabled=true;
      try {
        const result=await request({method:'POST',body:JSON.stringify({unsubscribe:true,idempotencyKey:state.unsubscribeKey})});
        if(destroyed)return;
        if(result.status!=='unsubscribed'&&result.unsubscribed!==true)throw new Error('Die Abmeldung konnte noch nicht bestätigt werden.');
        renderUnsubscribed();
      }catch(error){if(!destroyed){const footer=main.querySelector('.email-preference');if(footer){footer.textContent=error.message || 'Die Abmeldung konnte nicht abgeschlossen werden.';const retry=document.createElement('button');retry.type='button';retry.textContent='Erneut abmelden';retry.addEventListener('click',unsubscribe);footer.appendChild(retry);}}}
      finally{state.busy=false;}
    }
    function renderUnsubscribed() {
      main.setAttribute('aria-busy','false');main.innerHTML='<div class="success-icon" aria-hidden="true">✓</div><p class="eyebrow">E-Mail-Einstellungen</p><h1>Ihre Abmeldung ist gespeichert.</h1><p class="intro-copy">Sie erhalten keine weiteren automatischen E-Mails zur Kundenbetreuung aus diesem Projekt.</p><p class="success-footnote">Sie können diese Seite jetzt schließen.</p>';focusHeading();
    }
    function renderIntro() {
      const payload=state.payload;
      const offer=payload.offer;
      const verifiedOffer=offer?.verified===true && typeof offer.monthlyCost==='number' && Number.isFinite(offer.monthlyCost) && offer.monthlyCost>=0 && typeof offer.provider==='string';
      const offerTitle=verifiedOffer ? (offer.sourceType==='verified-document'?'Manuell geprüftes Originalangebot':'Geprüftes Anbieterangebot') : offer?.headline;
      const offerSummary=verifiedOffer ? offer.provider+' · '+offer.monthlyCost.toLocaleString('de-DE',{style:'currency',currency:'EUR'})+' monatlich'+(offer.expiresAt?' · gültig bis '+new Date(offer.expiresAt).toLocaleDateString('de-DE'):'')+(offer.summary?'\n'+offer.summary:'') : offer?.summary;
      main.innerHTML=`<p class="eyebrow">${payload.kind==='optimization'?'Ein frischer Blick auf Ihre Möglichkeiten':'Ihr Jahres-Check-up'}</p><h1>${escapeHtml(payload.title || (payload.kind==='optimization'?'Passt Ihr Vertrag noch zu Ihrem Leben?':'Das Leben verändert sich. Ihre Beratung auch.'))}</h1><p class="intro-copy">${escapeHtml(payload.intro || 'Mit ein paar kurzen Antworten bringen Sie uns auf den neuesten Stand. Gemeinsam schauen wir, was weiterhin passt und wo sich ein genauerer Blick lohnt.')}</p><div class="intro-benefits"><span><i>✓</i>${state.questions.length} kurze Fragen</span><span><i>✓</i>In etwa 2 Minuten</span><span><i>✓</i>Auch ohne Termin</span></div><div class="intro-card"><strong>${escapeHtml(offerTitle || 'Was hat sich bei Ihnen verändert?')}</strong><p>${escapeHtml(offerSummary || 'Familie, Wohnen, Beruf oder neue Pläne: Sie sagen uns, was wichtig ist. Wir kümmern uns um den nächsten Schritt.')}</p>${verifiedOffer&&offer.conditions?`<details class="offer-conditions"><summary>Bedingungen und Leistungsumfang ansehen</summary><p>${escapeHtml(offer.conditions)}</p></details>`:''}</div><div class="intro-actions"><button type="button" class="button" data-start>Check-up starten <span class="arrow" aria-hidden="true">→</span></button><span class="microcopy">Ihre Antworten gehen an Ihre persönliche Betreuung.</span></div>`;
      main.querySelector('[data-start]').addEventListener('click',()=>{state.step=0;renderStep();});appendEmailPreference();
    }
    function readAnswer() {
      const question=state.questions[state.step];
      if (!question) return true;
      let answer;
      if (question.type==='text') answer=main.querySelector('textarea')?.value || '';
      else if(question.type==='multi') answer=Array.from(main.querySelectorAll('input:checked'),input=>input.value);
      else answer=main.querySelector('input:checked')?.value || '';
      state.answers[question.id]=answer;
      return validateAnswer(question,answer);
    }
    function renderStep() {
      if(state.step>=state.questions.length) return renderReview();
      const question=state.questions[state.step], answer=state.answers[question.id], completed=state.step+1;
      const options = question.type==='text'
        ? `<textarea id="answer" maxlength="${question.maxLength}" placeholder="${escapeHtml(question.placeholder)}" ${question.required?'required':''}>${escapeHtml(answer || '')}</textarea><span class="character-count" data-count>${String(answer || '').length} / ${question.maxLength}</span>`
        : `<div class="options">${question.options.map(option=>`<label class="option"><input type="${question.type==='multi'?'checkbox':'radio'}" name="answer" value="${escapeHtml(option.value)}" ${(question.type==='multi'?Array.isArray(answer)&&answer.includes(option.value):answer===option.value)?'checked':''}><span>${escapeHtml(option.label)}</span></label>`).join('')}</div>`;
      main.innerHTML=`<div class="step-top"><b>Ihr Check-up</b><span>Frage ${completed} von ${state.questions.length}</span></div><div class="progress-track" role="progressbar" aria-label="Fortschritt" aria-valuemin="0" aria-valuemax="${state.questions.length}" aria-valuenow="${state.step}"><div class="progress-fill" style="width:${state.step/state.questions.length*100}%"></div></div><h2 id="questionTitle">${escapeHtml(question.label)}</h2><p class="question-hint">${escapeHtml(question.hint || (question.type==='multi'?'Mehrere Antworten sind möglich.':question.required?'Wählen Sie die Antwort, die am besten passt.':'Diese Frage können Sie auch überspringen.'))}</p><form data-question novalidate><fieldset class="question-fieldset" aria-labelledby="questionTitle"><legend class="sr-only">${escapeHtml(question.label)}</legend>${options}</fieldset><div class="error" data-error role="alert"></div><div class="question-actions"><button type="button" class="button secondary" data-back>Zurück</button><button type="submit" class="button">${state.step===state.questions.length-1?'Weiter zum Abschluss':'Weiter'} <span class="arrow" aria-hidden="true">→</span></button></div></form>`;
      main.querySelector('[data-question]').addEventListener('submit',event=>{event.preventDefault();if(!readAnswer()){errorText(question.type==='text'?'Bitte ergänzen Sie eine kurze Antwort.':'Bitte wählen Sie eine passende Antwort aus.');main.querySelector('input,textarea')?.focus();return;}state.step++;renderStep();});
      main.querySelector('[data-back]').addEventListener('click',()=>{readAnswer();state.step--;state.step<0?renderIntro():renderStep();focusHeading();});
      main.querySelector('textarea')?.addEventListener('input',event=>{main.querySelector('[data-count]').textContent=`${event.target.value.length} / ${question.maxLength}`;});
      appendEmailPreference();focusHeading();
    }
    function renderReview() {
      main.innerHTML=`<div class="step-top"><b>Fast geschafft</b><span>Ihre nächsten Schritte</span></div><div class="progress-track"><div class="progress-fill" style="width:100%"></div></div><h2>Wie dürfen wir Sie unterstützen?</h2><p class="question-hint">Sie entscheiden, wie es weitergeht. Beides ist freiwillig.</p><form data-review><div class="review-card"><label class="option"><input type="checkbox" name="interest" ${state.interest?'checked':''}><span><strong>${state.payload.kind==='optimization'?'Ja, ich interessiere mich für eine Optimierung.':'Bitte prüfen Sie meine Möglichkeiten.'}</strong><small>Ihre persönliche Betreuung erhält Ihren Wunsch und meldet sich bei Ihnen.</small></span></label><label class="option"><input type="checkbox" name="booking" ${state.bookingRequested?'checked':''}><span><strong>Ich möchte einen Beratungstermin.</strong><small>Nach dem Absenden können Sie einen verfügbaren Termin wählen, sofern Ihre Betreuung eine Online-Buchung anbietet.</small></span></label><p class="review-note">Mit dem Absenden übermitteln Sie Ihre Antworten an Ihre Betreuung. Ein Vertrag wird dadurch weder geändert noch abgeschlossen.</p></div><div class="error" data-error role="alert"></div><div class="question-actions"><button type="button" class="button secondary" data-back>Zurück</button><button type="submit" class="button" data-submit>Antworten absenden <span class="arrow" aria-hidden="true">→</span></button></div></form>`;
      main.querySelector('[data-back]').addEventListener('click',()=>{state.interest=main.querySelector('[name=interest]').checked;state.bookingRequested=main.querySelector('[name=booking]').checked;state.step--;renderStep();});
      main.querySelector('[data-review]').addEventListener('submit',submit);
      appendEmailPreference();focusHeading();
    }
    async function submit(event) {
      event.preventDefault();if(state.busy || state.submitted) return;
      if(!state.idempotencyKey) {errorText('Ihr Browser kann die Antwort gerade nicht sicher übermitteln. Bitte öffnen Sie den Link in einem aktuellen Browser.');return;}
      if(!state.questions.every(question=>validateAnswer(question,state.answers[question.id]))) {errorText('Bitte gehen Sie zurück und vervollständigen Sie die Antworten.');return;}
      state.interest=main.querySelector('[name=interest]').checked;state.bookingRequested=main.querySelector('[name=booking]').checked;state.busy=true;
      main.querySelectorAll('button,input').forEach(element=>{element.disabled=true;});
      main.querySelector('[data-submit]').textContent='Wird übermittelt …';errorText('');
      try {
        const result=await request({method:'POST',body:JSON.stringify({answers:state.answers,interest:state.interest,bookingRequested:state.bookingRequested,idempotencyKey:state.idempotencyKey})});
        if(destroyed)return;
        if(!['submitted','already-submitted','already_submitted'].includes(result.status) && result.submitted!==true) throw new Error('Die Übermittlung konnte noch nicht bestätigt werden. Bitte versuchen Sie es erneut.');
        state.submitted=true;renderSuccess(result);
      } catch(error) {
        if(destroyed)return;
        if([404,410].includes(error.status)) invalid(error.code==='revoked'?'revoked':error.status===410?'expired':'invalid');
        else {errorText(error.message || 'Die Verbindung wurde unterbrochen. Bitte versuchen Sie es erneut.');main.querySelectorAll('button,input').forEach(element=>{element.disabled=false;});const button=main.querySelector('[data-submit]');if(button)button.textContent='Erneut absenden';}
      } finally {state.busy=false;}
    }
    function renderSuccess(result={}) {
      const booking=safeHttpsUrl(result.bookingUrl);
      main.innerHTML=`<div class="success-icon" aria-hidden="true">✓</div><p class="eyebrow">Check-up abgeschlossen</p><h1>Danke. Jetzt sind wir wieder auf dem neuesten Stand.</h1><p class="intro-copy">Ihre Antworten sind eingegangen.${state.interest?' Ihr Wunsch nach einer Optimierung wurde an Ihre Betreuung weitergegeben.':''}</p>${state.bookingRequested?`<div class="success-card"><strong>${booking?'Lassen Sie uns persönlich sprechen.':'Ihr Terminwunsch ist angekommen.'}</strong><p>${booking?'Wählen Sie im Kalender einen passenden Termin. Die verbindliche Bestätigung erhalten Sie im Buchungssystem.':'Ihre Betreuung erhält Ihren Terminwunsch und kann die weiteren Details mit Ihnen abstimmen.'}</p>${booking?`<a class="button" href="${escapeHtml(booking)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">Termin auswählen <span class="arrow" aria-hidden="true">↗</span></a>`:''}</div>`:''}<p class="success-footnote">Sie können diese Seite jetzt schließen.</p>`;appendEmailPreference();focusHeading();
    }
    async function load() {
      if(!/^[A-Za-z0-9_-]{24,256}$/.test(token || '')) return invalid();
      try {
        const payload=await request({method:'GET'});if(destroyed)return;state.payload=payload;
        if(payload.status==='unsubscribed')return renderUnsubscribed();
        if(['expired','revoked','invalid'].includes(payload.status))return invalid(payload.status);
        if(['submitted','already-submitted','already_submitted'].includes(payload.status)){state.submitted=true;state.bookingRequested=payload.bookingRequested===true || Boolean(safeHttpsUrl(payload.bookingUrl));state.interest=payload.interest===true;renderSuccess(payload);return;}
        const questions=normalizeQuestions(payload.questions);
        if(!questions) return invalid('unavailable');
        state.payload=payload;state.questions=questions;
        projectName.textContent=String(payload.project?.name || 'Ihr persönlicher Check-up');
        if(/^#[\da-f]{6}$/i.test(payload.project?.accentColor || '')) document.documentElement.style.setProperty('--accent',payload.project.accentColor);
        document.title=(payload.kind==='optimization'?'Ihr persönlicher Vertrags-Check':'Ihr Jahres-Check-up')+' · '+projectName.textContent;
        main.setAttribute('aria-busy','false');renderIntro();
      }catch(error){if(!destroyed)invalid(error.code==='revoked'?'revoked':error.status===410?'expired':error.status===404?'invalid':'unavailable');}
    }
    load();
    return {destroy(){destroyed=true;main.replaceChildren();},reload:load};
  }
  global.IVACheckup={mount,normalizeQuestions,validateAnswer,safeHttpsUrl};
  if(typeof document!=='undefined') {
    const main=document.getElementById('checkupMain'),projectName=document.getElementById('projectName');
    const match=global.location?.pathname.match(/^\/checkup\/([A-Za-z0-9_-]+)\/?$/);
    if(main&&projectName)mount({main,projectName,token:match?.[1] || ''});
  }
})(globalThis);
