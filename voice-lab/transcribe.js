import { activePronunciationCorrections } from './store.js';

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
export const TRANSCRIPTION_GLOSSARY_VERSION = 'iva-de-2026-08-24';

const BASE_GLOSSARY = Object.freeze([
  'IVA', 'Eva', 'Nadine Sell', 'HeatHero', 'Heat Hero', 'HausWertSchutz',
  'Qonekto', 'blau direkt', 'AMEISE', 'Pipedrive', 'Planbar', 'Wattfox',
  'PLAUD', 'TMB', 'bKV', 'bAV', 'PVGIS', 'Photovoltaik', 'Wärmepumpe',
  'Panasonic', 'Bosch', 'Goals & Concepts', 'Sol Living', 'Versuro',
  'LUMIT', 'Mannheimer', 'Calendly', 'Railway', 'Codex', 'Supabase',
]);

const CANONICAL_TERMS = Object.freeze([
  [/(?:\bheat[ -]?hero\b)/giu, 'HeatHero'],
  [/(?:\bhaus[ -]?wert[ -]?schutz\b)/giu, 'HausWertSchutz'],
  [/(?:\b(?:konekto|connecto|qone[kc]to)\b)/giu, 'Qonekto'],
  [/(?:\bblau[ -]?direkt\b)/giu, 'blau direkt'],
  [/(?:\bpipe[ -]?drive\b)/giu, 'Pipedrive'],
  [/(?:\bplau[dt]\b)/giu, 'PLAUD'],
  [/(?:\bwatt[ -]?fox\b)/giu, 'Wattfox'],
  [/(?:\bplan[ -]?bar\b)/giu, 'Planbar'],
  [/(?:\bgoals? and concepts?\b)/giu, 'Goals & Concepts'],
  [/(?:\bsol[ -]?living\b)/giu, 'Sol Living'],
]);

function extensionForMime(mime = '') {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  return 'webm';
}

function safeFileName(fileName, mime) {
  return String(fileName || `voice.${extensionForMime(mime)}`)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120);
}

async function glossaryTerms() {
  const learned = await activePronunciationCorrections().catch(() => []);
  return [...new Set([
    ...BASE_GLOSSARY,
    ...learned.flatMap(item => [item.term, item.spokenAs]).filter(Boolean),
  ])].slice(0, 250);
}

export function buildTranscriptionPrompt(terms = BASE_GLOSSARY) {
  return [
    'Deutsche Geschäftssprache von Nadine an ihre persönliche Assistentin IVA.',
    'Eigennamen, Firmennamen, Fachbegriffe, buchstabierte Namen, Datumsangaben und Zahlen exakt wiedergeben.',
    'Keine Namen ergänzen, keine Person aus dem Zusammenhang erraten und keine Inhalte zusammenfassen.',
    `Wichtige Schreibweisen: ${terms.join(', ')}.`,
  ].join(' ');
}

export function normalizeTranscript(value = '') {
  let text = String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  for (const [pattern, canonical] of CANONICAL_TERMS) text = text.replace(pattern, canonical);
  return text;
}

function parsePayload(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

async function requestTranscription({ endpoint, apiKey, model, buffer, mime, fileName, prompt, provider }) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), safeFileName(fileName, mime));
  form.append('model', model);
  form.append('language', 'de');
  form.append('temperature', '0');
  form.append('response_format', 'json');
  form.append('prompt', prompt);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await response.text();
  const payload = parsePayload(raw);
  if (!response.ok) {
    throw new Error(`${provider} Transkription ${response.status}: ${String(payload?.error?.message || raw).slice(0, 180)}`);
  }
  return normalizeTranscript(payload?.text || '');
}

export function transcriptionProviderStatus() {
  const openai = Boolean(process.env.OPENAI_API_KEY);
  const groq = Boolean(process.env.GROQ_API_KEY);
  return {
    ready: openai || groq,
    activeProvider: openai ? 'openai' : groq ? 'groq' : null,
    activeModel: openai
      ? (process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe')
      : groq ? 'whisper-large-v3-turbo' : null,
    openai,
    groq,
    fallbackReady: openai && groq,
    glossaryVersion: TRANSCRIPTION_GLOSSARY_VERSION,
  };
}

export async function transcribeAudio(buffer, { mime = 'audio/webm', fileName = '' } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Keine Audiodaten empfangen.');
  if (buffer.length > MAX_AUDIO_BYTES) throw new Error('Audio ist größer als 15 MB.');
  const providers = transcriptionProviderStatus();
  if (!providers.ready) throw new Error('OPENAI_API_KEY oder GROQ_API_KEY fehlt.');
  const startedAt = Date.now();
  const prompt = buildTranscriptionPrompt(await glossaryTerms());
  const attempts = [];

  if (providers.openai) attempts.push({
    provider: 'OpenAI', providerId: 'openai',
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe',
  });
  if (providers.groq) attempts.push({
    provider: 'Groq', providerId: 'groq',
    endpoint: 'https://api.groq.com/openai/v1/audio/transcriptions',
    apiKey: process.env.GROQ_API_KEY,
    model: 'whisper-large-v3-turbo',
  });

  const errors = [];
  for (const attempt of attempts) {
    try {
      const text = await requestTranscription({ ...attempt, buffer, mime, fileName, prompt });
      return {
        text,
        provider: attempt.providerId,
        model: attempt.model,
        language: 'de',
        durationMs: Date.now() - startedAt,
        audioBytes: buffer.length,
        audioStored: false,
        glossaryVersion: TRANSCRIPTION_GLOSSARY_VERSION,
        fallbackUsed: errors.length > 0,
      };
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(errors.join(' · '));
}
