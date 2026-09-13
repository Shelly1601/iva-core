export function recoveryDelayMs(attempt = 1) {
  return Math.min(300_000, 2_000 * 2 ** Math.min(8, Math.max(0, Number(attempt) - 1)));
}
export function hasCompletionEvidence({request = {}, state = {}, resultText = '', structuredResult = null} = {}) {
  if (request.planbar) return state.planbarProgress?.status === 'completed';
  if (request.resultProtocol === 1) return ['completed','no_changes'].includes(structuredResult?.outcome);
  if (request.mode === 'build') return state.phase === 'completed' && Boolean(String(resultText).trim());
  return /(?:^|\n)\s*Status\s*:\s*(?:\*\*)?erfolgreich\b/i.test(resultText);
}
