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
  listVoiceEvaluations,
  listVoiceLearning,
  recordVoiceEvaluation,
  saveCommunicationPreference,
  savePronunciationCorrection,
  voiceLabSummary,
  voiceLearningPromptContext,
} = await import('../voice-lab/store.js');
const { prepareSpeechText } = await import('../voice.js');

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

await saveCommunicationPreference({ preference: 'Nenne zuerst das Ergebnis.', context: 'Sprache' });
assert.match(await voiceLearningPromptContext(), /Nenne zuerst das Ergebnis/);

const improvement = await captureImprovementRequest({
  title: 'Neue Kundenfunktion',
  description: 'IVA soll eine neue Kundenansicht vorbereiten.',
  desiredOutcome: 'Ein geprüfter Bauvorschlag mit Tests.',
});
assert.equal(improvement.status, 'captured');
assert.equal(improvement.requiresConfirmationBeforeCode, true);
assert.equal(improvement.requiresConfirmationBeforeDeploy, true);
const learning = await listVoiceLearning();
assert.equal(learning.pronunciations.length, 1);
assert.equal(learning.communicationPreferences.length, 1);
assert.equal(learning.improvementRequests.length, 1);
const learnedSummary = await voiceLabSummary();
assert.deepEqual(learnedSummary.learned, { pronunciations: 1, communicationPreferences: 1, improvementRequests: 1 });

console.log('IVA Voice-Lab: OK');
