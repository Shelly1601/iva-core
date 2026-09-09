import { courseCredentialStatus, ensureCourseLogin, getCourseCredentialProfile, storeCourseCredentialEnvelope } from './course-credentials.mjs';
import { startCodexTask } from './codex-tasks.mjs';

const clean = (value, max = 2000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);

function safeUrl(value) {
  const url = new URL(clean(value, 1800));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Der Kursimport benötigt eine sichere HTTPS-Adresse.');
  url.hash = '';
  return url.toString();
}

export function buildKnowledgeImportPrompt(input = {}) {
  const importId = clean(input.importId, 80);
  const entryId = clean(input.entryId, 80);
  const title = clean(input.title, 240);
  const sourceUrl = safeUrl(input.sourceUrl);
  const mode = input.mode === 'iva-drive' ? 'iva-drive' : 'iva-only';
  const accessMode = input.accessMode === 'purchase-needed' ? 'purchase-needed' : 'existing';
  const credentialProfileId = clean(input.credentialProfileId, 80);
  const archiveFolderUrl = mode === 'iva-drive' ? clean(input.archiveFolderUrl, 1800) : '';
  const completionCommand = `node local-mac-helper/knowledge-import-client.mjs complete ${JSON.stringify(importId)} <absoluter-manifest-pfad>`;
  return `Arbeite den von Nadine freigegebenen Kurs vollständig und systematisch über ihren normalen angemeldeten Zugang durch.

Kurs: ${title}
Startadresse: ${sourceUrl}
IVA-Wissenseintrag: ${entryId}
Importauftrag: ${importId}
Zielmodus: ${mode === 'iva-drive' ? 'IVA-Wissensdatenbank plus Lernakte in Google Drive' : 'nur IVA-Wissensdatenbank'}
Zugangsstatus: ${accessMode === 'purchase-needed' ? 'Buchung ist noch erforderlich; bis zur finalen kostenpflichtigen Bestätigung vorbereiten und dann den belegten Freigabeschritt melden' : 'Zugang beziehungsweise Abo besteht bereits'}
${archiveFolderUrl ? `Google-Drive-Hauptordner: ${archiveFolderUrl}` : ''}

Pflichtablauf:
1. Öffne oder verwende ein eigenes Chrome-Fenster ausschließlich auf dem verifizierten rechten Display. Die Anmeldung wurde vor dem Start mit dem lokalen Schlüsselbund versucht; prüfe den sichtbaren Zielzustand und melde niemals Zugangsdaten.${credentialProfileId ? ` Falls die Sitzung später abläuft, melde dich erneut ausschließlich mit \`node local-mac-helper/cli.mjs course-login ${credentialProfileId}\` an.` : ''}
2. Inventarisiere zuerst alle sichtbaren Module, Lektionen, Downloads und Fortschrittsstände. Speichere den Zwischenstand im eigenen Auftragsordner, damit ein Wiederanlauf beim ersten offenen Punkt fortsetzt.
3. Arbeite jede zugängliche Lektion ab. Extrahiere eine sehr genaue fachliche Arbeitsfassung, Schritte, Beispiele, Einwände, Checklisten und für die Anwendung notwendige prägnante Originalformulierungen wie konkrete Pitches. Umgehe keinen Kopier-, Download- oder Zugriffsschutz und erstelle keine systematische vollständige Ersatzkopie geschützter Videos oder Seiten.
4. Melde echten Prozentfortschritt anhand erledigter Lektionen mit dem im Auftrag eingeblendeten Fortschrittsbefehl. Technische Browser-, Tab-, Reload-, Datei- oder Verbindungsfehler reparierst du und setzt idempotent fort; sie sind kein Abschluss.
5. Im Modus iva-drive: Lege unter dem angegebenen Drive-Hauptordner genau eine Lernakte für diesen Kurs an. Nutze 00 Inventar, 01 erlaubte Originaldownloads, 02 Lektionen, 03 Pitches und Skripte, 04 ausgewählte visuelle Belege, 05 Checklisten, 06 Praxisanwendung, 07 Quellen und 99 Vollständigkeitsbericht. Verwende die verbundene Google-Drive-Funktion; falls sie vorübergehend gestört ist, repariere oder nutze den vorhandenen authentifizierten Drive-Zugang rechts. Keine doppelte Lernakte erzeugen.
6. Erzeuge am Ende im eigenen Auftragsordner eine JSON-Datei mit title, content, notes, tags, summary, completedLessons, totalLessons und optional archiveFolderUrl. content enthält die zusammengeführte, quellennahe IVA-Arbeitsfassung. Übergib sie genau einmal mit:
   ${completionCommand}
7. Prüfe danach über IVA beziehungsweise Drive sichtbar, dass der Wissenseintrag nutzbar ist und bei Archivmodus die Lernakte existiert. Erst dann ist der Auftrag erfolgreich.

Wenn eine noch nicht autorisierte kostenpflichtige Buchung, ein CAPTCHA, eine Kontosperre oder eine technisch erzwungene externe Bestätigung erscheint, erhalte Inventar und Fortschritt und benenne genau diese eine Aktion. Erfinde keinen Abschluss. Eine normale Login-Seite, ein abgelaufener Tab oder ein technischer Steuerfehler ist dagegen selbstständig zu lösen.`;
}

export async function startKnowledgeImportTask(input = {}, dependencies = {}) {
  const startTask = dependencies.startTask || startCodexTask;
  const importId = clean(input.importId, 80);
  if (!/^[a-f0-9-]{36}$/i.test(importId)) throw new Error('Ungültiger Wissensimport.');
  const profileId = clean(input.credentialProfileId, 80);
  let credentialStatus = { configured: false, loginStatus: 'session-only', secretValuesReturned: false };
  if (input.credentialEnvelope) {
    credentialStatus = await storeCourseCredentialEnvelope({
      profileId,
      title: input.title,
      sourceUrl: input.sourceUrl,
      envelope: input.credentialEnvelope,
    });
  }
  const profile = profileId ? await getCourseCredentialProfile(profileId).catch(() => null) : null;
  if (profile) {
    const status = await courseCredentialStatus(profile.id);
    const login = await ensureCourseLogin(profile.id);
    credentialStatus = {
      configured: status.keychainReady,
      loginStatus: login.status,
      blocker: login.blocker || '',
      secretValuesReturned: false,
    };
    if (login.status === 'setup_required') {
      throw new Error(`Externe Bestätigung erforderlich: Kurs-Zugangsdaten fehlen (${(login.missingFields || []).join(', ') || 'Login'}).`);
    }
    if (login.status === 'blocked') {
      throw new Error(`Externe Bestätigung erforderlich: Kursanmeldung blockiert (${login.blocker || 'Login nicht bestätigt'}).`);
    }
  }
  const prompt = buildKnowledgeImportPrompt(input);
  const task = await startTask({
    prompt,
    title: `Wissen aufnehmen · ${clean(input.title, 150)}`,
    requestId: `knowledge-import:${importId}:attempt-${Math.max(1, Number(input.attempt) || 1)}`,
    mode: 'operational',
    projectId: 'knowledge',
    workflowId: `knowledge-import:${importId}`,
    workflowName: `Wissensimport · ${clean(input.title, 160)}`,
    acceptanceCriteria: [
      'Alle sichtbaren Lektionen wurden inventarisiert und der Fortschritt basiert auf diesem Inventar.',
      'Das zusammengeführte Wissen wurde über den Gerätekanal in IVAs Wissensdatenbank geschrieben und erneut geprüft.',
      ...(input.mode === 'iva-drive' ? ['Genau eine Google-Drive-Lernakte wurde angelegt, befüllt und sichtbar verifiziert.'] : []),
      'Zugangsdaten, Tokens und Einmalcodes erscheinen weder im Ergebnis noch in Dateien oder Protokollen.',
    ],
  });
  return { ...task, importId, credentialStatus, secretValuesReturned: false };
}
