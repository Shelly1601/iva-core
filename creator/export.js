import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { checkCreatorOriginality, words } from './sources.js';

const FORMAT = { pdf: ['application/pdf', 'pdf'], md: ['text/markdown; charset=utf-8', 'md'], zip: ['application/zip', 'zip'] };
const TYPES = { course: 'Kurs', book: 'Buch', workbook: 'Workbook', checklist: 'Checkliste', 'sales-guide': 'Verkaufsleitfaden' };
const FONTS = { regular: fileURLToPath(new URL('./assets/LiberationSans-Regular.ttf', import.meta.url)), bold: fileURLToPath(new URL('./assets/LiberationSans-Bold.ttf', import.meta.url)) };
const error = (message, code = 'CREATOR_EXPORT_INVALID') => Object.assign(new Error(message), { code, status: 422 });
const hash = value => createHash('sha256').update(value).digest('hex');
const slug = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72).toLowerCase() || 'produkt';
const text = (value, label, max = 2000, optional = false) => {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw error(`${label} fehlt, ist zu lang oder enthält ungültige Steuerzeichen.`);
  return value.replace(/\r\n?/g, '\n').normalize('NFC').trim();
};
const identifier = (value, label) => { const result = text(value, label, 180); if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result)) throw error(`${label} ist ungültig.`); return result; };
function safeUrl(value) {
  if (!value) return '';
  if (typeof value !== 'string' || /[\s\0-\x1f<>"\\]/.test(value)) throw error('Eine Exportquelle enthält einen ungültigen Link.');
  let url; try { url = new URL(value); } catch { throw error('Ein Exportlink ist ungültig.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw error('Ein Exportlink verwendet ein unzulässiges Ziel oder eingebettete Zugangsdaten.');
  return url.toString();
}
function markdown(value, label, max = 100000) {
  const content = text(value, label, max);
  // Exported Markdown may be opened by HTML-capable readers. Preserve raw tags
  // as visible text and reject executable/local URL targets, including references.
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)|^\s*\[[^\]]+\]:\s*(\S+)/gm)) safeUrl(match[1] || match[2]);
  if (/\]\(\s*(?:javascript|data|file|vbscript)\s*:/i.test(content) || /<\s*(?:javascript|data|file|vbscript):/i.test(content)) throw error('Der Inhalt enthält einen nicht exportierbaren Link.');
  return content.replace(/<([^>]+)>/g, (_whole, inside) => /^https?:\/\//i.test(inside) ? `[${safeUrl(inside)}](${safeUrl(inside)})` : `&lt;${inside}&gt;`);
}
function list(values, label, max = 100) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > max) throw error(`${label} ist keine vollständige zulässige Liste.`);
  return values;
}
function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw error('Der Versionszeitpunkt fehlt.');
  const date = new Date(value);
  const day = new Date(value.slice(0, 10) + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) throw error('Der Versionszeitpunkt ist ungültig.');
  return date.toISOString();
}

export function prepareCreatorExport({ product, version, format = 'pdf' } = {}) {
  if (!FORMAT[format]) throw error('Exportformat muss pdf, md oder zip sein.');
  if (product?.status !== 'ready' || version?.stage !== 'complete') throw error('Nur vollständig erstellte und fertige Versionen können exportiert werden.', 'CREATOR_EXPORT_NOT_READY');
  if (!TYPES[product.type]) throw error('Dieser Produkttyp wird noch nicht exportiert.');
  const safeProduct = { id: identifier(product.id, 'Produkt-ID'), projectId: identifier(product.projectId, 'Projekt-ID'), type: product.type, title: text(product.title, 'Produkttitel', 300), audience: product.audience ? markdown(product.audience, 'Zielgruppe', 8000) : '', status: 'ready' };
  const safeVersion = { id: identifier(version.id, 'Versions-ID'), createdAt: isoDate(version.createdAt), stage: 'complete', title: text(version.title || product.title, 'Versionstitel', 300) };
  // Briefs are private authoring instructions, not publishable reader copy.
  // Only the generated, versioned product concept supplies the introduction.
  const introduction = { positioning: version.plan?.positioning ? markdown(version.plan.positioning, 'Positionierung', 3000) : '', promise: version.plan?.promise ? markdown(version.plan.promise, 'Nutzen', 2000) : '', approach: version.plan?.approach ? markdown(version.plan.approach, 'Vorgehen', 4000) : '', learningObjectives: list(version.plan?.learningObjectives, 'Lernziele', 12).map(value => markdown(value, 'Lernziel', 1200)) };
  if (version.productSnapshot && (version.productSnapshot.id !== product.id || version.productSnapshot.projectId !== product.projectId)) throw error('Produkt und unveränderliche Version gehören nicht zusammen.');
  const outline = list(version.outline, 'Gliederung', 200).map(row => ({ id: text(row?.id, 'Gliederungs-ID', 180), title: text(row.title, 'Gliederungstitel', 300), objective: row.objective ? markdown(row.objective, 'Lernziel', 4000) : '' }));
  const rawUnits = list(version.units, 'Einheiten', 200);
  if (!outline.length || rawUnits.length !== outline.length || new Set(outline.map(row => row.id)).size !== outline.length || new Set(rawUnits.map(row => row?.id)).size !== rawUnits.length) throw error('Die vollständige Gliederung und genau eine Einheit je Eintrag sind erforderlich.', 'CREATOR_EXPORT_INCOMPLETE');
  const units = outline.map((entry, index) => {
    const unit = rawUnits.find(row => row?.id === entry.id);
    if (!unit) throw error('Eine Gliederungseinheit fehlt im fertigen Produkt.', 'CREATOR_EXPORT_INCOMPLETE');
    return { id: entry.id, number: index + 1, title: text(unit.title, 'Einheitstitel', 300), objective: entry.objective,
      content: markdown(unit.content, `Inhalt ${index + 1}`), examples: list(unit.examples, 'Beispiele').map(value => markdown(value, 'Beispiel', 20000)), exercises: list(unit.exercises, 'Übungen').map(value => markdown(value, 'Übung', 20000)),
      sourceIds: [...new Set(list(unit.sourceIds, 'Quellen-IDs', 1000).map(value => text(value, 'Quellen-ID', 180)))], exactSnippetIds: [...new Set(list(unit.exactSnippetIds, 'Textauszug-IDs', 1000).map(value => text(value, 'Textauszug-ID', 180)))] };
  });
  const sources = list(version.sourceSnapshots, 'Quellennachweise', 1000).map(source => {
    const digest = text(source?.sha256, 'Quellen-Prüfsumme', 64);
    if (!/^[a-f0-9]{64}$/i.test(digest)) throw error('Eine Quellen-Prüfsumme ist ungültig.');
    if (typeof source.content !== 'string' || source.content.length > 100000 || hash(source.content) !== digest.toLowerCase()) throw error('Eine eingefrorene Quelle stimmt nicht mit ihrer Prüfsumme überein.');
    return { id: identifier(source.id, 'Quellen-ID'), type: text(source.type, 'Quellenart', 80), originalId: text(source.originalId, 'Original-ID', 300, true), title: text(source.title, 'Quellentitel', 1000), url: safeUrl(source.url), sha256: digest.toLowerCase(), importedAt: source.importedAt ? isoDate(source.importedAt) : null,
      attribution: markdown(source.attribution || source.rights?.attribution || source.title, 'Quellenangabe', 4000), rightsStatus: text(source.rights?.status || 'unconfirmed', 'Rechtestatus', 100),
      rights: { usage: text(source.rights?.usage || 'research', 'Quellennutzung', 50), status: text(source.rights?.status || 'unconfirmed', 'Rechtestatus', 100), rightsConfirmed: source.rights?.rightsConfirmed === true, rightsBasis: text(source.rights?.rightsBasis, 'Quellen-Rechtegrundlage', 4000, true), usageNote: text(source.rights?.usageNote, 'Nutzungshinweis', 2000, true) }, contentIncluded: false };
  });
  if (new Set(sources.map(row => row.id)).size !== sources.length) throw error('Quellen-IDs sind nicht eindeutig.');
  const snippets = list(version.exactSnippets, 'Freigegebene Textauszüge', 30).map(snippet => ({ id: text(snippet.id, 'Textauszug-ID', 180), sourceId: text(snippet.sourceId, 'Textauszug-Quelle', 180), sourceSha256: text(snippet.sourceSha256, 'Textauszug-Quellenversion', 64), text: markdown(snippet.text, 'Textauszug', 1600), locator: text(snippet.locator, 'Fundstelle', 2000), usage: text(snippet.usage, 'Nutzungsart', 50), rightsConfirmed: snippet.rightsConfirmed === true, rightsBasis: text(snippet.rightsBasis, 'Rechtegrundlage', 4000, true), attribution: markdown(snippet.attribution, 'Textauszug-Quellenangabe', 4000) }));
  if (new Set(snippets.map(row => row.id)).size !== snippets.length) throw error('Textauszug-IDs sind nicht eindeutig.');
  const usedSnippets = new Set(units.flatMap(unit => unit.exactSnippetIds));
  if (snippets.some(snippet => !usedSnippets.has(snippet.id))) throw error('Ein ausgewählter Textauszug fehlt in der fertigen Fassung.', 'CREATOR_EXPORT_INCOMPLETE');
  for (const snippet of snippets) {
    const source = sources.find(source => source.id === snippet.sourceId);
    if (!source || snippet.sourceSha256 !== source.sha256) throw error('Ein Textauszug hat keinen passenden unveränderlichen Quellennachweis.');
    if (!usedSnippets.has(snippet.id)) continue;
    if (!['own', 'licensed', 'quotation'].includes(snippet.usage) || (snippet.usage !== 'quotation' && (!snippet.rightsConfirmed || snippet.rightsBasis.length < 10))) throw error('Ein verwendeter Originalauszug hat keine dokumentierte Nutzungsfreigabe.', 'CREATOR_EXPORT_RIGHTS_REQUIRED');
    const original = version.exactSnippets.find(row => row.id === snippet.id), originalSource = version.sourceSnapshots.find(row => row.id === snippet.sourceId);
    if (!words(original.text).length || words(original.text).length > 160 || !originalSource.content?.includes(original.text)) throw error('Ein Textauszug ist nicht unverändert in der eingefrorenen Quelle belegt.');
  }
  for (const unit of units) {
    if (unit.sourceIds.some(id => !sources.some(source => source.id === id)) || unit.exactSnippetIds.some(id => !snippets.some(snippet => snippet.id === id))) throw error('Einheit verweist auf einen fehlenden Quellennachweis.');
  }
  if (JSON.stringify(units).length > 2_000_000) throw error('Das Produkt überschreitet die sichere Exportgröße.');
  // Recheck the same content already approved by the engine. In particular this
  // counts every quote occurrence per original URL/document, including exercises.
  // A missing attributed block is rejected; exports never invent/add content.
  checkCreatorOriginality(rawUnits, version.sourceSnapshots || [], version.exactSnippets || []);
  checkCreatorOriginality(units, version.sourceSnapshots || [], snippets);
  const manifest = { schemaVersion: 1, exportKind: 'iva-creator-product', product: safeProduct, version: safeVersion, sourceContentsIncluded: false, sources,
    units: units.map(unit => ({ id: unit.id, number: unit.number, title: unit.title, sha256: hash(unit.content), sourceIds: unit.sourceIds, exactSnippetIds: unit.exactSnippetIds, examples: unit.examples.length, exercises: unit.exercises.length })),
    exactSnippets: snippets.filter(snippet => usedSnippets.has(snippet.id)).map(({ text: content, ...metadata }) => ({ ...metadata, sha256: hash(content), textIncludedInUnit: true })),
    conventions: { sourceHash: 'SHA-256 der eingefrorenen Originalquelle; deren Volltext wird nicht mitgeliefert.', unitHash: 'SHA-256 des als Markdown exportierten Einheitentextes.', font: 'Liberation Sans, SIL Open Font License 1.1' } };
  return { product: safeProduct, version: safeVersion, introduction, outline, units, sources, snippets: snippets.filter(snippet => usedSnippets.has(snippet.id)), manifest, format, stem: `${slug(safeProduct.title)}-v-${slug(safeVersion.id).slice(0, 36)}` };
}

const headingText = value => value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_{}\[\]<>])/g, '\\$1');
function unitMarkdown(unit, data) {
  const rows = [`# ${unit.number}. ${headingText(unit.title)}`, unit.objective ? `**Ziel:** ${unit.objective}` : '', unit.content];
  if (unit.examples.length) rows.push('## Beispiele', ...unit.examples.map((value, index) => `### Beispiel ${index + 1}\n\n${value}`));
  if (unit.exercises.length) rows.push('## Übungen', ...unit.exercises.map((value, index) => `### Übung ${index + 1}\n\n${value}\n\nNotizen / Antwort:\n\n______________________________\n\n______________________________`));
  const selected = data.sources.filter(source => unit.sourceIds.includes(source.id));
  if (selected.length) rows.push('## Quellen zu dieser Einheit', ...selected.map(source => `- ${source.attribution}${source.url ? ` - <${source.url}>` : ''} [${source.id}]`));
  return rows.filter(Boolean).join('\n\n') + '\n';
}
function sourceMarkdown(data) {
  if (!data.sources.length) return '# Entstehungsnachweis\n\nKeine externen Quellen für diese Fassung hinterlegt.\n';
  return ['# Quellen und Entstehungsnachweis', 'Originaltexte der Wissensbasis werden nicht mit diesem Produkt exportiert.', ...data.sources.map(source => `## ${headingText(source.title)}\n\n${source.attribution}${source.url ? `\n\n${source.url}` : ''}\n\nQuellen-ID: ${source.id}\n\nSHA-256: ${source.sha256}\n\nDokumentierter Rechtestatus: ${headingText(source.rightsStatus)}`)].join('\n\n') + '\n';
}
function fullMarkdown(data) {
  const intro = data.introduction;
  return [`# ${headingText(data.product.title)}`, `${TYPES[data.product.type]} | Version ${data.version.id} | ${data.version.createdAt.slice(0, 10)}`, data.product.audience ? `**Für wen:** ${data.product.audience}` : '', intro.positioning, intro.promise ? `## Ihr Ergebnis\n\n${intro.promise}` : '', intro.approach ? `## So gehen Sie vor\n\n${intro.approach}` : '', intro.learningObjectives.length ? `## Das lernen Sie\n\n${intro.learningObjectives.map(value => `- ${value}`).join('\n')}` : '', '## Inhalt', ...data.units.map(unit => `${unit.number}. ${headingText(unit.title)}`), ...data.units.map(unit => unitMarkdown(unit, data)), sourceMarkdown(data)].filter(Boolean).join('\n\n') + '\n';
}
function workbookMarkdown(data) {
  const units = data.units.filter(unit => unit.exercises.length);
  if (!units.length) return null;
  return [`# Workbook: ${headingText(data.product.title)}`, `Version ${data.version.id} | ${data.version.createdAt.slice(0, 10)}`, ...units.flatMap(unit => [`## ${unit.number}. ${headingText(unit.title)}`, ...unit.exercises.map((value, index) => `### Übung ${index + 1}\n\n${value}\n\nMeine Antwort / nächste Schritte:\n\n______________________________\n\n______________________________\n\n______________________________`)])].join('\n\n') + '\n';
}
const plain = value => value.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, 'Bildverweis: $1 ($2)').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[\u2010-\u2015]/g, '-').replace(/\u00a0/g, ' ');

async function pdf(data, { workbook = false } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [], doc = new PDFDocument({ size: 'A4', margins: { top: 84, bottom: 70, left: 60, right: 60 }, bufferPages: true, autoFirstPage: false, compress: true, info: { Title: workbook ? `Workbook: ${data.product.title}` : data.product.title, Author: 'IVA Creator', Subject: `${TYPES[data.product.type]} - Version ${data.version.id}`, CreationDate: new Date(data.version.createdAt), ModDate: new Date(data.version.createdAt) } });
    doc.on('data', chunk => chunks.push(chunk)); doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('Body', FONTS.regular); doc.registerFont('Strong', FONTS.bold); doc.font('Body');
      const fonts = [doc._font.font]; doc.font('Strong'); fonts.push(doc._font.font); doc.font('Body');
      const ink = '#162C38', muted = '#566D76', teal = '#0D7F79', pale = '#EDF7F5', width = 475.28;
      const checkGlyphs = value => {
        for (const character of new Set(plain(value))) if (!/[\n\r\t]/.test(character) && fonts.some(font => !font.hasGlyphForCodePoint(character.codePointAt(0)))) throw error(`Das Zeichen „${character}“ kann mit der Exportschrift nicht verlässlich dargestellt werden. Bitte im Inhalt ausschreiben.`, 'CREATOR_EXPORT_UNSUPPORTED_GLYPH');
      };
      checkGlyphs(fullMarkdown(data));
      const fitLabel = (value, maxWidth) => { let result = plain(value).replace(/\n/g, ' '); while (result.length && doc.widthOfString(result) > maxWidth) result = result.slice(0, -1); return result === plain(value).replace(/\n/g, ' ') ? result : result.slice(0, -3) + '...'; };
      let currentLabel = 'Überblick';
      const header = () => {
        const activeFont = doc._font, activeSize = doc._fontSize, activeColor = doc._fillColor;
        doc.save().strokeColor('#D6E3E5').lineWidth(0.6).moveTo(60, 58).lineTo(535, 58).stroke();
        doc.font('Strong').fontSize(8).fillColor(teal).text('IVA CREATOR', 60, 38, { width: 120, lineBreak: false });
        doc.font('Body').fontSize(8).fillColor(muted).text(fitLabel(currentLabel, 335), 200, 38, { width: 335, align: 'right', lineBreak: false });
        doc.restore(); doc._font = activeFont; doc.fontSize(activeSize);
        if (activeColor) doc.fillColor(...activeColor);
        doc.x = 60; doc.y = 84;
      };
      doc.on('pageAdded', header);
      const ensure = height => { if (doc.y + height > 770) doc.addPage(); };
      const paragraph = (value, { size = 10.7, color = ink, bold = false, indent = 0, after = 9 } = {}) => {
        const content = plain(value); doc.font(bold ? 'Strong' : 'Body').fontSize(size).fillColor(color);
        doc.text(content, 60 + indent, doc.y, { width: width - indent, lineGap: 3.1, paragraphGap: 0 }); doc.y += after;
      };
      const heading = (value, level = 2) => { const size = level === 1 ? 25 : level === 2 ? 16 : 12; doc.font('Strong').fontSize(size); ensure(Math.min(650, doc.heightOfString(plain(value), { width, lineGap: 3.1 }) + 40)); paragraph(value, { size, color: level === 1 ? ink : teal, bold: true, after: 11 }); };
      const content = value => {
        let buffer = [], code = false;
        const flush = () => { if (buffer.length) { paragraph(buffer.join(code ? '\n' : ' '), { size: code ? 9.2 : 10.7, color: code ? muted : ink, indent: code ? 10 : 0 }); buffer = []; } };
        for (const line of value.split('\n')) {
          if (/^\s*```/.test(line)) { flush(); code = !code; continue; }
          if (code) { buffer.push(line); continue; }
          if (!line.trim()) { flush(); continue; }
          const title = /^(#{1,6})\s+(.+)/.exec(line), bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)/.exec(line);
          if (title) { flush(); heading(title[2], Math.min(3, title[1].length + 1)); }
          else if (bullet) { flush(); ensure(34); paragraph('- ' + bullet[1], { indent: 10, after: 6 }); }
          else if (/^>\s?/.test(line)) { flush(); paragraph(line.replace(/^>\s?/, ''), { color: muted, indent: 14 }); }
          else if (/^\s*[-*_]{3,}\s*$/.test(line)) { flush(); ensure(20); doc.strokeColor('#D6E3E5').moveTo(60, doc.y).lineTo(535, doc.y).stroke(); doc.y += 16; }
          else buffer.push(line);
        }
        flush();
      };
      doc.addPage();
      doc.save().rect(0, 0, 595.28, 841.89).fill('#F7FAF9').restore();
      doc.font('Strong').fontSize(10).fillColor(teal).text(workbook ? 'ARBEITSBUCH' : TYPES[data.product.type].toUpperCase(), 72, 84, { characterSpacing: 1.3 });
      const coverTitle = workbook ? `Workbook\n${data.product.title}` : data.product.title;
      let size = 34; while (size > 22 && doc.font('Strong').fontSize(size).heightOfString(coverTitle, { width: 440 }) > 300) size -= 2;
      doc.save().rect(48, 157, 4, 190).fill(teal).restore();
      doc.font('Strong').fontSize(size).fillColor(ink).text(coverTitle, 72, 154, { width: 440, lineGap: 4 });
      const metadataY = Math.max(400, doc.y + 36);
      doc.font('Body').fontSize(11).fillColor(muted).text(`${data.units.length} ${data.product.type === 'course' ? 'Lektionen' : 'Kapitel'}  /  ${data.sources.length} Quellennachweise`, 72, metadataY, { width: 440 });
      doc.fontSize(9).text(`Fassung vom ${data.version.createdAt.slice(0, 10)}\nVersion ${data.version.id}`, 72, doc.y + 18, { width: 440, lineGap: 5 });
      doc.font('Strong').fontSize(10).fillColor(teal).text('Wissen verstehen. In die Praxis übertragen.', 72, 710, { width: 440 });
      const selected = workbook ? data.units.filter(unit => unit.exercises.length) : data.units;
      const toc = []; let tocEntries = [], tocY = 139;
      doc.font('Body').fontSize(11);
      for (const unit of selected) {
        const height = doc.heightOfString(`${unit.number}. ${plain(unit.title)}`, { width: 415, lineGap: 3 }) + 15;
        if (tocY + height > 745 && tocEntries.length) { toc.push(tocEntries); tocEntries = []; tocY = 139; }
        tocEntries.push({ unit, y: tocY, height }); tocY += height;
      }
      if (tocEntries.length) toc.push(tocEntries);
      currentLabel = 'Inhalt';
      const tocIndices = toc.map(() => { doc.addPage(); return doc.bufferedPageRange().count - 1; });
      if (!workbook && (data.product.audience || Object.values(data.introduction).some(value => value.length))) {
        currentLabel = 'Orientierung'; doc.addPage(); heading('So nutzen Sie dieses Produkt', 1);
        if (data.product.audience) { heading('Für wen es gedacht ist'); content(data.product.audience); }
        if (data.introduction.positioning) content(data.introduction.positioning);
        if (data.introduction.promise) { heading('Ihr Ergebnis'); content(data.introduction.promise); }
        if (data.introduction.approach) { heading('So gehen Sie vor'); content(data.introduction.approach); }
        if (data.introduction.learningObjectives.length) { heading('Das lernen Sie'); data.introduction.learningObjectives.forEach(value => content(`- ${value}`)); }
      }
      const unitPages = new Map();
      for (const unit of selected) {
        currentLabel = unit.title; doc.addPage(); unitPages.set(unit.id, doc.bufferedPageRange().count);
        doc.font('Strong').fontSize(9).fillColor(teal).text(`${data.product.type === 'course' ? 'LEKTION' : 'KAPITEL'} ${String(unit.number).padStart(2, '0')}`, 60, doc.y, { characterSpacing: 1.2 }); doc.y += 18;
        heading(unit.title, 1);
        if (unit.objective) { paragraph('ZIEL', { size: 8.5, color: teal, bold: true, after: 5 }); paragraph(unit.objective, { color: muted, after: 20 }); }
        if (!workbook && unit.sourceIds.length) paragraph(`Quellen zu dieser Einheit: ${unit.sourceIds.map(id => `[${id}]`).join(', ')}`, { size: 8.5, color: muted, after: 12 });
        if (!workbook) content(unit.content);
        if (!workbook && unit.examples.length) { heading('Beispiele'); unit.examples.forEach((example, index) => { heading(`Beispiel ${index + 1}`, 3); content(example); }); }
        if (unit.exercises.length) {
          unit.exercises.forEach((exercise, index) => {
            const answerHeight = workbook ? 124 : 85;
            doc.font('Body').fontSize(10.7);
            const questionHeight = doc.heightOfString(plain(exercise), { width, lineGap: 3.1 }) + 45;
            // Reserve the first exercise before printing its section heading.
            // A multi-page exercise keeps a meaningful opening on this page.
            const exerciseStart = questionHeight + answerHeight < 640 ? questionHeight + answerHeight : 160;
            if (index === 0) {
              doc.font('Strong').fontSize(16);
              const sectionHeight = doc.heightOfString('Übungen und Umsetzung', { width, lineGap: 3.1 }) + 11;
              ensure(sectionHeight + exerciseStart);
              heading('Übungen und Umsetzung');
            } else ensure(exerciseStart);
            heading(`Übung ${index + 1}`, 3); content(exercise); ensure(answerHeight);
            paragraph('Meine Antwort / nächste Schritte', { size: 9, color: muted });
            for (let line = 0; line < (workbook ? 3 : 2); line++) { doc.strokeColor('#CCDADD').lineWidth(0.6).moveTo(60, doc.y + 12).lineTo(535, doc.y + 12).stroke(); doc.y += workbook ? 28 : 24; }
            doc.y += 12;
          });
        }
      }
      if (!workbook && data.sources.length) {
        currentLabel = 'Quellen und Nachweise'; doc.addPage(); heading('Quellen und Entstehungsnachweis', 1);
        paragraph('Die Originaltexte der Wissensbasis sind nicht Bestandteil dieses Exports. Verwendete Fassungen sind anhand ihrer Prüfsummen nachvollziehbar.', { color: muted });
        for (const source of data.sources) {
          heading(source.title, 3); paragraph(source.attribution, { size: 9.5 });
          if (source.url) { doc.font('Body').fontSize(9).fillColor(teal).text(source.url, 60, doc.y, { width, link: source.url, underline: true, lineGap: 2 }); doc.y += 9; }
          paragraph(`ID: ${source.id}\nSHA-256: ${source.sha256}\nRechtestatus: ${source.rightsStatus}`, { size: 8.3, color: muted, after: 18 });
        }
      }
      toc.forEach((entries, index) => {
        doc.switchToPage(tocIndices[index]); doc.y = 84; heading(index ? 'Inhalt - Fortsetzung' : 'Inhalt', 1);
        for (const entry of entries) {
          doc.font('Body').fontSize(11).fillColor(ink).text(`${entry.unit.number}. ${plain(entry.unit.title)}`, 60, entry.y, { width: 415, lineGap: 3 });
          doc.font('Strong').fillColor(teal).text(String(unitPages.get(entry.unit.id)), 490, entry.y, { width: 45, align: 'right', lineBreak: false });
          doc.strokeColor('#E0E9E9').lineWidth(0.5).moveTo(60, entry.y + entry.height - 9).lineTo(535, entry.y + entry.height - 9).stroke();
        }
      });
      const pageCount = doc.bufferedPageRange().count;
      for (let page = 0; page < pageCount; page++) {
        doc.switchToPage(page); const bottom = doc.page.margins.bottom; doc.page.margins.bottom = 0;
        doc.strokeColor('#D6E3E5').lineWidth(0.6).moveTo(60, 789).lineTo(535, 789).stroke();
        doc.font('Body').fontSize(8).fillColor(muted).text(fitLabel(`${workbook ? 'Workbook / ' : ''}${data.product.title}`, 410), 60, 802, { width: 410, lineBreak: false });
        doc.text(`${page + 1} / ${pageCount}`, 483, 802, { width: 52, align: 'right', lineBreak: false }); doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (cause) { doc.destroy(); reject(cause); }
  });
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1; return value >>> 0; });
function crc32(buffer) { let crc = 0xFFFFFFFF; for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [filename, value] of files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(filename) || filename.split('/').some(part => !part || part === '.' || part === '..') || filename.startsWith('/')) throw error('Unsicherer Dateiname im Exportpaket.');
    const name = Buffer.from(filename), content = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'), compressed = deflateRawSync(content), crc = crc32(content);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034B50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(content.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014B50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const index = Buffer.concat(central), footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054B50); footer.writeUInt16LE(files.length, 8); footer.writeUInt16LE(files.length, 10); footer.writeUInt32LE(index.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, footer]);
}

export async function exportCreatorProduct(input) {
  const data = prepareCreatorExport(input), [contentType, extension] = FORMAT[data.format];
  let buffer;
  if (data.format === 'md') buffer = Buffer.from(fullMarkdown(data), 'utf8');
  else if (data.format === 'pdf') buffer = await pdf(data);
  else {
    const files = [['produkt.pdf', await pdf(data)], ['produkt.md', fullMarkdown(data)], ['quellen.md', sourceMarkdown(data)]];
    for (const unit of data.units) files.push([`${data.product.type === 'course' ? 'lektionen' : 'kapitel'}/${String(unit.number).padStart(3, '0')}-${slug(unit.title)}.md`, unitMarkdown(unit, data)]);
    const workbook = workbookMarkdown(data);
    if (workbook) files.push(['workbook.md', workbook], ['workbook.pdf', await pdf(data, { workbook: true })]);
    const manifest = { ...data.manifest, files: files.map(([name, content]) => ({ name, sha256: hash(content), bytes: Buffer.byteLength(content) })) };
    files.push(['manifest.json', JSON.stringify(manifest, null, 2) + '\n']);
    files.push(['README.md', `# ${headingText(data.product.title)}\n\nFertige Version: ${data.version.id}\nErstellt: ${data.version.createdAt}\n\n## Dateien\n\n- produkt.pdf: vollständiges lesbares Produkt mit Inhaltsverzeichnis und Quellen.\n- produkt.md: bearbeitbare vollständige Markdown-Fassung.\n- ${data.product.type === 'course' ? 'lektionen' : 'kapitel'}/: einzelne Einheiten als Markdown.\n${workbook ? '- workbook.pdf und workbook.md: Übungen mit Raum für Antworten.\n' : ''}- quellen.md: Quellenangaben ohne Originalvolltexte.\n- manifest.json: eingefrorene Versions-, Quellen- und Datei-Prüfsummen.\n\nDer Export veröffentlicht nichts und lädt keine externen Inhalte nach. Quellenrechte sind dokumentierte Eingaben, keine zusätzliche Rechtegarantie. Rohtexte der Wissensbasis sind nicht enthalten.\n`]);
    buffer = zip(files);
  }
  return { buffer, contentType, filename: `${data.stem}.${extension}` };
}
