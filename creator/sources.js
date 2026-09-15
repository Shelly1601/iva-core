import { createHash, randomUUID } from 'node:crypto';
import { creatorError, creatorId, creatorText } from './store.js';

export const creatorHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const words = value => String(value || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu) || [];
export function httpsUrl(value) {
  if (!value) return '';
  let url; try { url = new URL(String(value)); } catch { throw creatorError('Bitte eine vollständige HTTPS-Adresse angeben.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 4000) throw creatorError('Bitte eine HTTPS-Adresse ohne Zugangsdaten angeben.');
  return url.href;
}
function sourceUrl(value) { try { return httpsUrl(value); } catch { return ''; } }
export function normalizeSourceRights(input = {}) {
  const usage = input.usage || 'research'; if (!['research', 'own', 'licensed'].includes(usage)) throw creatorError('Ungültige Quellennutzung.');
  const rightsBasis = creatorText(input.rightsBasis, 2000), rightsConfirmed = input.rightsConfirmed === true;
  if (usage !== 'research' && (!rightsConfirmed || rightsBasis.length < 10)) throw creatorError('Eigene oder lizenzierte Inhalte brauchen eine ausdrücklich bestätigte Rechtegrundlage.');
  return { usage, status: usage === 'research' ? 'unconfirmed' : 'user-confirmed', rightsConfirmed: usage === 'research' ? false : true, rightsBasis, usageNote: creatorText(input.usageNote, 1000) };
}
export async function snapshotCreatorSources({ knowledgeIds = [], opportunityIds = [], sourceRights = [] } = {}, dependencies = {}) {
  if (![knowledgeIds, opportunityIds, sourceRights].every(Array.isArray) || knowledgeIds.length + opportunityIds.length > 12 || sourceRights.length > 12) throw creatorError('Bitte höchstens zwölf konkrete Quellen auswählen.');
  const snapshots = [], importedAt = new Date().toISOString();
  for (const [type, ids, read] of [['knowledge', [...new Set(knowledgeIds)], dependencies.getKnowledgeEntry], ['opportunity', [...new Set(opportunityIds)], dependencies.getOpportunity]]) {
    for (const originalId of ids) {
      creatorId(originalId, 'Quelle'); if (typeof read !== 'function') throw creatorError('Diese Quellenanbindung ist nicht verfügbar.', 503);
      const row = await read(originalId); if (!row) throw creatorError('Die ausgewählte Quelle wurde nicht gefunden.', 404);
      if (row.projectId && dependencies.projectId && row.projectId !== dependencies.projectId) throw creatorError('Diese Quelle gehört zu einem anderen Projekt.', 404);
      if (type === 'knowledge' && row.status !== 'ready') throw creatorError('Nur fertig eingelesene Wissensquellen können verwendet werden.');
      let content, coverage;
      if (type === 'knowledge') {
        content = [row.content, row.documentText].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n\n');
        coverage = { kind: 'text', originalCharacters: content.length, importedCharacters: Math.min(content.length, 100000), truncated: content.length > 100000, transcript: false, visual: false };
      } else {
        // A radar assessment is a derived idea and evidence record, never a
        // substitute for unseen original videos, books, or entire websites.
        const picked = Object.fromEntries(['title', 'summary', 'description', 'idea', 'assessment', 'rationale', 'implementation', 'implementationOptions', 'risks', 'sources', 'research', 'evidence', 'claims', 'claimChecks', 'media', 'url', 'sourceUrl'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
        content = JSON.stringify(picked, null, 2);
        coverage = { kind: 'radar-assessment', derived: true, originalCharacters: content.length, importedCharacters: Math.min(content.length, 100000), truncated: content.length > 100000, transcript: row.media?.coverage?.transcript === true, visual: row.media?.coverage?.visual === true };
      }
      if (content.trim().length < 30) throw creatorError('Die Quelle enthält zu wenig tatsächlich lesbaren Inhalt.');
      const captured = content.slice(0, 100000), id = `S${snapshots.length + 1}`;
      const rightsInput = sourceRights.find(item => item.sourceId === originalId || item.sourceId === id) || {};
      snapshots.push({ id, type, originalId, title: creatorText(row.title || row.name || 'Quelle', 300), url: sourceUrl(row.url || row.sourceUrl), content: captured, sha256: creatorHash(captured), originalSha256: creatorHash(content), importedAt, rights: normalizeSourceRights(rightsInput), coverage });
    }
  }
  if (snapshots.reduce((n, s) => n + s.content.length, 0) > 400000) throw creatorError('Die Auswahl ist zu groß. Bitte kleinere Quellenabschnitte oder weniger Quellen verwenden.', 413);
  return snapshots;
}
export function normalizeExactSnippet(input, sources, existing = []) {
  const source = sources.find(row => row.id === input.sourceId); if (!source) throw creatorError('Die Textstelle muss aus einer ausgewählten Quelle stammen.');
  const text = creatorText(input.text, 1600), count = words(text).length;
  if (!count || count > 160 || !source.content.includes(text)) throw creatorError('Die Textstelle muss exakt im gespeicherten Quelleninhalt vorkommen und höchstens 160 Wörter enthalten.');
  const usage = input.usage, rightsBasis = creatorText(input.rightsBasis, 2000), attribution = creatorText(input.attribution, 500), locator = creatorText(input.locator, 500);
  if (!['own', 'licensed', 'quotation'].includes(usage) || !locator || !attribution) throw creatorError('Nutzung, genaue Fundstelle und Herkunftsangabe fehlen.');
  if (usage !== 'quotation' && (input.rightsConfirmed !== true || rightsBasis.length < 10)) throw creatorError('Für diese wörtliche Übernahme muss der konkrete Nutzungsumfang ausdrücklich bestätigt sein.');
  // Same underlying URL/document counts as one source, even if selected twice.
  const identity = s => s.url || `${s.type}:${s.originalId}`;
  const previousWords = existing.filter(s => s.usage === 'quotation' && identity(sources.find(x => x.id === s.sourceId) || {}) === identity(source)).reduce((n, s) => n + words(s.text).length, 0);
  if (usage === 'quotation' && count + previousWords > 25) throw creatorError('Kurze Zitate sind zusammen auf 25 Wörter je Originalquelle begrenzt.');
  return { id: `q_${randomUUID()}`, sourceId: source.id, sourceSha256: source.sha256, text, locator, usage, rightsConfirmed: usage === 'quotation' ? false : true, rightsBasis, attribution, wordCount: count, createdAt: new Date().toISOString() };
}
export function sourceWarnings(sources) {
  return sources.flatMap(s => [s.coverage?.truncated ? `${s.id}: Die Quelle wurde auf ${s.coverage.importedCharacters} Zeichen begrenzt; nicht eingelesene Abschnitte wurden nicht ausgewertet.` : null, s.type === 'opportunity' ? `${s.id}: Radar-Einschätzung als Ideenbeleg; keine vollständige Primärquelle.` : null, s.rights?.status !== 'user-confirmed' ? `${s.id}: Recherchequelle ohne bestätigte Übernahmerechte; nur eigenständige Aufbereitung und zulässige gekennzeichnete Kurz-Zitate.` : null].filter(Boolean));
}

// A deterministic overlap screen is a review aid, not a claim of legal clearance.
// All non-approved 12-word runs are rejected, including in examples/exercises.
export function checkCreatorOriginality(units, sources, snippets) {
  const usedCounts = new Map(), quotationTotals = new Map();
  for (const unit of units) {
    let text = [unit.content, ...(unit.examples || []), ...(unit.exercises || [])].join('\n');
    for (const id of unit.exactSnippetIds || []) {
      const snippet = snippets.find(s => s.id === id); if (!snippet) throw creatorError('Die Einheit verweist auf eine unbekannte wörtliche Textstelle.');
      const block = `> ${snippet.text}\n> — ${snippet.attribution} (${snippet.locator})`;
      const occurrences = text.split(block).length - 1;
      if (!occurrences) throw creatorError('Wörtliche Textstellen müssen als Zitatblock mit Herkunft und Fundstelle gekennzeichnet sein.');
      usedCounts.set(id, (usedCounts.get(id) || 0) + occurrences);
      text = text.split(block).join(' ');
      if (snippet.usage === 'quotation') {
        const source = sources.find(s => s.id === snippet.sourceId), key = source?.url || `${source?.type}:${source?.originalId}`;
        quotationTotals.set(key, (quotationTotals.get(key) || 0) + occurrences * words(snippet.text).length);
      }
    }
    const tokens = words(text), ngrams = new Set(); for (let i = 0; i + 12 <= tokens.length; i++) ngrams.add(tokens.slice(i, i + 12).join(' '));
    for (const source of sources) {
      const tokens = words(source.content); for (let i = 0; i + 12 <= tokens.length; i++) if (ngrams.has(tokens.slice(i, i + 12).join(' '))) throw creatorError(`Eine längere wörtliche Übernahme aus ${source.id} wurde erkannt. Den Abschnitt eigenständig neu formulieren oder eine konkrete Textstelle freigeben.`, 422, 'CREATOR_SOURCE_OVERLAP');
    }
  }
  if ([...quotationTotals.values()].some(count => count > 25)) throw creatorError('Die tatsächlich verwendeten Kurz-Zitate überschreiten 25 Wörter je Originalquelle.', 422);
  return { status: 'checked', method: 'exact-12-word-overlap', checkedAt: new Date().toISOString(), requiresEditorialReview: true, usedSnippetIds: [...usedCounts.keys()] };
}
