import {createHash,randomUUID} from 'node:crypto';
import {createCustomerCareStore,careError,careId} from './store.js';
import {cleanCareText} from './rules.js';
export function createCustomerCareQuotes({dataDir,customers,getWorkspace,readWorkspaceFile,now=Date.now}) {
 const store=createCustomerCareStore({dataDir});
 async function context(scope){const rows=await customers(scope);if(!scope.workspaceId||rows.length!==1)throw careError('Bitte genau eine Kundenakte auswählen.');const state=await store.read(scope.projectId);return {customer:rows[0],state};}
 async function proof(workspaceId,documentId){const file=await readWorkspaceFile(workspaceId,documentId);if(!file||file.buffer.subarray(0,5).toString()!=='%PDF-')throw careError('Das Originalangebot muss als PDF in dieser Kundenakte liegen.');return {sourceDocumentId:documentId,sourceSha256:createHash('sha256').update(file.buffer).digest('hex')};}
 return {
   async list(scope){if(!scope.workspaceId)return {documents:[],quotes:[]};const {state,customer}=await context(scope);const workspace=await getWorkspace(customer.workspaceId);return {documents:(workspace?.files||[]).filter(f=>f.mime==='application/pdf'||/\.pdf$/i.test(f.name)).map(f=>({id:f.id,name:f.name})),quotes:(state.quotes||[]).filter(q=>q.customerId===customer.id&&q.workspaceId===customer.workspaceId)};},
   async save(scope,input){const {customer,state}=await context(scope);const contract=state.contracts.find(c=>c.id===input.contractId&&c.customerId===customer.id&&c.workspaceId===customer.workspaceId);if(!contract)throw careError('Vertrag nicht in dieser Kundenakte gefunden.',404);
     if(input.reviewConfirmed!==true)throw careError('Bitte Preis und Leistungsumfang anhand des Originalangebots prüfen.');
     const price=input.monthlyCost;if(typeof price!=='number'||!Number.isFinite(price)||price<0||price>1000000)throw careError('Der monatliche Gesamtpreis ist ungültig.');
     const expiresAt=Date.parse(input.expiresAt);if(!Number.isFinite(expiresAt)||expiresAt<=now()||expiresAt>now()+366*86400000)throw careError('Bitte eine gültige Angebotsfrist hinterlegen.');
     const provider=cleanCareText(input.provider,160),summary=cleanCareText(input.summary,2000),conditions=cleanCareText(input.conditions,4000);if(!provider||!summary||!conditions)throw careError('Anbieter, Vergleichsergebnis und Leistungsbedingungen fehlen.');
     const source=await proof(customer.workspaceId,careId(input.sourceDocumentId));
     const quote={id:randomUUID(),projectId:scope.projectId,customerId:customer.id,workspaceId:customer.workspaceId,contractId:contract.id,provider,monthlyCost:price,currency:'EUR',expiresAt:new Date(expiresAt).toISOString(),checkedAt:new Date(now()).toISOString(),reviewedAt:new Date(now()).toISOString(),reviewedBy:'admin',sourceType:'verified-document',verified:true,providerVerified:false,summary,conditions,...source};
     return store.transaction(scope.projectId,current=>{current.quotes||=[];const existing=current.quotes.find(q=>q.sourceSha256===quote.sourceSha256&&q.contractId===quote.contractId&&q.provider===provider&&q.monthlyCost===price&&q.expiresAt===quote.expiresAt);if(existing)return existing;current.quotes.push(quote);if(current.quoteChecks)delete current.quoteChecks[contract.id];for(const n of current.notifications)if(n.kind==='quote-required'&&n.contractId===contract.id)n.status='resolved';return quote;});
   },
   async get({projectId,customer,contract}) {const state=await store.read(projectId);const candidates=(state.quotes||[]).filter(q=>q.customerId===customer.id&&q.workspaceId===customer.workspaceId&&q.contractId===contract.id&&Date.parse(q.expiresAt)>now()).sort((a,b)=>b.checkedAt.localeCompare(a.checkedAt));for(const q of candidates){try{const actual=await proof(customer.workspaceId,q.sourceDocumentId);if(actual.sourceSha256===q.sourceSha256)return q;}catch{}}return null;}
 };
}
