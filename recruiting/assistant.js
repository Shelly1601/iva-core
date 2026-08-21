const clean = (value, max = 20_000) => String(value ?? '').trim().slice(0, max);
const list = (value, max = 30) => [...new Set((Array.isArray(value) ? value : []).map(item => clean(item, 160)).filter(Boolean))].slice(0, max);

function normalized(value) {
  return clean(value, 50_000).toLocaleLowerCase('de-DE').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function evidenceFor(text, criterion) {
  const haystack = normalized(text);
  const needles = clean(criterion, 160).split(/[|,/;]/).map(normalized).map(item => item.trim()).filter(item => item.length >= 2);
  const matched = needles.find(needle => haystack.includes(needle));
  if (!matched) return { status: 'not-evidenced', evidence: '' };
  const sentences = clean(text, 50_000).split(/(?<=[.!?\n])\s+/);
  const sentence = sentences.find(item => normalized(item).includes(matched));
  return { status: 'evidenced', evidence: clean(sentence || matched, 500) };
}

export function createCandidateSearchPlan(input = {}) {
  const mustHave = list(input.mustHave); const niceToHave = list(input.niceToHave);
  if (!mustHave.length) throw new Error('Mindestens ein Muss-Kriterium fehlt');
  const role = clean(input.role, 200);
  const titles = list(input.titles, 12);
  const excludedTerms = list(input.excludedTerms, 12);
  const quote = item => item.includes(' ') ? `"${item}"` : item;
  const roleTerms = titles.length ? titles : [role].filter(Boolean);
  const orGroup = values => values.length > 1 ? `(${values.map(quote).join(' OR ')})` : values.map(quote).join('');
  const criterionTerm = value => orGroup(clean(value, 180).split('|').map(item => item.trim()).filter(Boolean));
  const exclusion = excludedTerms.slice(0, 3).map(item => `NOT ${quote(item)}`);
  const chunks = [];
  for (let index = 0; index < mustHave.length; index += 2) {
    chunks.push([...(roleTerms.length ? [orGroup(roleTerms.slice(0, 4))] : []), ...mustHave.slice(index, index + 2).map(criterionTerm), ...exclusion].filter(Boolean).join(' AND '));
  }
  const queries = [...new Set(chunks.filter(Boolean))].slice(0, 5).map((query, index) => ({
    id: `search-${index + 1}`,
    label: index === 0 ? 'Kernsuche' : `Ergaenzung ${index + 1}`,
    query,
    url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(query)}`,
  }));
  const booleanQuery = queries[0]?.query || role;
  return {
    role,
    mode: 'manual-linkedin-free-search',
    booleanQuery,
    queries,
    naturalLanguageQuery: [role, mustHave.length ? `mit ${mustHave.join(', ')}` : '', input.locations?.length ? `in ${list(input.locations, 10).join(' oder ')}` : '', clean(input.remote, 50)].filter(Boolean).join(' '),
    filters: {
      location: list(input.locations, 10), remote: clean(input.remote, 50), languages: list(input.languages, 10),
      seniority: list(input.seniority, 10), industries: list(input.industries, 15),
    },
    reviewSequence: ['LinkedIn-Suche manuell oeffnen', 'Interessante Profile per Link oder offizieller PDF uebernehmen', 'Must-haves durch Belegstelle pruefen', 'Wechselmotivation im Gespraech klaeren', 'Nice-to-haves getrennt bewerten'],
    guardrails: ['Keine automatisierte LinkedIn-Profilabfrage', 'Kein Massen-Outreach', 'Keine Bewertung geschuetzter oder nicht jobrelevanter Merkmale', 'LinkedIn-Limits und Plattformregeln beachten'],
    notice: 'Kostenloser Modus: IVA bereitet die Suche vor. Auswahl und Profilaufruf erfolgen manuell in LinkedIn; IVA liest keine Profile automatisiert aus.',
  };
}

export function screenResumeAgainstCriteria(input = {}) {
  const cvText = clean(input.cvText, 50_000);
  if (!cvText) throw new Error('Lebenslauftext fehlt');
  const mustHave = list(input.mustHave); const niceToHave = list(input.niceToHave);
  if (!mustHave.length) throw new Error('Mindestens ein Muss-Kriterium fehlt');
  const must = mustHave.map(criterion => ({ criterion, ...evidenceFor(cvText, criterion) }));
  const nice = niceToHave.map(criterion => ({ criterion, ...evidenceFor(cvText, criterion) }));
  const mustRate = must.filter(item => item.status === 'evidenced').length / must.length;
  const niceRate = nice.length ? nice.filter(item => item.status === 'evidenced').length / nice.length : 0;
  return {
    role: clean(input.role, 200),
    result: 'manual-review-required',
    evidenceScore: Math.round((mustRate * 0.8 + niceRate * 0.2) * 100),
    mustHave: must,
    niceToHave: nice,
    openQuestions: must.filter(item => item.status !== 'evidenced').map(item => `Bitte konkretes Beispiel fuer ${item.criterion} erfragen.`),
    notice: 'Nicht gefunden bedeutet nur: im bereitgestellten Text nicht belegt. Es ist keine automatische Absage oder Eignungsentscheidung.',
  };
}

export function createInterviewGuide(input = {}) {
  const mustHave = list(input.mustHave); const niceToHave = list(input.niceToHave);
  const role = clean(input.role, 200) || 'die Position';
  const evidenceQuestions = mustHave.map((criterion, index) => ({
    id: `must-${index + 1}`, criterion,
    question: `Erzaehl mir bitte von einer konkreten Situation, in der du ${criterion} eingesetzt hast. Was war dein eigener Beitrag und welches messbare Ergebnis gab es?`,
    scoring: { 0: 'kein Beispiel', 1: 'nur allgemeine Aussage', 2: 'konkretes Beispiel ohne klares Ergebnis', 3: 'konkretes Beispiel mit eigenem Beitrag und nachvollziehbarem Ergebnis' },
  }));
  return {
    role,
    durationMinutes: Math.max(20, Math.min(120, Number(input.durationMinutes) || 45)),
    agenda: [
      { minutes: 5, topic: 'Begruessung, Rolle und Ablauf' },
      { minutes: 8, topic: 'Motivation, Wechselgrund und Erwartungen' },
      { minutes: 20, topic: 'Muss-Kriterien mit konkreten Belegen', questions: evidenceQuestions },
      { minutes: 7, topic: 'Arbeitsweise, Zusammenarbeit und offene Punkte' },
      { minutes: 5, topic: 'Fragen der Kandidatin/des Kandidaten und naechste Schritte' },
    ],
    niceToHavePrompts: niceToHave.map(item => `Wie viel praktische Erfahrung hast du mit ${item}, und woran kann man das erkennen?`),
    preparation: ['CV-Belegstellen pruefen', 'Kriterien vor dem Gespraech gewichten', 'gleiche Kernfragen fuer vergleichbare Kandidaten verwenden', 'Notizen als Fakten und Eindruck getrennt erfassen'],
    guardrails: ['Nur jobrelevante Kriterien', 'keine sensiblen Merkmale ableiten', 'keine autonome Zusage oder Absage', 'finale Entscheidung durch Menschen'],
  };
}
