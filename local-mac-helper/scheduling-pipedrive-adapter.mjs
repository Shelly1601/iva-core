import { executePipedriveJavaScript } from './chrome-pipedrive.mjs';

// Existing authenticated browser API; no token is read or copied. The caller
// holds pipedrive-write across mutation and subsequent visible/API readback.
export function createSchedulingPipedriveAdapter({ execute = executePipedriveJavaScript } = {}) {
  const invoke = async (input, operation) => {
    const dealId = String(input.dealId || '');
    if (!/^\d+$/.test(dealId)) throw Error('Scheduling requires a uniquely resolved Pipedrive deal ID');
    const result = await execute(`(() => {
      const input = ${JSON.stringify(input)};
      const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('de').replace(/\\s+/g,' ').trim();
      const request = (method, endpoint, body) => {
        const resource = globalThis.performance?.getEntriesByType?.('resource').map(entry=>entry.name).find(name=>name.includes('session_token='));
        const token = resource ? new URL(resource).searchParams.get('session_token') : '';
        const target = token ? endpoint + (endpoint.includes('?') ? '&' : '?') + 'strict_mode=true&session_token=' + encodeURIComponent(token) : endpoint;
        const xhr = new XMLHttpRequest(); xhr.open(method, target, false);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(body === undefined ? null : JSON.stringify(body));
        if (xhr.status < 200 || xhr.status >= 300) throw Error('Pipedrive HTTP ' + xhr.status);
        const response = JSON.parse(xhr.responseText);
        if (response.success !== true) throw Error('Pipedrive request not confirmed');
        return response.data;
      };
      const endpoint = '/api/v1/deals/' + input.dealId;
      ${operation}
    })()`, { dealId, timeoutMs: 10000, retryTransient: false });
    return typeof result === 'string' ? JSON.parse(result) : result;
  };
  const fieldLookup = `const fields = request('GET', '/api/v1/dealFields?start=0&limit=500');
    const matchingFields = fields.filter(field => field.name === 'Einbautermin Kalenderwoche');
    if (matchingFields.length !== 1) throw Error('Scheduling KW field is not unique');
    const field = matchingFields[0];`;
  const adapter = {
    read: async input => invoke(input, `${fieldLookup}
      const deal = request('GET', endpoint);
      const personName = deal.person_id && deal.person_id.name;
      const stages = request('GET', '/api/v1/stages?pipeline_id=' + encodeURIComponent(deal.pipeline_id) + '&start=0&limit=500')
        .filter(stage => String(stage.pipeline_id) === String(deal.pipeline_id)).sort((a,b) => Number(a.order_nr)-Number(b.order_nr));
      if (stages.some(stage => !Number.isFinite(Number(stage.order_nr))) || new Set(stages.map(stage=>Number(stage.order_nr))).size !== stages.length) throw Error('Pipedrive stage ordering ambiguous');
      const visibleSelected = document.querySelector('button.cui5-stage-selector__stage[aria-selected="true"]');
      const stage = stages.find(item => String(item.id) === String(deal.stage_id));
      const identityVerified = !!personName && normalize(personName) === normalize(input.customerName);
      return JSON.stringify({ dealId: String(deal.id), identityVerified, week: deal[field.key] || '', stageId: String(deal.stage_id),
        visibleStageOrder: stages.map(stage=>String(stage.id)), verified: identityVerified && !!stage && !!visibleSelected && normalize(visibleSelected.getAttribute('aria-label') || visibleSelected.textContent).includes(normalize(stage.name)),
        verifiedAt: new Date().toISOString(), source: 'authenticated-pipedrive-api',
        visibleSelectedStage: visibleSelected ? String(visibleSelected.textContent || '').trim() : null });`),
    writeWeek: async (dealId, value) => {
      if (!/^KW\d{2}$/.test(value)) throw Error('Scheduling KW must have two digits');
      return invoke({dealId,value}, `${fieldLookup}
        request('PUT', endpoint, { [field.key]: input.value });
        return JSON.stringify({accepted:true});`);
    },
    writeStage: async (dealId, fromStageId, toStageId) => invoke({dealId,fromStageId:String(fromStageId),toStageId:String(toStageId)}, `
      const current = request('GET', endpoint);
      if (String(current.stage_id) === input.toStageId) return JSON.stringify({alreadyPresent:true});
      if (String(current.stage_id) !== input.fromStageId) throw Error('Pipedrive source stage changed');
      const stages = request('GET', '/api/v1/stages?pipeline_id=' + encodeURIComponent(current.pipeline_id) + '&start=0&limit=500')
        .filter(stage => String(stage.pipeline_id) === String(current.pipeline_id)).sort((a,b)=>Number(a.order_nr)-Number(b.order_nr));
      const index = stages.findIndex(stage=>String(stage.id) === input.fromStageId);
      if (index < 0 || String(stages[index+1]?.id) !== input.toStageId) throw Error('Pipedrive target is not right neighbour');
      request('PUT', endpoint, {stage_id:Number(input.toStageId)});
      return JSON.stringify({accepted:true});`),
  };
  return {...adapter,read:async input=>{
    let proof=await adapter.read(input);
    if(proof.identityVerified && !proof.verified){
      // A successful API mutation must become visible in the deal's phase bar.
      // Refresh is read-only; never repeat PUT while waiting for the new UI.
      await execute('location.reload(); JSON.stringify({refreshing:true})',{dealId:String(input.dealId),timeoutMs:10000,retryTransient:false});
      for(let attempt=0;attempt<12;attempt++){
        await new Promise(resolve=>setTimeout(resolve,250));
        try {proof=await adapter.read(input);if(proof.verified)break;} catch(error){if(attempt===11)throw error;}
      }
    }
    return proof;
  }};
}
