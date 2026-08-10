import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export const DIRECT_SALES_WHATSAPP_GROUP = 'HEATHERO Direktvertrieb';

const normalize = value => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
  .toLowerCase()
  .replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function defaultDirectSalesRosterFile() {
  return path.join(
    process.env.IVA_MAC_HELPER_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'IVA Mac Helper'),
    'funding-direct-sales-roster.json',
  );
}

export function cleanDirectSalesMemberName(value) {
  const cleaned = String(value || '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/,\s*Admin\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > 120 || !/\p{L}/u.test(cleaned)) return '';
  if (/^(?:mitglieder(?:änderungen|anderungen)?(?:\s+ansehen)?|fertig|suchen)$/i.test(cleaned)) return '';
  return cleaned;
}

export async function saveDirectSalesRoster(members, {
  filePath = defaultDirectSalesRosterFile(),
  groupName = DIRECT_SALES_WHATSAPP_GROUP,
  sourceMemberCount = null,
} = {}) {
  const cleanedMembers = [...new Map((Array.isArray(members) ? members : [])
    .map(cleanDirectSalesMemberName)
    .filter(Boolean)
    .map(name => [normalize(name), name])).values()]
    .sort((a, b) => a.localeCompare(b, 'de'));
  const previous = loadDirectSalesRosterSync(filePath);
  const expectedNamedMinimum = Number.isInteger(sourceMemberCount)
    ? Math.max(10, sourceMemberCount - 2)
    : 10;
  const sameGroupSizeAsPrevious = Number.isInteger(sourceMemberCount)
    && sourceMemberCount === previous.sourceMemberCount;
  const losesKnownMembers = sameGroupSizeAsPrevious
    && previous.cachedMemberCount > cleanedMembers.length;
  if (cleanedMembers.length < expectedNamedMinimum || losesKnownMembers) {
    throw new Error('Direktvertriebs-Abgleich abgebrochen: Die WhatsApp-Mitgliederliste ist unvollständig oder nicht eindeutig sichtbar.');
  }
  const roster = {
    version: 1,
    groupName,
    syncedAt: new Date().toISOString(),
    sourceMemberCount: Number.isInteger(sourceMemberCount) ? sourceMemberCount : null,
    cachedMemberCount: cleanedMembers.length,
    members: cleanedMembers,
  };
  const absoluteFile = path.resolve(filePath);
  const temporary = `${absoluteFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(absoluteFile), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, JSON.stringify(roster, null, 2), { mode: 0o600 });
    await rename(temporary, absoluteFile);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return { ...roster, savedTo: absoluteFile };
}

export function loadDirectSalesRosterSync(filePath = defaultDirectSalesRosterFile()) {
  try {
    const value = JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
    const members = Array.isArray(value?.members) ? value.members.map(cleanDirectSalesMemberName).filter(Boolean) : [];
    return {
      ...value,
      cachedMemberCount: members.length,
      members,
    };
  } catch {
    return { version: 1, groupName: DIRECT_SALES_WHATSAPP_GROUP, syncedAt: null, sourceMemberCount: null, cachedMemberCount: 0, members: [] };
  }
}

function emailLocalPart(value) {
  return String(value || '').trim().toLowerCase().split('@')[0] || '';
}

export function matchDirectSalesPartner({ vpName, vpEmail } = {}, roster = loadDirectSalesRosterSync()) {
  const members = (roster?.members || []).map(name => ({ name, normalized: normalize(name) })).filter(item => item.normalized);
  const normalizedName = normalize(vpName);
  const exact = members.filter(item => item.normalized === normalizedName);
  if (exact.length === 1) return { matched: true, memberName: exact[0].name, matchedBy: 'exact_name' };

  const local = normalize(emailLocalPart(vpEmail || vpName));
  const localCompact = local.replace(/\s+/g, '');
  if (!local) return { matched: false, memberName: null, matchedBy: null };
  const emailMatches = members.filter(item => {
    const tokens = item.normalized.split(' ').filter(Boolean);
    const first = tokens[0] || '';
    const surname = tokens.at(-1) || '';
    const memberCompact = `${first}${surname}`;
    const localTokens = local.split(' ').filter(Boolean);
    return localCompact === memberCompact
      || (surname.length >= 3 && localTokens.includes(surname) && localTokens.some(token => token === first || token === first[0]));
  });
  if (emailMatches.length === 1) return { matched: true, memberName: emailMatches[0].name, matchedBy: 'email_name_match' };
  return { matched: false, memberName: null, matchedBy: null };
}

