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

let failures = 0;
function check(name, value) {
  const ok = Boolean(value);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failures += 1;
}

const projects = await listProjects();
const heat = projects.find(item => item.id === 'heat-hero');
check('Heat Hero vorhanden', heat);
check('Projektphasen sichtbar', heat.phases.length === 5);
check('Automationen sichtbar', heat.automations.length >= 6);
check('Planbar aktiv', heat.automations.some(item => item.id === 'planbar-weekly-export' && item.status === 'active' && item.enabled));
check('Planbar-Vervollständigung ist live schaltbar und aktiv', heat.automations.some(item => item.id === 'planbar-completion-morning' && item.toggleAvailable && item.status === 'active' && item.enabled));
check('KfW-Morgenlauf wird ohne ausführbaren Job nicht fälschlich als aktiv gezeigt', heat.automations.some(item => item.id === 'kfw-approval-morning' && item.status === 'blocked' && !item.toggleAvailable && !item.enabled));
check('Montage-Pflichtfeldlauf separat schaltbar', heat.automations.some(item => item.id === 'montage-required-fields-morning' && item.toggleAvailable && item.enabled));
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
const blockedKfwToggle = await setProjectAutomationEnabled('heat-hero', 'kfw-approval-morning', true).then(() => false).catch(error => /noch nicht ausführbar/.test(error.message));
check('Blockierter KfW-Morgenlauf kann nicht versehentlich eingeschaltet werden', blockedKfwToggle);
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
check('Markenprofil mit Logo, Website und Instagram ist bedienbar', html.includes('Markenprofil bearbeiten') && html.includes('projectWebsite') && html.includes('projectInstagram') && html.includes('projectLogo') && js.includes('/logo') && js.includes('projectLogo(project)'));
check('Kunde terminieren steht oben mit Kundenname und KW-Auswahl bereit', html.includes('.workflow-launcher') && js.includes('Kunde terminieren') && js.includes('scheduleCustomerName') && js.includes('scheduleWeek') && js.includes('/customer-scheduling-requests'));
check('Kunde terminieren startet direkt und erklärt die Fünf-Tage-Kapazität', js.includes('Jetzt terminieren') && js.includes('direkt an den Planbar-Workflow') && js.includes('vollständig freien fünf Tagen'));
check('Kundentypen, Kürzelverwaltung und Enter-Ersatzplatz sind bedienbar', js.includes('schedulePartner') && js.includes('schedulePartnerPrefixes') && js.includes('saveCustomerSchedulingPartners') && js.includes('scheduleAllowFreeResourceFallback') && js.includes('ENTER-Block'));
check('Kunde terminieren ist standardmäßig kompakt einklappbar', js.includes('<details class="workflow-launcher workflow-launcher-disclosure"') && html.includes('.workflow-launcher-disclosure'));
check('Materialfragen und optionale Zusatzinfo stehen im Schnellstart bereit', js.includes('scheduleMaterialDeliverySpace') && js.includes('scheduleTheftWeatherProtected') && js.includes('scheduleAdditionalInfo'));

console.log(failures ? `${failures} Fehler` : 'Projektakten erfolgreich verifiziert.');
process.exit(failures ? 1 : 0);
