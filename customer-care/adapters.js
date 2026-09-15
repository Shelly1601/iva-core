const norm = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function workspaceProjectIds(workspace, projects) {
  const data = workspace.data || {};
  const explicit = [...(Array.isArray(data.projectIds) ? data.projectIds : []), data.projectId, data.crm?.projectId].filter(Boolean);
  if (explicit.length) return projects.filter(p => explicit.includes(p.id)).map(p => p.id);
  const label = norm(data.project || data.crm?.project);
  if (!label) return [];
  return projects.filter(p => norm(p.id) === label || norm(p.name) === label).map(p => p.id);
}
export function createCustomerCareCustomers({listWorkspaces, listProjects}) {
  return async scope => {
    const [workspaces, projects] = await Promise.all([listWorkspaces({mode:'kunde'}), listProjects()]);
    const rows = workspaces.filter(w => workspaceProjectIds(w,projects).includes(scope.projectId));
    const customers = rows.map(w => ({id:w.id,workspaceId:w.id,name:w.customer?.name || w.title,email:w.customer?.email || '',
      emailAuthorized:w.data?.customerCare?.emailAuthorized === true, topics:w.data?.customerCare?.topics || [],externalId:w.customer?.id || ''}));
    // The workspace is the stable identity even if an external CRM ID changes.
    if (scope.workspaceId || scope.customerId) return customers.filter(c => (!scope.workspaceId || c.workspaceId === scope.workspaceId) && (!scope.customerId || c.id === scope.customerId || c.externalId === scope.customerId));
    return customers;
  };
}
export function createCustomerCareDelivery({enqueueDeviceCommand,findCustomerCareDeviceCommands,acknowledgeCustomerCareCommand,deviceAgentStatus}) {
  return {
    async readiness() {
      const device = await deviceAgentStatus();
      const supported = device.allowedActions?.includes('customer-care.mail.send') === true;
      return [{id:'email',label:'Outlook auf dem Mac Mini',status:device.online && supported ? 'ready' : 'missing',detail:device.online && supported ? 'Versand mit Absenderprüfung und Kontrolle im Gesendet-Ordner. Das konkrete Konto wird vor dem Versand geprüft.' : 'Mac Mini verbinden und die aktuelle IVA-Laufzeit aktivieren.'}];
    },
    async deliver(envelope) {
      const command = await enqueueDeviceCommand({action:'customer-care.mail.send',payload:{outboxId:envelope.outboxId || envelope.id,idempotencyKey:envelope.idempotencyKey,projectId:envelope.projectId},requestedBy:'customer-care',requestText:'Automatische Kundenbetreuung nach gespeicherter Regel'});
      return {status:'queued',queueId:command.id};
    },
    async reconcile(service) {
      const pending = await service.listPendingDeliveries({});
      const commands = await findCustomerCareDeviceCommands(pending.map(row=>row.id));
      for (const row of pending) {
        const cmd = commands.find(c => c.id === row.queueId || c.payload?.outboxId === row.id);
        if (!cmd) continue;
        if (cmd.result?.receipt?.status === 'uncertain') { await service.completeDelivery(row.id,cmd.result.receipt); continue; }
        if (['queued','running'].includes(cmd.status)) continue;
        if (cmd.status === 'completed' && cmd.result?.receipt) {await service.completeDelivery(row.id,cmd.result.receipt);await acknowledgeCustomerCareCommand(cmd.id);}
        else if (['failed','waiting_verification','canceled'].includes(cmd.status)) await service.completeDelivery(row.id,{status:cmd.status==='canceled'?'canceled':'uncertain',error:cmd.error || 'Der Versandbeleg fehlt.'});
      }
    }
  };
}
