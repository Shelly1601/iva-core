import PDFDocument from 'pdfkit';
import { normalizeEnergyData, TMB_PHOTO_LABELS } from './tmb.js';

const COLORS = {
  navy: '#0e1b30',
  blue: '#247fba',
  cyan: '#1aaea6',
  ink: '#172033',
  muted: '#607187',
  line: '#d9e2ec',
  pale: '#f3f7fb',
  white: '#ffffff',
};

function clean(value, fallback = 'Nicht angegeben') {
  const text = String(value ?? '').trim()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
  return text || fallback;
}

function yesNo(value) {
  return value === true ? 'Ja' : value === false ? 'Nein' : 'Nicht angegeben';
}

function option(value, labels = {}) {
  return labels[value] || clean(value);
}

function asMetric(value, unit) {
  return String(value ?? '').trim() ? `${clean(value)} ${unit}` : 'Nicht angegeben';
}

function asEuro(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }) : 'Nicht angegeben';
}

function displayName(workspace) {
  return clean(workspace?.customer?.name, 'Kunde nicht angegeben');
}

export async function createTmbPdf(workspace, { readFile } = {}) {
  if (!workspace || workspace.mode !== 'energie') throw new Error('TMB-PDF ist nur für Energie-Fallakten verfügbar.');
  const data = normalizeEnergyData(workspace.data || {});
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 52, right: 48, bottom: 52, left: 48 },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `Technische Machbarkeitsbewertung - ${displayName(workspace)}`,
      Author: 'IVA Energieplaner',
      Subject: 'Technische Machbarkeitsbewertung Wärmepumpe',
      Keywords: 'TMB, Wärmepumpe, Energieplanung, IVA',
    },
  });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const left = doc.page.margins.left;

  function ensureSpace(height) {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom - 16) doc.addPage();
  }

  function section(title, subtitle = '') {
    ensureSpace(subtitle ? 58 : 42);
    doc.moveDown(0.55);
    const y = doc.y;
    doc.roundedRect(left, y, contentWidth, subtitle ? 45 : 30, 7).fill(COLORS.navy);
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(12).text(clean(title), left + 13, y + 8, { width: contentWidth - 26 });
    if (subtitle) doc.fillColor('#b9d5ea').font('Helvetica').fontSize(8.5).text(clean(subtitle), left + 13, y + 25, { width: contentWidth - 26 });
    doc.y = y + (subtitle ? 53 : 38);
  }

  function field(label, value) {
    const labelWidth = 175;
    const valueWidth = contentWidth - labelWidth - 18;
    const shown = clean(value);
    doc.font('Helvetica-Bold').fontSize(8.7);
    const lh = doc.heightOfString(clean(label), { width: labelWidth });
    doc.font('Helvetica').fontSize(9.2);
    const vh = doc.heightOfString(shown, { width: valueWidth });
    const height = Math.max(24, lh, vh) + 8;
    ensureSpace(height);
    const y = doc.y;
    doc.rect(left, y, contentWidth, height).fillAndStroke(COLORS.pale, COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8.7).text(clean(label), left + 9, y + 8, { width: labelWidth });
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9.2).text(shown, left + labelWidth + 12, y + 8, { width: valueWidth });
    doc.y = y + height + 3;
  }

  function compactFields(items) {
    for (const [label, value] of items) field(label, value);
  }

  function tableHeader(columns) {
    ensureSpace(28);
    const y = doc.y;
    doc.rect(left, y, contentWidth, 24).fill(COLORS.blue);
    let x = left;
    for (const col of columns) {
      doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(7.8).text(col.label, x + 5, y + 7, { width: col.width - 10 });
      x += col.width;
    }
    doc.y = y + 24;
  }

  function tableRow(columns, values, index) {
    doc.font('Helvetica').fontSize(7.8);
    const heights = columns.map((col, i) => doc.heightOfString(clean(values[i]), { width: col.width - 10 }));
    const height = Math.max(27, ...heights.map(h => h + 12));
    if (doc.y + height > doc.page.height - doc.page.margins.bottom - 16) {
      doc.addPage();
      tableHeader(columns);
    }
    const y = doc.y;
    doc.rect(left, y, contentWidth, height).fillAndStroke(index % 2 ? COLORS.white : COLORS.pale, COLORS.line);
    let x = left;
    for (let i = 0; i < columns.length; i += 1) {
      doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.8).text(clean(values[i]), x + 5, y + 7, { width: columns[i].width - 10 });
      x += columns[i].width;
      if (i < columns.length - 1) doc.moveTo(x, y).lineTo(x, y + height).stroke(COLORS.line);
    }
    doc.y = y + height;
  }

  // Titelseite
  doc.rect(0, 0, doc.page.width, 170).fill(COLORS.navy);
  doc.fillColor(COLORS.cyan).font('Helvetica-Bold').fontSize(11).text('IVA ENERGIEPLANER', left, 56, { characterSpacing: 1.4 });
  doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(25).text('Technische\nMachbarkeitsbewertung', left, 82, { width: 410, lineGap: 2 });
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(18).text(displayName(workspace), left, 208);
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(11).text(clean(workspace.customer?.address), left, 236, { width: contentWidth });
  doc.moveTo(left, 280).lineTo(left + contentWidth, 280).lineWidth(1.5).stroke(COLORS.cyan);
  doc.y = 305;
  compactFields([
    ['Fallakte', workspace.title],
    ['Besichtigung', data.assessment.visitDate],
    ['Berater/in', data.assessment.adviser],
    ['Bearbeitungsstand', option(workspace.status, { draft: 'Entwurf', active: 'In Bearbeitung', review: 'Zur Prüfung', complete: 'Abgeschlossen' })],
    ['Schema', data.schemaVersion],
    ['Erstellt', new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' })],
  ]);
  doc.moveDown(1);
  doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(8.5).text('Hinweis: Diese Dokumentation basiert auf den in der Fallakte erfassten und geprüften Angaben. Sie ersetzt keine Fachplanung, Heizlastberechnung oder finale Auslegung durch einen qualifizierten Fachbetrieb.', left, doc.y, { width: contentWidth, lineGap: 2 });

  doc.addPage();
  section('1. Kunde und Vor-Ort-Termin');
  compactFields([
    ['Kundenname', workspace.customer?.name],
    ['Adresse', workspace.customer?.address],
    ['E-Mail', workspace.customer?.email],
    ['Telefon', workspace.customer?.phone],
    ['Besichtigung', data.assessment.visitDate],
    ['Berater/in', data.assessment.adviser],
    ['Vertrieb / Leadquelle', [data.assessment.salesRep, data.assessment.leadSource].filter(Boolean).join(' / ')],
  ]);

  section('2. Gebäude');
  compactFields([
    ['Gebäudetyp', data.building.type],
    ['Baujahr', data.building.year],
    ['Beheizte Fläche', asMetric(data.building.heatedArea, 'm²')],
    ['Geschosse / Einheiten', [data.building.floors && `${data.building.floors} Geschosse`, data.building.units && `${data.building.units} Einheiten`].filter(Boolean).join(' / ')],
    ['Bewohner', data.building.occupants],
    ['Bauweise', data.building.construction],
    ['Fenster / Verglasung', data.building.glazing],
    ['Dach', data.building.roof],
    ['Keller', data.building.basement],
    ['Dämmung', [data.building.exteriorInsulation && `Fassade: ${data.building.exteriorInsulation}`, data.building.roofInsulation && `Dach: ${data.building.roofInsulation}`, data.building.basementInsulation && `Keller: ${data.building.basementInsulation}`].filter(Boolean).join(' | ')],
    ['Norm-Außentemperatur', asMetric(data.building.designOutdoorTemperature, 'Grad C')],
    ['Wärmebrücken-Zuschlag', asMetric(data.building.thermalBridgePercent, '%')],
  ]);

  section('3. Bestandsheizung');
  compactFields([
    ['Energieträger', data.existingHeating.energySource],
    ['Hersteller / Modell', [data.existingHeating.manufacturer, data.existingHeating.model].filter(Boolean).join(' / ')],
    ['Baujahr / Leistung', [data.existingHeating.installationYear, data.existingHeating.nominalPower && `${data.existingHeating.nominalPower} kW`].filter(Boolean).join(' / ')],
    ['Aufstellort', data.existingHeating.boilerLocation],
    ['Heizsystem', data.existingHeating.systemType],
    ['Rohrsystem / Durchmesser', [data.existingHeating.pipeSystem, data.existingHeating.pipeDiameter].filter(Boolean).join(' / ')],
    ['Vorlauftemperatur', asMetric(data.existingHeating.flowTemperature, 'Grad C')],
    ['Warmwasser', data.existingHeating.hotWater],
    ['Tank / Lager', data.existingHeating.tanks],
    ['Jahresverbrauch', [data.existingHeating.annualConsumption, data.existingHeating.consumptionUnit, data.existingHeating.consumptionPeriod].filter(Boolean).join(' / ')],
    ['Verbrauchsnachweis vorhanden', yesNo(data.existingHeating.billAvailable)],
  ]);

  section('4. Wärmepumpen-Standort und Leitungsweg');
  compactFields([
    ['Gewünschter Außenstandort', data.heatPump.desiredPosition],
    ['Innenstandort', data.heatPump.indoorPosition],
    ['Entfernung', asMetric(data.heatPump.distance, 'm')],
    ['Kleinste Zugangsbreite', asMetric(data.heatPump.accessWidth, 'cm')],
    ['Höhenunterschied', asMetric(data.heatPump.levelDifference, 'm')],
    ['Leitungsweg', data.heatPump.route],
    ['Kältemittelwunsch', data.heatPump.refrigerantPreference],
    ['Herstellerwunsch', data.heatPump.manufacturerPreference],
    ['Hinweise', data.heatPump.notes],
    ['Denkmalschutz', yesNo(data.site.protectedBuilding)],
    ['Geräuschsensibles Umfeld', yesNo(data.site.noiseSensitive)],
    ['Kran erforderlich', yesNo(data.site.craneRequired)],
    ['Zugang / Aufstellung', data.site.accessNotes],
  ]);

  section('5. Hydraulik, Elektro und erneuerbare Anlagen');
  compactFields([
    ['Fußbodenheizung vorhanden', yesNo(data.hydraulics.underfloorHeating)],
    ['Umwälzpumpen', data.hydraulics.circulationPumps],
    ['Pufferspeicher', data.hydraulics.bufferTank],
    ['Hydraulische Hinweise', data.hydraulics.notes],
    ['Hausanschluss / Absicherung', data.electrical.serviceAmps],
    ['Zählerart', data.electrical.meterType],
    ['Freie Plätze', data.electrical.freeSlots],
    ['Anpassung Elektroanlage', option(data.electrical.upgradeNeeded, { unknown: 'Noch zu prüfen', yes: 'Erforderlich', no: 'Nach Sichtprüfung nicht erforderlich' })],
    ['Elektro-Hinweise', data.electrical.cabinetNotes],
    ['PV-Anlage', data.pv.present ? `Ja${data.pv.power ? `, ${data.pv.power} kWp` : ''}` : 'Nein'],
    ['Batteriespeicher', data.pv.batteryPresent ? `Ja${data.pv.batteryCapacity ? `, ${data.pv.batteryCapacity} kWh` : ''}` : 'Nein'],
    ['Solarthermie', yesNo(data.pv.solarThermal)],
  ]);

  doc.addPage();
  section('6. Räume und Heizkörper', `${data.rooms.length} Räume, ${data.rooms.reduce((sum, room) => sum + room.radiators.length, 0)} Heizkörper erfasst`);
  if (!data.rooms.length) {
    field('Erfassung', 'Noch keine Räume oder Heizkörper hinterlegt.');
  } else {
    const columns = [
      { label: 'Etage / Raum', width: 100 },
      { label: 'Nutzung / Fläche', width: 92 },
      { label: 'Heizkörper', width: 98 },
      { label: 'Typ', width: 55 },
      { label: 'Maße B x H x T', width: contentWidth - 345 },
    ];
    tableHeader(columns);
    let rowIndex = 0;
    for (const room of data.rooms) {
      const radiators = room.radiators.length ? room.radiators : [{ type: 'Keiner erfasst', panelType: '', width: '', height: '', depth: '', notes: '' }];
      for (let i = 0; i < radiators.length; i += 1) {
        const radiator = radiators[i];
        tableRow(columns, [
          [room.floor, room.name].filter(Boolean).join(' / '),
          [room.use, room.area && `${room.area} m2`, room.height && `H ${room.height} m`].filter(Boolean).join(' / '),
          [radiator.type, radiator.notes].filter(Boolean).join(' / '),
          radiator.panelType,
          [radiator.width, radiator.height, radiator.depth].filter(Boolean).join(' x ') + (radiator.width || radiator.height || radiator.depth ? ' mm' : ''),
        ], rowIndex);
        rowIndex += 1;
      }
    }
  }

  section('7. Heizlast-Vorplanung und Fördercheck');
  if (data.calculation?.status === 'preliminary') {
    compactFields([
      ['Heizlast-Vorplanung gesamt', `${clean(data.calculation.totalKw)} kW`],
      ['Räume berechnet', data.calculation.rooms?.length],
      ['Berechnungsstatus', 'Technische Vorplanung, kein DIN-Nachweis'],
      ['Rechenweg', data.calculation.formula],
      ['Hinweis', data.calculation.notice],
    ]);
  } else {
    compactFields([
      ['Heizlaststatus', data.calculation?.status === 'data-required' ? `${data.calculation.missing?.length || 0} Pflichtangaben fehlen` : 'Noch nicht berechnet'],
      ['Hinweis', data.calculation?.notice || 'Für diese Fallakte liegt noch keine Heizlast-Vorplanung vor.'],
    ]);
  }
  const funding = data.funding?.result;
  if (funding) {
    compactFields([
      ['KfW-Regelstand', funding.rulesAsOf],
      ['Förderübersicht', funding.noteSummary || `${clean(funding.rate, '0')} %`],
      ['Grundförderung Gesamtgebäude', `${clean(funding.buildingBaseRate, '0')} %`],
      ['Fördersatz selbst genutzte WE', funding.selfUsed ? `${clean(funding.selfUsedUnitRate, '0')} %` : 'nicht anwendbar'],
      ['Effektiver Satz Gesamtgebäude', `${clean(funding.effectiveBuildingRate ?? funding.rate, '0')} %`],
      ['Förderfähige Kosten im Vorcheck', asEuro(funding.eligibleCosts)],
      ['Rechnerischer Zuschuss', asEuro(funding.estimatedGrant)],
      ['Offene Voraussetzungen', funding.blockers?.length ? funding.blockers.join(' | ') : 'Keine offenen Eingaben im IVA-Vorcheck'],
      ['Förderhinweis', funding.notice],
    ]);
  } else field('Fördercheck', 'Noch nicht berechnet.');

  section('8. Prüfung und Bemerkungen');
  compactFields([
    ['Fachlich geprüft', yesNo(data.declaration.reviewed)],
    ['Geprüft durch', data.declaration.reviewedBy],
    ['Prüfdatum', data.declaration.reviewedAt],
    ['Bemerkungen', data.declaration.notes],
    ['Aufnahme-Einwilligung', workspace.visit?.consent?.granted ? `Erteilt (${clean(workspace.visit?.consent?.method)})` : 'Nicht dokumentiert'],
    ['PLAUD-Aufnahme', workspace.visit?.plaud?.recordingId],
  ]);

  const assignments = (data.photoAssignments || []).filter(assignment => assignment?.fileId);
  if (assignments.length && typeof readFile === 'function') {
    doc.addPage();
    section('9. Fotodokumentation', `${assignments.length} zugeordnete Dateien`);
    for (let i = 0; i < assignments.length; i += 1) {
      const assignment = assignments[i];
      let stored;
      try { stored = await readFile(workspace.id, assignment.fileId); } catch { stored = null; }
      if (!stored?.buffer || !String(stored.meta?.mime || '').startsWith('image/')) continue;
      ensureSpace(245);
      const y = doc.y;
      doc.roundedRect(left, y, contentWidth, 224, 8).fillAndStroke(COLORS.pale, COLORS.line);
      try {
        doc.image(stored.buffer, left + 10, y + 10, { fit: [230, 170], align: 'center', valign: 'center' });
      } catch {
        doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9).text('Bild konnte nicht eingebettet werden.', left + 18, y + 80, { width: 210 });
      }
      doc.fillColor(COLORS.blue).font('Helvetica-Bold').fontSize(10).text(TMB_PHOTO_LABELS[assignment.category] || TMB_PHOTO_LABELS.sonstiges, left + 260, y + 18, { width: contentWidth - 278 });
      doc.fillColor(COLORS.ink).font('Helvetica').fontSize(9).text(clean(assignment.note, 'Keine Zusatznotiz'), left + 260, y + 42, { width: contentWidth - 278, lineGap: 2 });
      doc.fillColor(COLORS.muted).fontSize(7.8).text(clean(stored.meta?.name), left + 260, y + 185, { width: contentWidth - 278 });
      doc.y = y + 234;
    }
  }

  const pageRange = doc.bufferedPageRange();
  for (let pageIndex = pageRange.start; pageIndex < pageRange.start + pageRange.count; pageIndex += 1) {
    doc.switchToPage(pageIndex);
    const footerY = doc.page.height - 34;
    const originalBottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.moveTo(left, footerY - 8).lineTo(left + contentWidth, footerY - 8).lineWidth(0.6).stroke(COLORS.line);
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7.5)
      .text('IVA Energieplaner - Technische Machbarkeitsbewertung', left, footerY, { width: contentWidth / 1.5, lineBreak: false })
      .text(`Seite ${pageIndex + 1} von ${pageRange.count}`, left + contentWidth - 100, footerY, { width: 100, align: 'right', lineBreak: false });
    doc.page.margins.bottom = originalBottomMargin;
  }

  doc.end();
  return finished;
}
