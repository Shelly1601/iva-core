export function fundingIntakeProofIsComplete({ proof, jobId, mode, createdAt } = {}) {
  if (!['initial-backfill', 'incremental'].includes(mode) || !jobId || proof?.protocol !== 2 || proof.jobId !== jobId || proof.mode !== mode
    || proof.coverageComplete !== true || proof.checkpointRecorded !== true || proof.completed !== true || proof.pending !== 0) return false;
  const scannedAt = Date.parse(proof.scannedAt);
  if (!Number.isFinite(scannedAt) || scannedAt > Date.now() + 60000) return false;
  if (mode === 'initial-backfill') return proof.since === '2026-08-01' && proof.backfillCompleted === true;
  return Number.isFinite(Date.parse(createdAt)) && scannedAt >= Date.parse(createdAt);
}

export function recoveryDelayMs(attempt = 1) {
  return Math.min(300_000, 2_000 * 2 ** Math.min(8, Math.max(0, Number(attempt) - 1)));
}
export function hasCompletionEvidence({request = {}, state = {}, resultText = '', structuredResult = null} = {}) {
  if (request.planbar) return state.planbarProgress?.status === 'completed';
  if (request.workflowId === 'planbar-weekly-export') {
    const proof = state.workflowProof, delivery = request.forecastDelivery;
    return Boolean(proof?.sentFolderVerified === true && delivery
      && proof.runMode === delivery.runMode
      && (delivery.runMode === 'automatic'
        ? proof.automationSlotKey === delivery.automationSlotKey
        : proof.deliveryRunKey === delivery.deliveryRunKey));
  }
  if (request.workflowId === 'planbar-completion-morning') {
    const proof = state.planbarCompletionProof;
    return Boolean(proof?.protocol === 2 && proof.jobId === request.jobId
      && proof.scope === 'heat-hero-private' && proof.inventoryComplete === true
      && ['completed', 'no_changes'].includes(proof.status));
  }
  if (request.resultProtocol === 1) {
    const complete = ['completed','no_changes'].includes(structuredResult?.outcome);
    if (['funding-initial-backfill', 'funding-daily-sequence', 'funding-monitor'].includes(request.workflowId)) {
      const mode = request.workflowId === 'funding-initial-backfill' ? 'initial-backfill' : 'incremental';
      return Boolean(complete && request.fundingRun?.mode === mode && fundingIntakeProofIsComplete({proof: state.fundingIntakeProof, jobId: request.jobId, mode, createdAt: request.createdAt}));
    }
    return complete;
  }
  if (request.mode === 'build') return state.phase === 'completed' && Boolean(String(resultText).trim());
  return /(?:^|\n)\s*Status\s*:\s*(?:\*\*)?erfolgreich\b/i.test(resultText);
}

// Three short repair attempts, then a checkpointed pause. The same job remains
// pending; a busy loop cannot consume unlimited model calls or create new jobs.
export function planbarRecoveryDelayMs(attempt = 1) {
  const count = Math.max(1, Number(attempt) || 1);
  return count % 3 === 0 ? 15 * 60_000 : recoveryDelayMs(count);
}
