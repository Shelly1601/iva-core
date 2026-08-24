import fs from 'fs/promises';
import crypto from 'crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const STORE_FILE = DATA_DIR + '/voice-lab.json';
let writeQueue = Promise.resolve();

export const VOICE_TEST_PHRASES = Object.freeze([
  { id: 'kunden', category: 'Kunden', text: 'Eva, zeig mir alle Kunden mit einem offenen Strategiegespräch.' },
  { id: 'bestaetigung', category: 'Sicherheit', text: 'Schick noch nichts ab, zeig mir zuerst nur den Entwurf.' },
  { id: 'adresse', category: 'Kundendaten', text: 'Ich möchte die Adresse eines Kunden ändern, aber frag mich vor dem Speichern noch einmal.' },
  { id: 'beratung', category: 'Beratung', text: 'Öffne die Kundenakte und bereite eine Beratung nach DIN 77230 vor.' },
  { id: 'vertrag', category: 'Verträge', text: 'Was steht im Hausratvertrag zur groben Fahrlässigkeit?' },
  { id: 'energie', category: 'Energie', text: 'Erstelle mir aus den Gebäudedaten eine Heizlastvorplanung.' },
  { id: 'tagesplan', category: 'Alltag', text: 'Wie viele Termine und unerledigte Aufgaben habe ich heute?' },
  { id: 'unterbrechung', category: 'Gespräch', text: 'Stopp, das ist mir zu ausführlich. Sag mir nur den wichtigsten Punkt.' },
]);

function emptyStore() {
  return {
    version: 1,
    settings: {
      storeAudio: false,
      retentionDays: 90,
      targets: { wordErrorRate: 0.12, firstTextMs: 1500, firstAudioMs: 2400, totalMs: 6500, maxAnswerWords: 80 },
    },
    evaluations: [],
    pronunciations: [],
    communicationPreferences: [],
    improvementRequests: [],
  };
}

const clean = (value, max = 2000) => String(value || '').trim().slice(0, max);
const finite = value => Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : null;

async function load() {
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, 'utf8'));
    const base = emptyStore();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}), targets: { ...base.settings.targets, ...(parsed.settings?.targets || {}) } },
      evaluations: Array.isArray(parsed.evaluations) ? parsed.evaluations : [],
      pronunciations: Array.isArray(parsed.pronunciations) ? parsed.pronunciations : [],
      communicationPreferences: Array.isArray(parsed.communicationPreferences) ? parsed.communicationPreferences : [],
      improvementRequests: Array.isArray(parsed.improvementRequests) ? parsed.improvementRequests : [],
    };
  } catch {
    return emptyStore();
  }
}

async function save(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(store, null, 2));
  await fs.rename(temporary, STORE_FILE);
}

async function mutate(fn) {
  let result;
  const job = writeQueue.catch(() => {}).then(async () => {
    const store = await load();
    result = await fn(store);
    await save(store);
  });
  writeQueue = job.catch(() => {});
  await job;
  return result;
}

function normalizedWords(value) {
  return clean(value, 6000)
    .toLocaleLowerCase('de-DE')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function editDistance(reference, hypothesis) {
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let i = 1; i <= reference.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= hypothesis.length; j += 1) {
      current[j] = reference[i - 1] === hypothesis[j - 1]
        ? previous[j - 1]
        : 1 + Math.min(previous[j - 1], previous[j], current[j - 1]);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[hypothesis.length];
}

export function calculateWordErrorRate(referenceText, hypothesisText) {
  const reference = normalizedWords(referenceText);
  const hypothesis = normalizedWords(hypothesisText);
  if (!reference.length) return null;
  const errors = editDistance(reference, hypothesis);
  return { errors, referenceWords: reference.length, rate: Math.round((errors / reference.length) * 1000) / 1000 };
}

export function evaluateSpokenAnswer(answer, maxAnswerWords = 80) {
  const text = clean(answer, 12000);
  const words = normalizedWords(text).length;
  const sentences = text.split(/[.!?]+/).map(part => part.trim()).filter(Boolean).length;
  const checks = {
    concise: words <= maxAnswerWords,
    noMarkdown: !/(^|\n)\s*[-*#]|\*\*|```/.test(text),
    noRawLinks: !/https?:\/\/|www\./i.test(text),
    noEmailReadout: !/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text),
    directStart: !/^(gerne|natürlich|selbstverständlich|klar[,!]|kein problem)/i.test(text),
  };
  return { words, sentences, checks, spokenReady: Object.values(checks).every(Boolean) };
}

function normalizeTimings(input = {}) {
  const timings = {};
  for (const field of ['endpointMs', 'transcriptionMs', 'firstTextMs', 'brainTotalMs', 'firstAudioMs', 'ttsRequestMs', 'totalMs']) {
    const value = finite(input[field]);
    if (value !== null) timings[field] = Math.min(value, 600_000);
  }
  return timings;
}

export async function recordVoiceEvaluation(input = {}) {
  return mutate(store => {
    const createdAt = new Date().toISOString();
    const transcript = clean(input.transcript, 6000);
    const correctedTranscript = clean(input.correctedTranscript, 6000);
    const expectedText = clean(input.expectedText, 6000);
    const referenceText = correctedTranscript || expectedText;
    const answer = clean(input.answer, 12000);
    const rating = Number(input.rating);
    const item = {
      id: crypto.randomUUID(),
      source: ['cockpit', 'voice-lab', 'regression'].includes(input.source) ? input.source : 'voice-lab',
      phraseId: clean(input.phraseId, 80),
      expectedText,
      transcript,
      correctedTranscript,
      answer,
      rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
      tags: [...new Set((Array.isArray(input.tags) ? input.tags : []).map(tag => clean(tag, 50)).filter(Boolean))].slice(0, 12),
      notes: clean(input.notes, 2000),
      timings: normalizeTimings(input.timings),
      asr: referenceText && transcript ? calculateWordErrorRate(referenceText, transcript) : null,
      response: answer ? evaluateSpokenAnswer(answer, store.settings.targets.maxAnswerWords) : null,
      audioStored: false,
      createdAt,
    };
    store.evaluations.push(item);
    const cutoff = Date.now() - Math.max(7, Number(store.settings.retentionDays) || 90) * 86_400_000;
    store.evaluations = store.evaluations
      .filter(entry => Date.parse(entry.createdAt) >= cutoff)
      .slice(-3000);
    return structuredClone(item);
  });
}

export async function listVoiceEvaluations({ limit = 60, source = '' } = {}) {
  const store = await load();
  return store.evaluations
    .filter(item => !source || item.source === source)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(500, Number(limit) || 60)));
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export async function voiceLabSummary() {
  const store = await load();
  const items = store.evaluations;
  const rated = items.filter(item => Number.isFinite(item.rating));
  const wer = items.map(item => item.asr?.rate).filter(Number.isFinite);
  const issueCounts = {};
  for (const item of items) for (const tag of item.tags || []) issueCounts[tag] = (issueCounts[tag] || 0) + 1;
  const topIssues = Object.entries(issueCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([tag, count]) => ({ tag, count }));
  const avg = values => values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : null;
  return {
    configured: {
      transcription: Boolean(process.env.OPENAI_API_KEY || process.env.GROQ_API_KEY),
      openaiTranscription: Boolean(process.env.OPENAI_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      elevenLabs: Boolean(process.env.ELEVENLABS_API_KEY),
    },
    privacy: { audioStored: false, transcriptRetentionDays: store.settings.retentionDays },
    samples: items.length,
    ratedSamples: rated.length,
    averageRating: avg(rated.map(item => item.rating)),
    averageWordErrorRate: avg(wer.map(value => value * 100)),
    spokenReadyRate: items.filter(item => item.response).length
      ? Math.round((items.filter(item => item.response?.spokenReady).length / items.filter(item => item.response).length) * 1000) / 10
      : null,
    medianFirstTextMs: median(items.map(item => item.timings?.firstTextMs)),
    medianFirstAudioMs: median(items.map(item => item.timings?.firstAudioMs)),
    medianTotalMs: median(items.map(item => item.timings?.totalMs)),
    topIssues,
    targets: store.settings.targets,
    testPhrases: VOICE_TEST_PHRASES,
    learned: {
      pronunciations: store.pronunciations.filter(item => item.active !== false).length,
      communicationPreferences: store.communicationPreferences.filter(item => item.active !== false).length,
      improvementRequests: store.improvementRequests.filter(item => item.status !== 'rejected').length,
    },
  };
}

export async function savePronunciationCorrection(input = {}) {
  const term = clean(input.term, 120);
  const spokenAs = clean(input.spokenAs, 180);
  if (!term || !spokenAs) throw new Error('Begriff und gewünschte Aussprache werden benötigt.');
  if (term.length < 2 || spokenAs.length < 2) throw new Error('Aussprachekorrektur ist zu kurz.');
  return mutate(store => {
    const now = new Date().toISOString();
    const existing = store.pronunciations.find(item => item.term.toLocaleLowerCase('de-DE') === term.toLocaleLowerCase('de-DE'));
    const correction = {
      id: existing?.id || crypto.randomUUID(),
      term,
      spokenAs,
      example: clean(input.example, 500),
      source: clean(input.source || 'nadine', 80),
      active: true,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (existing) Object.assign(existing, correction);
    else store.pronunciations.push(correction);
    store.pronunciations = store.pronunciations.slice(-250);
    return structuredClone(correction);
  });
}

export async function saveCommunicationPreference(input = {}) {
  const preference = clean(input.preference, 500);
  if (!preference) throw new Error('Kommunikationsregel fehlt.');
  return mutate(store => {
    const now = new Date().toISOString();
    const key = preference.toLocaleLowerCase('de-DE');
    const existing = store.communicationPreferences.find(item => item.preference.toLocaleLowerCase('de-DE') === key);
    if (existing) { existing.active = true; existing.updatedAt = now; return structuredClone(existing); }
    const item = { id: crypto.randomUUID(), preference, context: clean(input.context || 'allgemein', 100), active: true, createdAt: now, updatedAt: now };
    store.communicationPreferences.push(item);
    store.communicationPreferences = store.communicationPreferences.slice(-150);
    return structuredClone(item);
  });
}

export async function captureImprovementRequest(input = {}) {
  const title = clean(input.title, 180);
  const desiredOutcome = clean(input.desiredOutcome || input.description, 3000);
  if (!title || !desiredOutcome) throw new Error('Titel und gewünschtes Ergebnis fehlen.');
  return mutate(store => {
    const now = new Date().toISOString();
    const item = {
      id: crypto.randomUUID(),
      title,
      description: clean(input.description, 4000),
      desiredOutcome,
      acceptanceCriteria: (Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []).map(value => clean(value, 500)).filter(Boolean).slice(0, 12),
      area: clean(input.area || 'iva-core', 100),
      priority: ['low', 'normal', 'high'].includes(input.priority) ? input.priority : 'normal',
      status: 'captured',
      buildMode: 'autonomous-on-command',
      requiresConfirmationBeforeCode: false,
      requiresConfirmationBeforeDeploy: false,
      createdAt: now,
      updatedAt: now,
    };
    store.improvementRequests.push(item);
    store.improvementRequests = store.improvementRequests.slice(-500);
    return structuredClone(item);
  });
}

export async function markImprovementRequestDispatched(requestId, { commandId = '', jobId = '' } = {}) {
  return mutate(store => {
    const item = store.improvementRequests.find(entry => entry.id === String(requestId));
    if (!item) throw new Error('Der IVA-Bauauftrag wurde nicht gefunden.');
    item.status = 'dispatched';
    item.commandId = clean(commandId, 100);
    item.jobId = clean(jobId, 100);
    item.updatedAt = new Date().toISOString();
    return structuredClone(item);
  });
}

export async function listVoiceLearning() {
  const store = await load();
  return {
    pronunciations: store.pronunciations.filter(item => item.active !== false).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    communicationPreferences: store.communicationPreferences.filter(item => item.active !== false).slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    improvementRequests: store.improvementRequests.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
  };
}

export async function activePronunciationCorrections() {
  return (await load()).pronunciations
    .filter(item => item.active !== false && item.term && item.spokenAs)
    .sort((a, b) => b.term.length - a.term.length)
    .slice(0, 250)
    .map(item => ({ term: item.term, spokenAs: item.spokenAs }));
}

export async function voiceLearningPromptContext() {
  const store = await load();
  const preferences = store.communicationPreferences.filter(item => item.active !== false).slice(-30);
  if (!preferences.length) return 'Noch keine zusätzlichen Kommunikationspräferenzen gespeichert.';
  return preferences.map(item => `- ${item.preference}${item.context && item.context !== 'allgemein' ? ` (Kontext: ${item.context})` : ''}`).join('\n');
}
