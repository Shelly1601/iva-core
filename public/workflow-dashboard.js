(function attachWorkflowDashboard(root) {
  'use strict';

  const STALE_AFTER_MS = 5 * 60 * 1000;
  const TERMINAL = new Set(['completed', 'successful', 'sent-and-verified', 'skipped']);
  const TECHNICAL_REVIEW = new Set(['failed', 'timed_out', 'incomplete', 'expired', 'stopped']);

  function clean(value, max = 2000) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function timestamp(item) {
    return clean(item.updatedAt || item.completedAt || item.startedAt || item.createdAt, 80);
  }

  function timeValue(value) {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function progressValue(value) {
    if (value == null || value === '') return null;
    if (!Number.isFinite(Number(value))) return null;
    return Math.max(0, Math.min(100, Math.round(Number(value))));
  }

  function sourceLabel(item, origin) {
    const source = clean(item.source, 140);
    if (/imac/i.test(source) && /codex/i.test(source)) return 'iMac · Codex';
    if (/codex/i.test(source) || item.type === 'build' || origin === 'build') return 'Codex';
    if (/imac/i.test(source) || item.type === 'command') return 'iMac';
    if (/railway/i.test(source) || item.type === 'automation') return 'IVA Core / Railway';
    if (/iva core/i.test(source)) return 'IVA Core / Railway';
    return source || 'IVA Core / Railway';
  }

  function candidate(item, origin) {
    const rawStatus = clean(item.rawStatus || item.status || 'recorded', 50).toLowerCase();
    const updatedAt = timestamp(item);
    return {
      id: clean(item.jobId || item.id || `${origin}:${item.title || item.name}:${updatedAt}`, 260),
      jobId: clean(item.jobId, 100),
      title: clean(item.title || item.name || 'IVA-Workflow', 220),
      rawStatus,
      source: sourceLabel(item, origin),
      purpose: clean(item.description || item.summary || item.requestPreview || item.detail || 'Echter IVA-Lauf', 1200),
      detail: clean(item.detail || item.summary || item.resultPreview || item.description || item.error || 'Laufstatus wurde erfasst.', 1800),
      blocker: rawStatus === 'blocked' ? clean(item.blocker || item.error || item.detail || item.summary, 1200) : '',
      phase: clean(item.phaseLabel || item.phase || rawStatus, 100),
      progress: progressValue(item.progress),
      updatedAt,
      startedAt: clean(item.startedAt || item.createdAt, 80),
      completedAt: clean(item.completedAt, 80),
      origin,
    };
  }

  function mergeCandidate(current, incoming) {
    if (!current) return incoming;
    const currentIsActivity = current.origin === 'activity';
    const incomingIsActivity = incoming.origin === 'activity';
    const statusOwner = incomingIsActivity && !currentIsActivity ? incoming : current;
    const richer = incoming.progress != null || incoming.origin === 'build' ? incoming : current;
    return {
      ...current,
      ...richer,
      rawStatus: statusOwner.rawStatus,
      blocker: statusOwner.rawStatus === 'blocked' ? (statusOwner.blocker || current.blocker || incoming.blocker) : '',
      source: statusOwner.source || richer.source,
      updatedAt: timeValue(incoming.updatedAt) > timeValue(current.updatedAt) ? incoming.updatedAt : current.updatedAt,
      purpose: richer.purpose || current.purpose,
      detail: richer.detail || current.detail,
      origin: currentIsActivity || incomingIsActivity ? 'activity' : richer.origin,
    };
  }

  function groupFor(item, now) {
    const age = timeValue(item.updatedAt) ? now - timeValue(item.updatedAt) : Number.POSITIVE_INFINITY;
    const stale = item.rawStatus === 'running' && age > STALE_AFTER_MS;
    if (stale) return { group: 'waiting', status: 'stale', label: 'veraltet · Prüfung läuft', stale: true, technicalReview: false };
    if (item.rawStatus === 'running') return { group: 'running', status: 'running', label: 'läuft', stale: false, technicalReview: false };
    if (item.rawStatus === 'blocked') return { group: 'blocked', status: 'blocked', label: 'blockiert', stale: false, technicalReview: false };
    if (TERMINAL.has(item.rawStatus)) return { group: 'done', status: 'completed', label: 'erledigt', stale: false, technicalReview: false };
    if (TECHNICAL_REVIEW.has(item.rawStatus)) return { group: 'waiting', status: 'review', label: 'technische Prüfung', stale: false, technicalReview: true };
    return { group: 'waiting', status: 'waiting', label: 'wartet', stale: false, technicalReview: false };
  }

  function buildWorkflowDashboard(snapshot, options) {
    const now = Number(options && options.now) || Date.now();
    const merged = new Map();
    const activity = Array.isArray(snapshot && snapshot.activity) ? snapshot.activity : [];
    for (const item of activity) {
      const entry = candidate(item, 'activity');
      merged.set(entry.id, mergeCandidate(merged.get(entry.id), entry));
    }

    const buildProgress = snapshot && snapshot.buildProgress ? snapshot.buildProgress : {};
    for (const key of ['active', 'queued', 'blocked', 'recent']) {
      for (const item of Array.isArray(buildProgress[key]) ? buildProgress[key] : []) {
        const entry = candidate(item, 'build');
        merged.set(entry.id, mergeCandidate(merged.get(entry.id), entry));
      }
    }

    const groups = { running: [], waiting: [], blocked: [], done: [] };
    for (const entry of merged.values()) {
      const classification = groupFor(entry, now);
      const normalized = { ...entry, ...classification };
      if (normalized.group !== 'blocked') normalized.blocker = '';
      groups[normalized.group].push(normalized);
    }
    for (const values of Object.values(groups)) values.sort((a, b) => timeValue(b.updatedAt) - timeValue(a.updatedAt));
    groups.done = groups.done.slice(0, 12);
    return {
      ...groups,
      counts: {
        running: groups.running.length,
        waiting: groups.waiting.length,
        blocked: groups.blocked.length,
        done: groups.done.length,
      },
      staleAfterMs: STALE_AFTER_MS,
      generatedAt: clean(snapshot && snapshot.generatedAt, 80),
    };
  }

  root.IVAWorkflowDashboard = Object.freeze({ buildWorkflowDashboard, STALE_AFTER_MS });
})(typeof window !== 'undefined' ? window : globalThis);
