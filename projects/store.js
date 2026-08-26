import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import {
  buildPlanbarSchedulingExtras,
  DEFAULT_CUSTOMER_SCHEDULING_PARTNERS,
  normalizeCustomerSchedulingPartners,
  normalizePlanbarCapacitySnapshot,
} from '../operations/customer-scheduling.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = path.join(DATA_DIR, 'projects.json');
const PROJECT_FILES_DIR = path.join(DATA_DIR, 'project-files');
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const LOGO_MIME_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);
const PROJECT_STATUSES = new Set(['idea', 'planned', 'prepared', 'active', 'paused', 'complete']);
const AREA_STATUSES = new Set(['idea', 'planned', 'foundation', 'prepared', 'active', 'blocked', 'complete']);
const AUTOMATION_STATUSES = new Set(['planned', 'prepared', 'active', 'paused', 'blocked']);
let writeQueue = Promise.resolve();

const HEAT_HERO_PROJECT = {
  id: 'heat-hero',
  name: 'Heat Hero',
  company: 'Heat Hero',
  category: 'Vertrieb · Wärmepumpen · Photovoltaik',
  status: 'planned',
  description: 'Zentrale Projektakte für den digitalen Innendienstvertrieb, Hersteller-Leads, Kundenaufnahme, Energieplanung, Angebotsprozess und operative Automationen.',
  objective: 'Interne Vertriebsteams arbeiten ausschließlich im HeatHero CRM und in einer gemeinsamen IVA-Fallakte. Kunden werden im Videotermin geführt aufgenommen; geprüfte Daten fließen ohne Doppelarbeit in TMB, Planung, Angebot und Herstellerrückmeldung.',
  principles: [
    'HeatHero CRM bleibt führend für Lead und Vertriebsfortschritt.',
    'Pro Kunde gibt es eine gemeinsame Energie-Fallakte statt mehrerer Datenkopien.',
    'Der Kunde wird durch kleine, verständliche Schritte geführt; komplexe Selbstauskunft wird vermieden.',
    'Automatik verarbeitet nur belegte Daten. Unklare Angaben werden sichtbar nachgefragt.',
    'Heizlast und Angebot werden deterministisch gerechnet und fachlich freigegeben, nicht frei von einem Sprachmodell geschätzt.',
  ],
  protocolPolicy: {
    enabled: true,
    folderName: 'Workflow-Protokolle',
    dailyFolder: 'taeglich',
    weeklyFolder: 'woechentlich',
    dailyRetentionDays: 7,
    weeklyRetentionDays: 30,
    dailySchedule: 'Täglich · 23:55 Uhr',
    weeklySchedule: 'Sonntag · 23:58 Uhr',
    cleanupSchedule: 'Täglich · 00:20 Uhr',
    expectedWorkflows: [
      { workflowId: 'funding-monitor', workflowName: 'Fördermonitor und Pipedrive-Nachlauf', cadence: 'daily', weekday: null },
      { workflowId: 'kfw-approval-morning', workflowName: 'KfW-Zusagen morgens prüfen', cadence: 'daily', weekday: null },
      { workflowId: 'montage-required-fields-morning', workflowName: 'Montage-Pflichtfelder morgens prüfen', cadence: 'daily', weekday: null },
      { workflowId: 'planbar-completion-morning', workflowName: 'Planbar Vervollständigung', cadence: 'daily', weekday: null },
      { workflowId: 'planbar-weekly-export', workflowName: 'Planbar-Kundenliste und Hersteller-PDFs', cadence: 'weekly', weekday: 5 },
    ],
    note: 'Jede Datei zeigt Typ, Aufbewahrungsdauer und konkretes automatisches Löschdatum als Tags.',
  },
  customerSchedulingPartners: DEFAULT_CUSTOMER_SCHEDULING_PARTNERS,
  planbarCapacity: {
    updatedAt: '2026-08-22T15:48:00.000Z',
    source: 'Planbar · sichtbare Blöcke „Geblockt für Kunde ENTER“',
    excludedResources: ['Dawid Service', 'Antonio Lausic'],
    weeks: [
      { isoYear: 2026, week: 35, freeSlots: 0 },
      { isoYear: 2026, week: 36, freeSlots: 1 },
      { isoYear: 2026, week: 37, freeSlots: 7 },
      { isoYear: 2026, week: 38, freeSlots: 5 },
      { isoYear: 2026, week: 39, freeSlots: 7 },
      { isoYear: 2026, week: 40, freeSlots: 4 },
      { isoYear: 2026, week: 41, freeSlots: 2 },
      { isoYear: 2026, week: 42, freeSlots: 5 },
      { isoYear: 2026, week: 43, freeSlots: 4 },
      { isoYear: 2026, week: 44, freeSlots: 1 },
      { isoYear: 2026, week: 45, freeSlots: 1 },
    ],
  },
  areas: [
    {
      id: 'inside-sales', name: 'Innendienstvertrieb', status: 'planned', owner: 'Heat Hero',
      summary: 'Geführter digitaler Beratungsprozess vom Lead bis zum Abschluss, optimiert für ältere Kundinnen und Kunden.',
      nextStep: 'MVP für Vorbereitung und geführte Live-Aufnahme im Videocall bauen.',
    },
    {
      id: 'customer-capture', name: 'Kundenaufnahme im Videocall', status: 'foundation', owner: 'IVA Energie',
      summary: 'Grundriss, Maße, maximal zehn geführte Fotos, Heizkörper, Gebäude- und Heizungsdaten direkt in einer Fallakte erfassen und live prüfen.',
      nextStep: 'Kundenlink ohne Login, Live-Fortschritt und Foto-/Maß-Qualitätsprüfung ergänzen.',
    },
    {
      id: 'energy-planning', name: 'TMB, 3D und Energieplanung', status: 'foundation', owner: 'IVA Energie',
      summary: 'TMB, Räume, Heizkörper, Heizlast, Leitungsweg, Wanddurchbrüche, PV und technische Machbarkeit zusammenführen.',
      nextStep: '3D-Grundriss-Review, Leitungswegmodell und normgerecht abgenommene Heizlast-Engine ergänzen.',
    },
    {
      id: 'sales-coach', name: 'KI-Sales-Coach und Gesprächsdaten', status: 'planned', owner: 'IVA Sales',
      summary: 'Gespräch mit Einwilligung begleiten, bestätigte Angaben strukturiert vorschlagen und offene TMB-Punkte live anzeigen.',
      nextStep: 'Feldvorschläge mit Quelle, Zeitstempel, Confidence und ausdrücklicher Beraterbestätigung entwickeln.',
    },
    {
      id: 'quote-agent', name: 'Angebots-KI', status: 'planned', owner: 'IVA Energie',
      summary: 'Aus geprüfter Fallakte, Stückliste, Preislisten und freigegebenen Kalkulationsregeln ein nachvollziehbares Angebot erzeugen.',
      nextStep: 'Preislisten und repräsentative Beispielangebote versioniert aufnehmen und Kalkulationsregeln fachlich abnehmen.',
    },
    {
      id: 'manufacturer-leads', name: 'Panasonic- und Bosch-Leads', status: 'prepared', owner: 'IVA Operations',
      summary: 'Hersteller-Leads gebietsabhängig übernehmen, im HeatHero CRM anlegen und Vertriebszuordnung kontrollieren.',
      nextStep: 'Passwörter rotieren, Gebiete eintragen, iMac vorbereiten und Trockenlauf durchführen.',
    },
    {
      id: 'manufacturer-feedback', name: 'Hersteller-Rückmeldungen', status: 'planned', owner: 'IVA Operations',
      summary: 'Belegte CRM-Fortschritte automatisch in Panasonic und Bosch zurückmelden – Schnittstelle ohne offizielle Schnittstelle.',
      nextStep: 'Portalstatus rein lesend aufnehmen und je Hersteller mit CRM-Ereignissen mappen.',
    },
    {
      id: 'wattfox', name: 'Wattfox und Regler', status: 'prepared', owner: 'IVA Operations',
      summary: 'Widerrufsbestätigungen und Regler-Rückmeldungen täglich auswerten, wöchentlich abgleichen und offen gebliebene Fälle melden.',
      nextStep: 'Ordnerzugriff auf dem iMac testen; CRM-Statusänderungen bleiben vorerst gesperrt.',
    },
    {
      id: 'planbar', name: 'Planbar und Herstellerlisten', status: 'active', owner: 'IVA Operations',
      summary: 'Zehn-Wochen-Kundenliste und Hersteller-PDFs freitags erzeugen, vollständig prüfen und an Angelo senden.',
      nextStep: 'Jeden Lauf mit Zeitraum, Umfang, Anhängen und Versandprüfung im Projektprotokoll dokumentieren.',
    },
    {
      id: 'mac-automations', name: 'iMac-Automationen', status: 'prepared', owner: 'IVA Operations',
      summary: 'Lokale Browser-/Outlook-Abläufe mit Readiness-Prüfungen, Dublettenschutz und Tagesreport betreiben.',
      nextStep: 'Richtigen iMac bestätigen und jeden Schreibweg einzeln testen.',
    },
  ],
  process: [
    { id: 'lead', name: '1. Lead übernehmen', outcome: 'Hersteller-/Plattform-ID ist fest mit der HeatHero-CRM-ID verknüpft.', gate: 'Eindeutige Identität, Gebiet und Dublettenprüfung.' },
    { id: 'preflight', name: '2. Termin vorbereiten', outcome: 'Kunde erhält einen einfachen Link und legt Zollstock, Grundriss und Verbrauchsnachweis bereit.', gate: 'Keine Pflicht-App, kein kompliziertes Konto, große Einzelschritte.' },
    { id: 'video', name: '3. Geführter Videotermin', outcome: 'Berater führt den Kunden durch Räume, Heizraum, Außenstandort, Elektro und Leitungsweg.', gate: 'Live-Vorschau zeigt sofort unscharfe, falsche oder fehlende Bilder und Maße.' },
    { id: 'review', name: '4. Datenprüfung', outcome: 'Aussagen, Fotos, Maße und Grundriss sind in einer Fallakte zusammengeführt.', gate: 'Grün/Gelb/Rot je Feld; gelbe und rote Punkte müssen geklärt werden.' },
    { id: 'calculation', name: '5. Technische Planung', outcome: 'Räume, Heizkörper, Heizlast, Aufstellort, Rohrmeter, Wanddurchbrüche und PV-Variante sind nachvollziehbar berechnet.', gate: 'Deterministische Rechenengine, Regelversion und fachliche Freigabe.' },
    { id: 'offer', name: '6. Angebot im Gespräch', outcome: 'Freigegebene Stückliste und Preise erzeugen eine transparente Angebotsvariante.', gate: 'Preisstand, Marge, Pflichtpositionen und technische Plausibilität bestätigt.' },
    { id: 'sync', name: '7. Rückmeldung und Nachlauf', outcome: 'CRM-Status, offene Unterlagen und Herstellerfortschritt bleiben synchron.', gate: 'Nur belegte, verifizierte Statuswechsel; keine Rückstufung oder Vermutung.' },
  ],
  qualityGates: [
    { level: 'green', name: 'Automatisch verwendbar', rule: 'Pflichtfeld vorhanden, Quelle eindeutig, technisch plausibel und gegebenenfalls vom Berater bestätigt.' },
    { level: 'yellow', name: 'Im Gespräch klären', rule: 'Angabe ist lesbar, aber unvollständig, widersprüchlich oder nur aus einer schwachen Quelle abgeleitet.' },
    { level: 'red', name: 'Planung blockiert', rule: 'Pflichtfoto/Grundmaß fehlt, Identität unklar, Berechnung unvollständig oder sicherheitsrelevanter Widerspruch vorhanden.' },
  ],
  automations: [
    {
      id: 'workflow-protocol-summaries',
      name: 'Workflow-Protokolle und Ergebnisübersichten',
      status: 'active',
      schedule: 'Täglich · 23:55 Uhr; wöchentlich Sonntag · 23:58 Uhr',
      execution: 'IVA Core · Projektakte Heat Hero',
      purpose: 'Ergebnisse aller angebundenen Workflows in Tages- und Wochenprotokollen zusammenfassen und als Dateien im Projektordner bereitstellen.',
      safety: 'Tagesdateien werden nach 7 Tagen, Wochendateien nach 30 Tagen automatisch gelöscht; Typ und Löschdatum stehen sichtbar als Tags an jeder Datei.',
      nextStep: 'Weitere Workflow-Quellen über den einheitlichen Ergebnis-Endpunkt anbinden und fehlende Meldungen als Lücke anzeigen.',
    },
    {
      id: 'planbar-completion-morning',
      specVersion: 4,
      name: 'Planbar Vervollständigung',
      status: 'active',
      enabled: true,
      schedule: 'Täglich · 08:00 Uhr',
      execution: 'Codex-Automation · lokaler iMac · WhatsApp, Chrome, Pipedrive, Planbar, Outlook und Telegram-Fallback',
      purpose: 'Nadines Nachrichten aus „Terminierungen Dispo“ vom Vortag Kunden und KW zuordnen, vorhandene HH-Einträge als reine Formatbeispiele lesen und beim bestehenden Planbar-Termin ausschließlich Auftragsnummer und belegte Kurzbeschreibung vervollständigen.',
      safety: 'Nur eindeutige Einzelfälle bearbeiten; Pipedrive und HH-Beispiele rein lesend, nichts in Planbar anlegen, löschen oder verschieben. Unklare Dokumente oder TMB-Maße blockieren den Fall. Maximal 20 Minuten, danach Display genau einmal aus.',
      nextStep: 'Ersten automatischen Morgenlauf anhand des detaillierten E-Mail-Berichts, eines möglichen Telegram-Ersatzberichts und des Projektprotokolls prüfen.',
    },
    {
      id: 'planbar-weekly-export',
      name: 'Planbar-Kundenliste und Hersteller-PDFs',
      status: 'active',
      schedule: 'Freitag · 18:00 Uhr',
      execution: 'iMac · Chrome und Outlook',
      purpose: 'Zehn kommende Kalenderwochen aus Planbar aufbereiten, Gesamt-XLSX und Hersteller-PDFs prüfen und an Angelo senden.',
      safety: 'Kein Versand bei fehlender Anmeldung, unvollständigen Dateien, falschem Absender/Empfänger oder erkanntem Doppelversand.',
      nextStep: 'Nächsten Freitagslauf über zehn Wochen ausführen und im Projektprotokoll verifizieren.',
    },
    {
      id: 'funding-monitor',
      name: 'Fördermonitor und Pipedrive-Nachlauf',
      status: 'active',
      schedule: 'Täglich · 23:00 Uhr',
      execution: 'iMac · Outlook, Pipedrive und lokaler IVA-Helfer',
      purpose: 'Förderfälle vollständig neu lesen, eingegangene Unterlagen zuordnen und sichere Entwürfe beziehungsweise Nachfassaktionen vorbereiten.',
      safety: 'Abgelaufene Pipedrive-Sitzungen werden neu geladen und erneut geprüft. Fremde Notizen werden nie geändert oder gelöscht; Fehler werden ohne CRM-Folgeaktion protokolliert.',
      nextStep: 'Jeden Lauf automatisch an das zentrale Tages- und Wochenprotokoll melden.',
    },
    {
      id: 'kfw-approval-morning',
      specVersion: 2,
      name: 'KfW-Zusagen morgens prüfen',
      status: 'blocked',
      enabled: false,
      schedule: 'Täglich · 07:00 Uhr',
      execution: 'Noch kein ausführbarer Job registriert · Pipedrive-Anmeldung und Feldschema fehlen',
      purpose: 'Geplant: In Förderung beantragen neue offizielle KfW-Zusagen prüfen, den belegten Zuschussbetrag in das echte Pipedrive-Feld eintragen, Pflichtfelder absichern und vollständig belegte Deals auf Gewonnen setzen.',
      safety: 'Keine Statusänderung ohne echte Zuschusszusage und widerspruchsfreie Pflichtfelder. Abgelaufene Pipedrive-Sitzungen werden selbstständig erneuert; bei der Gerätegrenze dürfen andere Pipedrive-Sitzungen abgemeldet werden.',
      nextStep: 'In Pipedrive anmelden, exakten Feldnamen/-typ lesen, eine echte KfW-Zusage kontrolliert auswerten und erst nach Schreib-/Leserückprüfung als aktiv schalten.',
    },
    {
      id: 'montage-required-fields-morning',
      specVersion: 1,
      name: 'Montage-Pflichtfelder morgens prüfen',
      status: 'active',
      enabled: true,
      schedule: 'Täglich · 07:00 Uhr',
      execution: 'iMac · Chrome, Pipedrive und lokaler IVA-Helfer',
      purpose: 'Bei allen offenen Deals in Montage terminieren Telefonnummer und E-Mail gegen die TMB sowie die Anlage gegen das unterschriebene Angebot prüfen und fehlende Werte ergänzen.',
      safety: 'Nur eindeutig belegte leere Felder befüllen und sichtbar verifizieren. Bestehende Widersprüche niemals still überschreiben, sondern separat melden.',
      nextStep: 'Täglich separat protokollieren und nur über diesen Schalter pausieren.',
    },
    {
      id: 'manufacturer-leads-wattfox',
      name: 'Panasonic-/Bosch-Leads und Wattfox',
      status: 'paused',
      schedule: 'Täglich · 21:00 Uhr; freitags zusätzlicher Wochenabgleich',
      execution: 'iMac · Outlook, Chrome und Ente Auth',
      purpose: 'Hersteller-Leads nach Gebiet prüfen, angenommene Leads in HeatHero CRM anlegen, Vertriebszuordnung kontrollieren und Wattfox-Rückmeldungen auswerten.',
      safety: 'Ohne Passwortwechsel, Gebiete, bestätigten iMac, Readiness-Prüfung und Trockenlauf keinerlei Schreibaktion.',
      nextStep: 'Passwörter rotieren, Gebiete eintragen, Ente Auth auf dem iMac prüfen und Trockenlauf freigeben.',
    },
    {
      id: 'manufacturer-feedback-sync',
      name: 'CRM-Fortschritt an Panasonic und Bosch',
      status: 'planned',
      schedule: 'Geplant: täglich nach dem Leadlauf',
      execution: 'HeatHero CRM → iMac → Herstellerportale',
      purpose: 'Belegte CRM-Fortschritte ohne doppeltes Eintragen in die Herstellerportale zurückmelden.',
      safety: 'Nur feste CRM-/Hersteller-ID-Zuordnung, erlaubte Vorwärtsübergänge und sichtbare Portalverifikation; keine Statusvermutung.',
      nextStep: 'Reale Statuslisten in beiden Portalen aufnehmen und Mapping fachlich freigeben.',
    },
    {
      id: 'customer-preflight',
      name: 'Kundenvorbereitung vor dem Videotermin',
      status: 'planned',
      schedule: 'Geplant: automatisch nach Terminbuchung',
      execution: 'IVA Kundenlink · Smartphone oder Desktop',
      purpose: 'Kunden mit Zollstock, Grundriss und Verbrauchsnachweis vorbereiten und Dokumente direkt der Fallakte zuordnen.',
      safety: 'Kein kompliziertes Konto; nur notwendige Unterlagen und dokumentierte Einwilligung.',
      nextStep: 'Einfachen Kundenlink und Live-Fortschritt für den Innendienst bauen.',
    },
    {
      id: 'sales-coach-tmb',
      name: 'Sales Coach → TMB-Feldvorschläge',
      status: 'planned',
      schedule: 'Geplant: während des freigegebenen Videotermins',
      execution: 'IVA Sales Coach und Energie-Fallakte',
      purpose: 'Bestätigte Gesprächsangaben mit Quelle, Zeitstempel und Confidence in die TMB-Vorbereitung übernehmen.',
      safety: 'Nur nach dokumentierter Einwilligung; technische Pflichtwerte benötigen Beraterbestätigung.',
      nextStep: 'Live-Transkript mit Feldvorschlägen und Grün/Gelb/Rot-Prüfung verbinden.',
    },
    {
      id: 'quote-generation',
      name: 'Angebot aus geprüfter Energie-Fallakte',
      status: 'planned',
      schedule: 'Geplant: auf Knopfdruck im Kundengespräch',
      execution: 'IVA Angebots-KI',
      purpose: 'Aus technischer Planung, Stückliste und versionierten Preislisten ein nachvollziehbares Angebot erzeugen.',
      safety: 'Nur bei grünen Pflichtgates, gültigem Preisstand und freigegebenen Kalkulationsregeln.',
      nextStep: 'Preislisten und repräsentative Beispielangebote versioniert aufnehmen.',
    },
  ],
  runLog: [
    {
      id: 'planbar-2026-08-13-kw34-39',
      automationId: 'planbar-weekly-export',
      executedAt: '2026-08-13T13:22:00+02:00',
      scheduledFor: '2026-08-14',
      status: 'sent-and-verified',
      scope: 'KW 34–39 / 2026',
      summary: 'Regulärer Freitagslauf einen Tag vorgezogen: 62 Baustellen, Gesamt-XLSX und Hersteller-PDFs versandt und im Gesendet-Ordner geprüft.',
      sender: 'n.sell@heat-hero.com',
      recipient: 'a.keller@heat-hero.com',
      attachmentCount: 10,
      customerCount: 62,
      details: 'Für Freitag war danach kein Doppelversand mehr erforderlich.',
    },
    {
      id: 'planbar-2026-08-15-kw34-43',
      automationId: 'planbar-weekly-export',
      executedAt: '2026-08-15T16:15:00+02:00',
      scheduledFor: '2026-08-15',
      status: 'sent-and-verified',
      scope: 'KW 34–43 / 2026',
      summary: 'Korrigierter Zehn-Wochen-Lauf: 65 Baustellen, Gesamt-XLSX und neun Hersteller-PDFs versandt und im Gesendet-Ordner geprüft.',
      sender: 'n.sell@heat-hero.com',
      recipient: 'a.keller@heat-hero.com',
      attachmentCount: 10,
      customerCount: 65,
      details: 'KW 42 und KW 43 enthalten keine Baustellen; Urlaub, Nicht verfügbar und Blocker wurden ausgeschlossen.',
    },
    {
      id: 'planbar-2026-08-23-kw36-45',
      automationId: 'planbar-weekly-export',
      executedAt: '2026-08-23T11:59:00+02:00',
      scheduledFor: '2026-08-23',
      status: 'sent-and-verified',
      scope: 'KW 36–45 / 2026',
      summary: 'Manuell ausgelöster Zehn-Wochen-Forecast erfolgreich versandt: Gesamt-XLSX und sieben nichtleere Hersteller-XLSX; Versand an Angelo im Outlook-Ordner „Gesendet“ verifiziert.',
      sender: 'n.sell@heat-hero.com',
      recipient: 'a.keller@heat-hero.com',
      attachmentCount: 8,
      customerCount: 56,
      details: 'Betreff „Planbar-Listen KW 36-45 / 2026“. Ausschließlich XLSX-Anhänge; keine PDF. Belegt durch outputs/planbar-weekly/send-log.json.',
    },
  ],
  existingCapabilities: [
    'Gemeinsame IVA-Energie-Fallakte mit Kunden-, Gebäude-, Heizungs-, Elektro-, Hydraulik- und PV-Daten.',
    'Dynamische TMB-Foto-Checkliste und kategorisierte Dateiablage.',
    'Räume mit mehreren Heizkörpern sowie editierbare technische Felder.',
    'TMB-PDF und transparente Heizlast-Vorplanung mit sichtbaren Datenlücken.',
    'HeatHero-CRM-Lesezugang und vorbereitete lokale Hersteller-/Outlook-Automationen.',
  ],
  missingCapabilities: [
    'Kundenlink ohne Login mit betreutem Live-Modus im Videocall.',
    'Automatische Qualitätsprüfung für Fotos, Typenschilder, Maßbezug und Perspektive.',
    'Grundriss-Erkennung mit bestätigbarem 3D-Modell und Leitungsweg/Wanddurchbrüchen.',
    'Sales-Coach-Transkript zu TMB-Feldvorschlägen mit Quelle und Bestätigung.',
    'Fachlich abgenommene DIN-Heizlast- und Auslegungsengine.',
    'Versionierte Preislisten, Stücklistenregeln und Angebotsgenerator.',
    'Pipedrive-/HeatHero-Prozessauslöser und verifizierte Herstellerrückmeldung.',
  ],
  roadmap: [
    { phase: 1, name: 'Geführte Kundenaufnahme', status: 'next', result: 'Kundenlink, Videocall-Cockpit, zehn Fotoaufgaben, Maße und Live-Vollständigkeit.' },
    { phase: 2, name: 'Sales Coach → TMB', status: 'planned', result: 'Gesprächsdaten werden als belegte Feldvorschläge vorbereitet und vom Berater bestätigt.' },
    { phase: 3, name: '3D und technische Engine', status: 'planned', result: 'Bestätigter Grundriss, Heizkörper, Leitungsweg und fachlich abgenommene Heizlast/Auslegung.' },
    { phase: 4, name: 'Angebots-KI', status: 'planned', result: 'Versionierte Kalkulation aus Preislisten, Stückliste und geprüfter Fallakte.' },
    { phase: 5, name: 'CRM-/Herstellerkreislauf', status: 'prepared', result: 'Automatischer Fortschrittsabgleich zwischen CRM, Panasonic, Bosch und Reporting.' },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clean(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeWebsiteUrl(value) {
  const raw = clean(value, 1200);
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new Error();
    url.hash = '';
    return url.toString();
  } catch { throw new Error('Bitte eine gültige Website-Adresse eintragen.'); }
}

function normalizeInstagramUrl(value) {
  const raw = clean(value, 1200);
  if (!raw) return '';
  const handle = raw.replace(/^@/, '').replace(/^\/+|\/+$/g, '');
  const candidate = /^@?[a-z0-9._]{1,30}$/i.test(raw) ? `https://www.instagram.com/${handle}` : (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  try {
    const url = new URL(candidate);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname) || url.username || url.password) throw new Error();
    const profile = url.pathname.split('/').filter(Boolean)[0];
    if (!profile || !/^[a-z0-9._]{1,30}$/i.test(profile)) throw new Error();
    return `https://www.instagram.com/${profile}`;
  } catch { throw new Error('Bitte ein gültiges Instagram-Profil oder einen @Namen eintragen.'); }
}

function normalizeLogo(logo) {
  if (!logo || typeof logo !== 'object') return null;
  const mime = clean(logo.mime, 100).toLowerCase();
  const storageName = clean(logo.storageName, 300);
  if (!LOGO_MIME_EXTENSIONS.has(mime) || !storageName || path.basename(storageName) !== storageName) return null;
  return {
    name: clean(logo.name, 240) || `Projektlogo${LOGO_MIME_EXTENSIONS.get(mime)}`,
    mime,
    bytes: Math.max(0, Number(logo.bytes) || 0),
    sha256: clean(logo.sha256, 128),
    storageName,
    uploadedAt: iso(logo.uploadedAt),
  };
}

function validLogoSignature(buffer, mime) {
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/jpeg') return buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function projectFileDir(projectId) {
  const safeId = clean(projectId, 100);
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/i.test(safeId)) throw new Error('Ungültige Projekt-ID.');
  return path.join(PROJECT_FILES_DIR, safeId);
}

function iso(value) {
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeNote(note = {}) {
  return { id: clean(note.id, 100) || crypto.randomUUID(), text: clean(note.text, 12_000), source: clean(note.source, 80) || 'manual', createdAt: iso(note.createdAt) };
}

function normalizeCustomerSchedulingRequest(request = {}) {
  const customerName = clean(request.customerName, 220);
  const isoYear = Math.max(2000, Math.min(2100, Number(request.isoYear) || new Date().getUTCFullYear()));
  const week = Math.max(1, Math.min(53, Number(request.week) || 1));
  const materialDeliverySpace = request.materialDeliverySpace === true;
  const theftWeatherProtected = request.theftWeatherProtected === true;
  const additionalInfo = clean(request.additionalInfo, 2000);
  const partnerId = clean(request.partnerId, 80) || 'heat-hero';
  const partnerName = clean(request.partnerName, 80) || 'Heat Hero';
  const partnerPrefix = clean(request.partnerPrefix, 6).toUpperCase() || 'HH';
  const schedulingMode = request.schedulingMode === 'enter-block-first' ? 'enter-block-first' : 'free-resource';
  const allowFreeResourceFallback = schedulingMode === 'enter-block-first' && request.allowFreeResourceFallback === true;
  const planbarDescriptionExtras = buildPlanbarSchedulingExtras({ materialDeliverySpace, theftWeatherProtected, additionalInfo });
  return {
    id: clean(request.id, 100) || crypto.randomUUID(),
    customerName,
    isoYear,
    week,
    materialDeliverySpace,
    theftWeatherProtected,
    additionalInfo,
    partnerId,
    partnerName,
    partnerPrefix,
    schedulingMode,
    allowFreeResourceFallback,
    planbarDescriptionExtras,
    command: `Kunde terminieren: ${customerName} in KW ${week}/${isoYear} für ${partnerName} (${partnerPrefix})${schedulingMode === 'enter-block-first' ? `\nFreien Fünf-Tage-Platz verwenden, falls kein ENTER-Block vorhanden: ${allowFreeResourceFallback ? 'Ja' : 'Nein'}` : ''}\n${planbarDescriptionExtras.join('\n')}`,
    status: request.status === 'completed' ? 'completed' : 'requested',
    createdAt: iso(request.createdAt),
  };
}

function normalizeFolder(folder = {}) {
  return { id: clean(folder.id, 100) || crypto.randomUUID(), name: clean(folder.name, 180) || 'Neuer Ordner', parentId: clean(folder.parentId, 100) || null, createdAt: iso(folder.createdAt) };
}

function normalizeFile(file = {}) {
  return {
    id: clean(file.id, 100) || crypto.randomUUID(), name: clean(file.name, 240) || 'Dokument',
    mime: clean(file.mime, 160) || 'application/octet-stream', bytes: Math.max(0, Number(file.bytes) || 0),
    sha256: clean(file.sha256, 128), folderId: clean(file.folderId, 100) || null,
    storageName: clean(file.storageName, 300), createdAt: iso(file.createdAt),
  };
}

function seedProjects() {
  return [clone(HEAT_HERO_PROJECT)];
}

function normalizeArea(area = {}, fallback = {}) {
  const id = clean(area.id || fallback.id, 100) || crypto.randomUUID();
  return {
    id,
    name: clean(area.name || fallback.name, 180) || 'Neuer Bereich',
    status: AREA_STATUSES.has(area.status) ? area.status : (AREA_STATUSES.has(fallback.status) ? fallback.status : 'planned'),
    owner: clean(area.owner || fallback.owner, 160),
    summary: clean(area.summary || fallback.summary, 3000),
    nextStep: clean(area.nextStep || fallback.nextStep, 2000),
  };
}

function normalizeAutomation(automation = {}, fallback = {}) {
  const status = AUTOMATION_STATUSES.has(automation.status) ? automation.status : (AUTOMATION_STATUSES.has(fallback.status) ? fallback.status : 'planned');
  const runnable = ['active', 'paused'].includes(status);
  return {
    id: clean(automation.id || fallback.id, 100) || crypto.randomUUID(),
    name: clean(automation.name || fallback.name, 220) || 'Neue Automation',
    status,
    enabled: runnable && (typeof automation.enabled === 'boolean' ? automation.enabled : (typeof fallback.enabled === 'boolean' ? fallback.enabled : status === 'active')),
    toggleAvailable: runnable,
    schedule: clean(automation.schedule || fallback.schedule, 300),
    execution: clean(automation.execution || fallback.execution, 300),
    purpose: clean(automation.purpose || fallback.purpose, 3000),
    safety: clean(automation.safety || fallback.safety, 3000),
    nextStep: clean(automation.nextStep || fallback.nextStep, 2000),
  };
}

function normalizeRunLogEntry(entry = {}, fallback = {}) {
  return {
    id: clean(entry.id || fallback.id, 140) || crypto.randomUUID(),
    automationId: clean(entry.automationId || fallback.automationId, 140),
    executedAt: clean(entry.executedAt || fallback.executedAt, 80),
    scheduledFor: clean(entry.scheduledFor || fallback.scheduledFor, 80),
    status: clean(entry.status || fallback.status, 100) || 'recorded',
    scope: clean(entry.scope || fallback.scope, 300),
    summary: clean(entry.summary || fallback.summary, 3000),
    sender: clean(entry.sender || fallback.sender, 320),
    recipient: clean(entry.recipient || fallback.recipient, 320),
    attachmentCount: Number.isFinite(Number(entry.attachmentCount ?? fallback.attachmentCount)) ? Number(entry.attachmentCount ?? fallback.attachmentCount) : 0,
    customerCount: Number.isFinite(Number(entry.customerCount ?? fallback.customerCount)) ? Number(entry.customerCount ?? fallback.customerCount) : 0,
    details: clean(entry.details || fallback.details, 3000),
  };
}

function normalizeProject(input = {}, fallback = {}) {
  const areas = Array.isArray(input.areas) ? input.areas : (fallback.areas || []);
  const inputAutomations = Array.isArray(input.automations) ? input.automations : [];
  const fallbackAutomations = Array.isArray(fallback.automations) ? fallback.automations : [];
  const automationIds = new Set([...fallbackAutomations, ...inputAutomations].map(item => item?.id).filter(Boolean));
  const automations = [...automationIds].map(id => normalizeAutomation(
    inputAutomations.find(item => item?.id === id) || {},
    fallbackAutomations.find(item => item?.id === id) || {},
  ));
  const inputRunLog = Array.isArray(input.runLog) ? input.runLog : [];
  const fallbackRunLog = Array.isArray(fallback.runLog) ? fallback.runLog : [];
  const runLogIds = new Set([...fallbackRunLog, ...inputRunLog].map(item => item?.id).filter(Boolean));
  const runLog = [...runLogIds].map(id => normalizeRunLogEntry(
    inputRunLog.find(item => item?.id === id) || {},
    fallbackRunLog.find(item => item?.id === id) || {},
  )).sort((left, right) => String(right.executedAt).localeCompare(String(left.executedAt)));
  const notes = Array.isArray(input.notes) ? input.notes : (fallback.notes || []);
  const customerSchedulingRequests = Array.isArray(input.customerSchedulingRequests)
    ? input.customerSchedulingRequests
    : (fallback.customerSchedulingRequests || []);
  const folders = Array.isArray(input.folders) ? input.folders : (fallback.folders || []);
  const files = Array.isArray(input.files) ? input.files : (fallback.files || []);
  return {
    ...clone(fallback),
    id: clean(input.id || fallback.id, 100) || crypto.randomUUID(),
    name: clean(input.name || fallback.name, 180) || 'Neues Projekt',
    company: clean(input.company || fallback.company, 180),
    category: clean(input.category || fallback.category, 240),
    websiteUrl: normalizeWebsiteUrl(input.websiteUrl ?? fallback.websiteUrl),
    instagramUrl: normalizeInstagramUrl(input.instagramUrl ?? fallback.instagramUrl),
    logo: normalizeLogo(input.logo ?? fallback.logo),
    status: PROJECT_STATUSES.has(input.status) ? input.status : (PROJECT_STATUSES.has(fallback.status) ? fallback.status : 'planned'),
    description: clean(input.description || fallback.description, 5000),
    objective: clean(input.objective || fallback.objective, 5000),
    principles: (Array.isArray(input.principles) ? input.principles : (fallback.principles || [])).map(item => clean(item, 2000)).filter(Boolean).slice(0, 100),
    areas: areas.map(area => normalizeArea(area, (fallback.areas || []).find(item => item.id === area?.id) || {})).slice(0, 100),
    process: clone(Array.isArray(input.process) ? input.process : (fallback.process || [])),
    qualityGates: clone(Array.isArray(input.qualityGates) ? input.qualityGates : (fallback.qualityGates || [])),
    phases: clone(Array.isArray(input.phases)
      ? input.phases
      : (fallback.phases || input.roadmap || fallback.roadmap || [])),
    automations,
    runLog,
    planbarCapacity: normalizePlanbarCapacitySnapshot(
      Array.isArray(input.planbarCapacity?.weeks) && input.planbarCapacity.weeks.length
        ? input.planbarCapacity
        : fallback.planbarCapacity,
    ),
    customerSchedulingPartners: normalizeCustomerSchedulingPartners(
      input.customerSchedulingPartners ?? fallback.customerSchedulingPartners,
    ),
    protocolPolicy: {
      enabled: input.protocolPolicy?.enabled ?? fallback.protocolPolicy?.enabled ?? false,
      folderName: clean(input.protocolPolicy?.folderName || fallback.protocolPolicy?.folderName, 180) || 'Workflow-Protokolle',
      dailyFolder: clean(input.protocolPolicy?.dailyFolder || fallback.protocolPolicy?.dailyFolder, 100) || 'taeglich',
      weeklyFolder: clean(input.protocolPolicy?.weeklyFolder || fallback.protocolPolicy?.weeklyFolder, 100) || 'woechentlich',
      dailyRetentionDays: Math.max(1, Math.min(365, Number(input.protocolPolicy?.dailyRetentionDays ?? fallback.protocolPolicy?.dailyRetentionDays ?? 7))),
      weeklyRetentionDays: Math.max(1, Math.min(365, Number(input.protocolPolicy?.weeklyRetentionDays ?? fallback.protocolPolicy?.weeklyRetentionDays ?? 30))),
      dailySchedule: clean(input.protocolPolicy?.dailySchedule || fallback.protocolPolicy?.dailySchedule, 180),
      weeklySchedule: clean(input.protocolPolicy?.weeklySchedule || fallback.protocolPolicy?.weeklySchedule, 180),
      cleanupSchedule: clean(input.protocolPolicy?.cleanupSchedule || fallback.protocolPolicy?.cleanupSchedule, 180),
      expectedWorkflows: (Array.isArray(input.protocolPolicy?.expectedWorkflows)
        ? input.protocolPolicy.expectedWorkflows
        : (fallback.protocolPolicy?.expectedWorkflows || [])).map(item => ({
          workflowId: clean(item?.workflowId, 140),
          workflowName: clean(item?.workflowName, 240),
          cadence: item?.cadence === 'weekly' ? 'weekly' : 'daily',
          weekday: Number.isInteger(Number(item?.weekday)) ? Number(item.weekday) : null,
        })).filter(item => item.workflowId).slice(0, 100),
      note: clean(input.protocolPolicy?.note || fallback.protocolPolicy?.note, 1000),
    },
    existingCapabilities: (Array.isArray(input.existingCapabilities) ? input.existingCapabilities : (fallback.existingCapabilities || [])).map(item => clean(item, 3000)).filter(Boolean).slice(0, 200),
    missingCapabilities: (Array.isArray(input.missingCapabilities) ? input.missingCapabilities : (fallback.missingCapabilities || [])).map(item => clean(item, 3000)).filter(Boolean).slice(0, 200),
    roadmap: clone(Array.isArray(input.roadmap) ? input.roadmap : (fallback.roadmap || [])),
    notes: notes.map(normalizeNote).filter(note => note.text),
    customerSchedulingRequests: customerSchedulingRequests
      .map(normalizeCustomerSchedulingRequest)
      .filter(request => request.customerName)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .slice(0, 100),
    folders: folders.map(normalizeFolder),
    files: files.map(normalizeFile).filter(file => file.storageName),
  };
}

function publicProject(project) {
  const output = clone(project);
  output.files = (output.files || []).map(({ storageName, ...file }) => file);
  if (output.logo) {
    const { storageName, ...logo } = output.logo;
    output.logo = logo;
  }
  return output;
}

async function loadStore() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    const storedProjects = Array.isArray(parsed?.projects) ? parsed.projects : [];
    const deletedProjectIds = Array.isArray(parsed?.deletedProjectIds)
      ? [...new Set(parsed.deletedProjectIds.map(id => clean(id, 100)).filter(Boolean))]
      : [];
    const seeds = seedProjects();
    const projects = seeds.filter(seed => !deletedProjectIds.includes(seed.id)).map(seed => normalizeProject(storedProjects.find(item => item.id === seed.id) || {}, seed));
    const heatSeed = seeds.find(item => item.id === 'heat-hero');
    const heatProject = projects.find(item => item.id === 'heat-hero');
    const storedHeat = storedProjects.find(item => item.id === 'heat-hero');
    const kfwSeed = heatSeed?.automations?.find(item => item.id === 'kfw-approval-morning');
    const storedKfw = storedHeat?.automations?.find(item => item.id === 'kfw-approval-morning');
    if (heatProject && kfwSeed && Number(kfwSeed.specVersion || 0) > Number(storedKfw?.specVersion || 0)) {
      const index = heatProject.automations.findIndex(item => item.id === 'kfw-approval-morning');
      if (index >= 0) heatProject.automations[index] = normalizeAutomation({}, kfwSeed);
    }
    for (const item of storedProjects.filter(item => !deletedProjectIds.includes(item.id) && !seeds.some(seed => seed.id === item.id))) projects.push(normalizeProject(item));
    return { version: 2, deletedProjectIds, projects };
  } catch {
    return { version: 2, deletedProjectIds: [], projects: seedProjects().map(seed => normalizeProject({}, seed)) };
  }
}

async function saveStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, STORE_FILE);
}

async function mutate(fn) {
  let result;
  const job = writeQueue.catch(() => {}).then(async () => {
    const store = await loadStore();
    result = await fn(store);
    await saveStore(store);
  });
  writeQueue = job.catch(() => {});
  await job;
  return result;
}

export async function listProjects() {
  const store = await loadStore();
  return store.projects.map(publicProject).sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getProject(id) {
  const project = (await loadStore()).projects.find(item => item.id === clean(id, 100));
  return project ? publicProject(project) : null;
}

export async function createProject(input = {}) {
  return mutate(store => {
    const project = normalizeProject({ ...input, id: undefined, logo: null, notes: [], customerSchedulingRequests: [], folders: [], files: [] });
    if (store.projects.some(item => item.id === project.id)) throw new Error('Projekt-ID ist bereits vorhanden.');
    store.projects.push(project);
    store.deletedProjectIds = (store.deletedProjectIds || []).filter(id => id !== project.id);
    return publicProject(project);
  });
}

export async function updateProject(id, patch = {}) {
  return mutate(store => {
    const index = store.projects.findIndex(item => item.id === clean(id, 100));
    if (index < 0) return null;
    const current = store.projects[index];
    store.projects[index] = normalizeProject({ ...current, ...patch, id: current.id, logo: current.logo, notes: current.notes, customerSchedulingRequests: current.customerSchedulingRequests, planbarCapacity: current.planbarCapacity, folders: current.folders, files: current.files }, current);
    return publicProject(store.projects[index]);
  });
}

export async function setProjectAutomationEnabled(projectId, automationId, enabled) {
  return mutate(store => {
    const projectIndex = store.projects.findIndex(item => item.id === clean(projectId, 100));
    if (projectIndex < 0) return null;
    const project = store.projects[projectIndex];
    const itemIndex = (project.automations || []).findIndex(item => item.id === clean(automationId, 100));
    if (itemIndex < 0) throw new Error('Projekt-Workflow nicht gefunden.');
    const item = project.automations[itemIndex];
    if (!['active', 'paused'].includes(item.status)) throw new Error('Dieser Workflow ist noch nicht ausführbar und kann deshalb nicht eingeschaltet werden.');
    project.automations[itemIndex] = { ...item, enabled: enabled === true, status: enabled === true ? 'active' : 'paused' };
    store.projects[projectIndex] = normalizeProject(project, project);
    return publicProject(store.projects[projectIndex]);
  });
}

export async function renameProjectAutomation(projectId, automationId, name) {
  const workflowName = clean(name, 220);
  if (workflowName.length < 2) throw new Error('Bitte einen Workflow-Namen mit mindestens zwei Zeichen eingeben.');
  return mutate(store => {
    const projectIndex = store.projects.findIndex(item => item.id === clean(projectId, 100));
    if (projectIndex < 0) return null;
    const project = store.projects[projectIndex];
    const itemIndex = (project.automations || []).findIndex(item => item.id === clean(automationId, 100));
    if (itemIndex < 0) throw new Error('Projekt-Workflow nicht gefunden.');
    project.automations[itemIndex] = { ...project.automations[itemIndex], name: workflowName };
    store.projects[projectIndex] = normalizeProject(project, project);
    return publicProject(store.projects[projectIndex]);
  });
}

export async function addProjectNote(id, text, source = 'manual') {
  const noteText = clean(text, 12_000);
  if (!noteText) throw new Error('Bitte zuerst eine Notiz eingeben.');
  return mutate(store => {
    const project = store.projects.find(item => item.id === clean(id, 100));
    if (!project) return null;
    project.notes = [...(project.notes || []), normalizeNote({ text: noteText, source })];
    return publicProject(project);
  });
}

export async function addCustomerSchedulingRequest(id, input = {}) {
  const customerName = clean(input.customerName, 220);
  const isoYear = Number(input.isoYear);
  const week = Number(input.week);
  if (customerName.length < 3) throw new Error('Bitte den vollständigen Kundennamen eingeben.');
  if (!Number.isInteger(isoYear) || isoYear < 2000 || isoYear > 2100) throw new Error('Das Kalenderjahr ist ungültig.');
  if (!Number.isInteger(week) || week < 1 || week > 53) throw new Error('Die Kalenderwoche ist ungültig.');
  if (typeof input.materialDeliverySpace !== 'boolean' || typeof input.theftWeatherProtected !== 'boolean') {
    throw new Error('Bitte beide Materialfragen mit Ja oder Nein beantworten.');
  }
  return mutate(store => {
    const project = store.projects.find(item => item.id === clean(id, 100));
    if (!project) return null;
    const partner = normalizeCustomerSchedulingPartners(project.customerSchedulingPartners)
      .find(item => item.id === clean(input.partnerId, 80));
    if (!partner) throw new Error('Bitte den Planbar-Partner für diesen Kunden auswählen.');
    const request = normalizeCustomerSchedulingRequest({
      customerName,
      isoYear,
      week,
      materialDeliverySpace: input.materialDeliverySpace,
      theftWeatherProtected: input.theftWeatherProtected,
      additionalInfo: input.additionalInfo,
      partnerId: partner.id,
      partnerName: partner.name,
      partnerPrefix: partner.prefix,
      schedulingMode: partner.schedulingMode,
      allowFreeResourceFallback: input.allowFreeResourceFallback,
    });
    project.customerSchedulingRequests = [request, ...(project.customerSchedulingRequests || [])].slice(0, 100);
    return publicProject(project);
  });
}

export async function updatePlanbarCapacity(id, input = {}) {
  const snapshot = normalizePlanbarCapacitySnapshot(input);
  if (!snapshot.weeks.length) throw new Error('Mindestens eine gültige Kalenderwoche ist erforderlich.');
  return mutate(store => {
    const project = store.projects.find(item => item.id === clean(id, 100));
    if (!project) return null;
    project.planbarCapacity = snapshot;
    return publicProject(project);
  });
}

export async function createProjectFolder(id, input = {}) {
  const name = clean(input.name, 180);
  const parentId = clean(input.parentId, 100) || null;
  if (!name) throw new Error('Der Ordner braucht einen Namen.');
  return mutate(store => {
    const project = store.projects.find(item => item.id === clean(id, 100));
    if (!project) return null;
    if (parentId && !(project.folders || []).some(folder => folder.id === parentId)) throw new Error('Der übergeordnete Ordner wurde nicht gefunden.');
    const duplicate = (project.folders || []).some(folder => folder.parentId === parentId && folder.name.localeCompare(name, 'de', { sensitivity: 'base' }) === 0);
    if (duplicate) throw new Error('In diesem Ordner gibt es bereits einen Ordner mit diesem Namen.');
    project.folders = [...(project.folders || []), normalizeFolder({ name, parentId })];
    return publicProject(project);
  });
}

export async function storeProjectLogo(id, { name, mime, buffer } = {}) {
  const safeMime = clean(mime, 100).split(';')[0].toLowerCase();
  if (!LOGO_MIME_EXTENSIONS.has(safeMime)) throw new Error('Erlaubt sind PNG-, JPG- und WebP-Logos.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Die Logo-Datei ist leer.');
  if (buffer.length > MAX_LOGO_BYTES) throw new Error('Das Logo ist größer als 5 MB.');
  if (!validLogoSignature(buffer, safeMime)) throw new Error('Dateityp und Inhalt des Logos passen nicht zusammen.');
  const projectId = clean(id, 100);
  const extension = LOGO_MIME_EXTENSIONS.get(safeMime);
  const storageName = `brand-logo-${crypto.randomUUID()}${extension}`;
  const result = await mutate(async store => {
    const project = store.projects.find(item => item.id === projectId);
    if (!project) return null;
    const projectDir = projectFileDir(project.id);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, storageName), buffer, { mode: 0o600 });
    const previousStorageName = project.logo?.storageName || '';
    project.logo = normalizeLogo({
      name: clean(name, 240) || `Projektlogo${extension}`,
      mime: safeMime,
      bytes: buffer.length,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      storageName,
      uploadedAt: new Date().toISOString(),
    });
    return { project: publicProject(project), previousStorageName };
  });
  if (!result) return null;
  if (result.previousStorageName && result.previousStorageName !== storageName) {
    await fs.rm(path.join(projectFileDir(projectId), result.previousStorageName), { force: true }).catch(() => {});
  }
  return result.project;
}

export async function readProjectLogo(id) {
  const project = (await loadStore()).projects.find(item => item.id === clean(id, 100));
  if (!project?.logo?.storageName) return null;
  const projectDir = projectFileDir(project.id);
  const filePath = path.join(projectDir, project.logo.storageName);
  if (!filePath.startsWith(`${projectDir}${path.sep}`)) return null;
  const { storageName, ...meta } = project.logo;
  return { meta: clone(meta), buffer: await fs.readFile(filePath) };
}

export async function deleteProjectLogo(id) {
  const projectId = clean(id, 100);
  const result = await mutate(store => {
    const project = store.projects.find(item => item.id === projectId);
    if (!project) return null;
    const storageName = project.logo?.storageName || '';
    project.logo = null;
    return { project: publicProject(project), storageName };
  });
  if (!result) return null;
  if (result.storageName) await fs.rm(path.join(projectFileDir(projectId), result.storageName), { force: true }).catch(() => {});
  return result.project;
}

export async function storeProjectFile(id, { name, mime, folderId, buffer }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Die Datei ist leer.');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('Die Datei ist größer als 25 MB.');
  const safeName = clean(name, 240) || 'Dokument';
  const requestedFolderId = clean(folderId, 100) || null;
  return mutate(async store => {
    const project = store.projects.find(item => item.id === clean(id, 100));
    if (!project) return null;
    if (requestedFolderId && !(project.folders || []).some(folder => folder.id === requestedFolderId)) throw new Error('Der Zielordner wurde nicht gefunden.');
    const extension = path.extname(safeName).replace(/[^a-z0-9.]/gi, '').slice(0, 16);
    const storageName = `${crypto.randomUUID()}${extension}`;
    const projectDir = projectFileDir(project.id);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, storageName), buffer, { mode: 0o600 });
    const file = normalizeFile({ name: safeName, mime, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), folderId: requestedFolderId, storageName });
    project.files = [...(project.files || []), file];
    return publicProject({ ...project, files: [file] }).files[0];
  });
}

export async function readProjectFile(id, fileId) {
  const project = (await loadStore()).projects.find(item => item.id === clean(id, 100));
  const file = project?.files?.find(item => item.id === clean(fileId, 100));
  if (!project || !file?.storageName) return null;
  const projectDir = projectFileDir(project.id);
  const filePath = path.join(projectDir, file.storageName);
  if (!filePath.startsWith(`${projectDir}${path.sep}`)) return null;
  return { meta: publicProject({ files: [file] }).files[0], buffer: await fs.readFile(filePath) };
}

export async function deleteProject(id) {
  const projectId = clean(id, 100);
  const deleted = await mutate(store => {
    const index = store.projects.findIndex(item => item.id === projectId);
    if (index < 0) return null;
    const [project] = store.projects.splice(index, 1);
    store.deletedProjectIds = [...new Set([...(store.deletedProjectIds || []), project.id])];
    return publicProject(project);
  });
  if (!deleted) return null;
  const projectDir = projectFileDir(projectId);
  if (projectDir.startsWith(`${PROJECT_FILES_DIR}${path.sep}`)) await fs.rm(projectDir, { recursive: true, force: true });
  return deleted;
}

export { HEAT_HERO_PROJECT };
