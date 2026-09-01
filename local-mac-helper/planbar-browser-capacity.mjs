import { isoWeekRange, countPlanbarFreeWorkweekCapacity, PLANBAR_CAPACITY_RULE_VERSION } from '../operations/customer-scheduling.js';

export const PLANBAR_CAPACITY_TASK_TITLE = 'Heat Hero: Planbar-Kapazität lesend prüfen';
const ORIGIN = 'https://heathero-partner-a.planbar365.com';
const dayAfter = date => new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

// Executed only through the supported Browser tool's read-only DOM evaluator.
// Deliberately excludes customer names, contact data, cookies and hidden app state.
export function readPlanbarCapacityDom() {
  const datedCells = Array.from(document.querySelectorAll('th.fc-timeline-slot-label[data-date]'));
  const groupedRows = [];
  const rowIndexes = new Map();
  for (const cell of datedCells) {
    const row = cell.closest?.('tr');
    if (!row) continue;
    let index = rowIndexes.get(row);
    if (index === undefined) {
      index = groupedRows.length;
      rowIndexes.set(row, index);
      groupedRows.push([]);
    }
    const rect = cell.getBoundingClientRect();
    groupedRows[index].push({
      date: cell.getAttribute('data-date'),
      colspan: Number.parseInt(cell.getAttribute('colspan') || String(cell.colSpan || ''), 10),
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
    });
  }
  const nextDate = date => new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const chronologicalLeafRows = groupedRows.filter(cells => cells.length >= 28 && cells.every((cell, index) => {
    const previous = cells[index - 1];
    return /^\d{4}-\d{2}-\d{2}$/.test(cell.date) && cell.colspan === 1
      && Number.isFinite(cell.left) && Number.isFinite(cell.right) && cell.right - cell.left >= 5
      && Number.isFinite(cell.top) && Number.isFinite(cell.bottom) && cell.bottom - cell.top >= 5
      && (!previous || (nextDate(previous.date) === cell.date
        && Math.abs(previous.right - cell.left) <= 2
        && Math.abs(previous.top - cell.top) <= 2
        && Math.abs(previous.bottom - cell.bottom) <= 2));
  }));
  const fullestCount = Math.max(0, ...chronologicalLeafRows.map(cells => cells.length));
  const fullestRows = chronologicalLeafRows.filter(cells => cells.length === fullestCount);
  if (fullestRows.length !== 1) throw new Error('Tageskopfzeile fehlt oder ist mehrdeutig.');
  const selectedDays = fullestRows[0];
  return {
    url: location.href, ready: document.readyState, observedAt: new Date().toISOString(),
    dayHeader: {
      selectionRule: 'unique-fullest-chronological-tr-v1',
      datedCellCount: datedCells.length,
      candidateRowCount: groupedRows.length,
      chronologicalLeafRowCount: chronologicalLeafRows.length,
      fullestRowCellCount: fullestCount,
      fullestRowTieCount: fullestRows.length,
      selectedStartDate: selectedDays[0].date,
      selectedEndDate: selectedDays.at(-1).date,
    },
    days: selectedDays.map(({ date, left, right }) => ({ date, left, right })),
    resources: Array.from(document.querySelectorAll('.fc-datagrid-body [data-resource-id]')).map(e => ({ id: e.getAttribute('data-resource-id'), name: e.textContent.replace(/\s+/g, ' ').trim() })),
    rows: Array.from(document.querySelectorAll('.fc-timeline-body [data-resource-id]')).map(e => ({ id: e.getAttribute('data-resource-id'),
      events: Array.from(e.querySelectorAll('.fc-timeline-event-harness, .fc-bg-event')).map(b => ({ left: b.getBoundingClientRect().left, right: b.getBoundingClientRect().right })) })),
  };
}

export function normalizePlanbarDomWindow(input) {
  if (input?.url !== ORIGIN + '/resource/list' || input.ready !== 'complete') throw new Error('Keine vollständig geladene Planbar-Plantafel.');
  const { dayHeader, days, resources, rows } = input;
  if (dayHeader?.selectionRule !== 'unique-fullest-chronological-tr-v1'
    || !Number.isInteger(dayHeader.datedCellCount) || dayHeader.datedCellCount < days?.length
    || !Number.isInteger(dayHeader.candidateRowCount) || dayHeader.candidateRowCount < 1
    || !Number.isInteger(dayHeader.chronologicalLeafRowCount) || dayHeader.chronologicalLeafRowCount < 1
    || dayHeader.fullestRowTieCount !== 1 || dayHeader.fullestRowCellCount !== days?.length
    || dayHeader.selectedStartDate !== days?.[0]?.date || dayHeader.selectedEndDate !== days?.at(-1)?.date) {
    throw new Error('Tageskopfzeile fehlt oder ist mehrdeutig.');
  }
  if (!Array.isArray(days) || days.length < 28 || !Array.isArray(resources) || !resources.length || !Array.isArray(rows) || rows.length !== resources.length) throw new Error('Kalender oder Ressourcen unvollständig.');
  const ids = new Set(resources.map(r => r.id));
  if (ids.size !== resources.length || rows.some(r => !ids.has(r.id)) || new Set(rows.map(r => r.id)).size !== ids.size) throw new Error('Ressourcenzuordnung mehrdeutig.');
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !Number.isFinite(d.left) || !Number.isFinite(d.right) || d.right - d.left < 5
      || (i && (dayAfter(days[i-1].date) !== d.date || Math.abs(days[i-1].right-d.left) > 2))) throw new Error('Tagesraster nicht eindeutig oder lückenhaft.');
  }
  const bookings = [];
  for (const row of rows) {
    if (!Array.isArray(row.events)) throw new Error('Terminliste fehlt.');
    for (const event of row.events) {
      if (!Number.isFinite(event.left) || !Number.isFinite(event.right) || event.right <= event.left) throw new Error('Terminrechteck nicht lesbar.');
      // Never round an occupied rectangle away from a date. Subpixel border
      // ambiguity may hide a free day, but must never manufacture a free day.
      const left = event.left, right = event.right;
      if (right <= left) throw new Error('Terminzeitraum nicht eindeutig.');
      const covered = days.filter(d => left < d.right - 0.01 && right > d.left + 0.01);
      if (!covered.length) throw new Error('Termin außerhalb des geprüften Kalenders.');
      bookings.push({ resourceId: row.id, startDate: covered[0].date, endDateExclusive: dayAfter(covered.at(-1).date) });
    }
  }
  if (!bookings.length) throw new Error('Keine geladenen Termine; leere Ladeansicht wird nicht als freie Kapazität verwendet.');
  return { rangeStart: days[0].date, rangeEndExclusive: dayAfter(days.at(-1).date), resources, bookings };
}

export function buildBrowserPlanbarCapacity({ refreshedAt, windows, repeatedWindows }, { now = Date.now() } = {}) {
  const refreshed = Date.parse(refreshedAt);
  if (!Number.isFinite(refreshed) || refreshed > now || now-refreshed > 5*60000 || !Array.isArray(windows) || windows.length !== 2) throw new Error('Frischer Reload-Nachweis mit zwei Kalenderansichten fehlt.');
  if (!Array.isArray(repeatedWindows) || repeatedWindows.length !== 2) throw new Error('Unabhängiger zweiter Kalenderdurchgang fehlt.');
  const normalized = windows.map(normalizePlanbarDomWindow);
  const repeated = repeatedWindows.map(normalizePlanbarDomWindow);
  for (let i=0;i<2;i++) {
    const a=Date.parse(windows[i].observedAt), b=Date.parse(repeatedWindows[i].observedAt);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < refreshed || b-a < 5000 || b > now
      || JSON.stringify(normalized[i]) !== JSON.stringify(repeated[i])) throw new Error('Kalenderdaten zwischen den zwei Durchgängen nicht stabil oder Prüfzeitpunkte ungültig.');
  }
  const [first, second] = normalized;
  if (first.rangeEndExclusive !== second.rangeStart || JSON.stringify(first.resources) !== JSON.stringify(second.resources)) throw new Error('Kalenderansichten schließen nicht lückenlos mit identischen Ressourcen an.');
  const bookings = normalized.flatMap(w => w.bookings);
  const weeks = [];
  const year = new Date(now).getUTCFullYear();
  for (const isoYear of [year, year+1]) for (let week=1; week<=53; week++) {
    let range; try { range=isoWeekRange(isoYear,week); } catch { continue; }
    if (Date.parse(range.startDate+'T00:00:00Z') <= now || range.startDate < first.rangeStart || range.endDateExclusive > second.rangeEndExclusive) continue;
    weeks.push({ isoYear, week, freeSlots: countPlanbarFreeWorkweekCapacity({ resources:first.resources, bookings, year:isoYear, week }) });
  }
  if (weeks.length < 12) throw new Error('Weniger als zwölf vollständig geprüfte zukünftige Kalenderwochen.');
  return { updatedAt: new Date(now).toISOString(), sourceCheckedAt: null, pageRefreshedAt: refreshedAt,
    refreshMode:'browser-page-reload',
    minimumBlockDays:5, countingRuleVersion:PLANBAR_CAPACITY_RULE_VERSION,
    excludedResources:['Dawid Service','Antonio Lausic'], weeks:weeks.slice(0,12) };
}

export function buildPlanbarCapacityReadTask() {
  return {
    mode:'operational', title:PLANBAR_CAPACITY_TASK_TITLE,
    prompt:`Prüfe ausschließlich lesend die aktuellen zwölf zukünftigen Montagewochen für den öffentlichen Heat-Hero-Terminlink. Keine Kundenanlage, Buchung, Änderung, Nachricht oder Mail. Benutze den unterstützten Browser-Skill mit der angemeldeten Chrome-Sitzung; keine AppleScript-/Accessibility-Steuerung, keine HTTP-Abkürzung und keine Cookie-/Passwortauslesung. Die zentrale UI-Sperre wird bereits vom Worker gehalten.
Öffne einen eigenen temporären Tab https://heathero-partner-a.planbar365.com/resource/list. ERSTER fachlicher Schritt ist tab.reload(); warte auf document.readyState complete und vollständig geladene Ressourcen/Termine. Speichere danach den tatsächlichen Zeitpunkt als refreshedAt. Lies aus der zentralen Laufzeit local-mac-helper/planbar-browser-capacity.mjs die Funktion readPlanbarCapacityDom vollständig und verwende genau diese Funktion im unterstützten tab.playwright.evaluate. Sie liest ausschließlich gerenderte DOM-Geometrie und Ressourcennamen, keine Kundendaten.
Wähle über den sichtbaren Button „8 Wochen“. Zur eindeutigen Ausrichtung auf Montag klicke einmal „Nächste“, danach „Vorherige“, BEVOR du Daten sammelst (Planbar richtet den Zeitraum beim Blättern auf Montag aus). Prüfe, dass die erste Ansicht am Montag der aktuellen Woche beginnt. Warte auf vollständig gerenderte Tagesköpfe, alle Ressourcenzeilen und Termine; prüfe die Ansicht visuell. Speichere die DOM-Ausgabe unverändert. Klicke „Nächste“ einmal, warte nach demselben Verfahren auf die nächste vollständig geladene Acht-Wochen-Ansicht und speichere diese Ausgabe. Danach klicke „Vorherige“ und lies die erste Ansicht erneut, dann „Nächste“ und lies die zweite erneut. Zwischen Erst- und Wiederholungslesung jeder Ansicht müssen mindestens fünf Sekunden liegen. Falls die Inhalte abweichen, war die Ansicht noch im Laden oder wurde verändert: vollständig neu prüfen, niemals fehlende Termine als frei zählen. Keine Datumslücken und keine geratenen leeren Wochen. Die vier tatsächlichen DOM-Ausgaben bleiben im eigenen Aufgabenordner als capacity-dom.json mit {refreshedAt,windows:[ersteAnsicht,zweiteAnsicht],repeatedWindows:[ersteWiederholung,zweiteWiederholung]}. Falls der Abruf fünf Minuten überschreitet, neu laden und beide Durchgänge frisch lesen.
Führe abschließend den installierten Helfer local-mac-helper/planbar-browser-capacity.mjs report <absoluter Pfad zu capacity-dom.json> aus. Er validiert die zwölf Wochen deterministisch und meldet ausschließlich Kapazitäten über den authentifizierten Gerätekanal. Keine selbst berechneten oder geratenen Kapazitäten posten. Erfolg nur bei bestätigtem Helferergebnis. Beende den eigenen Tab. Berichte nur Prüfzeitpunkt und freie Kalenderwochen, keine Kundendaten. Bei echtem Zugriffsblocker keine Ausweichdaten, Status: blockiert.`,
    acceptanceCriteria:['Frischer Reload vor Kapazitätsprüfung','Zwei stabile vollständige Acht-Wochen-Ansichten','Deterministisch geprüft und über zentralen Gerätekanal veröffentlicht','Keine Kundentermine oder Nachrichten erzeugt'],
  };
}

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('/planbar-browser-capacity.mjs') && process.argv[2] === 'report') {
  try {
    const { readFile, realpath } = await import('node:fs/promises');
    const path = await import('node:path'); const os = await import('node:os');
    const file = await realpath(process.argv[3]);
    const root = path.join(os.homedir(),'Library','Application Support','IVA Mac Helper','codex-tasks');
    if (!file.startsWith(root + path.sep) || path.basename(file)!=='capacity-dom.json') throw new Error('Kapazitätsbeleg muss im eigenen Aufgabenordner liegen.');
    const snapshot=buildBrowserPlanbarCapacity(JSON.parse(await readFile(file,'utf8')));
    const { publishPlanbarCapacitySnapshot } = await import('./device-agent.mjs');
    const stored=await publishPlanbarCapacitySnapshot(snapshot);
    if (stored?.planbarCapacity?.pageRefreshedAt !== snapshot.pageRefreshedAt
      || JSON.stringify(stored?.planbarCapacity?.weeks) !== JSON.stringify(snapshot.weeks)) throw new Error('Der zentrale Kapazitätsnachweis wurde nicht bestätigt.');
    console.log(JSON.stringify({verified:true,updatedAt:snapshot.updatedAt,weeks:snapshot.weeks,noCustomerChanges:true}));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
