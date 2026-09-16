import { courseCredentialStatus, getCourseCredentialProfile, storeCourseCredentialEnvelope } from './course-credentials.mjs';
import { startCodexTask } from './codex-tasks.mjs';
import { deriveKnowledgeTitle } from './knowledge-source.mjs';

const clean = (value, max = 2000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);

function safeUrl(value) {
  const url = new URL(clean(value, 1800));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Der Wissensimport benötigt eine sichere HTTPS-Adresse.');
  url.hash = '';
  return url.toString();
}

export function buildKnowledgeImportPrompt(input = {}) {
  const importId = clean(input.importId, 80);
  const entryId = clean(input.entryId, 80);
  const sourceUrl = safeUrl(input.sourceUrl);
  const title = deriveKnowledgeTitle({ ...input, sourceUrl });
  const titleGenerated = input.titleGenerated === true || !clean(input.title, 240);
  const mode = input.mode === 'iva-drive' ? 'iva-drive' : 'iva-only';
  const accessMode = input.accessMode === 'purchase-needed' ? 'purchase-needed' : 'existing';
  const credentialProfileId = clean(input.credentialProfileId, 80);
  const archiveFolderUrl = mode === 'iva-drive' ? clean(input.archiveFolderUrl, 1800) : '';
  const completionCommand = `node local-mac-helper/knowledge-import-client.mjs complete ${JSON.stringify(importId)} <absoluter-manifest-pfad>`;
  return `Nimm den Inhalt des von Nadine angegebenen Links in IVA auf. Der Link kann ein einzelner Beitrag, ein Reel oder Video, eine Webseite oder ein Kurs sein. Nutze zunächst den öffentlichen Inhalt oder eine bereits funktionierende Sitzung. Zugangsdaten sind optional und nur bei einer tatsächlichen Anmeldesperre erforderlich.

Vorläufiger Quellentitel: ${title}
Startadresse: ${sourceUrl}
IVA-Wissenseintrag: ${entryId}
Importauftrag: ${importId}
Zielmodus: ${mode === 'iva-drive' ? 'IVA-Wissensdatenbank plus Lernakte in Google Drive' : 'nur IVA-Wissensdatenbank'}
Zugangsstatus: ${accessMode === 'purchase-needed' ? 'Buchung ist noch erforderlich; bis zur finalen kostenpflichtigen Bestätigung vorbereiten und dann den belegten Freigabeschritt melden' : 'öffentlichen Inhalt beziehungsweise vorhandene Sitzung zuerst verwenden; kein neues Login voraussetzen'}
${archiveFolderUrl ? `Google-Drive-Hauptordner: ${archiveFolderUrl}` : ''}

Pflichtablauf:
1. Öffne die konkrete Quelle in einem eigenen IVA-Browserfenster auf dem vorhandenen Arbeitsdisplay dieses Mac Mini. Prüfe zuerst den öffentlich lesbaren Inhalt und die bestehende Sitzung; keine zusätzliche Anmeldung, solange der Inhalt zugänglich ist. Melde niemals Zugangsdaten.${credentialProfileId ? ` Nur wenn die Quelle tatsächlich eine Anmeldung verlangt, nutze das vorhandene lokale Profil mit \`node local-mac-helper/cli.mjs course-login ${credentialProfileId}\`. Fehlt das Profil oder die Freigabe, benenne den tatsächlich erforderlichen Zugang; der bloße Importstart benötigt ihn nicht.` : ' Nur eine tatsächlich gesperrte Quelle mit fehlendem Zugang bleibt offen.'}
2. Inventarisiere zuerst den beauftragten Umfang: Ein einzelner Link/Beitrag zählt als genau eine Quelle (1/1), nicht als Auftrag zum Auslesen des gesamten Kontos. Bei einem ausdrücklich verlinkten Kurs inventarisiere alle sichtbaren Module, Lektionen, Downloads und Fortschrittsstände. Speichere den Zwischenstand im eigenen Auftragsordner, damit ein Wiederanlauf beim ersten offenen Punkt fortsetzt.
3. Lies den eigentlichen Quelleninhalt. Bei Reel/Video: Inhalt tatsächlich abspielen beziehungsweise ein zugängliches Transkript oder eine erlaubte Audioauswertung verwenden und relevante eingeblendete Aussagen prüfen. Titel, Caption und Vorschaubild allein sind kein gelesener Videoinhalt. Wenn Ton oder Video nicht zugänglich sind, speichere einen offenen Zwischenstand, niemals eine erfundene Zusammenfassung oder einen vollständigen Abschluss. Keine Zugangssperren umgehen. Arbeite bei Kursen jede zugängliche Lektion ab. Extrahiere eine sehr genaue fachliche Arbeitsfassung, Schritte, Beispiele, Einwände, Checklisten und für die Anwendung notwendige prägnante Originalformulierungen wie konkrete Pitches. Umgehe keinen Kopier-, Download- oder Zugriffsschutz und erstelle keine systematische vollständige Ersatzkopie geschützter Videos oder Seiten.
4. Melde echten Prozentfortschritt anhand erledigter Lektionen mit dem im Auftrag eingeblendeten Fortschrittsbefehl. Technische Browser-, Tab-, Reload-, Datei- oder Verbindungsfehler reparierst du und setzt idempotent fort; sie sind kein Abschluss.
5. Im Modus iva-drive: Lege unter dem angegebenen Drive-Hauptordner genau eine Lernakte für diesen Kurs an. Nutze 00 Inventar, 01 erlaubte Originaldownloads, 02 Lektionen, 03 Pitches und Skripte, 04 ausgewählte visuelle Belege, 05 Checklisten, 06 Praxisanwendung, 07 Quellen und 99 Vollständigkeitsbericht. Verwende die verbundene Google-Drive-Funktion; falls sie vorübergehend gestört ist, repariere oder nutze den vorhandenen authentifizierten Drive-Zugang rechts. Keine doppelte Lernakte erzeugen.
6. ${titleGenerated ? 'Leite einen kurzen aussagekräftigen Titel aus dem tatsächlich gelesenen Inhalt ab; frage Nadine nicht nach einem Titel.' : 'Behalte den von Nadine vorgegebenen Titel unverändert bei; ersetze ihn nicht durch einen automatisch abgeleiteten Titel.'} Erzeuge am Ende im eigenen Auftragsordner eine JSON-Datei mit title, content, notes, tags, summary, completedLessons, totalLessons, sourceEvidence und optional archiveFolderUrl. content enthält die zusammengeführte, quellennahe IVA-Arbeitsfassung. completedLessons und totalLessons sind gleiche positive Ganzzahlen, bei einem Einzelbeitrag 1 und 1. sourceEvidence enthält die ursprüngliche Startadresse als sourceUrl, sourceRead:true und method. Bei Video zusätzlich mediaType:"video", videoRead:true sowie audioRead:true nach tatsächlicher Ton-/Transkriptprüfung; bei nachweislich sprachlosem Video stattdessen speechPresent:false und visualsRead:true. Diese Belege nur nach der tatsächlichen Prüfung setzen. Übergib sie genau einmal mit:
   ${completionCommand}
7. Prüfe danach über IVA beziehungsweise Drive sichtbar, dass der Wissenseintrag nutzbar ist und bei Archivmodus die Lernakte existiert. Erst dann ist der Auftrag erfolgreich.

Wenn eine noch nicht autorisierte kostenpflichtige Buchung, ein CAPTCHA, eine Kontosperre oder eine technisch erzwungene externe Bestätigung erscheint, erhalte Inventar und Fortschritt und benenne genau diese eine Aktion. Erfinde keinen Abschluss. Eine Login-Seite ist nur dann selbstständig mit vorhandenen freigegebenen Zugängen zu lösen, wenn die Quelle wirklich nicht öffentlich beziehungsweise über die bestehende Sitzung lesbar ist. Fehlende Zugangsdaten konkret erst dann benennen. Abgelaufene Tabs und technische Steuerfehler soweit möglich selbstständig reparieren.`;
}

export async function startKnowledgeImportTask(input = {}, dependencies = {}) {
  const startTask = dependencies.startTask || startCodexTask;
  const importId = clean(input.importId, 80);
  if (!/^[a-f0-9-]{36}$/i.test(importId)) throw new Error('Ungültiger Wissensimport.');
  const sourceUrl = safeUrl(input.sourceUrl);
  const title = deriveKnowledgeTitle({ ...input, sourceUrl });
  const profileId = clean(input.credentialProfileId, 80);
  const storeEnvelope = dependencies.storeCredentialEnvelope || storeCourseCredentialEnvelope;
  const readProfile = dependencies.readCredentialProfile || getCourseCredentialProfile;
  const readStatus = dependencies.credentialStatus || courseCredentialStatus;
  let credentialStatus = { configured: false, loginStatus: 'public-or-existing-session', secretValuesReturned: false };
  if (input.credentialEnvelope) {
    try {
      const stored = await storeEnvelope({ profileId, title, sourceUrl, envelope: input.credentialEnvelope });
      credentialStatus.configured = stored.keychainReady === true;
    } catch {
      // Optional credentials must not prevent reading a public source or a
      // functioning session. Report the save failure without secret details.
      credentialStatus.credentialSaveFailed = true;
    }
  }
  const profile = profileId ? await readProfile(profileId).catch(() => null) : null;
  if (profile) {
    const status = await readStatus(profile.id).catch(() => null);
    credentialStatus.configured = status?.keychainReady === true;
  }
  // Login is deferred until the worker observes a real access restriction.
  // Eager login can wrongly reject public reels due to an unrelated old profile.
  input = { ...input, titleGenerated: input.titleGenerated === true || !clean(input.title, 240), title, sourceUrl, credentialProfileId: profile?.id || '' };
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
      'Der verlinkte Inhalt wurde tatsächlich gelesen; ein Einzelbeitrag zählt 1/1, Kurse verwenden ihr vollständiges Inventar.',
      'Ein Reel oder Video gilt erst nach tatsächlicher Video- und Ton-/Transkriptprüfung als aufgenommen; eine Caption allein reicht nicht.',
      'Ein eigener Titel bleibt erhalten; nur ein fehlender oder automatisch vergebener Titel wird aus dem gelesenen Inhalt präzisiert.',
      'Das zusammengeführte Wissen wurde über den Gerätekanal in IVAs Wissensdatenbank geschrieben und erneut geprüft.',
      ...(input.mode === 'iva-drive' ? ['Genau eine Google-Drive-Lernakte wurde angelegt, befüllt und sichtbar verifiziert.'] : []),
      'Zugangsdaten, Tokens und Einmalcodes erscheinen weder im Ergebnis noch in Dateien oder Protokollen.',
    ],
  });
  return { ...task, importId, credentialStatus, secretValuesReturned: false };
}
