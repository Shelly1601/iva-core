import fs from 'fs/promises';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-projects-'));
const {
  addProjectNote,
  createProject,
  createProjectFolder,
  deleteProject,
  getProject,
  listProjects,
  readProjectFile,
  storeProjectFile,
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
check('Planbar aktiv', heat.automations.some(item => item.id === 'planbar-weekly' && item.status === 'active'));
check('Herstellerlauf pausiert', heat.automations.some(item => item.id === 'manufacturer-daily' && item.status === 'paused'));
await updateProject('heat-hero', { status: 'active', files: [{ storageName: 'injected' }] });
const updatedHeat = await getProject('heat-hero');
check('Projektupdate bleibt gespeichert', updatedHeat.status === 'active');
check('Projektupdate kann Dateien nicht einschleusen', updatedHeat.files.length === 0);

const project = await createProject({ name: 'Testprojekt', category: 'Test', description: 'Projektakte testen' });
check('Neues Projekt erhält sichere ID', /^[a-z0-9-]+$/i.test(project.id));
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

console.log(failures ? `${failures} Fehler` : 'Projektakten erfolgreich verifiziert.');
process.exit(failures ? 1 : 0);
