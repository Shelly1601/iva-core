import {
  listAutomationRuns,
  recordAutomationDelivery,
  saveAutomationReport,
  successfulDelivery,
} from './store.js';

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
  const counts = { total: runs.length, completed: 0, failed: 0, blocked: 0, skipped: 0, running: 0 };
  for (const run of runs) counts[run.status] = (counts[run.status] || 0) + 1;
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
  return ({ completed: 'Erfolgreich durchgelaufen', failed: 'Fehler', blocked: 'Blockiert', skipped: 'Übersprungen', running: 'Läuft noch' })[status]
    || String(status || 'Unbekannt');
}

function reportSections(runs) {
  if (!runs.length) return ['Keine automatischen Läufe protokolliert.'];
  return runs.map(run => {
    const attempts = Number(run.attemptCount || 1) > 1 ? ` · ${run.attemptCount} Versuche, als ein Lauf gezählt` : '';
    const detail = run.summary === 'Automatischer Lauf fehlgeschlagen.' && run.error
      ? `${run.summary} Grund: ${run.error}`
      : (run.summary || 'Ohne Zusammenfassung.');
    return `**${run.automationName}**\nStatus: ${statusLabel(run.status)}${attempts}\nErgebnis: ${detail}`;
  });
}

export function formatAutomationReportText({ title, counts, runs }) {
  const overview = [
    `**${title}**`,
    `Läufe: ${counts.total}`,
    `Erfolgreich: ${counts.completed}`,
    `Fehler: ${counts.failed}`,
    `Blockiert: ${counts.blocked}`,
  ].join('\n');
  return [overview, ...reportSections(runs)].join('\n\n');
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
  const allRuns = await listAutomationRuns({ limit: 1000 });
  const runs = collapseAutomationRunAttempts(allRuns
    .filter(run => normalizedType === 'weekly' ? runIsoWeek(run) === periodKey : runLocalDate(run) === periodKey)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt))));
  const counts = countsFor(runs);
  const label = normalizedType === 'weekly' ? `Wochenreport ${periodKey}` : `Tagesreport ${periodKey}`;
  const title = `IVA Workflow-${label}`;
  const text = formatAutomationReportText({ title, counts, runs });
  const tableRows = runs.map(run => `<tr><td>${escapeHtml(run.automationName)}</td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.summary || '–')}</td></tr>`).join('');
  const html = `<!doctype html><html lang="de"><body style="font-family:Arial,sans-serif;color:#16233b"><h2>${escapeHtml(title)}</h2><p><b>${counts.completed}</b> erfolgreich · <b>${counts.failed}</b> Fehler · <b>${counts.blocked}</b> blockiert · ${counts.total} insgesamt</p><table cellpadding="8" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#d8e1ef;width:100%"><thead><tr><th align="left">Workflow</th><th align="left">Status</th><th align="left">Ergebnis</th></tr></thead><tbody>${tableRows || '<tr><td colspan="3">Keine automatischen Läufe protokolliert.</td></tr>'}</tbody></table><p style="color:#62708a;font-size:12px">Automatisch erstellt von IVA · Zeitzone Europe/Berlin</p></body></html>`;
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
