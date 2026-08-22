const STATUS_LABELS = Object.freeze({
  auto_uploaded_to_pipedrive: 'Unterlagen verifiziert zu Pipedrive hochgeladen',
  missing_documents_draft_created: 'Mail-Entwurf für fehlende Unterlagen angelegt',
  duplicate_draft_suppressed: 'Passender Mail-Entwurf war bereits vorhanden',
  kfw_approval_ready_for_manual_viktoria_message: 'KfW-Zusage erkannt; manuelle Übergabe an Viktoria vorbereitet',
  complete_ready_for_manual_stage_and_viktoria_review: 'Unterlagen vollständig; Phasenwechsel bleibt zur Kontrolle offen',
  manual_document_review_required: 'Manuelle Dokumentenprüfung erforderlich',
  production_outcome_failed: 'Nachbearbeitung fehlgeschlagen',
});

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function dealIdOf(value) {
  return clean(value?.dealId, 80);
}

function unique(items) {
  return [...new Set(items.map(item => clean(item)).filter(Boolean))];
}

function draftFrom(value) {
  const subject = clean(value?.subject || value?.emailDraft?.subject || value?.email?.subject);
  if (!subject) return null;
  return { subject, recipient: clean(value?.recipient || value?.emailDraft?.recipient || value?.email?.recipient) };
}

export function buildFundingDealActions(report = {}) {
  const actions = new Map();
  const ensure = rawDealId => {
    const dealId = clean(rawDealId, 80);
    if (!dealId) return null;
    if (!actions.has(dealId)) actions.set(dealId, {
      dealId, uploadedFiles: [], drafts: [], fieldUpdates: [], notes: [], statuses: [], errors: [],
    });
    return actions.get(dealId);
  };

  for (const result of Array.isArray(report.results) ? report.results : []) {
    const action = ensure(dealIdOf(result));
    if (!action) continue;
    action.uploadedFiles.push(...(Array.isArray(result.uploadedFiles) ? result.uploadedFiles : []));
    if (result.status) action.statuses.push(STATUS_LABELS[result.status] || result.status);
    if (result.error) action.errors.push(result.error);
    const responseDraft = draftFrom(result.customerEmail);
    if (responseDraft) action.drafts.push(responseDraft);
  }

  const outcomes = [
    ...(Array.isArray(report.productionOutcomes) ? report.productionOutcomes : []),
    ...(Array.isArray(report.followUpOutcomes) ? report.followUpOutcomes : []),
  ];
  for (const outcome of outcomes) {
    const action = ensure(dealIdOf(outcome));
    if (!action) continue;
    if (outcome.status) action.statuses.push(STATUS_LABELS[outcome.status] || outcome.status);
    if (outcome.error) action.errors.push(outcome.error);
    const draft = draftFrom(outcome);
    if (draft && /draft|entwurf/i.test(`${outcome.status} ${outcome.emailDraft ? 'draft' : ''}`)) action.drafts.push(draft);
    if (outcome.note?.action && outcome.note.action !== 'none') action.notes.push({ action: outcome.note.action });
    for (const update of Array.isArray(outcome.fieldUpdates) ? outcome.fieldUpdates : []) action.fieldUpdates.push(update);
  }

  for (const changed of Array.isArray(report.reconciliation?.changedDeals) ? report.reconciliation.changedDeals : []) {
    const action = ensure(dealIdOf(changed));
    if (!action) continue;
    const reasons = unique(Array.isArray(changed.reasons) ? changed.reasons : []);
    if (reasons.length) action.statuses.push(`Pipedrive-Änderung erkannt: ${reasons.join(', ')}`);
  }

  return [...actions.values()].map(action => ({
    dealId: action.dealId,
    uploadedFiles: unique(action.uploadedFiles),
    drafts: action.drafts.filter((draft, index, all) => all.findIndex(item => item.subject === draft.subject && item.recipient === draft.recipient) === index),
    fieldUpdates: action.fieldUpdates,
    notes: action.notes,
    status: unique(action.statuses).join(' · '),
    error: unique(action.errors).join(' · '),
  }));
}

export function fundingReportArtifacts(dealActions = []) {
  const artifacts = [];
  for (const action of dealActions) {
    for (const file of action.uploadedFiles || []) artifacts.push(`Deal ${action.dealId}: Datei ${file} zu Pipedrive hochgeladen`);
    for (const draft of action.drafts || []) artifacts.push(`Deal ${action.dealId}: Mail-Entwurf „${draft.subject}“ angelegt`);
    for (const field of action.fieldUpdates || []) artifacts.push(`Deal ${action.dealId}: Pipedrive-Feld ${field.field || field.name} = ${field.value ?? field.newValue ?? ''}`.trim());
  }
  return unique(artifacts).slice(0, 100);
}
