import {tool} from 'ai';
import {z} from 'zod';
export function taxPreparationSkill({service,projectId}){
  const project=projectId?{}:{projectId:z.string().min(1).max(100)},bound=input=>({...input,projectId:projectId||input.projectId});
  const scope=z.object({...project,entityId:z.string(),year:z.number().int().min(2020).max(2100)});
  const tools = {
    getTaxPreparation:tool({description:'Liest den Jahresfragebogen, verknüpfte Belege und die nächsten offenen Fragen zur Steuer-VORBEREITUNG im aktiven Projekt. Keine Berechnung oder Übermittlung der Steuererklärung.',parameters:scope,execute:input=>service.get(bound(input))}),
    getTaxPreparationEntities:tool({description:'Listet verfügbare Rechtsträger für die Steuer-Vorbereitung des aktiven Projekts.',parameters:z.object(project),execute:input=>service.context(projectId||input.projectId)}),
    saveTaxPreparationAnswer:tool({description:'Speichert die ausdrückliche Antwort des Nutzers auf einen Steuer-Prüfpunkt, ohne Absetzbarkeit zu bestätigen. Nutze die aktuelle revision aus getTaxPreparation. Beleg-IDs nur aus diesem Rechtsträger und Jahr.',parameters:scope.extend({expectedRevision:z.number().int(),questionId:z.string(),relevance:z.enum(['yes','no','unknown']),note:z.string().max(3000),documentIds:z.array(z.string()).max(30)}),execute:({questionId,relevance,note,documentIds,expectedRevision,...input})=>service.update(bound(input),{expectedRevision,answers:{[questionId]:{relevance,note,documentIds}}})}),
  };
  return Object.fromEntries(Object.entries(tools).map(([name,value])=>[name,{...value,...(projectId?{projectId}:{}),iva:{skillId:'taxPreparation'}}]));
}
