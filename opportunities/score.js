const clamp = (value, min = 0, max = 10) => Math.max(min, Math.min(max, Number(value) || 0));
const round = value => Math.round(value * 10) / 10;

const WEIGHTS = Object.freeze({
  demandEvidence: 15,
  monetizationClarity: 15,
  automationFit: 20,
  lowOngoingEffort: 15,
  speedToValidate: 10,
  nadineFit: 10,
  evidenceQuality: 10,
  defensibility: 5,
});

export function scoreOpportunity(input = {}, settings = {}) {
  const ratings = Object.fromEntries(Object.keys(WEIGHTS).map(key => [key, clamp(input.ratings?.[key])]));
  const contributions = Object.fromEntries(Object.entries(WEIGHTS).map(([key, weight]) => [key, round(ratings[key] / 10 * weight)]));
  const base = Object.values(contributions).reduce((sum, value) => sum + value, 0);
  const risk = {
    platformRisk: clamp(input.ratings?.platformRisk),
    legalRisk: clamp(input.ratings?.legalRisk),
    saturationRisk: clamp(input.ratings?.saturationRisk),
    hypeRisk: clamp(input.ratings?.hypeRisk),
  };
  const penalties = {
    platformRisk: round(risk.platformRisk * 0.7),
    legalRisk: round(risk.legalRisk * 1.1),
    saturationRisk: round(risk.saturationRisk * 0.6),
    hypeRisk: round(risk.hypeRisk * 0.9),
    budgetOverCap: Number(input.initialBudgetEur || 0) > Number(settings.maxInitialBudgetEur || Infinity) ? 5 : 0,
    setupOverCap: Number(input.setupHours || 0) > Number(settings.maxSetupHours || Infinity) ? 5 : 0,
    ongoingOverCap: Number(input.ongoingHoursPerWeek || 0) > Number(settings.maxOngoingHoursPerWeek || Infinity) ? 8 : 0,
    noDirectSource: Array.isArray(input.sources) && input.sources.some(source => source?.url) ? 0 : 8,
  };
  const penalty = Object.values(penalties).reduce((sum, value) => sum + value, 0);
  const score = Math.max(0, Math.min(100, Math.round(base - penalty)));
  const grade = score >= 80 ? 'sehr-hoch' : score >= 65 ? 'hoch' : score >= 50 ? 'mittel' : score >= 35 ? 'niedrig' : 'aussortieren';
  return { score, grade, base: round(base), penalty: round(penalty), weights: WEIGHTS, ratings, contributions, risks: risk, penalties };
}

export function sortOpportunities(items = []) {
  return [...items].sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function formatWeeklyPitch(items = [], { max = 5 } = {}) {
  const ranked = sortOpportunities(items).filter(item => Number(item.score || 0) >= 35).slice(0, Math.max(1, Math.min(10, Number(max) || 5)));
  if (!ranked.length) return 'IVA Chancenradar\n\nDiese Woche ist keine Idee durch den Mindestcheck gekommen. Das ist besser als ein schoengerechneter Schnellschuss.';
  const lines = ['IVA Chancenradar', '', 'Diese Ideen haben diese Woche den Quellen- und Machbarkeitscheck bestanden:'];
  ranked.forEach((item, index) => {
    lines.push('', `${index + 1}. ${item.title} — ${item.score}/100`);
    lines.push(`Warum interessant: ${item.summary || item.offer || 'noch zu konkretisieren'}`);
    lines.push(`Aufwand: ca. ${Number(item.setupHours || 0)} Std. Start, ${Number(item.ongoingHoursPerWeek || 0)} Std./Woche, ${Number(item.initialBudgetEur || 0)} EUR Startbudget`);
    lines.push(`Erster Test: ${item.firstValidation || '7-Tage-Test noch festlegen'}`);
    if (item.risks) lines.push(`Haken: ${item.risks}`);
  });
  lines.push('', 'Wenn du eine davon vertiefen willst, antworte zum Beispiel: „Chancenidee 1 prüfen“. IVA bereitet dann den Umsetzungsplan vor, startet aber nichts ungefragt.');
  return lines.join('\n');
}

export { WEIGHTS };
