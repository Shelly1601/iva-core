function clean(value, max = 400) {
  return value === undefined || value === null ? '' : String(value).trim().slice(0, max);
}

export function normalizeName(value) {
  return clean(value)
    .toLocaleLowerCase('de')
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function buildNameSearchVariants(value, limit = 8) {
  const original = clean(value, 180).replace(/\s+/g, ' ');
  if (!original) return [];
  const variants = new Set([original]);
  const ascii = original
    .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss');
  variants.add(ascii);
  const tokens = original.split(/[^\p{L}\p{N}]+/u).filter(token => token.length >= 3);
  [...tokens].sort((a, b) => b.length - a.length).forEach(token => variants.add(token));
  const rules = [
    [/ph/gi, 'f'], [/ie/gi, 'i'], [/y/gi, 'i'], [/v/gi, 'f'], [/w/gi, 'v'],
    [/ck/gi, 'k'], [/tz/gi, 'z'], [/sch/gi, 'sh'], [/ai/gi, 'ei'],
  ];
  for (const [pattern, replacement] of rules) {
    const changed = original.replace(pattern, replacement);
    if (changed !== original) variants.add(changed);
  }
  return [...variants].filter(Boolean).slice(0, Math.min(Math.max(limit, 1), 12));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  return 1 - (levenshtein(a, b) / Math.max(a.length, b.length, 1));
}

function deepScalar(raw, aliases, maxDepth = 4) {
  const wanted = new Set(aliases.map(normalizeName));
  const queue = [{ value: raw, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (wanted.has(normalizeName(key)) && ['string', 'number'].includes(typeof child) && clean(child)) return clean(child);
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
  }
  return '';
}

export function leadDisplayName(lead = {}) {
  const full = deepScalar(lead, ['full_name', 'fullname', 'customer_name', 'kundenname', 'contact_name', 'name']);
  if (full) return full;
  const first = deepScalar(lead, ['first_name', 'firstname', 'given_name', 'vorname']);
  const last = deepScalar(lead, ['last_name', 'lastname', 'surname', 'nachname']);
  return [first, last].filter(Boolean).join(' ');
}

function leadSummary(lead, score) {
  return {
    id: deepScalar(lead, ['lead_id', 'customer_id', 'kunden_id', 'id', 'uuid']),
    name: leadDisplayName(lead),
    email: deepScalar(lead, ['email', 'e_mail', 'mail']),
    phone: deepScalar(lead, ['phone', 'telefon', 'mobile', 'mobil', 'handy']),
    city: deepScalar(lead, ['city', 'ort', 'stadt']),
    score: Number(score.toFixed(3)),
    lead,
  };
}

function nameScore(query, candidate) {
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.94;
  const qTokens = q.split(' ');
  const cTokens = c.split(' ');
  const tokenScore = qTokens.reduce((sum, token) => sum + Math.max(...cTokens.map(other => similarity(token, other))), 0) / qTokens.length;
  return Math.max(similarity(q, c), tokenScore * 0.96);
}

export function resolveLeadName(query, leads = [], limit = 8) {
  const unique = new Map();
  for (const lead of Array.isArray(leads) ? leads : []) {
    const name = leadDisplayName(lead);
    if (!name) continue;
    const id = deepScalar(lead, ['lead_id', 'customer_id', 'kunden_id', 'id', 'uuid']);
    const key = id || `${normalizeName(name)}|${deepScalar(lead, ['email', 'mail'])}`;
    if (!unique.has(key)) unique.set(key, lead);
  }
  const candidates = [...unique.values()]
    .map(lead => leadSummary(lead, nameScore(query, leadDisplayName(lead))))
    .filter(candidate => candidate.score >= 0.48)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'de'))
    .slice(0, Math.min(Math.max(limit, 1), 20));
  const best = candidates[0] || null;
  const second = candidates[1] || null;
  const uniqueMatch = Boolean(best && best.score >= 0.86 && (!second || best.score - second.score >= 0.08));
  const matchStatus = !best ? 'not-found' : uniqueMatch ? 'unique' : 'ambiguous';
  return {
    query: clean(query, 180),
    matchStatus,
    bestMatch: uniqueMatch ? best : null,
    candidates,
    clarification: matchStatus === 'unique'
      ? `Eindeutiger CRM-Treffer: ${best.name}.`
      : matchStatus === 'ambiguous'
        ? `Bitte nachfragen, welcher CRM-Kontakt gemeint ist: ${candidates.slice(0, 3).map(candidate => candidate.name).join(', ')}.`
        : 'Bitte fragen, wie der Nachname geschrieben wird. Nicht raten.',
  };
}
