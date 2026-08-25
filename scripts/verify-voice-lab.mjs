import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-voice-lab-'));

const {
  VOICE_TEST_PHRASES,
  calculateWordErrorRate,
  captureImprovementRequest,
  evaluateSpokenAnswer,
  activePronunciationCorrections,
  activeTranscriptionCorrections,
  listVoiceEvaluations,
  listVoiceLearning,
  recordVoiceEvaluation,
  saveCommunicationPreference,
  savePronunciationCorrection,
  saveTranscriptionCorrection,
  voiceLabSummary,
  voiceLearningPromptContext,
} = await import('../voice-lab/store.js');
const { prepareSpeechText } = await import('../voice.js');
const { applyLearnedTranscriptionCorrections, buildTranscriptionPrompt, normalizeTranscript, transcribeAudio, transcriptionProviderStatus } = await import('../voice-lab/transcribe.js');
const cockpitSource = await fs.readFile(new URL('../public/cockpit.html', import.meta.url), 'utf8');
const voiceLabSource = await fs.readFile(new URL('../public/voice-lab.html', import.meta.url), 'utf8');
const voiceLabScript = await fs.readFile(new URL('../public/voice-lab.js', import.meta.url), 'utf8');
const transcriptionSource = await fs.readFile(new URL('../voice-lab/transcribe.js', import.meta.url), 'utf8');
const cockpitScript = cockpitSource.match(/<script>([\s\S]*)<\/script>/)?.[1] || '';
assert.doesNotThrow(() => new Function(cockpitScript), 'Cockpit-Script muss syntaktisch gültig sein');
assert.doesNotThrow(() => new Function(voiceLabScript), 'Sprachlabor-Script muss syntaktisch gültig sein');

assert.ok(VOICE_TEST_PHRASES.length >= 8);
assert.equal(calculateWordErrorRate('Eva öffne die Kundenakte', 'Eva öffne Kundenakte').errors, 1);
assert.equal(evaluateSpokenAnswer('Klar, gerne helfe ich dir dabei.').checks.directStart, false);
assert.equal(evaluateSpokenAnswer('Die Kundenakte ist geöffnet. Ich bereite nur den Entwurf vor.').spokenReady, true);

const evaluation = await recordVoiceEvaluation({
  source: 'voice-lab', phraseId: 'kunden',
  expectedText: 'Eva zeig mir alle Kunden', transcript: 'Eva zeig mir alle Kunde',
  correctedTranscript: 'Eva zeig mir alle Kunden',
  answer: 'Ich zeige dir die offenen Kundenakten. Änderungen führe ich erst nach deiner Bestätigung aus.',
  rating: 4, tags: ['good'], timings: { transcriptionMs: 620, firstTextMs: 940, firstAudioMs: 1650, totalMs: 4200 },
});
assert.equal(evaluation.audioStored, false);
assert.ok(evaluation.asr.rate > 0);
assert.equal((await listVoiceEvaluations()).length, 1);
const summary = await voiceLabSummary();
assert.equal(summary.samples, 1);
assert.equal(summary.averageRating, 4);
assert.equal(summary.medianFirstTextMs, 940);
assert.equal(summary.privacy.audioStored, false);

await savePronunciationCorrection({ term: 'Qonekto', spokenAs: 'Ko-nek-to', source: 'test' });
assert.deepEqual(await activePronunciationCorrections(), [{ term: 'Qonekto', spokenAs: 'Ko-nek-to' }]);
assert.match(await prepareSpeechText('Qonekto ist verbunden.'), /Ko-nek-to ist verbunden/);

await saveTranscriptionCorrection({ heardText: 'Plan war Kunde', correctedText: 'Planbar Kunde', context: 'Hersteller' });
assert.deepEqual(await activeTranscriptionCorrections(), [{ heardText: 'Plan war Kunde', correctedText: 'Planbar Kunde' }]);
assert.equal(applyLearnedTranscriptionCorrections('Bitte Plan war Kunde öffnen.', await activeTranscriptionCorrections()), 'Bitte Planbar Kunde öffnen.');

await saveCommunicationPreference({ preference: 'Nenne zuerst das Ergebnis.', context: 'Sprache' });
assert.match(await voiceLearningPromptContext(), /Nenne zuerst das Ergebnis/);

const improvement = await captureImprovementRequest({
  title: 'Neue Kundenfunktion',
  description: 'IVA soll eine neue Kundenansicht vorbereiten.',
  desiredOutcome: 'Ein geprüfter Bauvorschlag mit Tests.',
});
assert.equal(improvement.status, 'captured');
assert.equal(improvement.buildMode, 'autonomous-on-command');
assert.equal(improvement.requiresConfirmationBeforeCode, false);
assert.equal(improvement.requiresConfirmationBeforeDeploy, false);
const learning = await listVoiceLearning();
assert.equal(learning.pronunciations.length, 1);
assert.equal(learning.transcriptionCorrections.length, 1);
assert.equal(learning.communicationPreferences.length, 1);
assert.equal(learning.improvementRequests.length, 1);
const learnedSummary = await voiceLabSummary();
assert.deepEqual(learnedSummary.learned, { pronunciations: 1, transcriptionCorrections: 1, communicationPreferences: 1, improvementRequests: 1 });

assert.match(cockpitSource, /function shouldListen\(\)\{ return wakeOn\|\|manualMicOn; \}/);
assert.match(cockpitSource, /rec\?\.abort\(\)/, 'Mikro aus muss die Erkennung hart abbrechen');
assert.match(cockpitSource, /navigator\.mediaDevices\?\.getUserMedia/, 'Cockpit muss echtes Audio serverseitig transkribieren');
assert.match(cockpitSource, /\/api\/voice\/transcribe/, 'Cockpit und Sprachlabor müssen dieselbe Transkriptionsroute verwenden');
assert.match(cockpitSource, /if\(manualMicOn\|\|awake\)startServerCapture\(\);else startRec\(\);/, 'Nur das Wake-Word darf Browser-SpeechRecognition verwenden');
assert.match(cockpitSource, /queueTranscriptForSend/, 'Transkript muss vor dem automatischen Senden sichtbar korrigierbar sein');
assert.match(cockpitSource, /location\.assign\(url\)/, 'Blockierte Pop-ups brauchen Same-Tab-Fallback');
assert.match(cockpitSource, /openOptions=\{sameTab:viaVoice===true\}/, 'Sprachbefehle öffnen Arbeitsbereiche ohne Pop-up-Abhängigkeit');
assert.doesNotMatch(cockpitSource, /Bitte Pop-ups für IVA erlauben/);
assert.match(transcriptionSource, /Eigennamen, Firmennamen, Fachbegriffe/);
assert.match(voiceLabSource, /id="pauseRecording"/);
assert.match(voiceLabSource, /Transkript-Entwurf · vor dem Senden bearbeitbar/);
assert.match(voiceLabSource, /Korrigierten Text an IVA senden/);
assert.match(voiceLabScript, /state\.media\.pause\(\)/);
assert.match(voiceLabScript, /state\.media\.resume\(\)/);
assert.match(voiceLabScript, /\/api\/voice-lab\/transcription-corrections/);
assert.equal(normalizeTranscript('Connecto und Heat Hero mit Haus Wert Schutz'), 'Qonekto und HeatHero mit HausWertSchutz');
assert.match(buildTranscriptionPrompt(['Qonekto']), /Wichtige Schreibweisen: Qonekto/);
assert.match(buildTranscriptionPrompt(['Planbar'], await activeTranscriptionCorrections()), /Plan war Kunde/);
assert.equal(typeof transcriptionProviderStatus().ready, 'boolean');

const previousFetch = globalThis.fetch;
const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousGroqKey = process.env.GROQ_API_KEY;
process.env.OPENAI_API_KEY = '';
process.env.GROQ_API_KEY = 'test-key';
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(options.body.get('language'), 'de');
  assert.match(options.body.get('prompt'), /Qonekto/);
  return { ok: true, status: 200, text: async () => JSON.stringify({ text: 'Connecto und Heat Hero' }) };
};
const mockedTranscript = await transcribeAudio(Buffer.from('fake-audio'), { mime: 'audio/webm', fileName: 'test.webm' });
assert.equal(mockedTranscript.text, 'Qonekto und HeatHero');
assert.equal(mockedTranscript.provider, 'groq');
assert.equal(mockedTranscript.audioStored, false);
globalThis.fetch = previousFetch;
if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousOpenAiKey;
if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previousGroqKey;

console.log('IVA Voice-Lab: OK');
