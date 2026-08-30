import fs from 'fs/promises';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-projects-'));
const {
  addCustomerSchedulingRequest,
  addProjectNote,
  createProject,
  createProjectFolder,
  deleteProjectLogo,
  deleteProject,
  getProject,
  listProjects,
  readProjectFile,
  readProjectLogo,
  renameProjectAutomation,
  setProjectAutomationEnabled,
  storeProjectFile,
  storeProjectLogo,
  updateProject,
} = await import('../projects/store.js');
const { summarizeDewarmteLinkPdfJobs, validateDewarmteLinkPdfInput } = await import('../projects/dewarmte.js');

let failures = 0;
function check(name, value) {
  const ok = Boolean(value);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures += 1;
}

const projects = await listProjects();
const heat = projects.find(item => item.id === 'heat-hero');
const dewarmte = projects.find(item => item.id === 'dewarmte');
check('Heat Hero vorhanden', heat);
check('DeWarmte als eigenes Projekt vorhanden', dewarmte?.name === 'DeWarmte' && dewarmte.status === 'active');
check('DeWarmte-Linkworkflow sichtbar und aktiv', dewarmte?.automations.some(item => item.id === 'dewarmte-link-to-material-pdf' && item.status === 'active' && item.enabled && item.toggleAvailable));
check('DeWarmte-Quelle ist strikt nur lesend', dewarmte?.automations.some(item => item.id === 'dewarmte-link-to-material-pdf' && /keine Änderung.*Löschung/i.test(item.safety)));
check('DeWarmte-Linkeingabe normalisiert Download ohne Empfänger', validateDewarmteLinkPdfInput({ sourceUrl: 'https://docs.google.com/document/d/test/edit#heading', deliveryMode: 'download' }).recipientEmail === '');
check('DeWarmte-Mailversand braucht Empfänger', (() => { try { validateDewarmteLinkPdfInput({ sourceUrl: 'https://example.com/plan.pdf', deliveryMode: 'email-send' }); return false; } catch (error) { return /Empfängeradresse/.test(error.message); } })());
check('DeWarmte blockiert lokale Quelllinks', (() => { try { validateDewarmteLinkPdfInput({ sourceUrl: 'https://127.0.0.1/plan.pdf' }); return false; } catch (error) { return /öffentlichen HTTPS-Link/.test(error.message); } })());
check('Projektphasen sichtbar', heat.phases.length === 5);
check('Automationen sichtbar', heat.automations.length >= 6);
check('Planbar aktiv', heat.automations.some(item => item.id === 'planbar-weekly-export' && item.status === 'active' && item.enabled));
check('Planbar-Vervollständigung ist live schaltbar und aktiv', heat.automations.some(item => item.id === 'planbar-completion-morning' && item.toggleAvailable && item.status === 'active' && item.enabled));
check('Installationsplan-Materialliste ist als aktiver Nur-Lese-Workflow verfügbar', heat.automations.some(item => item.id === 'installation-plan-material-list' && item.toggleAvailable && item.status === 'active' && item.enabled && /nichts.*löschen|Löschung/i.test(item.safety)));
check('Förderung 1 ist benannt, aktiv und um 05:00 Uhr iMac-gebunden', heat.automations.some(item => item.id === 'funding-monitor' && item.name === 'Förderung 1 – Vollständigkeit & Unterlagen' && item.status === 'active' && item.enabled && /iMac/.test(item.execution)));
check('Förder-Gesamtlauf ist als zentraler geordneter Start sichtbar und aktiv', heat.automations.some(item => item.id === 'funding-daily-sequence' && item.status === 'active' && item.enabled && /1 → 2 → 3/.test(item.name)));
check('Förderung 2 ist benannt und aktiv', heat.automations.some(item => item.id === 'kfw-funding-amount-morning' && item.name === 'Förderung 2 – Förderhöhe prüfen' && item.status === 'active' && item.enabled));
check('Förderung 3 ist benannt und aktiv', heat.automations.some(item => item.id === 'kfw-approval-morning' && item.name === 'Förderung 3 – KfW-Zusagen prüfen' && item.status === 'active' && item.enabled));
check('Projektprotokoll erwartet den geordneten Förder-Tageslauf', heat.protocolPolicy.expectedWorkflows.some(item => item.workflowId === 'funding-daily-sequence' && item.cadence === 'daily'));
check('Montage-Pflichtfeldlauf separat schaltbar', heat.automations.some(item => item.id === 'montage-required-fields-morning' && item.toggleAvailable && item.enabled));
check('HeatHero-Rückmeldungen laufen täglich im großen CRM', heat.automations.some(item => item.id === 'heat-hero-too-often-replies' && item.status === 'active' && item.enabled));
check('HeatHero-Rückmeldungen werden im Tagesprotokoll erwartet', heat.protocolPolicy.expectedWorkflows.some(item => item.workflowId === 'heat-hero-too-often-replies' && item.cadence === 'daily'));
const heatWithSchedulingRequest = await addCustomerSchedulingRequest('heat-hero', {
  customerName: 'Stefanie Schneider', isoYear: 2026, week: 39,
  partnerId: 'enter', allowFreeResourceFallback: true,
  materialDeliverySpace: true, theftWeatherProtected: false,
  additionalInfo: 'Zufahrt nur über den Hof.',
});
const schedulingRequest = heatWithSchedulingRequest.customerSchedulingRequests[0];
check('Kunde-terminieren-Auftrag wird in der Projektakte vorgemerkt', schedulingRequest?.command.includes('Kunde terminieren: Stefanie Schneider in KW 39/2026'));
check('Enter-Auftrag speichert EN und den erlaubten freien Ersatzplatz', schedulingRequest?.partnerPrefix === 'EN' && schedulingRequest?.schedulingMode === 'enter-block-first' && schedulingRequest?.allowFreeResourceFallback === true);
check('Materialantworten werden für Planbar gespeichert', schedulingRequest?.planbarDescriptionExtras.includes('Materialannahme einige Tage vor Montagebeginn: Ja') && schedulingRequest?.planbarDescriptionExtras.includes('Diebstahl- und wettersicher: Nein'));
check('Vorhandene Zusatzinfo wird für Planbar gespeichert', schedulingRequest?.planbarDescriptionExtras.includes('Zusatzinfo: Zufahrt nur über den Hof.'));
const withoutAdditionalInfo = await addCustomerSchedulingRequest('heat-hero', { customerName: 'Max Mustermann', partnerId: 'heat-hero', isoYear: 2026, week: 40, materialDeliverySpace: false, theftWeatherProtected: true, additionalInfo: '   ' });
check('Leere Zusatzinfo wird nicht an Planbar übergeben', !withoutAdditionalInfo.customerSchedulingRequests[0]?.planbarDescriptionExtras.some(line => line.startsWith('Zusatzinfo:')));
const invalidSchedulingWeek = await addCustomerSchedulingRequest('heat-hero', { customerName: 'Stefanie Schneider', isoYear: 2026, week: 54, materialDeliverySpace: true, theftWeatherProtected: true }).then(() => false).catch(error => /Kalenderwoche/.test(error.message));
check('Ungültige Kalenderwoche wird abgewiesen', invalidSchedulingWeek);
check('Herstellerlauf pausiert', heat.automations.some(item => item.id === 'manufacturer-leads-wattfox' && item.status === 'paused' && !item.enabled));
const disabledKfw = await setProjectAutomationEnabled('heat-hero', 'kfw-approval-morning', false);
check('Förderung 3 lässt sich kontrolliert ausschalten', disabledKfw.automations.some(item => item.id === 'kfw-approval-morning' && item.status === 'paused' && !item.enabled));
const enabledKfw = await setProjectAutomationEnabled('heat-hero', 'kfw-approval-morning', true);
check('Förderung 3 lässt sich wieder einschalten', enabledKfw.automations.some(item => item.id === 'kfw-approval-morning' && item.status === 'active' && item.enabled));
const disabledHeat = await setProjectAutomationEnabled('heat-hero', 'planbar-weekly-export', false);
check('Projektworkflow lässt sich ausschalten', disabledHeat.automations.some(item => item.id === 'planbar-weekly-export' && item.status === 'paused' && !item.enabled));
const enabledHeat = await setProjectAutomationEnabled('heat-hero', 'planbar-weekly-export', true);
check('Projektworkflow lässt sich wieder einschalten', enabledHeat.automations.some(item => item.id === 'planbar-weekly-export' && item.status === 'active' && item.enabled));
const disabledPlanbarCompletion = await setProjectAutomationEnabled('heat-hero', 'planbar-completion-morning', false);
check('Planbar-Vervollständigung lässt sich ausschalten', disabledPlanbarCompletion.automations.some(item => item.id === 'planbar-completion-morning' && item.status === 'paused' && !item.enabled));
const enabledPlanbarCompletion = await setProjectAutomationEnabled('heat-hero', 'planbar-completion-morning', true);
check('Planbar-Vervollständigung lässt sich wieder einschalten', enabledPlanbarCompletion.automations.some(item => item.id === 'planbar-completion-morning' && item.status === 'active' && item.enabled));
const renamedPlanbar = await renameProjectAutomation('heat-hero', 'planbar-weekly-export', 'Planbar Kunden- und Herstellerlisten');
check('Workflow-Name lässt sich frei anpassen und speichern', renamedPlanbar.automations.some(item => item.id === 'planbar-weekly-export' && item.name === 'Planbar Kunden- und Herstellerlisten'));
const invalidWorkflowName = await renameProjectAutomation('heat-hero', 'planbar-weekly-export', ' ').then(() => false).catch(error => /mindestens zwei Zeichen/.test(error.message));
check('Leerer Workflow-Name wird abgewiesen', invalidWorkflowName);
await updateProject('heat-hero', {
  status: 'active',
  files: [{ storageName: 'injected' }],
  customerSchedulingPartners: [
    ...heat.customerSchedulingPartners,
    { id: 'partner-x', name: 'Partner X', prefix: 'PX', schedulingMode: 'free-resource' },
  ],
});
const updatedHeat = await getProject('heat-hero');
check('Projektupdate bleibt gespeichert', updatedHeat.status === 'active');
check('Projektupdate kann Dateien nicht einschleusen', updatedHeat.files.length === 0);
check('Zusätzliche Planbar-Kürzel lassen sich speichern', updatedHeat.customerSchedulingPartners.some(item => item.name === 'Partner X' && item.prefix === 'PX'));

const project = await createProject({ name: 'Testprojekt', category: 'Test', description: 'Projektakte testen', websiteUrl: 'beispiel.de', instagramUrl: '@beispiel.marke' });
check('Neues Projekt erhält sichere ID', /^[a-z0-9-]+$/i.test(project.id));
check('Website und Instagram werden als Markenprofil normalisiert', project.websiteUrl === 'https://beispiel.de/' && project.instagramUrl === 'https://www.instagram.com/beispiel.marke');
const logoInjection = await updateProject(project.id, { logo: { name: 'falsch.png', mime: 'image/png', storageName: '../../falsch.png' } });
check('Projektupdate kann kein internes Logo einschleusen', logoInjection.logo === null);
const logoBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const withLogo = await storeProjectLogo(project.id, { name: 'marke.png', mime: 'image/png', buffer: logoBuffer });
check('Projektlogo wird gespeichert und intern geschützt', withLogo.logo?.name === 'marke.png' && !Object.hasOwn(withLogo.logo, 'storageName'));
const readLogo = await readProjectLogo(project.id);
check('Projektlogo ist unverändert abrufbar', readLogo.meta.mime === 'image/png' && readLogo.buffer.equals(logoBuffer));
const withoutLogo = await deleteProjectLogo(project.id);
check('Projektlogo lässt sich entfernen', withoutLogo.logo === null && !(await readProjectLogo(project.id)));
await storeProjectLogo(project.id, { name: 'marke.png', mime: 'image/png', buffer: logoBuffer });
const invalidLogoRejected = await storeProjectLogo(project.id, { name: 'falsch.png', mime: 'image/png', buffer: Buffer.from('kein bild') }).then(() => false).catch(error => /Dateityp und Inhalt/.test(error.message));
check('Falsche Logo-Dateien werden abgelehnt', invalidLogoRejected);
const withNote = await addProjectNote(project.id, 'Idee und Absprache');
check('Notiz wird gespeichert', withNote.notes.some(note => note.text === 'Idee und Absprache'));
const withRoot = await createProjectFolder(project.id, { name: 'Unterlagen' });
const rootFolder = withRoot.folders.find(folder => folder.name === 'Unterlagen');
const withChild = await createProjectFolder(project.id, { name: 'Angebote', parentId: rootFolder.id });
const childFolder = withChild.folders.find(folder => folder.name === 'Angebote');
check('Unterordner wird korrekt zugeordnet', childFolder.parentId === rootFolder.id);

const payload = Buffer.from('Projektdatei-Inhalt');
const storedFile = await storeProjectFile(project.id, { name: 'angebot.txt', mime: 'text/plain', folderId: childFolder.id, buffer: payload });
const projectWithFile = await getProject(project.id);
check('Datei wird dem Unterordner zugeordnet', projectWithFile.files.some(file => file.id === storedFile.id && file.folderId === childFolder.id));
check('Interner Speichername bleibt privat', !Object.hasOwn(projectWithFile.files[0], 'storageName'));
const readFile = await readProjectFile(project.id, storedFile.id);
check('Projektdatei ist unverändert abrufbar', readFile.buffer.equals(payload));

await deleteProject(project.id);
check('Projektakte wird gelöscht', !(await getProject(project.id)));
const deletedFilePath = path.join(process.env.DATA_DIR, 'project-files', project.id);
check('Projektdateien werden mitgelöscht', await fs.access(deletedFilePath).then(() => false).catch(() => true));
await deleteProject('heat-hero');
check('Gelöschtes Standardprojekt wird nicht neu erzeugt', !(await listProjects()).some(item => item.id === 'heat-hero'));

const html = await fs.readFile(new URL('../public/projects.html', import.meta.url), 'utf8');
const js = await fs.readFile(new URL('../public/projects.js', import.meta.url), 'utf8');
check('Plus für neue Projektakten vorhanden', html.includes('＋ Neues Projekt') && js.includes("api('/api/projects'"));
check('Notizen stehen in der Projektakte bereit', js.includes('Notizen, Ideen & Absprachen') && js.includes('/notes'));
check('Ordner, Unterordner und Mehrfachupload vorhanden', html.includes('multiple') && js.includes('/folders') && js.includes('parentId'));
check('Papierkorb löscht nur die Projektakte', js.includes('Projektdateien werden entfernt') && js.includes("method: 'DELETE'"));
check('Projektbereiche sind standardmäßig zugeklappt', html.includes('project-disclosure') && js.includes('collapseProjectSections'));
check('Projektworkflows haben echte Ein-Aus-Schalter', html.includes('.switch{') && js.includes('class="switch"') && js.includes('data-project-automation') && js.includes("method: 'PATCH'"));
check('Workflow-Namen sind bearbeitbar und speicherbar', js.includes('data-workflow-name') && js.includes('data-workflow-save') && js.includes('saveWorkflowName'));
check('Jeder Workflow hat manuellen Start oder IVA-Fertigstellungsauftrag', js.includes('▶ Jetzt auslösen') && js.includes('✦ Mit IVA fertig bauen') && js.includes('/${action}') && js.includes('runOrPrepareWorkflow'));
check('Installationsplan-Materialliste besitzt den echten manuellen Start', js.includes("'installation-plan-material-list'") && js.includes('MANUAL_WORKFLOW_IDS'));
check('Alle drei Förderungsläufe und der geordnete Gesamtlauf besitzen den echten manuellen Start', ['funding-daily-sequence', 'funding-monitor', 'kfw-funding-amount-morning', 'kfw-approval-morning'].every(id => js.includes(`'${id}'`)) && js.includes('MANUAL_WORKFLOW_IDS'));
check('DeWarmte zeigt Link-rein-PDF-raus direkt in der Projektakte', js.includes('Link rein → PDF raus') && js.includes('dewarmtePdfForm') && js.includes('/api/projects/dewarmte/link-pdf-jobs'));
check('DeWarmte zeigt festen Deckblatt- und Materialaufbau', js.includes('Immer unverändert aus Seite 1 der Installationsplanung') && js.includes('DeWarmte Material') && js.includes('HEAT|Hero Material'));
check('DeWarmte zeigt echten Fortschrittsbalken und aktualisiert laufende Aufträge automatisch', html.includes('.dewarmte-progress') && js.includes('role="progressbar"') && js.includes('scheduleDewarmtePolling') && js.includes('refreshAfterMs'));
check('DeWarmte bietet Download, Mailentwurf und bestätigten Direktversand', js.includes('email-draft') && js.includes('email-send') && js.includes('direkt an ${recipientEmail} senden'));
check('DeWarmte akzeptiert optionalen Freitext und eine zusätzliche PDF', js.includes('dewarmteSupplementaryText') && js.includes('dewarmteSupplementaryPdf') && js.includes('/api/projects/dewarmte/supplement-pdfs'));
check('DeWarmte weist die dreitägige Löschung der Zusatzdaten aus', js.includes('nach drei Tagen automatisch gelöscht') && dewarmte?.automations.some(item => item.id === 'dewarmte-link-to-material-pdf' && /drei Tagen/.test(item.safety)));
check('DeWarmte-Jobliste verknüpft fertige PDF mit echtem Download', js.includes('data-download-file') && js.includes('downloadFile') && js.includes('job.file?.name'));
check('Markenprofil mit Logo, Website und Instagram ist bedienbar', html.includes('Markenprofil bearbeiten') && html.includes('projectWebsite') && html.includes('projectInstagram') && html.includes('projectLogo') && js.includes('/logo') && js.includes('projectLogo(project)'));
check('Kunde terminieren steht oben mit Kundenname und KW-Auswahl bereit', html.includes('.workflow-launcher') && js.includes('Kunde terminieren') && js.includes('scheduleCustomerName') && js.includes('scheduleWeek') && js.includes('/customer-scheduling-requests'));
check('Kunde terminieren startet direkt und erklärt die Fünf-Tage-Kapazität', js.includes('Jetzt terminieren') && js.includes('direkt an den Planbar-Workflow') && js.includes('vollständig freien fünf Tagen'));
check('Kundentypen, Kürzelverwaltung und Enter-Ersatzplatz sind bedienbar', js.includes('schedulePartner') && js.includes('schedulePartnerPrefixes') && js.includes('saveCustomerSchedulingPartners') && js.includes('scheduleAllowFreeResourceFallback') && js.includes('ENTER-Block'));
check('Kunde terminieren ist standardmäßig kompakt einklappbar', js.includes('<details class="workflow-launcher workflow-launcher-disclosure"') && html.includes('.workflow-launcher-disclosure'));
check('Materialfragen und optionale Zusatzinfo stehen im Schnellstart bereit', js.includes('scheduleMaterialDeliverySpace') && js.includes('scheduleTheftWeatherProtected') && js.includes('scheduleAdditionalInfo'));
const dewarmteJobId = '12345678-1234-4123-8123-123456789012';
const dewarmteFile = await storeProjectFile('dewarmte', {
  name: 'DeWarmte_Materialliste_Test.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-test'),
  workflowId: 'dewarmte-link-to-material-pdf', jobId: dewarmteJobId,
});
check('Erzeugte DeWarmte-PDF wird mit Job-Zuordnung gespeichert', dewarmteFile?.jobId === dewarmteJobId && dewarmteFile.workflowId === 'dewarmte-link-to-material-pdf');
const duplicateDewarmteFile = await storeProjectFile('dewarmte', {
  name: 'DeWarmte_Materialliste_Test.pdf', mime: 'application/pdf', buffer: Buffer.from('%PDF-test'),
  workflowId: 'dewarmte-link-to-material-pdf', jobId: dewarmteJobId,
});
check('Wiederholter DeWarmte-Upload erzeugt keine PDF-Dublette', duplicateDewarmteFile?.id === dewarmteFile.id);
const dewarmteJobs = summarizeDewarmteLinkPdfJobs([{
  id: 'command-test', action: 'project.workflow.run', status: 'completed', createdAt: '2026-08-30T07:00:00Z', result: { jobId: dewarmteJobId },
  payload: { projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', deliveryMode: 'download' },
}], [dewarmteFile], [], [{
  projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', jobId: dewarmteJobId,
  status: 'completed', phase: 'live_verification', progress: 100, updatedAt: '2026-08-30T07:04:00Z',
}]);
check('DeWarmte-Job wird nach PDF-Upload als fertig und downloadbar angezeigt', dewarmteJobs[0]?.status === 'completed' && dewarmteJobs[0]?.file?.id === dewarmteFile.id);
const dewarmteMailStillRunning = summarizeDewarmteLinkPdfJobs([{
  id: 'command-mail-running', action: 'project.workflow.run', status: 'completed', createdAt: '2026-08-30T07:00:00Z', result: { jobId: dewarmteJobId },
  payload: { projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', deliveryMode: 'email-send', recipientEmail: 'kunde@example.com' },
}], [dewarmteFile], [], [{
  projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', jobId: dewarmteJobId,
  status: 'running', phase: 'live_verification', progress: 96, updatedAt: '2026-08-30T07:03:00Z',
}]);
check('PDF-Upload allein meldet Mailversand noch nicht als fertig', dewarmteMailStillRunning[0]?.status === 'running' && dewarmteMailStillRunning[0]?.progress === 96);
const dewarmteUnverifiedMail = summarizeDewarmteLinkPdfJobs([{
  id: 'command-mail-test', action: 'project.workflow.run', status: 'completed', createdAt: '2026-08-30T07:00:00Z', result: { jobId: dewarmteJobId },
  payload: { projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', deliveryMode: 'email-send', recipientEmail: 'kunde@example.com' },
}], [dewarmteFile], [{
  workflowId: 'dewarmte-link-to-material-pdf', status: 'blocked', summary: 'Versandstatus muss im Gesendet-Ordner geprüft werden.', metrics: { jobId: dewarmteJobId },
}]);
check('Unklarer Mailversand bleibt trotz fertiger PDF sichtbar prüfbedürftig', dewarmteUnverifiedMail[0]?.status === 'blocked' && /Weitere Aktion nötig/.test(dewarmteUnverifiedMail[0]?.detail));
const dewarmteRunning = summarizeDewarmteLinkPdfJobs([{
  id: 'command-running-test', action: 'project.workflow.run', status: 'completed', createdAt: '2026-08-30T07:00:00Z', result: { jobId: dewarmteJobId },
  payload: { projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', deliveryMode: 'download' },
}], [], [], [{
  projectId: 'dewarmte', workflowId: 'dewarmte-link-to-material-pdf', jobId: dewarmteJobId,
  status: 'running', phase: 'implementing', progress: 30, updatedAt: '2026-08-30T07:02:00Z', resultPreview: 'PDF wird erstellt.',
}]);
check('DeWarmte übernimmt den gemeldeten iMac-Livefortschritt', dewarmteRunning[0]?.progress === 30 && dewarmteRunning[0]?.active === true && /Material wird zugeordnet/.test(dewarmteRunning[0]?.phase));

console.log(failures ? `${failures} Fehler` : 'Projektakten erfolgreich verifiziert.');
process.exit(failures ? 1 : 0);
