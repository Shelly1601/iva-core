import {
  listAutomationRuns,
  recordAutomationDelivery,
  saveAutomationReport,
  successfulDelivery,
} from './store.js';
import { listProjects } from '../projects/store.js';
import { listProjectProtocols } from '../projects/protocols.js';

const TIME_ZONE = 'Europe/Berlin';
const DEFAULT_RECIPIENT = 'n.sell@heat-hero.com';

function localParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(value);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function dateKeyFromUtcDate(value) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

function shiftLocalDate(value, days) {
  const parts = localParts(value);
  const shifted = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + days));
  return dateKeyFromUtcDate(shifted);
}

function isoWeekForDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const weekYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

function previousIsoWeek(now) {
  return isoWeekForDateKey(shiftLocalDate(now, -7));
}

function runLocalDate(run) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(new Date(run.startedAt));
}

function runIsoWeek(run) {
  return isoWeekForDateKey(runLocalDate(run));
}

function countsFor(runs) {
  const counts = { total: runs.length, completed: 0, partial: 0, failed: 0, blocked: 0, skipped: 0, missing: 0, running: 0 };
  for (const run of runs) {
    const status = ({ successful: 'completed', partial: 'partial' })[run.outcome] || run.status;
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

export function collapseAutomationRunAttempts(runs) {
  const groups = new Map();
  for (const run of runs) {
    const key = run.slotKey || run.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  return [...groups.values()].map(attempts => {
    const ordered = attempts.slice().sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    const completed = ordered.find(item => item.status === 'completed');
    const selected = completed || ordered.at(-1);
    return { ...selected, attemptCount: ordered.length };
  }).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function statusLabel(status) {
  return ({ completed: 'Erfolgreich durchgelaufen', successful: 'Erfolgreich durchgelaufen', partial: 'Teilweise erfolgreich', failed: 'Fehler', blocked: 'Blockiert', skipped: 'Übersprungen', missing: 'NICHT GELAUFEN', running: 'Läuft noch', waiting: 'Läuft · wartet auf Endnachweis' })[status]
    || String(status || 'Unbekannt');
}

function normalizedRunStatus(run) {
  return ({ successful: 'completed', partial: 'partial' })[run.outcome] || run.status || 'completed';
}

function stringList(value, max = 100) {
  return (Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean).slice(0, max);
}

function dealActionText(action = {}) {
  const deal = String(action.dealId || action.id || 'unbekannt').trim();
  const label = String(action.dealName || action.customerName || '').trim();
  const lines = [`Deal ${deal}${label ? ` – ${label}` : ''}`];
  const uploads = stringList(action.uploadedFiles || action.uploads);
  if (uploads.length) lines.push(`Hochgeladen: ${uploads.join(', ')}`);
  for (const draft of Array.isArray(action.drafts) ? action.drafts : []) {
    const subject = String(draft?.subject || draft || '').trim();
    if (!subject) continue;
    const recipient = String(draft?.recipient || '').trim();
    lines.push(`Mail-Entwurf: ${subject}${recipient ? ` · an ${recipient}` : ''}`);
  }
  for (const field of Array.isArray(action.fieldUpdates) ? action.fieldUpdates : []) {
    const name = String(field?.field || field?.name || '').trim();
    const value = String(field?.value ?? field?.newValue ?? '').trim();
    if (name) lines.push(`Pipedrive-Feld: ${name}${value ? ` = ${value}` : ''}`);
  }
  for (const note of Array.isArray(action.notes) ? action.notes : []) {
    const detail = String(note?.summary || note?.action || note || '').trim();
    if (detail) lines.push(`Pipedrive-Notiz: ${detail}`);
  }
  const actionStatus = String(action.status || action.result || '').trim();
  if (actionStatus) lines.push(`Ergebnis: ${actionStatus}`);
  const error = String(action.error || '').trim();
  if (error) lines.push(`Fehler: ${error}`);
  return lines;
}

function runDetailLines(run) {
  const lines = [];
  const dealActions = Array.isArray(run.metrics?.dealActions) ? run.metrics.dealActions : [];
  for (const action of dealActions) lines.push(...dealActionText(action).map((line, index) => `${index ? '  ' : ''}${line}`));
  for (const artifact of stringList(run.artifacts)) lines.push(`Erzeugt: ${artifact}`);
  if (run.error) lines.push(`Fehlergrund: ${run.error}`);
  return lines;
}

async function businessWorkflowRuns(type, periodKey) {
  const projects = (await listProjects()).filter(project => project.protocolPolicy?.enabled !== false);
  const runs = [];
  for (const project of projects) {
    const listing = await listProjectProtocols(project.id);
    const folder = listing.folders.find(item => item.id === type);
    const protocol = folder?.files?.find(item => item.period?.key === periodKey);
    if (!protocol) continue;
    for (const run of protocol.runs || []) runs.push({ ...run, projectId: project.id, projectName: project.name });
    for (const expectation of protocol.expectations || []) {
      if (!expectation.missingRuns) continue;
      runs.push({
        runId: `missing-${project.id}-${expectation.workflowId}-${periodKey}`,
        workflowId: expectation.workflowId,
        workflowName: expectation.workflowName,
        projectId: project.id,
        projectName: project.name,
        status: 'missing',
        outcome: 'missing',
        completedAt: `${protocol.period?.end || periodKey}T23:59:59.000Z`,
        summary: `Kein Ergebnisprotokoll eingegangen. Erwartet: ${expectation.expectedRuns}; gemeldet: ${expectation.actualRuns}.`,
        metrics: {}, artifacts: [], error: null,
      });
    }
  }
  return runs.sort((left, right) => String(left.completedAt).localeCompare(String(right.completedAt)));
}

function reportSections(runs) {
  if (!runs.length) return ['Keine fachlichen Workflow-Läufe protokolliert.'];
  return runs.map(run => {
    const attempts = Number(run.attemptCount || 1) > 1 ? ` · ${run.attemptCount} Versuche, als ein Lauf gezählt` : '';
    const detail = run.summary === 'Automatischer Lauf fehlgeschlagen.' && run.error
      ? `${run.summary} Grund: ${run.error}`
      : (run.summary || 'Ohne Zusammenfassung.');
    const project = run.projectName ? `\nProjekt: ${run.projectName}` : '';
    const details = runDetailLines(run);
    return `**${run.workflowName || run.automationName}**${project}\nStatus: ${statusLabel(normalizedRunStatus(run))}${attempts}\nZusammenfassung: ${detail}${details.length ? `\n${details.join('\n')}` : ''}`;
  });
}

export function formatAutomationReportText({ title, counts, runs }) {
  const overview = [
    `**${title}**`,
    `Läufe: ${counts.total}`,
    `Erfolgreich: ${counts.completed}`,
    `Teilweise: ${counts.partial || 0}`,
    `Fehler: ${counts.failed}`,
    `Blockiert: ${counts.blocked}`,
    `Nicht gelaufen: ${counts.missing || 0}`,
  ].join('\n');
  return [overview, ...reportSections(runs)].join('\n\n');
}

function runHtml(run) {
  const status = normalizedRunStatus(run);
  const colors = {
    completed: ['#dff7ea', '#146c43'], partial: ['#fff4d6', '#8a5b00'], failed: ['#ffe2e2', '#a51d1d'],
    blocked: ['#ffe9d6', '#9a4b00'], missing: ['#ffd7d7', '#8b0000'], skipped: ['#edf1f7', '#526078'],
  };
  const [background, color] = colors[status] || ['#edf1f7', '#526078'];
  const actions = Array.isArray(run.metrics?.dealActions) ? run.metrics.dealActions : [];
  const actionHtml = actions.map(action => {
    const lines = dealActionText(action);
    return `<div style="margin-top:10px;padding:10px 12px;background:#f5f8fc;border-left:4px solid #4f8ff7"><b>${escapeHtml(lines[0])}</b>${lines.slice(1).map(line => `<div style="margin-top:4px">${escapeHtml(line)}</div>`).join('')}</div>`;
  }).join('');
  const artifacts = stringList(run.artifacts).map(item => `<li>${escapeHtml(item)}</li>`).join('');
  return `<section style="margin:14px 0;padding:14px;border:1px solid #d8e1ef;border-radius:10px"><div style="font-size:12px;color:#62708a">${escapeHtml(run.projectName || '')}</div><h3 style="margin:4px 0 8px">${escapeHtml(run.workflowName || run.automationName)}</h3><span style="display:inline-block;padding:4px 8px;border-radius:999px;background:${background};color:${color};font-weight:bold">${escapeHtml(statusLabel(status))}</span><p style="margin:10px 0 0"><b>Zusammenfassung:</b> ${escapeHtml(run.summary || 'Ohne Zusammenfassung.')}</p>${actionHtml}${artifacts ? `<p style="margin-bottom:4px"><b>Weitere Ergebnisse:</b></p><ul style="margin-top:4px">${artifacts}</ul>` : ''}${run.error ? `<p style="color:#a51d1d"><b>Fehlergrund:</b> ${escapeHtml(run.error)}</p>` : ''}</section>`;
}

export function reportingStatus() {
  // Resend wird bevorzugt, weil der Provider den stabilen Idempotency-Key selbst
  // auswertet. Die IVA-Persistenz bleibt als zweite Deduplizierungsschicht aktiv.
  const provider = process.env.RESEND_API_KEY ? 'resend' : process.env.BREVO_API_KEY ? 'brevo' : '';
  const from = String(process.env.IVA_REPORT_FROM_EMAIL || '').trim();
  return {
    ready: Boolean(provider && from), provider, from,
    recipient: String(process.env.IVA_REPORT_TO_EMAIL || DEFAULT_RECIPIENT).trim() || DEFAULT_RECIPIENT,
    missing: [!provider && 'BREVO_API_KEY oder RESEND_API_KEY', !from && 'IVA_REPORT_FROM_EMAIL'].filter(Boolean),
  };
}

export async function buildAutomationReport(type = 'daily', now = new Date()) {
  const normalizedType = type === 'weekly' ? 'weekly' : 'daily';
  const periodKey = normalizedType === 'weekly' ? previousIsoWeek(now) : shiftLocalDate(now, -1);
  const runs = await businessWorkflowRuns(normalizedType, periodKey);
  const counts = countsFor(runs);
  const label = normalizedType === 'weekly' ? `Wochenreport ${periodKey}` : `Tagesreport ${periodKey}`;
  const title = `IVA Workflow-${label}`;
  const text = formatAutomationReportText({ title, counts, runs });
  const html = `<!doctype html><html lang="de"><body style="font-family:Arial,sans-serif;color:#16233b;max-width:780px;margin:0 auto;padding:18px"><h2>${escapeHtml(title)}</h2><p><b>${counts.completed}</b> erfolgreich · <b>${counts.partial}</b> teilweise · <b>${counts.failed}</b> Fehler · <b>${counts.blocked}</b> blockiert · <b>${counts.missing}</b> nicht gelaufen</p>${runs.map(runHtml).join('') || '<p>Keine fachlichen Workflow-Läufe protokolliert.</p>'}<p style="color:#62708a;font-size:12px">Enthalten sind nur fachliche Projekt-Workflows und ihre kontrollierbaren Ergebnisse. Reportversand, Bereinigung und Morning-Briefing werden hier bewusst nicht aufgeführt. · Zeitzone Europe/Berlin</p></body></html>`;
  return saveAutomationReport({ key: `workflow-report:${normalizedType}:${periodKey}`, type: normalizedType, periodKey, title, text, html, counts });
}

async function requestWithRetry(url, options, fetchImpl) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(url, { ...options, signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;
      lastError = new Error(payload.message || payload.error || `E-Mail-Provider HTTP ${response.status}`);
      if (response.status < 500 && response.status !== 429) throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt === 2) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise(resolve => setTimeout(resolve, 250 * attempt));
  }
  throw lastError || new Error('E-Mail-Versand fehlgeschlagen.');
}

export async function deliverReportEmail(report, { fetchImpl = fetch } = {}) {
  const status = reportingStatus();
  if (!status.ready) throw new Error(`E-Mail-Reporting nicht bereit: ${status.missing.join(', ')}.`);
  const dedupeKey = `email:${status.recipient.toLowerCase()}:${report.key}`;
  const existing = await successfulDelivery(dedupeKey);
  if (existing) return { delivered: false, duplicate: true, delivery: existing };
  try {
    let payload;
    if (status.provider === 'brevo') {
      payload = await requestWithRetry('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': process.env.BREVO_API_KEY },
        body: JSON.stringify({
          sender: { email: status.from, name: process.env.IVA_REPORT_FROM_NAME || 'IVA' },
          to: [{ email: status.recipient, name: 'Nadine' }], subject: report.title,
          htmlContent: report.html, textContent: report.text.replace(/\*\*/g, ''),
        }),
      }, fetchImpl);
    } else {
      payload = await requestWithRetry('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Idempotency-Key': dedupeKey.slice(0, 256), 'User-Agent': 'IVA-Core/1.0' },
        body: JSON.stringify({
          from: `${process.env.IVA_REPORT_FROM_NAME || 'IVA'} <${status.from}>`, to: [status.recipient],
          subject: report.title, html: report.html, text: report.text.replace(/\*\*/g, ''),
        }),
      }, fetchImpl);
    }
    const delivery = await recordAutomationDelivery({ dedupeKey, reportKey: report.key, channel: 'email', recipient: status.recipient, provider: status.provider, status: 'delivered', providerId: payload?.messageId || payload?.id || '' });
    return { delivered: true, duplicate: false, delivery };
  } catch (error) {
    await recordAutomationDelivery({ dedupeKey, reportKey: report.key, channel: 'email', recipient: status.recipient, provider: status.provider, status: 'failed', error: error.message });
    throw error;
  }
}

export async function deliverReportTelegram(report, { chatId, sendTelegram }) {
  if (!chatId) throw new Error('Telegram-Chat-ID fehlt.');
  if (typeof sendTelegram !== 'function') throw new Error('Telegram-Sender fehlt.');
  const dedupeKey = `telegram:${String(chatId)}:${report.key}`;
  const existing = await successfulDelivery(dedupeKey);
  if (existing) return { delivered: false, duplicate: true, delivery: existing };
  try {
    await sendTelegram(chatId, report.text);
    const delivery = await recordAutomationDelivery({ dedupeKey, reportKey: report.key, channel: 'telegram', recipient: chatId, provider: 'telegram', status: 'delivered' });
    return { delivered: true, duplicate: false, delivery };
  } catch (error) {
    await recordAutomationDelivery({ dedupeKey, reportKey: report.key, channel: 'telegram', recipient: chatId, provider: 'telegram', status: 'failed', error: error.message });
    throw error;
  }
}

export async function deliverReportEmailWithTelegramFallback(report, { chatId, sendTelegram, fetchImpl = fetch } = {}) {
  try {
    const email = await deliverReportEmail(report, { fetchImpl });
    return { preferredChannel: 'email', deliveredChannel: 'email', email, telegram: null, emailError: '' };
  } catch (error) {
    const emailError = String(error?.message || 'Unbekannter E-Mail-Fehler.').slice(0, 800);
    if (!chatId) throw new Error(`E-Mail-Report fehlgeschlagen (${emailError}); Telegram-Chat-ID für den Ersatzversand fehlt.`);
    const fallbackReport = {
      ...report,
      key: `${report.key}:email-fallback`,
      text: `**E-Mail-Zustellung fehlgeschlagen**\nDer Report an ${reportingStatus().recipient} konnte nicht per E-Mail zugestellt werden.\nGrund: ${emailError}\n\n${report.text}`,
    };
    const telegram = await deliverReportTelegram(fallbackReport, { chatId, sendTelegram });
    return { preferredChannel: 'email', deliveredChannel: 'telegram', email: null, telegram, emailError };
  }
}

export function isMondayInBerlin(now = new Date()) {
  return localParts(now).weekday === 'Mon';
}
