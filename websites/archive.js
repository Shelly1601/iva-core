import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const WEBSITE_LIMITS = Object.freeze({ files: 500, fileBytes: 3 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, archiveBytes: 25 * 1024 * 1024, compressionRatio: 250 });

function invalid(message, code = 'INVALID_WEBSITE_FILES') {
  return Object.assign(new Error(message), { code, status: 400, statusCode: 400 });
}

export function validateWebsitePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\x00-\x1f\x7f\\:]/.test(value) || /%(?:2e|2f|5c|00)/i.test(value)) throw invalid('Ungültiger Website-Dateipfad.');
  const name = value.normalize('NFC');
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.length > 100 || /[. ]$/.test(part))) throw invalid('Ungültiger Website-Dateipfad.');
  if (parts.some(part => /^(?:\.git|\.svn|\.hg|\.ssh|\.aws|\.azure|\.codex|node_modules)$/i.test(part) || /^\.env(?:\.|$)/i.test(part))) throw invalid('Zugänge, lokale Konfiguration und Abhängigkeiten dürfen nicht importiert werden.', 'WEBSITE_SECRET_FILE');
  const basename = parts.at(-1);
  if (/\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(basename) || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\.[^.]+)?|service[-_]?account(?:[-_.].*)?\.json)$/i.test(basename)) throw invalid('Schlüssel- und Zugangsdaten gehören nicht in Website-Dateien.', 'WEBSITE_SECRET_FILE');
  return name;
}

function detectSecretMaterial(bytes) {
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(text) || /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/.test(text)) throw invalid('Eine Datei enthält Schlüsselmaterial und wurde nicht übernommen.', 'WEBSITE_SECRET_FILE');
}

export function websiteFileBytes(file) {
  if (!file || typeof file !== 'object' || typeof file.content !== 'string') throw invalid('Website-Dateien benötigen einen Text- oder Base64-Inhalt.');
  if (file.symlink || file.type === 'symlink' || file.linkname || file.mode && (Number(file.mode) & 0o170000) === 0o120000) throw invalid('Symbolische Links sind in Websites nicht erlaubt.');
  const encoding = file.encoding || 'utf8';
  let bytes;
  if (encoding === 'utf8') {
    bytes = Buffer.from(file.content, 'utf8');
    if (bytes.toString('utf8') !== file.content) throw invalid('Ungültige UTF-8-Datei.');
  } else if (encoding === 'base64') {
    if (file.content.length > Math.ceil(WEBSITE_LIMITS.fileBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw invalid('Ungültiger Base64-Dateiinhalt.');
    bytes = Buffer.from(file.content, 'base64');
  } else throw invalid('Unbekannte Dateikodierung.');
  if (bytes.length > WEBSITE_LIMITS.fileBytes) throw invalid('Eine Website-Datei überschreitet 3 MiB.');
  detectSecretMaterial(bytes);
  return bytes;
}

export function normalizeWebsiteFiles(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > WEBSITE_LIMITS.files) throw invalid('Eine Website benötigt zwischen 1 und 500 Dateien.');
  let total = 0;
  const seen = new Set();
  const normalized = input.map(file => {
    const path = validateWebsitePath(file?.path);
    const key = path.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw invalid('Doppelte Website-Dateipfade sind nicht erlaubt.');
    seen.add(key);
    const bytes = websiteFileBytes(file);
    total += bytes.length;
    if (total > WEBSITE_LIMITS.totalBytes) throw invalid('Die Website überschreitet insgesamt 20 MiB.');
    return { path, content: file.content, encoding: file.encoding || 'utf8' };
  });
  for (const key of seen) {
    const parts = key.split('/');
    for (let index = 1; index < parts.length; index += 1) if (seen.has(parts.slice(0, index).join('/'))) throw invalid('Datei- und Ordnerpfade überschneiden sich.');
  }
  return normalized.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
export function websiteCrc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function checkExtraFields(extra) {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) throw invalid('Beschädigtes ZIP-Zusatzfeld.');
    const type = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    if (type === 0x0001) throw invalid('ZIP64-Archive werden nicht unterstützt.');
    if (offset + 4 + length > extra.length) throw invalid('Beschädigtes ZIP-Zusatzfeld.');
    offset += 4 + length;
  }
}

function zipName(bytes, flags) {
  if (!(flags & 0x800) && bytes.some(byte => byte >= 0x80)) throw invalid('ZIP-Dateinamen müssen UTF-8 verwenden.');
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw invalid('Ungültiger UTF-8-Dateiname im ZIP.');
  return decoded;
}

function fileFromBytes(path, bytes) {
  const utf8 = bytes.toString('utf8');
  return Buffer.from(utf8, 'utf8').equals(bytes) && !bytes.includes(0)
    ? { path, content: utf8, encoding: 'utf8' }
    : { path, content: bytes.toString('base64'), encoding: 'base64' };
}

export function readWebsiteZip(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length < 22 || buffer.length > WEBSITE_LIMITS.archiveBytes) throw invalid('Ungültige ZIP-Größe (maximal 25 MiB).');
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50 && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) { end = offset; break; }
  }
  if (end < 0) throw invalid('Das ZIP-Inhaltsverzeichnis fehlt.');
  const entries = buffer.readUInt16LE(end + 10);
  const directorySize = buffer.readUInt32LE(end + 12);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0 || buffer.readUInt16LE(end + 8) !== entries || entries === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw invalid('Geteilte und ZIP64-Archive werden nicht unterstützt.');
  if (!entries || entries > WEBSITE_LIMITS.files * 2 || directoryOffset + directorySize !== end) throw invalid('Ungültiges ZIP-Inhaltsverzeichnis.');
  const records = [];
  const seen = new Set();
  let offset = directoryOffset;
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid('Beschädigtes ZIP-Inhaltsverzeichnis.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const external = buffer.readUInt32LE(offset + 38);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || flags & ~0x080e || flags & 0x0001 || ![0, 8].includes(method) || buffer.readUInt16LE(offset + 34) !== 0) throw invalid('Verschlüsselte oder unbekannte ZIP-Einträge sind nicht erlaubt.');
    if ([size, compressedSize, localOffset].includes(0xffffffff)) throw invalid('ZIP64-Einträge werden nicht unterstützt.');
    if (((external >>> 16) & 0o170000) === 0o120000) throw invalid('Symbolische Links im ZIP sind nicht erlaubt.');
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = zipName(nameBytes, flags);
    const directory = name.endsWith('/');
    const safe = validateWebsitePath(directory ? name.slice(0, -1) : name);
    const key = safe.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw invalid('Doppelte ZIP-Dateipfade sind nicht erlaubt.');
    seen.add(key);
    checkExtraFields(buffer.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    if (size > WEBSITE_LIMITS.fileBytes || (size > 65536 && size > Math.max(1, compressedSize) * WEBSITE_LIMITS.compressionRatio) || compressedSize > WEBSITE_LIMITS.archiveBytes || directory && size !== 0) throw invalid('ZIP-Dateigröße oder Kompressionsverhältnis ist zu groß.');
    total += size;
    if (total > WEBSITE_LIMITS.totalBytes) throw invalid('Das entpackte ZIP überschreitet 20 MiB.');
    if (localOffset + 30 > directoryOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalid('Ungültiger lokaler ZIP-Eintrag.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const stop = start + compressedSize;
    if (start > directoryOffset || stop > directoryOffset || buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method || !buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) throw invalid('ZIP-Dateikopf und Inhaltsverzeichnis passen nicht zusammen.');
    if (!(flags & 8) && (buffer.readUInt32LE(localOffset + 14) !== crc || buffer.readUInt32LE(localOffset + 18) !== compressedSize || buffer.readUInt32LE(localOffset + 22) !== size)) throw invalid('ZIP-Dateigrößen stimmen nicht überein.');
    checkExtraFields(buffer.subarray(localOffset + 30 + localNameLength, start));
    records.push({ path: safe, directory, localOffset, start, stop, size, method, crc });
    offset = next;
  }
  if (offset !== end || records.filter(record => !record.directory).length > WEBSITE_LIMITS.files) throw invalid('Zu viele Dateien oder beschädigtes ZIP.');
  const ordered = [...records].sort((a, b) => a.localOffset - b.localOffset);
  for (let index = 1; index < ordered.length; index += 1) if (ordered[index].localOffset < ordered[index - 1].stop) throw invalid('Überlappende ZIP-Einträge sind nicht erlaubt.');
  const files = [];
  for (const record of records) {
    let bytes;
    try { bytes = record.method === 0 ? buffer.subarray(record.start, record.stop) : inflateRawSync(buffer.subarray(record.start, record.stop), { maxOutputLength: Math.max(1, record.size) }); }
    catch { throw invalid('ZIP-Datei ist beschädigt oder überschreitet die erlaubte Größe.'); }
    if (bytes.length !== record.size || websiteCrc32(bytes) !== record.crc) throw invalid('ZIP-Prüfsumme oder Dateigröße stimmt nicht.');
    if (!record.directory) files.push(fileFromBytes(record.path, bytes));
  }
  return normalizeWebsiteFiles(files);
}

export function createWebsiteZip(input) {
  const files = normalizeWebsiteFiles(input);
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const bytes = websiteFileBytes(file);
    const name = Buffer.from(file.path, 'utf8');
    const deflated = deflateRawSync(bytes, { level: 6 });
    // Keep exported archives within the same anti-bomb policy as imports.
    const compressed = deflated.length < bytes.length && !(bytes.length > 65536 && bytes.length > Math.max(1, deflated.length) * WEBSITE_LIMITS.compressionRatio);
    const payload = compressed ? deflated : bytes;
    const crc = websiteCrc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(compressed ? 8 : 0, 8);
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(payload.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(compressed ? 8 : 0, 10);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 * 65536) >>> 0, 38); central.writeUInt32LE(offset, 42);
    parts.push(header, name, payload); directory.push(central, name); offset += header.length + name.length + payload.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}
