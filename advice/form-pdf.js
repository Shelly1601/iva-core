import { PDFDocument, PDFDict, PDFArray, PDFName, PDFRef, StandardFonts } from 'pdf-lib';
import { adviceError } from './comparison.js';

function rejectActiveContent(doc) {
  const seen = new Set(); let count = 0;
  const visit = object => {
    if (!object || seen.has(object)) return; seen.add(object); if (++count > 100000) throw adviceError('PDF-Struktur ist zu komplex.');
    if (object instanceof PDFRef) return visit(doc.context.lookup(object));
    const dict = object instanceof PDFDict ? object : object.dict;
    if (dict instanceof PDFDict) {
      for (const [key, value] of dict.entries()) {
        const name = key.toString();
        if (['/JS', '/JavaScript', '/AA', '/OpenAction', '/XFA', '/EmbeddedFiles', '/RichMedia', '/ByteRange'].includes(name) || (name === '/S' && ['/JavaScript', '/Launch', '/SubmitForm', '/ImportData'].includes(value.toString()))) throw adviceError('Aktive, eingebettete oder bereits signierte PDF-Inhalte können nicht als Formular vorbereitet werden.', 422, 'ADVICE_UNSAFE_PDF');
        visit(value);
      }
    } else if (object instanceof PDFArray) object.asArray().forEach(visit);
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object);
}
export async function inspectAdviceForm(buffer) {
  let doc; try { doc = await PDFDocument.load(buffer, { ignoreEncryption: false }); } catch { throw adviceError('Original-PDF ist nicht lesbar oder geschützt.'); }
  rejectActiveContent(doc);
  return doc.getForm().getFields().map(field => ({ name: field.getName(), type: field.constructor.name, readOnly: field.isReadOnly(), ...(field.getOptions ? { options: field.getOptions() } : {}) }));
}
export async function fillAdviceForm({ buffer, values }) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 100) throw adviceError('Explizite PDF-Feldzuordnung erforderlich.');
  const fields = await inspectAdviceForm(buffer); if (!fields.length) throw adviceError('Diese PDF enthält keine interaktiven Formularfelder.');
  const doc = await PDFDocument.load(buffer), form = doc.getForm(), font = await doc.embedFont(StandardFonts.Helvetica), expected = new Map();
  for (const [name, value] of Object.entries(values)) {
    const spec = fields.find(row => row.name === name); if (!spec || spec.readOnly) throw adviceError(`PDF-Feld ${name.slice(0, 100)} ist nicht vorhanden oder schreibgeschützt.`);
    const field = form.getField(name);
    if (spec.type === 'PDFCheckBox') { if (typeof value !== 'boolean') throw adviceError('Checkbox benötigt true oder false.'); value ? field.check() : field.uncheck(); expected.set(name, value); }
    else if (spec.type === 'PDFTextField') { if (typeof value !== 'string' || value.length > 5000 || /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw adviceError('Ungültiger Text für das PDF-Feld.'); try { font.encodeText(value); field.setText(value); } catch { throw adviceError('Ein Zeichen oder die Textlänge passt nicht zur Original-PDF.'); } expected.set(name, value); }
    else if (['PDFDropdown', 'PDFOptionList', 'PDFRadioGroup'].includes(spec.type)) { if (typeof value !== 'string' || !spec.options.includes(value)) throw adviceError('Wert ist keine zulässige Formularauswahl.'); field.select(value); expected.set(name, value); }
    else throw adviceError('Dieses Feld wird für eine sichere Formularvorbereitung nicht unterstützt.');
  }
  form.updateFieldAppearances(font);
  doc.setSubject('Von IVA vorbereitet. Nicht eingereicht; Originalangaben und Zuordnung vor Verwendung prüfen.');
  const result = Buffer.from(await doc.save()), reopened = await PDFDocument.load(result), actual = reopened.getForm();
  for (const [name, value] of expected) { const field = actual.getField(name), stored = field.getText ? field.getText() : field.isChecked ? field.isChecked() : field.getSelected(); if (Array.isArray(stored) ? stored.length !== 1 || stored[0] !== value : stored !== value) throw adviceError('PDF-Feldwert konnte nicht zuverlässig geprüft werden.', 500); }
  return { buffer: result, filename: 'versicherer-formular-vorbereitet.pdf', contentType: 'application/pdf', submitted: false, fieldCount: expected.size };
}
