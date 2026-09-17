import { executePlanbarJavaScript, refreshPlanbarPage } from './planbar.mjs';
import { isoWeekRange, selectPlanbarSchedulingSlot } from '../operations/customer-scheduling.js';

// The wire contract is observed in Planbar's shipped planboard.js: resourceStore
// GET(startDateTime,endDateTime,resource_id,type,site_id). Customer/task creation
// is deliberately not guessed. A pre-indexed, verified existing task is required.
export function createSchedulingPlanbarAdapter({ execute = executePlanbarJavaScript, refresh = refreshPlanbarPage } = {}) {
  const call = async (input, body) => JSON.parse(await execute(`(() => {
    const input=${JSON.stringify(input)};
    const config=JSON.parse(document.querySelector('[data-planboard-config]')?.dataset.planboardConfig || '{}');
    const clean=value=>String(value||'').replace(/\\s+/g,' ').trim();
    const request=(route,params)=>{
      if(!config.routes?.[route])throw Error('Planbar route unavailable: '+route);
      const url=new URL(config.routes[route],location.origin);
      if(url.origin!==location.origin)throw Error('Planbar route origin mismatch');
      Object.entries(params).forEach(([key,value])=>url.searchParams.set(key,String(value)));
      const xhr=new XMLHttpRequest();xhr.open('GET',url.toString(),false);xhr.setRequestHeader('Accept','application/json');xhr.send(null);
      if(xhr.status<200||xhr.status>=300)throw Error('Planbar HTTP '+xhr.status);
      return JSON.parse(xhr.responseText);
    };
    ${body}
  })()`, {timeoutMs:10000}));
  const snapshot = async request => call({start:`${Number(request.isoYear)-1}-01-01`,end:`${Number(request.isoYear)+2}-01-01`}, `
    const data=request('resourceDataForTooltips',{start:input.start,end:input.end,globalEdit:true});
    if(!Array.isArray(data.entries))throw Error('Planbar entries missing');
    const resources=[...document.querySelectorAll('.fc-datagrid-body [data-resource-id]')].map(cell=>({id:clean(cell.getAttribute('data-resource-id')),name:clean(cell.innerText)}));
    const endDate=entry=>{let end=clean(entry.end).slice(0,10);const start=clean(entry.start).slice(0,10);if(!end||end<=start||/^\\d{4}-\\d{2}-\\d{2}[ T](?!00:00(?::00)?(?:\\.0+)?(?:Z|$))/.test(clean(entry.end))){const date=new Date((end||start)+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+1);end=date.toISOString().slice(0,10);}return end;};
    const entries=data.entries.map(entry=>({id:clean(entry.id),resourceId:clean(entry.resourceId),startDate:clean(entry.start).slice(0,10),endDateExclusive:endDate(entry),
      customerId:clean(entry.tooltipdata?.customer?.id),customerName:clean([entry.tooltipdata?.customer?.firstname,entry.tooltipdata?.customer?.lastname].filter(Boolean).join(' ')||entry.tooltipdata?.customer?.name),
      text:clean(entry.title||entry.text||entry.tooltipdata?.task)}));
    return JSON.stringify({resources,entries,verifiedAt:new Date().toISOString()});`);
  function matches(entry, request) {
    const normalize=value=>String(value||'').normalize('NFKC').toLocaleLowerCase('de').replace(/\s+/g,' ').trim();
    const target=normalize(request.customerName), name=normalize(entry.customerName);
    return (request.planbarCustomerId && entry.customerId===String(request.planbarCustomerId)) || name===target || name===normalize(`${request.partnerPrefix || 'HH'} ${request.customerName}`);
  }
  async function findExisting(request) {
    await refresh({execute,timeoutMs:10000});
    const data=await snapshot(request), range=isoWeekRange(request.isoYear,request.week);
    const candidates=data.entries.filter(entry=>matches(entry,request));
    if(candidates.length>1)return {ambiguous:true};
    if(candidates.length===1){
      const appointment=candidates[0];
      if(appointment.startDate!==range.startDate||appointment.endDateExclusive!==range.endDateExclusive)return {conflictingAppointment:true};
      return {appointment};
    }
    const identity=request.planbarIdentityProof;
    if(!request.planbarCustomerId||!request.planbarTaskId||identity?.verified!==true||String(identity.customerId)!==String(request.planbarCustomerId)||String(identity.taskId)!==String(request.planbarTaskId))throw Error('Planbar existing customer/task identity must be resolved before fast lane');
    const slot=selectPlanbarSchedulingSlot({resources:data.resources,bookings:data.entries,year:request.isoYear,week:request.week,schedulingMode:request.schedulingMode,allowFreeResourceFallback:request.allowFreeResourceFallback});
    // ENTER replacement requires a separately verified mutation contract; never
    // stack a new reservation onto its blocker using resourceStore.
    if(slot.blocker)throw Error('ENTER blocker replacement adapter is not yet verified');
    return {absenceVerified:true,identityVerified:true,capacityVerified:true,slot};
  }
  return {
    findExisting,
    create: async (request, observation) => {
      const fresh=await snapshot(request);
      if(fresh.entries.some(entry=>matches(entry,request)))throw Error('Planbar appointment appeared before create; reconcile existing');
      const slot=selectPlanbarSchedulingSlot({resources:fresh.resources,bookings:fresh.entries,year:request.isoYear,week:request.week,schedulingMode:request.schedulingMode,allowFreeResourceFallback:request.allowFreeResourceFallback});
      if(slot.blocker||slot.resource.id!==observation.slot.resource.id)throw Error('Planbar capacity changed before write');
      await call({startDateTime:`${slot.startDate} 00:00:00`,endDateTime:`${slot.endDateExclusive} 00:00:00`,resource_id:slot.resource.id,type:'employee',site_id:String(request.planbarTaskId)}, `
        if(config.permissions?.bookingStore!==true && config.permissions?.bookingStore!==1)throw Error('Planbar booking permission unavailable');
        const result=request('resourceStore',input);
        if(!result)throw Error('Planbar store not acknowledged');
        window.getPlanboard?.().refetchEvents();
        return JSON.stringify({accepted:true});`);
      return {resourceId:slot.resource.id};
    },
    read: async (target, request) => {
      const found=await findExisting(request);
      if(!found.appointment)throw Error('Planbar appointment readback missing or ambiguous');
      const appointment=found.appointment;
      if(target.id && target.id!==appointment.id)throw Error('Planbar appointment changed during readback');
      // Fresh API detail plus actual rendered event: accepted HTTP is never proof.
      await call({startDate:appointment.startDate}, `window.getPlanboard?.().gotoDate?.(input.startDate); return JSON.stringify({navigated:true});`);
      let detail;
      for(let attempt=0;attempt<12;attempt++){
      detail=await call({id:appointment.id}, `
        const detail=request('resourceModalData',{id:input.id});
        const calendar=window.getPlanboard?.();
        const event=calendar?.getEventById(input.id);
        const visible=!!event && !!document.querySelector('[data-resource-id="'+CSS.escape(String(event.getResources?.()[0]?.id||''))+'"]');
        return JSON.stringify({customerId:clean(detail.customer?.id),resourceId:clean(event?.getResources?.()[0]?.id),visible});`);
      if(detail.visible)break;
      await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!detail.visible||!detail.customerId||detail.resourceId!==appointment.resourceId)throw Error('Planbar visible customer/resource readback failed');
      if(request.planbarCustomerId && String(request.planbarCustomerId)!==detail.customerId)throw Error('Planbar customer ID readback mismatch');
      const data=await snapshot(request),resource=data.resources.find(item=>item.id===appointment.resourceId);
      if(!resource)throw Error('Planbar resource no longer visible');
      return {appointmentId:appointment.id,customerId:detail.customerId,resourceId:resource.id,resourceName:resource.name,...isoWeekRange(request.isoYear,request.week),isoYear:Number(request.isoYear),week:Number(request.week),verified:true,identityVerified:true,verifiedAt:new Date().toISOString()};
    },
  };
}
