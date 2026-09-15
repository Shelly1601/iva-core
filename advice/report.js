import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { calculateFinancialPlan, FINANCIAL_PLAN_FIELDS } from '../public/advice-finance.js';
import { adviceError, evaluateInsuranceCase } from './comparison.js';
import { ADVICE_PROVIDER_SOURCES } from './providers.js';

const money = value => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(value);
const decimal = value => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 }).format(value);
const safeText = value => String(value ?? '').replace(/[\u2010-\u2015]/g, '-').replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 12000);
const filename = value => String(value || 'beratung').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 70).toLowerCase();

export async function exportAdviceCasePdf(record) {
  const finance = record.kind === 'finance', result = finance ? calculateFinancialPlan(record.financeInput) : evaluateInsuranceCase(record);
  if (finance && result.status !== 'scenario') throw adviceError('Die Finanzplanung ist für einen PDF-Export noch unvollständig.');
  const chunks = [], doc = new PDFDocument({ size: 'A4', margins: { top: 76, bottom: 65, left: 54, right: 54 }, bufferPages: true, autoFirstPage: false, info: { Title: safeText(record.title), Author: 'IVA Beratung' } });
  const promise = new Promise((resolve, reject) => { doc.on('data', chunk => chunks.push(chunk)); doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks))); });
  try {
    doc.registerFont('Regular', fileURLToPath(new URL('../creator/assets/LiberationSans-Regular.ttf', import.meta.url)));
    doc.registerFont('Bold', fileURLToPath(new URL('../creator/assets/LiberationSans-Bold.ttf', import.meta.url)));
    doc.font('Regular'); const font = doc._font.font, width = 487.28, ink = '#163440', teal = '#087E7A', muted = '#526C76';
    const text = value => { const clean = safeText(value); for (const char of clean) if (!/[\n\r\t]/.test(char) && !font.hasGlyphForCodePoint(char.codePointAt(0))) throw adviceError('Ein Zeichen im Bericht ist mit der PDF-Schrift nicht darstellbar. Bitte dieses Zeichen ausschreiben.'); return clean; };
    const fit = (value, maxWidth) => { let line = text(value).replace(/\n/g, ' '); while (doc.widthOfString(line) > maxWidth && line.length) line = line.slice(0, -1); return line; };
    doc.on('pageAdded', () => {
      const currentFont = doc._font, size = doc._fontSize, color = doc._fillColor;
      doc.font('Bold').fontSize(9).fillColor(teal).text('IVA  /  BERATUNG', 54, 35, { lineBreak: false });
      doc.font('Regular').fontSize(8).fillColor(muted).text(fit(record.customer?.name || record.customerId, 290), 240, 35, { width: 301, align: 'right', lineBreak: false });
      doc.strokeColor('#D7E3E6').lineWidth(0.6).moveTo(54, 54).lineTo(541, 54).stroke(); doc._font = currentFont; doc.fontSize(size); if (color) doc.fillColor(...color); doc.x = 54; doc.y = 76;
    });
    const ensure = height => { if (doc.y + height > 767) doc.addPage(); };
    const paragraph = (value, { size = 10.4, bold = false, color = ink, after = 9 } = {}) => { doc.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor(color); doc.text(text(value), 54, doc.y, { width, lineGap: 3 }); doc.y += after; };
    const heading = (value, level = 2) => { const size = level === 1 ? 26 : 16; doc.font('Bold').fontSize(size); ensure(doc.heightOfString(text(value), { width, lineGap: 3 }) + 55); paragraph(value, { size, bold: true, color: level === 1 ? ink : teal, after: 14 }); };
    const row = (left, right) => { doc.font('Regular').fontSize(10); const height = Math.max(doc.heightOfString(text(left), { width: 300 }), doc.heightOfString(text(right), { width: 155 })) + 17; ensure(height); const y = doc.y; doc.fillColor(ink).text(text(left), 54, y, { width: 300 }); doc.font('Bold').text(text(right), 370, y, { width: 171, align: 'right' }); doc.strokeColor('#E3EBED').moveTo(54, y + height - 7).lineTo(541, y + height - 7).stroke(); doc.y = y + height; };
    const newPage = title => { doc.addPage(); heading(title, 1); };
    newPage(record.title);
    paragraph(`${finance ? 'Finanzplanung - Modellrechnung' : 'Versicherungsvergleich - Dokumentenprüfung'}  |  Stand ${new Date().toLocaleDateString('de-DE')}  |  Fassung ${record.revision}`, { size: 9, color: muted });
    if (finance) {
      const s = result.summary;
      row('Kapital nach der Ansparzeit', money(s.accumulationCapital)); row('Kapital am Ende der Planung', money(s.finalCapital)); row('Davon in heutiger Kaufkraft', money(s.finalRealCapital)); row('Einzahlungen / Entnahmen gesamt', `${money(s.paidIn)} / ${money(s.paidOut)}`);
      doc.y += 18; heading('Kapital im Zeitverlauf'); ensure(260);
      const x = 62, y = doc.y + 8, chartWidth = 463, chartHeight = 156, max = Math.max(1, ...result.points.map(point => point.balance));
      const plotY = y + 22;
      for (let line = 0; line <= 4; line++) { const yy = plotY + line * chartHeight / 4; doc.strokeColor('#E2EAEB').lineWidth(0.5).moveTo(x, yy).lineTo(x + chartWidth, yy).stroke(); }
      const plot = (key, color) => { doc.strokeColor(color).lineWidth(2); result.points.forEach((point, index) => { const xx = x + point.month / Math.max(1, s.months) * chartWidth, yy = plotY + chartHeight * (1 - point[key] / Math.max(max, ...result.points.map(p => p.realBalance))); if (!index) doc.moveTo(xx, yy); else doc.lineTo(xx, yy); }); doc.stroke(); };
      // Both lines use the same scale, including deflation scenarios.
      const chartMax = Math.max(max, ...result.points.map(point => point.realBalance));
      doc.font('Regular').fontSize(8).fillColor(muted).text(money(chartMax), x, y - 5, { width: 120 });
      plot('balance', teal); plot('realBalance', '#547AC1');
      if (s.months && result.input.savingMonths) { const xx = x + result.input.savingMonths / s.months * chartWidth; doc.strokeColor('#97AEB4').dash(3).moveTo(xx, plotY).lineTo(xx, plotY + chartHeight).stroke().undash(); }
      doc.font('Regular').fontSize(8).fillColor(muted).text('Heute', x, plotY + chartHeight + 8, { width: 100 }).text(`${decimal(s.months / 12)} Jahre`, x + chartWidth - 100, plotY + chartHeight + 8, { width: 100, align: 'right' });
      doc.y = plotY + chartHeight + 36; paragraph('Türkis: nominales Kapital   |   Blau: heutige Kaufkraft\nGestrichelte Linie: Beginn der Entnahmephase', { size: 8.8, color: muted });
      for (const warning of result.warnings) paragraph(warning, { size: 9.5, color: '#81570D' });
      newPage('Einzahlungen, Kosten und Ergebnisse');
      row('Erträge vor Kosten', money(s.investmentReturn)); row('Modellierte Kosten gesamt', money(s.costs)); row('Angenommene Steuer am Phasenwechsel', money(s.tax)); row('Nicht finanzierbare gewünschte Entnahmen', money(s.unmetWithdrawals));
      doc.y += 14; heading('Jährlicher Verlauf');
      for (const point of result.points) row(`Monat ${point.month} - ${point.phase === 'saving' ? 'Ansparen' : point.phase === 'drawdown' ? 'Entnehmen' : 'Start'}`, `${money(point.balance)}  /  ${money(point.realBalance)}`);
      paragraph('Je Zeile: nominaler Kapitalstand / heutige Kaufkraft.', { size: 9, color: muted });
      newPage('Annahmen und Rechenweg');
      for (const [key, label, unit] of FINANCIAL_PLAN_FIELDS) row(label, `${decimal(result.input[key])} ${unit}`);
      heading('So wird gerechnet'); for (const assumption of result.assumptions) paragraph(assumption, { size: 9.5 });
      paragraph(`Rechenversion: ${result.version}`, { size: 8.5, color: muted });
      heading('Fachliche Einordnung'); for (const source of ADVICE_PROVIDER_SOURCES.filter(row => ['inflation', 'costs'].includes(row.id))) { paragraph(source.title, { size: 9, bold: true }); paragraph(source.url, { size: 8, color: muted }); }
    } else {
      paragraph(result.ranking.length ? `${result.ranking.length} aktuell gültige, vollständig dokumentierte Angebote im ausgewählten Vergleich.` : 'Der Vergleich ist noch nicht vollständig. Offene Leistungen und Beiträge werden nicht als bestätigt bewertet.', { color: result.ranking.length ? ink : '#81570D' });
      heading('Nachvollziehbare Reihenfolge');
      for (const offer of result.ranking) { ensure(95); paragraph(`${offer.rank}. ${offer.provider} - ${offer.tariff}`, { bold: true }); row(`${decimal(offer.score)} von 100 Punkten`, `${money(offer.annualGross)} / Jahr`); }
      if (!result.ranking.length) paragraph('Noch kein Angebot erfüllt alle Voraussetzungen für das Ranking.');
      for (const offer of result.offers.filter(row => !row.eligible)) { ensure(90); paragraph(`${offer.provider} - ${offer.tariff}`, { bold: true }); paragraph(offer.reasons.join('\n'), { size: 9.4, color: muted }); }
      heading('Was diese Bewertung bedeutet'); paragraph(result.method, { size: 9.6 }); result.limitations.forEach(note => paragraph(note, { size: 9, color: muted }));
      const compared = [result.oldContract, ...(result.ranking.length ? result.ranking : result.offers).slice(0, 3)].filter(Boolean);
      if (compared.length) {
        newPage('Leistungen nebeneinander');
        paragraph('Altvertrag und bis zu drei Angebote. Die Werte gelten für die ausgewählten Kriterien; offene Nachweise bleiben sichtbar.', {size:9,color:muted});
        const labelWidth=168, cellWidth=(width-labelWidth)/compared.length;
        const tableRow=(label,values,{header=false}={})=>{
          const cells=[label,...values], widths=[labelWidth,...compared.map(()=>cellWidth)];
          doc.font(header?'Bold':'Regular').fontSize(header?8.6:8.3);
          const height=Math.max(...cells.map((value,index)=>doc.heightOfString(text(value),{width:widths[index]-14,lineGap:2})))+18;
          ensure(height);const y=doc.y;let left=54;
          if(header)doc.rect(54,y-5,width,height).fill('#E9F3F2');
          cells.forEach((value,index)=>{doc.font(header?'Bold':'Regular').fontSize(header?8.6:8.3).fillColor(ink).text(text(value),left+5,y,{width:widths[index]-14,lineGap:2});left+=widths[index];});
          doc.strokeColor('#D7E3E6').lineWidth(.5).moveTo(54,y+height-5).lineTo(541,y+height-5).stroke();doc.y=y+height;
        };
        const tableHead=()=>tableRow('Kriterium',compared.map(c=>`${c===result.oldContract?'Altvertrag':c.rank?'Rang '+c.rank:'Noch nicht gereiht'}\n${c.provider}\n${c.tariff}`),{header:true});
        tableHead();tableRow('Jahresgesamtbeitrag',compared.map(c=>c.annualGross===null?'Noch offen':money(c.annualGross)));
        for(const criterion of record.criteria){
          if(doc.y>680){doc.addPage();heading('Leistungsvergleich · Fortsetzung');tableHead();}
          tableRow(criterion.label,compared.map(c=>{const r=c.rows.find(r=>r.id===criterion.id);if(!r||r.score===null)return'Nicht belegt / ungeprüft';return typeof r.value==='boolean'?r.value?'Ja':'Nein':`${decimal(r.value)} ${r.unit||''}`;}));
        }
        paragraph('Die zugehörigen Fundstellen und Gewichte folgen in den Einzelansichten.',{size:8.5,color:muted});
      }
      for (const contract of [result.oldContract, ...result.offers].filter(Boolean)) {
        newPage(`${contract === result.oldContract ? 'Altvertrag' : 'Angebot'}: ${contract.provider}`); paragraph(contract.tariff, { bold: true });
        row('Belegter Jahresgesamtbeitrag', contract.annualGross === null ? 'Noch offen' : money(contract.annualGross));
        row('Abgedecktes Kriteriengewicht', `${decimal(contract.coveragePercent)} %`);
        for (const criterion of contract.rows) { ensure(115); heading(criterion.label); row(`Gewicht: ${criterion.weight}${criterion.mandatory ? ' / Muss-Kriterium' : ''}`, criterion.score === null ? 'Nicht belegt / ungeprüft' : `${decimal(criterion.score)} Punkte`); paragraph(`Angabe: ${criterion.value === null ? 'unbekannt' : typeof criterion.value === 'boolean' ? criterion.value ? 'Ja' : 'Nein' : `${decimal(criterion.value)} ${criterion.unit}`}`, { size: 9.5 }); if (criterion.evidence) paragraph(`Quelle ${criterion.evidence.documentId}, ${criterion.evidence.locator}`, { size: 8, color: muted }); }
      }
      if (record.documents.length) { newPage('Dokumentennachweise'); for (const document of record.documents) { ensure(110); paragraph(document.filename, { bold: true }); paragraph(`Dokument-ID: ${document.id}\nSHA-256: ${document.sha256}\nEingelesen: ${document.addedAt}\nDie Originalunterlage ist in der Beratungsakte hinterlegt.`, { size: 8.5, color: muted }); } }
    }
    const count = doc.bufferedPageRange().count;
    for (let i = 0; i < count; i++) { doc.switchToPage(i); const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0; doc.font('Regular').fontSize(8).fillColor(muted).text('Persönliche Beratungsunterlage - keine Antragseinreichung', 54, 800, { lineBreak: false }).text(`${i + 1} / ${count}`, 486, 800, { width: 55, align: 'right', lineBreak: false }); doc.page.margins.bottom = bottom; }
    doc.end(); return { buffer: await promise, filename: `${filename(record.title)}-beratung.pdf`, contentType: 'application/pdf' };
  } catch (error) { doc.destroy(); throw error; }
}
