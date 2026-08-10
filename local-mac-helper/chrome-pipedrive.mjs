import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { classifyFundingDocumentName } from './funding-document-extractor.mjs';
import { resolveFundingSupervisor } from './funding.mjs';

const PIPEDRIVE_HOST = 'simplegategmbh.pipedrive.com';
const MAX_OUTPUT_BYTES = 256 * 1024;

export const PIPEDRIVE_FILE_POLICY = Object.freeze({
  read: true,
  downloadTemporaryCopy: true,
  uploadAfterVerification: true,
  delete: false,
});

export function assertPipedriveFileActionAllowed(action) {
  if (String(action || '').trim().toLowerCase() === 'delete') {
    throw new Error('Pipedrive-Dateien dürfen unter keinen Umständen gelöscht werden.');
  }
  return true;
}

function runAppleScript(script, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Chrome-Diagnose hat das Zeitlimit überschritten.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || `osascript beendet mit Code ${code}`).trim()));
    });
    child.stdin.end(script);
  });
}

function dealIdFromUrl(value) {
  return String(value || '').match(/\/deal\/(\d+)/)?.[1] || null;
}

export async function executePipedriveJavaScript(javascript, { dealId = '', timeoutMs = 15000 } = {}) {
  const target = dealId ? `pipedrive.com/deal/${String(dealId).replace(/\D/g, '')}` : 'pipedrive.com/pipeline/1';
  const script = `tell application "Google Chrome"
repeat with w in windows
  repeat with t in tabs of w
    if (URL of t) contains "${target}" then return execute t javascript ${JSON.stringify(String(javascript))}
  end repeat
end repeat
return "NO_TAB"
end tell`;
  const output = await runAppleScript(script, { timeoutMs });
  if (output === 'NO_TAB') throw new Error(`Kein geöffneter Pipedrive-Deal ${dealId || ''} gefunden.`.trim());
  return output;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function inspectPipedrivePipelineBoard() {
  return JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const targetStages = ['Antrag eingereicht / Förderunterlagen einreichen', 'Förderung beantragt'];
    const anchors = [...document.querySelectorAll('a[href*="/deal/"]')];
    const stageHeadings = [...document.querySelectorAll('body *')]
      .filter(element => targetStages.some(stage => clean(element.textContent) === stage))
      .map(element => ({
        label: clean(element.textContent),
        x: Math.round(element.getBoundingClientRect().x),
        y: Math.round(element.getBoundingClientRect().y),
        tag: element.tagName,
        className: String(element.className || '').slice(0, 180),
      }));
    const firstDeal = anchors[0];
    const ancestors = [];
    let current = firstDeal;
    while (current && current !== document.documentElement) {
      const style = getComputedStyle(current);
      ancestors.push({
        tag: current.tagName,
        className: String(current.className || '').slice(0, 180),
        scrollTop: Math.round(current.scrollTop || 0),
        scrollHeight: Math.round(current.scrollHeight || 0),
        clientHeight: Math.round(current.clientHeight || 0),
        overflowY: style.overflowY,
        rect: {
          x: Math.round(current.getBoundingClientRect().x),
          y: Math.round(current.getBoundingClientRect().y),
          width: Math.round(current.getBoundingClientRect().width),
          height: Math.round(current.getBoundingClientRect().height),
        },
      });
      current = current.parentElement;
    }
    return JSON.stringify({
      url: location.href,
      title: document.title,
      documentScroll: {
        scrollTop: Math.round(document.scrollingElement?.scrollTop || 0),
        scrollHeight: Math.round(document.scrollingElement?.scrollHeight || 0),
        clientHeight: Math.round(document.scrollingElement?.clientHeight || 0),
      },
      stageHeadings,
      dealCountInDom: anchors.length,
      dealIdsInDom: [...new Set(anchors.map(anchor => anchor.getAttribute('href')?.match(/\/deal\/(\d+)/)?.[1]).filter(Boolean))],
      ancestors,
    });
  })()`));
}

export async function collectPipedriveFundingDealIds({ settleMs = 220 } = {}) {
  const setup = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
    const candidates = [...document.querySelectorAll('body *')]
      .map((element, index) => ({
        element,
        index,
        style: getComputedStyle(element),
        extra: Math.max(0, element.scrollHeight - element.clientHeight),
      }))
      .filter(item => ['auto', 'scroll'].includes(item.style.overflowY) && item.extra > 300 && item.element.clientHeight > 300)
      .sort((a, b) => b.extra - a.extra);
    const target = candidates[0]?.element;
    if (!target) return JSON.stringify({ error: 'scroll_container_not_found' });
    target.dataset.ivaFundingScroll = 'true';
    return JSON.stringify({
      originalScrollTop: Math.round(target.scrollTop),
      clientHeight: Math.round(target.clientHeight),
      scrollHeight: Math.round(target.scrollHeight),
      maxScrollTop: Math.max(0, Math.round(target.scrollHeight - target.clientHeight)),
    });
  })()`));
  if (setup.error) throw new Error('Die scrollbare Pipedrive-Pipeline konnte nicht erkannt werden.');

  const step = Math.max(280, Math.round(setup.clientHeight * 0.62));
  const positions = [];
  for (let top = 0; top < setup.maxScrollTop; top += step) positions.push(top);
  positions.push(setup.maxScrollTop);
  const collected = new Map([
    ['Antrag eingereicht / Förderunterlagen einreichen', new Map()],
    ['Förderung beantragt', new Map()],
  ]);

  try {
    for (const top of positions) {
      await executePipedriveJavaScript(String.raw`(() => {
        const target = document.querySelector('[data-iva-funding-scroll="true"]');
        if (!target) return 'missing';
        target.scrollTop = ${top};
        target.dispatchEvent(new Event('scroll', { bubbles: true }));
        return String(Math.round(target.scrollTop));
      })()`);
      await wait(settleMs);
      const pass = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        const targetStages = ['Antrag eingereicht / Förderunterlagen einreichen', 'Förderung beantragt'];
        const headingByLabel = new Map();
        for (const element of document.querySelectorAll('body *')) {
          const label = clean(element.textContent);
          if (!targetStages.includes(label)) continue;
          const rect = element.getBoundingClientRect();
          const current = headingByLabel.get(label);
          if (!current || rect.width < current.width) headingByLabel.set(label, { label, x: rect.x, width: rect.width });
        }
        const headings = [...headingByLabel.values()];
        const deals = [];
        for (const anchor of document.querySelectorAll('a[href*="/deal/"]')) {
          const id = anchor.getAttribute('href')?.match(/\/deal\/(\d+)/)?.[1];
          if (!id) continue;
          const rect = anchor.getBoundingClientRect();
          const nearest = headings
            .map(heading => ({ ...heading, distance: Math.abs(rect.x - heading.x) }))
            .sort((a, b) => a.distance - b.distance)[0];
          if (!nearest || nearest.distance > 115) continue;
          deals.push({ id, title: clean(anchor.innerText || anchor.textContent), stage: nearest.label });
        }
        return JSON.stringify({ deals });
      })()`));
      for (const deal of pass.deals) collected.get(deal.stage)?.set(deal.id, deal);
    }
  } finally {
    await executePipedriveJavaScript(String.raw`(() => {
      const target = document.querySelector('[data-iva-funding-scroll="true"]');
      if (!target) return 'missing';
      target.scrollTop = ${setup.originalScrollTop};
      target.dispatchEvent(new Event('scroll', { bubbles: true }));
      delete target.dataset.ivaFundingScroll;
      return 'restored';
    })()`).catch(() => {});
  }

  return {
    pipeline: 'Auftragsmachbarkeit',
    readOnly: true,
    positionsScanned: positions.length,
    stages: Object.fromEntries([...collected].map(([stage, deals]) => [stage, [...deals.values()]])),
  };
}

export async function readPipedriveFundingDeal({ dealId } = {}) {
  if (!/^\d+$/.test(String(dealId || ''))) throw new Error('Für die Pipedrive-Prüfung fehlt eine gültige Deal-ID.');
  const firstPass = await executePipedriveJavaScript(String.raw`(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const fieldNames = [...document.querySelectorAll('[data-testid="field-name"]')];
    const fieldName = label => fieldNames.find(element => clean(element.innerText).toLowerCase() === label.toLowerCase());
    const fieldRow = label => fieldName(label)?.parentElement || null;
    const fieldValue = label => {
      const row = fieldRow(label);
      if (!row) return null;
      const exactLabel = clean(fieldName(label)?.innerText);
      const lines = String(row.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      const value = lines.find(line => line.toLowerCase() !== exactLabel.toLowerCase()) || clean(row.innerText).slice(exactLabel.length).trim();
      return value && value !== '-' ? value : null;
    };
    const partnerRow = fieldRow('Vertriebspartner');
    const partnerLink = partnerRow?.querySelector('a[href*="/person/"]') || null;
    const partnerName = clean(partnerLink?.innerText || fieldValue('Vertriebspartner'));
    const partnerHref = partnerLink?.getAttribute('href') || '';
    if (partnerLink) for (const type of ['pointerover', 'mouseover', 'mouseenter']) partnerLink.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
    const personLinks = [...document.querySelectorAll('a[href*="/person/"]')]
      .map(link => ({ name: clean(link.innerText), href: link.getAttribute('href') || '' }))
      .filter(item => item.name);
    const customer = personLinks.find(item => item.href !== partnerHref) || null;
    const activeStageButton = [...document.querySelectorAll('button.cui5-stage-selector__stage')].find(button => button.getAttribute('aria-selected') === 'true');
    const activeStage = clean(activeStageButton?.innerText).replace(/^\d+\s*T\s*·\s*/i, '');
    const dealTitle = document.title.replace(/\s*-\s*Deals\s*$/i, '').trim();
    const titleLocation = (() => {
      if (!customer?.name) return null;
      const tail = dealTitle.replace(/^AM:\s*/i, '').slice(customer.name.length).replace(/^\s*-\s*/, '');
      const candidate = clean(tail.split(/\s+-\s+/)[0]);
      return candidate && candidate !== '-' ? candidate : null;
    })();
    const titleOrderNumber = dealTitle.match(/\bHH-(?:AN|AB)-[A-Z0-9-]{4,}\b/i)?.[0]?.toUpperCase() || null;
    const allButton = document.querySelector('[data-testid="filter-button-all"]');
    if (allButton) allButton.click();
    const incomeBonusValue = fieldValue('Einkommensbonus') || fieldValue('Einkommens-Bonus');
    const incomeBonusRequested = incomeBonusValue == null
      ? null
      : /^(ja|yes|beantragt|true|1)$/i.test(clean(incomeBonusValue))
        ? true
        : /^(nein|no|nicht beantragt|false|0)$/i.test(clean(incomeBonusValue))
          ? false
          : null;
    return JSON.stringify({
      url: location.href,
      dealId: location.pathname.match(/\/deal\/(\d+)/)?.[1] || null,
      dealTitle,
      pipeline: (document.body?.innerText || '').split(/\n+/).map(clean).some(line => line === 'Auftragsmachbarkeit') ? 'Auftragsmachbarkeit' : null,
      stage: activeStage || null,
      customerName: customer?.name || null,
      customerPersonId: customer?.href.match(/\/person\/(\d+)/)?.[1] || null,
      orderNumber: fieldValue('Auftragsnummer') || fieldValue('Angebotsnummer') || fieldValue('Angebotsnummer (sevdesk)') || titleOrderNumber,
      customerNumber: fieldValue('Kundennummer') || fieldValue('Kunden-Nr.'),
      phoneNumber: fieldValue('Telefonnummer') || fieldValue('Telefon') || fieldValue('Mobilnummer'),
      plant: fieldValue('Anlage'),
      incomeBonusRequested,
      location: fieldValue('Ort') || fieldValue('Stadt') || fieldValue('Kundenort') || titleLocation,
      vpName: partnerName || null,
      vpPersonId: partnerHref.match(/\/person\/(\d+)/)?.[1] || null,
    });
  })()`, { dealId });
  const core = JSON.parse(firstPass);
  await wait(900);
  const secondPass = await executePipedriveJavaScript(String.raw`(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const emailPattern = /[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/ig;
    const hasEmail = /[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    const partnerName = ${JSON.stringify(core.vpName || '')};
    let vpEmail = null;
    if (partnerName) {
      const contexts = [...document.querySelectorAll('body *')]
        .map(element => clean(element.innerText))
        .filter(value => value && value.length <= 260 && value.includes(partnerName) && hasEmail.test(value));
      vpEmail = contexts.flatMap(value => value.match(emailPattern) || [])[0] || null;
    }
    const filePattern = /\.(pdf|png|jpe?g|heic|docx?|xlsx?)\b/i;
    const files = [...new Set([...document.querySelectorAll('body *')]
      .filter(element => element.children.length === 0)
      .map(element => clean(element.textContent))
      .filter(value => value && value.length <= 300 && filePattern.test(value)))];
    return JSON.stringify({ vpEmail: vpEmail ? vpEmail.toLowerCase() : null, files: files.slice(0, 200) });
  })()`, { dealId });
  const detail = JSON.parse(secondPass);
  return {
    ...core,
    ...detail,
    documents: detail.files.map(fileName => classifyFundingDocumentName(fileName)),
    readOnly: true,
    mutated: false,
  };
}

async function openTemporaryPipedriveDealTabs(dealIds) {
  const ids = [...new Set(dealIds.map(String))].filter(id => /^\d+$/.test(id));
  if (!ids.length) return [];
  const blocks = ids.map(id => `set alreadyOpen to false
repeat with w in windows
  repeat with t in tabs of w
    if (URL of t) contains "pipedrive.com/deal/${id}" then set alreadyOpen to true
  end repeat
end repeat
if alreadyOpen is false then
  make new tab at end of tabs of front window with properties {URL:"https://${PIPEDRIVE_HOST}/deal/${id}"}
  set end of createdIds to "${id}"
end if`).join('\n');
  const output = await runAppleScript(`tell application "Google Chrome"
set createdIds to {}
${blocks}
set AppleScript's text item delimiters to ","
return createdIds as text
end tell`, { timeoutMs: 20000 });
  return output.split(',').map(value => value.trim()).filter(Boolean);
}

async function closeTemporaryPipedriveDealTabs(dealIds) {
  const ids = [...new Set(dealIds.map(String))].filter(id => /^\d+$/.test(id));
  if (!ids.length) return;
  const conditions = ids.map(id => `(URL of t) contains "pipedrive.com/deal/${id}"`).join(' or ');
  await runAppleScript(`tell application "Google Chrome"
repeat with w in windows
  set tabCount to count of tabs of w
  repeat with i from tabCount to 1 by -1
    set t to tab i of w
    if ${conditions} then close t
  end repeat
end repeat
end tell`, { timeoutMs: 20000 });
}

async function activatePipedriveDealTab(dealId) {
  const id = String(dealId || '').replace(/\D/g, '');
  if (!id) throw new Error('Pipedrive-Deal-ID fehlt.');
  const result = await runAppleScript(`tell application "Google Chrome"
repeat with w in windows
  set tabCount to count of tabs of w
  repeat with i from 1 to tabCount
    set t to tab i of w
    if (URL of t) contains "pipedrive.com/deal/${id}" then
      set active tab index of w to i
      set index of w to 1
      return "activated"
    end if
  end repeat
end repeat
return "missing"
end tell`, { timeoutMs: 10000 });
  if (result !== 'activated') throw new Error(`Pipedrive-Deal ${id} konnte nicht aktiviert werden.`);
}

async function warmPipedriveDealTabs(dealIds) {
  const ids = [...new Set(dealIds.map(String))].filter(id => /^\d+$/.test(id));
  if (!ids.length) return 0;
  const conditions = ids.map(id => `(URL of t) contains "pipedrive.com/deal/${id}"`).join(' or ');
  const result = await runAppleScript(`tell application "Google Chrome"
set warmedCount to 0
repeat with w in windows
  set tabCount to count of tabs of w
  repeat with i from 1 to tabCount
    set t to tab i of w
    if ${conditions} then
      set active tab index of w to i
      set index of w to 1
      set warmedCount to warmedCount + 1
      delay 1.8
    end if
  end repeat
end repeat
return warmedCount as text
end tell`, { timeoutMs: 30000 });
  return Number(result || 0);
}

async function executePipedriveJavaScriptForDeals(dealIds, javascript) {
  const ids = [...new Set(dealIds.map(String))].filter(id => /^\d+$/.test(id));
  if (!ids.length) return new Map();
  const conditions = ids.map((id, index) => `${index ? 'else ' : ''}if tabURL contains "pipedrive.com/deal/${id}" then
      set jsResult to execute t javascript ${JSON.stringify(String(javascript))}
      set end of outputLines to "${id}|||" & jsResult`).join('\n    ');
  const output = await runAppleScript(`tell application "Google Chrome"
set outputLines to {}
repeat with w in windows
  repeat with t in tabs of w
    set tabURL to URL of t
    ${conditions}
    end if
  end repeat
end repeat
set AppleScript's text item delimiters to linefeed
return outputLines as text
end tell`, { timeoutMs: 30000 });
  if (process.env.IVA_DEBUG_PIPEDRIVE === '1') console.error('Pipedrive bulk raw:', JSON.stringify(output));
  const results = new Map();
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const separator = line.indexOf('|||');
    if (separator < 1) continue;
    results.set(line.slice(0, separator), line.slice(separator + 3));
  }
  return results;
}

async function readOpenPipedriveFundingTabsBulk(dealIds) {
  const firstPass = await executePipedriveJavaScriptForDeals(dealIds, String.raw`(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const fieldNames = [...document.querySelectorAll('[data-testid="field-name"]')];
    const fieldName = label => fieldNames.find(element => clean(element.innerText).toLowerCase() === label.toLowerCase());
    const fieldRow = label => fieldName(label)?.parentElement || null;
    const fieldValue = label => {
      const row = fieldRow(label);
      if (!row) return null;
      const exactLabel = clean(fieldName(label)?.innerText);
      const lines = String(row.innerText || '').split(/\n+/).map(clean).filter(Boolean);
      const value = lines.find(line => line.toLowerCase() !== exactLabel.toLowerCase()) || clean(row.innerText).slice(exactLabel.length).trim();
      return value && value !== '-' ? value : null;
    };
    const partnerRow = fieldRow('Vertriebspartner');
    const partnerLink = partnerRow?.querySelector('a[href*="/person/"]') || null;
    const partnerName = clean(partnerLink?.innerText || fieldValue('Vertriebspartner'));
    const partnerHref = partnerLink?.getAttribute('href') || '';
    if (partnerLink) for (const type of ['pointerover', 'mouseover', 'mouseenter']) partnerLink.dispatchEvent(new MouseEvent(type, { bubbles: true, view: window }));
    const personLinks = [...document.querySelectorAll('a[href*="/person/"]')]
      .map(link => ({ name: clean(link.innerText), href: link.getAttribute('href') || '' }))
      .filter(item => item.name);
    const customer = personLinks.find(item => item.href !== partnerHref) || null;
    const activeStageButton = [...document.querySelectorAll('button.cui5-stage-selector__stage')].find(button => button.getAttribute('aria-selected') === 'true');
    const activeStage = clean(activeStageButton?.innerText).replace(/^\d+\s*T\s*·\s*/i, '');
    const dealTitle = document.title.replace(/\s*-\s*Deals\s*$/i, '').trim();
    const titleOrderNumber = dealTitle.match(/\bHH-(?:AN|AB)-[A-Z0-9-]{4,}\b/i)?.[0]?.toUpperCase() || null;
    const titleLocation = (() => {
      if (!customer?.name) return null;
      const tail = dealTitle.replace(/^AM:\s*/i, '').slice(customer.name.length).replace(/^\s*-\s*/, '');
      const candidate = clean(tail.split(/\s+-\s+/)[0]);
      return candidate && candidate !== '-' && !/^HH-(?:AN|AB)-/i.test(candidate) ? candidate : null;
    })();
    document.querySelector('[data-testid="filter-button-all"]')?.click();
    const incomeBonusValue = fieldValue('Einkommensbonus') || fieldValue('Einkommens-Bonus');
    const incomeBonusRequested = incomeBonusValue == null ? null
      : /^(ja|yes|beantragt|true|1)$/i.test(clean(incomeBonusValue)) ? true
        : /^(nein|no|nicht beantragt|false|0)$/i.test(clean(incomeBonusValue)) ? false : null;
    return JSON.stringify({
      url: location.href,
      dealId: location.pathname.match(/\/deal\/(\d+)/)?.[1] || null,
      dealTitle,
      pipeline: (document.body?.innerText || '').split(/\n+/).map(clean).some(line => line === 'Auftragsmachbarkeit') ? 'Auftragsmachbarkeit' : null,
      stage: activeStage || null,
      customerName: customer?.name || null,
      customerPersonId: customer?.href.match(/\/person\/(\d+)/)?.[1] || null,
      orderNumber: fieldValue('Auftragsnummer') || fieldValue('Angebotsnummer') || fieldValue('Angebotsnummer (sevdesk)') || titleOrderNumber,
      customerNumber: fieldValue('Kundennummer') || fieldValue('Kunden-Nr.'),
      phoneNumber: fieldValue('Telefonnummer') || fieldValue('Telefon') || fieldValue('Mobilnummer'),
      plant: fieldValue('Anlage'),
      incomeBonusRequested,
      location: fieldValue('Ort') || fieldValue('Stadt') || fieldValue('Kundenort') || titleLocation,
      vpName: partnerName || null,
      vpPersonId: partnerHref.match(/\/person\/(\d+)/)?.[1] || null,
    });
  })()`);
  await wait(1100);
  const secondPass = await executePipedriveJavaScriptForDeals(dealIds, String.raw`(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const emailPattern = /[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/ig;
    const hasEmail = /[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
    const fieldNames = [...document.querySelectorAll('[data-testid="field-name"]')];
    const partnerNameElement = fieldNames.find(element => clean(element.innerText).toLowerCase() === 'vertriebspartner');
    const partnerRow = partnerNameElement?.parentElement || null;
    const partnerName = clean(partnerRow?.querySelector('a[href*="/person/"]')?.innerText || partnerRow?.innerText).replace(/^Vertriebspartner\s*/i, '');
    let vpEmail = (partnerName.match(emailPattern) || [])[0] || null;
    if (!vpEmail && partnerName) {
      const contexts = [...document.querySelectorAll('[role="dialog"], [role="tooltip"], [data-testid*="popover"], [data-testid*="person"]')]
        .map(element => clean(element.innerText))
        .filter(value => value && value.length <= 300 && value.includes(partnerName) && hasEmail.test(value));
      vpEmail = contexts.flatMap(value => value.match(emailPattern) || [])[0] || null;
    }
    const filePattern = /\.(pdf|png|jpe?g|heic|docx?|xlsx?)\b/i;
    const files = [...new Set([...document.querySelectorAll('font, a, [data-testid*="file"], [data-testid*="attachment"]')]
      .map(element => clean(element.textContent))
      .filter(value => value && value.length <= 300 && filePattern.test(value)))];
    return JSON.stringify({ vpEmail: vpEmail ? vpEmail.toLowerCase() : null, files: files.slice(0, 200) });
  })()`);

  const snapshots = [];
  const errors = [];
  for (const id of dealIds) {
    try {
      if (!firstPass.has(id) || !secondPass.has(id)) {
        throw new Error(`Pipedrive-Tab lieferte keinen vollständigen Lese-Snapshot (Kern: ${firstPass.has(id) ? 'ja' : 'nein'}, Dateien: ${secondPass.has(id) ? 'ja' : 'nein'}).`);
      }
      const core = JSON.parse(firstPass.get(id));
      const detail = JSON.parse(secondPass.get(id));
      snapshots.push({
        ...core,
        ...detail,
        documents: detail.files.map(fileName => classifyFundingDocumentName(fileName)),
        readOnly: true,
        mutated: false,
      });
    } catch (error) {
      errors.push({ dealId: id, error: error.message });
    }
  }
  return { snapshots, errors };
}

async function waitForPipedriveDealTab(dealId, { timeoutMs = 12000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = JSON.parse(await executePipedriveJavaScript(String.raw`(() => JSON.stringify({
        readyState: document.readyState,
        dealId: location.pathname.match(/\/deal\/(\d+)/)?.[1] || null,
        hasBody: Boolean(document.body?.innerText?.trim()),
        hasStage: Boolean(document.querySelector('button.cui5-stage-selector__stage[aria-selected="true"]')),
      }))()`, { dealId }));
      if (state.readyState === 'complete' && state.dealId === String(dealId) && state.hasBody && state.hasStage) return true;
    } catch {}
    await wait(300);
  }
  throw new Error(`Pipedrive-Deal ${dealId} wurde nicht rechtzeitig vollständig geladen.`);
}

export async function readPipedriveFundingDealsBulk({ dealIds, batchSize = 4, onProgress } = {}) {
  const ids = [...new Set((Array.isArray(dealIds) ? dealIds : []).map(String))].filter(id => /^\d+$/.test(id));
  if (!ids.length) throw new Error('Für den Förder-Prüflauf fehlen Deal-IDs.');
  const safeBatchSize = Math.max(1, Math.min(6, Number(batchSize) || 4));
  const snapshots = [];
  const errors = [];

  for (let offset = 0; offset < ids.length; offset += safeBatchSize) {
    const batch = ids.slice(offset, offset + safeBatchSize);
    const createdIds = await openTemporaryPipedriveDealTabs(batch);
    try {
      await warmPipedriveDealTabs(batch);
      const readable = batch;
      try {
        const result = await readOpenPipedriveFundingTabsBulk(readable);
        snapshots.push(...result.snapshots);
        errors.push(...result.errors);
      } catch (error) {
        readable.forEach(dealId => errors.push({ dealId, error: error.message }));
      }
    } finally {
      await closeTemporaryPipedriveDealTabs(createdIds).catch(() => {});
    }
    if (typeof onProgress === 'function') onProgress({ processed: Math.min(offset + batch.length, ids.length), total: ids.length });
  }

  return {
    requested: ids.length,
    read: snapshots.length,
    failed: errors.length,
    snapshots,
    errors,
    readOnly: true,
    mutated: false,
  };
}

export async function readPipedriveFundingDealsViaApi({ dealIds, batchSize = 8, onProgress } = {}) {
  const ids = [...new Set((Array.isArray(dealIds) ? dealIds : []).map(String))].filter(id => /^\d+$/.test(id));
  if (!ids.length) throw new Error('Für den Förder-Prüflauf fehlen Deal-IDs.');
  const safeBatchSize = Math.max(1, Math.min(100, Number(batchSize) || 8));
  const snapshots = [];
  const errors = [];
  const sourceDealId = ids.includes('8153') ? '8153' : ids[0];
  const sourceCreatedIds = await openTemporaryPipedriveDealTabs([sourceDealId]);
  try {
    await activatePipedriveDealTab(sourceDealId);
    await waitForPipedriveDealTab(sourceDealId);
  for (let offset = 0; offset < ids.length; offset += safeBatchSize) {
    const batch = ids.slice(offset, offset + safeBatchSize);
    const raw = await executePipedriveJavaScript(String.raw`(() => {
      const ids = ${JSON.stringify(batch)};
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
      const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
      if (!sessionToken) return JSON.stringify({ fatal: 'missing_session_token', items: [] });
      const request = path => {
        const separator = path.includes('?') ? '&' : '?';
        const xhr = new XMLHttpRequest();
        xhr.open('GET', path + separator + 'strict_mode=true&session_token=' + encodeURIComponent(sessionToken), false);
        xhr.send();
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 200 || xhr.status >= 300 || payload?.success === false) {
          throw new Error('HTTP ' + xhr.status + ' für ' + path.split('?')[0]);
        }
        return payload?.data;
      };
      const fields = request('/api/v1/dealFields?start=0&limit=500') || [];
      const stages = request('/api/v1/stages?pipeline_id=1&start=0&limit=500') || [];
      const fieldByName = new Map(fields.map(field => [String(field.name || '').toLowerCase(), field]));
      const stageById = new Map(stages.map(stage => [String(stage.id), stage.name]));
      const personCache = new Map();
      const field = (...names) => names.map(name => fieldByName.get(name.toLowerCase())).find(Boolean) || null;
      const value = (deal, ...names) => {
        const definition = field(...names);
        return definition ? deal?.[definition.key] ?? null : null;
      };
      const enumLabel = (rawValue, definition) => definition?.options?.find(option => String(option.id) === String(rawValue))?.label || rawValue || null;
      const person = id => {
        if (!id) return null;
        const key = String(id);
        if (!personCache.has(key)) personCache.set(key, request('/api/v1/persons/' + encodeURIComponent(key)) || null);
        return personCache.get(key);
      };
      const primaryEmail = record => {
        const emails = Array.isArray(record?.email) ? record.email : [];
        return emails.find(item => item?.primary && item?.value)?.value || emails.find(item => item?.value)?.value || null;
      };
      const items = [];
      for (const id of ids) {
        try {
          const deal = request('/api/v1/deals/' + id + '?get_activity_summary=false&get_updated_deal_stage_averages=false') || {};
          const files = request('/api/v1/deals/' + id + '/files?start=0&limit=500') || [];
          const notes = request('/api/v1/notes?deal_id=' + encodeURIComponent(id) + '&start=0&limit=500') || [];
          const noteEvidence = notes.map(note => {
            const content = String(note?.content || '');
            const document = new DOMParser().parseFromString(content, 'text/html');
            const text = clean(document.body?.textContent || content);
            const marker = content.match(/IVA-FUNDING-REQUEST:\d+:[0-9a-f]{24}/i)?.[0] || null;
            const kfwEvidenceMarker = content.match(/IVA-KFW-EVIDENCE:\d+:[0-9a-f]{24}/i)?.[0] || null;
            const humanReadableIvaRequest = /^fehlende unterlagen:/i.test(text)
              && /angefragt\./i.test(text)
              && /\(notiz von nadine\)\s*$/i.test(text);
            const kfwEmailMatch = text.match(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
            const kfwSecretAfterEmail = kfwEmailMatch
              ? text.slice((kfwEmailMatch.index || 0) + kfwEmailMatch[0].length).trim().match(/^(\S{6,})/)?.[1] || ''
              : '';
            const hasExplicitKfwCredentials = Boolean(kfwEmailMatch)
              && (/(?:passwort|kennwort)\s*[:=\-]\s*\S{3,}/i.test(text)
                || (/kfw.{0,30}konto/i.test(text) && /[A-Za-z]/.test(kfwSecretAfterEmail) && /\d/.test(kfwSecretAfterEmail)));
            const redactedExcerpt = text
              .replace(/[a-z0-9.!#$%&'*+/=?^_{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/ig, '[E-Mail ausgeblendet]')
              .replace(/((?:passwort|kennwort)\s*[:=\-]\s*)\S+/ig, '$1[ausgeblendet]')
              .slice(0, 600);
            return {
              noteId: String(note?.id || ''),
              addTime: note?.add_time || note?.addTime || null,
              updateTime: note?.update_time || note?.updateTime || null,
              hasKfwCredentials: hasExplicitKfwCredentials,
              invalidatesKfwCredentials: /(?:zugangsdaten|passwort|kennwort|kfw.{0,30}konto).{0,80}(?:stimm(?:en|t)\s+nicht|ungültig|ungueltig|geändert|geaendert|nicht\s+bestätigt|nicht\s+bestaetigt|nicht\s+bestatigt)|(?:konto|aktivierungslink).{0,60}(?:nicht\s+bestätigt|nicht\s+bestaetigt|nicht\s+bestatigt)/i.test(text),
              isIvaFundingRequest: Boolean(marker) || humanReadableIvaRequest,
              marker,
              kfwEvidenceMarker,
              includesKfwMissing: (Boolean(marker) || humanReadableIvaRequest) && /(?:kfw.{0,60}(?:konto|bestätigung|bestatigung|bestaetigung|zugang)|bestätigung.{0,60}kfw|bestatigung.{0,60}kfw|bestaetigung.{0,60}kfw)/i.test(text),
              redactedExcerpt,
            };
          });
          const customerName = String(deal.person_name || '').trim() || null;
          const title = String(deal.title || '').trim();
          const titleOrderNumber = title.match(/\bHH-(?:AN|AB)-[A-Z0-9-]{4,}\b/i)?.[0]?.toUpperCase() || null;
          const customerLocation = (() => {
            if (!customerName) return null;
            const tail = title.replace(/^AM:\s*/i, '').slice(customerName.length).replace(/^\s*-\s*/, '');
            const candidate = tail.split(/\s+-\s+/)[0]?.trim() || '';
            if (!candidate || candidate === '-' || /HH-(?:AN|AB)-|SOL\s*LIVING|HEAT\s*HERO|EKD/i.test(candidate)) return null;
            return candidate;
          })();
          const vpId = value(deal, 'Vertriebspartner');
          const vp = person(vpId);
          const plantField = field('Anlage');
          const incomeBonusValue = value(deal, 'Einkommensbonus', 'Einkommens-Bonus');
          const incomeBonusRequested = incomeBonusValue == null ? null
            : /^(ja|yes|beantragt|true|1)$/i.test(String(incomeBonusValue).trim()) ? true
              : /^(nein|no|nicht beantragt|false|0)$/i.test(String(incomeBonusValue).trim()) ? false : null;
          items.push({
            dealId: String(deal.id || id),
            url: window.location.origin + '/deal/' + id,
            dealTitle: title,
            pipeline: Number(deal.pipeline_id) === 1 ? 'Auftragsmachbarkeit' : String(deal.pipeline_id || ''),
            stage: stageById.get(String(deal.stage_id)) || String(deal.stage_id || ''),
            customerName,
            customerPersonId: deal.person_id ? String(deal.person_id) : null,
            orderNumber: value(deal, 'Auftragsnummer', 'Angebotsnummer', 'Angebotsnummer (sevdesk)') || titleOrderNumber,
            customerNumber: value(deal, 'Kundennummer', 'Kunden-Nr.'),
            phoneNumber: value(deal, 'Telefonnummer', 'Telefon', 'Mobilnummer'),
            plant: enumLabel(value(deal, 'Anlage'), plantField),
            incomeBonusRequested,
            location: customerLocation,
            vpName: vp?.name || (typeof vpId === 'string' && vpId.includes('@') ? vpId : null),
            vpPersonId: vpId ? String(vpId) : null,
            vpEmail: primaryEmail(vp) || (typeof vpId === 'string' && vpId.includes('@') ? vpId.toLowerCase() : null),
            files: files.map(file => String(file.name || file.file_name || '').trim()).filter(Boolean),
            noteCount: notes.length,
            latestNoteAt: noteEvidence.map(note => note.updateTime || note.addTime).filter(Boolean).sort().at(-1) || null,
            latestExternalNote: noteEvidence
              .filter(note => !note.isIvaFundingRequest)
              .sort((a, b) => String(b.updateTime || b.addTime || '').localeCompare(String(a.updateTime || a.addTime || '')))[0] || null,
            // Fachvorgabe: Ein dokumentiertes KfW-Zugangsdatenpaar aus E-Mail
            // und Passwort gilt für die Fördercheckliste als Kontobestätigung.
            // Abweichende spätere Hinweise bleiben separat sichtbar, heben
            // diese Checklistenwertung aber nicht automatisch auf.
            kfwAccountConfirmedByCredentials: noteEvidence.some(note => note.hasKfwCredentials),
            kfwCredentialEvidenceNoteIds: noteEvidence.filter(note => note.hasKfwCredentials).map(note => note.noteId),
            kfwCredentialInvalidationNoteIds: noteEvidence.filter(note => note.invalidatesKfwCredentials).map(note => note.noteId),
            ivaFundingRequestNotes: noteEvidence.filter(note => note.isIvaFundingRequest),
          });
        } catch (error) {
          items.push({ dealId: id, error: error.message });
        }
      }
      return JSON.stringify({ items });
    })()`, { dealId: sourceDealId, timeoutMs: 120000 });
    const parsed = JSON.parse(raw);
    if (parsed.fatal) throw new Error('Der angemeldete Pipedrive-Lesezugriff ist nicht verfügbar.');
    for (const item of parsed.items || []) {
      if (item.error) {
        errors.push({ dealId: item.dealId, error: item.error });
        continue;
      }
      snapshots.push({
        ...item,
        documents: item.files.map(fileName => classifyFundingDocumentName(fileName)),
        readOnly: true,
        mutated: false,
        source: 'pipedrive-read-api',
      });
    }
    if (typeof onProgress === 'function') onProgress({ processed: Math.min(offset + batch.length, ids.length), total: ids.length });
  }

  return {
    requested: ids.length,
    read: snapshots.length,
    failed: errors.length,
    snapshots,
    errors,
    readOnly: true,
    mutated: false,
    source: 'pipedrive-read-api',
  };
  } finally {
    await closeTemporaryPipedriveDealTabs(sourceCreatedIds).catch(() => {});
  }
}

async function uploadPipedriveFileViaSignedInSession({ dealId, filePath, fileName }) {
  const data = await readFile(filePath);
  if (data.length > 20 * 1024 * 1024) throw new Error(`${fileName}: Datei ist groesser als 20 MB.`);
  if (data.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error(`${fileName}: Nur gepruefte PDF-Dateien duerfen hochgeladen werden.`);

  const uploadId = `iva-upload-${randomUUID()}`;
  const base64 = data.toString('base64');
  const chunkSize = 60_000;
  const chunkCount = Math.ceil(base64.length / chunkSize);
  const initialized = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
    window.__ivaPipedriveUploads ||= {};
    window.__ivaPipedriveUploads[${JSON.stringify(uploadId)}] = {
      status: 'receiving',
      chunks: [],
      expectedChunks: ${chunkCount},
      fileName: ${JSON.stringify(fileName)},
      dealId: ${JSON.stringify(String(dealId))},
    };
    return JSON.stringify({ initialized: true });
  })()`, { dealId, timeoutMs: 15000 }));
  if (!initialized.initialized) throw new Error(`${fileName}: Upload konnte nicht vorbereitet werden.`);

  try {
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = base64.slice(index * chunkSize, (index + 1) * chunkSize);
      const received = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
        const state = window.__ivaPipedriveUploads?.[${JSON.stringify(uploadId)}];
        if (!state || state.status !== 'receiving') return JSON.stringify({ error: 'upload_state_missing' });
        state.chunks[${index}] = ${JSON.stringify(chunk)};
        return JSON.stringify({ received: state.chunks.filter(Boolean).length });
      })()`, { dealId, timeoutMs: 15000 }));
      if (received.error || received.received !== index + 1) {
        throw new Error(`${fileName}: Upload-Block ${index + 1}/${chunkCount} wurde nicht bestaetigt.`);
      }
    }

    const started = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
      const uploadId = ${JSON.stringify(uploadId)};
      const state = window.__ivaPipedriveUploads?.[uploadId];
      if (!state || state.chunks.filter(Boolean).length !== state.expectedChunks) {
        return JSON.stringify({ error: 'incomplete_upload_buffer' });
      }
      state.status = 'uploading';
      (async () => {
        try {
          const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
          const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
          if (!sessionToken) throw new Error('missing_session_token');
          const binary = atob(state.chunks.join(''));
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          const form = new FormData();
          form.append('file', new Blob([bytes], { type: 'application/pdf' }), state.fileName);
          form.append('deal_id', state.dealId);
          state.chunks = [];
          const response = await fetch('/api/v1/files?strict_mode=true&session_token=' + encodeURIComponent(sessionToken), {
            method: 'POST',
            credentials: 'same-origin',
            body: form,
          });
          const body = await response.text();
          let payload = null;
          try { payload = JSON.parse(body); } catch {}
          if (!response.ok || payload?.success === false) {
            throw new Error('HTTP ' + response.status + ': ' + String(payload?.error || body || 'upload_failed').slice(0, 300));
          }
          state.status = 'complete';
          state.result = {
            id: payload?.data?.id ? String(payload.data.id) : null,
            name: String(payload?.data?.name || payload?.data?.file_name || state.fileName),
          };
        } catch (error) {
          state.status = 'error';
          state.error = String(error?.message || error).slice(0, 500);
        }
      })();
      return JSON.stringify({ started: true });
    })()`, { dealId, timeoutMs: 15000 }));
    if (started.error || !started.started) throw new Error(`${fileName}: Pipedrive-Upload konnte nicht gestartet werden.`);

    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await wait(750);
      const status = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
        const state = window.__ivaPipedriveUploads?.[${JSON.stringify(uploadId)}];
        return JSON.stringify(state ? { status: state.status, error: state.error || null, result: state.result || null } : { status: 'missing' });
      })()`, { dealId, timeoutMs: 15000 }));
      if (status.status === 'complete') return status.result;
      if (status.status === 'error' || status.status === 'missing') {
        throw new Error(`${fileName}: ${status.error || 'Upload-Status ging verloren.'}`);
      }
    }
    throw new Error(`${fileName}: Pipedrive-Upload wurde nicht innerhalb von 120 Sekunden bestaetigt.`);
  } finally {
    await executePipedriveJavaScript(String.raw`(() => {
      if (window.__ivaPipedriveUploads) delete window.__ivaPipedriveUploads[${JSON.stringify(uploadId)}];
      return 'cleaned';
    })()`, { dealId, timeoutMs: 15000 }).catch(() => {});
  }
}

export async function uploadPipedriveDealFiles({ dealId, directory } = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  if (!id) throw new Error('Fuer den Pipedrive-Dateiupload fehlt eine gueltige Deal-ID.');
  const absoluteDirectory = path.resolve(String(directory || ''));
  const directoryInfo = await stat(absoluteDirectory);
  if (!directoryInfo.isDirectory()) throw new Error('Der Pipedrive-Uploadpfad ist kein Verzeichnis.');
  const fileNames = (await readdir(absoluteDirectory)).filter(name => !name.startsWith('.')).sort();
  if (!fileNames.length) throw new Error('Das Pipedrive-Uploadverzeichnis ist leer.');
  for (const fileName of fileNames) {
    if (!fileName.toLowerCase().endsWith('.pdf')) throw new Error(`${fileName}: Im Uploadordner sind nur PDF-Dateien erlaubt.`);
    const file = await stat(path.join(absoluteDirectory, fileName));
    if (!file.isFile()) throw new Error('Das Pipedrive-Uploadverzeichnis darf ausschliesslich Dateien enthalten.');
  }

  const createdIds = await openTemporaryPipedriveDealTabs([id]);
  try {
    await activatePipedriveDealTab(id);
    await waitForPipedriveDealTab(id);
    const before = await readPipedriveFundingDealsViaApi({ dealIds: [id], batchSize: 1 });
    const beforeFiles = new Set(before.snapshots[0]?.files || []);
    const results = [];
    for (const fileName of fileNames) {
      if (beforeFiles.has(fileName)) {
        results.push({ fileName, status: 'already_present', uploaded: false, verified: true });
        continue;
      }
      const result = await uploadPipedriveFileViaSignedInSession({
        dealId: id,
        filePath: path.join(absoluteDirectory, fileName),
        fileName,
      });
      results.push({ fileName, status: 'uploaded', uploaded: true, apiResult: result });
    }

    const after = await readPipedriveFundingDealsViaApi({ dealIds: [id], batchSize: 1 });
    const afterFiles = new Set(after.snapshots[0]?.files || []);
    for (const result of results) result.verified = afterFiles.has(result.fileName);
    if (results.some(result => !result.verified)) {
      throw new Error(`Pipedrive konnte nicht alle Uploads verifizieren: ${results.filter(result => !result.verified).map(result => result.fileName).join(', ')}`);
    }
    return {
      dealId: id,
      results,
      uploadedCount: results.filter(result => result.uploaded).length,
      fullyVerified: true,
      deletedFromPipedrive: false,
    };
  } finally {
    await closeTemporaryPipedriveDealTabs(createdIds).catch(() => {});
  }
}

const escapePipedriveNoteHtml = value => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

function fundingRequestRecipientText({ vpName, vpEmail, ...routingInput } = {}) {
  const vp = String(vpName || vpEmail || '').replace(/\s+/g, ' ').trim();
  const supervisor = resolveFundingSupervisor({ vpName, vpEmail, ...routingInput });
  return {
    supervisor,
    text: vp ? `bei ${supervisor.name} und ${vp} angefragt.` : `bei ${supervisor.name} angefragt.`,
  };
}

export async function createPipedriveFundingRequestNote({ dealId, missingDocumentLabels, vpName, vpEmail, ...routingInput } = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  if (!id) throw new Error('Fuer die Pipedrive-Notiz fehlt eine gueltige Deal-ID.');
  const labels = [...new Set((Array.isArray(missingDocumentLabels) ? missingDocumentLabels : [])
    .map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (!labels.length) throw new Error('Ohne fehlende Unterlagen wird keine Pipedrive-Notiz erzeugt.');
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, labels })).digest('hex').slice(0, 24);
  const marker = `IVA-FUNDING-REQUEST:${id}:${fingerprint}`;
  const recipientText = fundingRequestRecipientText({ vpName, vpEmail, ...routingInput }).text;
  const content = `<p><strong>Fehlende Unterlagen:</strong></p><ul>${labels.map(label => `<li>${escapePipedriveNoteHtml(label)}</li>`).join('')}</ul><p>${escapePipedriveNoteHtml(recipientText)}</p><p>(Notiz von Nadine)</p>`;

  const createdIds = await openTemporaryPipedriveDealTabs([id]);
  try {
    await activatePipedriveDealTab(id);
    await waitForPipedriveDealTab(id);
    const result = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
      const dealId = ${JSON.stringify(id)};
      const marker = ${JSON.stringify(marker)};
      const content = ${JSON.stringify(content)};
      const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
      const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
      if (!sessionToken) return JSON.stringify({ error: 'missing_session_token' });
      const request = (method, path, body = null) => {
        const separator = path.includes('?') ? '&' : '?';
        const xhr = new XMLHttpRequest();
        xhr.open(method, path + separator + 'strict_mode=true&session_token=' + encodeURIComponent(sessionToken), false);
        if (body) xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(body ? JSON.stringify(body) : null);
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 200 || xhr.status >= 300 || payload?.success === false) {
          throw new Error('HTTP ' + xhr.status + ': ' + String(payload?.error || xhr.responseText || 'request_failed').slice(0, 300));
        }
        return payload?.data;
      };
      const semanticText = value => {
        const document = new DOMParser().parseFromString(String(value || ''), 'text/html');
        return String(document.body?.textContent || value || '').replace(/\s+/g, ' ').trim();
      };
      try {
        const current = request('GET', '/api/v1/notes?deal_id=' + encodeURIComponent(dealId) + '&start=0&limit=500') || [];
        const expectedText = semanticText(content);
        const existing = current.find(note => semanticText(note.content) === expectedText
          && /\(Notiz von Nadine\)\s*$/i.test(semanticText(note.content)));
        if (existing) return JSON.stringify({ created: false, alreadyPresent: true, noteId: String(existing.id || ''), marker });
        const note = request('POST', '/api/v1/notes', { deal_id: Number(dealId), content });
        const verified = (request('GET', '/api/v1/notes?deal_id=' + encodeURIComponent(dealId) + '&start=0&limit=500') || [])
          .find(item => semanticText(item.content) === expectedText
            && /\(Notiz von Nadine\)\s*$/i.test(semanticText(item.content)));
        if (!verified) return JSON.stringify({ error: 'note_not_verified' });
        return JSON.stringify({ created: true, alreadyPresent: false, noteId: String(verified.id || note?.id || ''), marker });
      } catch (error) {
        return JSON.stringify({ error: String(error?.message || error) });
      }
    })()`, { dealId: id, timeoutMs: 30000 }));
    if (result.error) throw new Error(`Pipedrive-Notiz fuer Deal ${id}: ${result.error}`);
    return { dealId: id, ...result, mutated: result.created === true, deletedFromPipedrive: false };
  } finally {
    await closeTemporaryPipedriveDealTabs(createdIds).catch(() => {});
  }
}

function preparePipedriveFundingRequestNote({ dealId, missingDocumentLabels, vpName, vpEmail, ...routingInput } = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  if (!id) throw new Error('Fuer die Pipedrive-Notiz fehlt eine gueltige Deal-ID.');
  const labels = [...new Set((Array.isArray(missingDocumentLabels) ? missingDocumentLabels : [])
    .map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (!labels.length) throw new Error(`Deal ${id}: Ohne fehlende Unterlagen wird keine Pipedrive-Notiz erzeugt.`);
  const fingerprint = createHash('sha256').update(JSON.stringify({ id, labels })).digest('hex').slice(0, 24);
  const marker = `IVA-FUNDING-REQUEST:${id}:${fingerprint}`;
  const recipientText = fundingRequestRecipientText({ vpName, vpEmail, ...routingInput }).text;
  const content = `<p><strong>Fehlende Unterlagen:</strong></p><ul>${labels.map(label => `<li>${escapePipedriveNoteHtml(label)}</li>`).join('')}</ul><p>${escapePipedriveNoteHtml(recipientText)}</p><p>(Notiz von Nadine)</p>`;
  return { dealId: id, marker, content };
}

function preparePipedriveFundingRequestNoteUpdate({ dealId, noteId, marker, missingDocumentLabels, vpName, vpEmail, ...routingInput } = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  const safeNoteId = String(noteId || '').replace(/\D/g, '');
  const safeMarker = String(marker || '').trim();
  if (!id || !safeNoteId) throw new Error('Für die Pipedrive-Notizaktualisierung fehlen Deal- oder Notiz-ID.');
  if (safeMarker && !new RegExp(`^IVA-FUNDING-REQUEST:${id}:[0-9a-f]{24}$`, 'i').test(safeMarker)) {
    throw new Error(`Deal ${id}: Die IVA-Notizkennung ist ungültig.`);
  }
  const labels = [...new Set((Array.isArray(missingDocumentLabels) ? missingDocumentLabels : [])
    .map(value => String(value || '').replace(/\s+/g, ' ').trim()).filter(Boolean))];
  if (!labels.length) throw new Error(`Deal ${id}: Eine leere IVA-Notiz darf nur über den gesonderten Löschpfad entfernt werden.`);
  const recipientText = fundingRequestRecipientText({ vpName, vpEmail, ...routingInput }).text;
  const content = `<p><strong>Fehlende Unterlagen:</strong></p><ul>${labels.map(label => `<li>${escapePipedriveNoteHtml(label)}</li>`).join('')}</ul><p>${escapePipedriveNoteHtml(recipientText)}</p><p>(Notiz von Nadine)</p>`;
  return { dealId: id, noteId: safeNoteId, marker: safeMarker, content };
}

export function renderPipedriveFundingInformationNote({ heading, details } = {}) {
  const safeHeading = String(heading || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!safeHeading) throw new Error('Für die Pipedrive-Information fehlt eine Überschrift.');
  const safeDetails = (Array.isArray(details) ? details : []).map(item => {
    if (typeof item === 'string') return { label: '', value: item.replace(/\s+/g, ' ').trim() };
    return {
      label: String(item?.label || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      value: String(item?.value || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    };
  }).filter(item => item.value).slice(0, 30);
  if (!safeDetails.length) throw new Error('Für die Pipedrive-Information fehlen konkrete Inhalte.');
  if (/kfw/i.test(safeHeading)) {
    const labels = safeDetails.map(item => item.label.toLowerCase());
    if (!labels.some(label => /e-mail|email/.test(label)) || !labels.some(label => /passwort|kennwort/.test(label))) {
      throw new Error('Eine KfW-Zugangsdaten-Notiz muss E-Mail-Adresse und Passwort konkret ausweisen.');
    }
  }
  const content = `<p><strong>${escapePipedriveNoteHtml(safeHeading)}</strong></p><ul>${safeDetails.map(item => `<li>${item.label ? `<strong>${escapePipedriveNoteHtml(item.label)}:</strong> ` : ''}${escapePipedriveNoteHtml(item.value)}</li>`).join('')}</ul><p>(Notiz von Nadine)</p>`;
  return { heading: safeHeading, details: safeDetails, content };
}

export async function createPipedriveFundingInformationNote({ dealId, heading, details } = {}) {
  const id = String(dealId || '').replace(/\D/g, '');
  if (!id) throw new Error('Für die Pipedrive-Information fehlt eine gültige Deal-ID.');
  const rendered = renderPipedriveFundingInformationNote({ heading, details });
  const createdIds = await openTemporaryPipedriveDealTabs([id]);
  try {
    await activatePipedriveDealTab(id);
    await waitForPipedriveDealTab(id);
    const result = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
      const dealId = ${JSON.stringify(id)};
      const content = ${JSON.stringify(rendered.content)};
      const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
      const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
      if (!sessionToken) return JSON.stringify({ error: 'missing_session_token' });
      const request = (method, path, body = null) => {
        const separator = path.includes('?') ? '&' : '?';
        const xhr = new XMLHttpRequest();
        xhr.open(method, path + separator + 'strict_mode=true&session_token=' + encodeURIComponent(sessionToken), false);
        if (body) xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(body ? JSON.stringify(body) : null);
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 200 || xhr.status >= 300 || payload?.success === false) throw new Error('HTTP ' + xhr.status);
        return payload?.data;
      };
      const semanticText = value => {
        const document = new DOMParser().parseFromString(String(value || ''), 'text/html');
        return String(document.body?.textContent || value || '').replace(/\s+/g, ' ').trim();
      };
      try {
        const path = '/api/v1/notes?deal_id=' + encodeURIComponent(dealId) + '&start=0&limit=500';
        const expectedText = semanticText(content);
        const current = request('GET', path) || [];
        const existing = current.find(note => semanticText(note.content) === expectedText);
        if (existing) return JSON.stringify({ created: false, alreadyPresent: true, noteId: String(existing.id || '') });
        const created = request('POST', '/api/v1/notes', { deal_id: Number(dealId), content });
        const verified = (request('GET', path) || []).find(note => semanticText(note.content) === expectedText
          && /\(Notiz von Nadine\)\s*$/i.test(semanticText(note.content))
          && !/IVA-(?:FUNDING|KFW)-/i.test(String(note.content || '')));
        if (!verified) throw new Error('note_not_verified');
        return JSON.stringify({ created: true, alreadyPresent: false, noteId: String(verified.id || created?.id || '') });
      } catch (error) {
        return JSON.stringify({ error: String(error?.message || error) });
      }
    })()`, { dealId: id, timeoutMs: 30000 }));
    if (result.error) throw new Error(`Pipedrive-Information für Deal ${id}: ${result.error}`);
    return { dealId: id, heading: rendered.heading, ...result, mutated: result.created === true, deletedFromPipedrive: false };
  } finally {
    await closeTemporaryPipedriveDealTabs(createdIds).catch(() => {});
  }
}

export async function updatePipedriveFundingRequestNotes({ items } = {}) {
  const prepared = (Array.isArray(items) ? items : []).map(preparePipedriveFundingRequestNoteUpdate);
  if (!prepared.length) return { requested: 0, updated: 0, unchanged: 0, failed: 0, results: [], mutated: false };
  if (prepared.length > 100) throw new Error('In einem Lauf dürfen höchstens 100 IVA-Pipedrive-Notizen aktualisiert werden.');
  if (new Set(prepared.map(item => item.noteId)).size !== prepared.length) throw new Error('Eine Pipedrive-Notiz ist im Aktualisierungslauf mehrfach enthalten.');

  const sourceDealId = prepared.find(item => item.dealId === '8153')?.dealId || prepared[0].dealId;
  const createdIds = await openTemporaryPipedriveDealTabs([sourceDealId]);
  try {
    await activatePipedriveDealTab(sourceDealId);
    await waitForPipedriveDealTab(sourceDealId);
    const result = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
      const items = ${JSON.stringify(prepared)};
      const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
      const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
      if (!sessionToken) return JSON.stringify({ fatal: 'missing_session_token', results: [] });
      const request = (method, path, body = null) => {
        const separator = path.includes('?') ? '&' : '?';
        const xhr = new XMLHttpRequest();
        xhr.open(method, path + separator + 'strict_mode=true&session_token=' + encodeURIComponent(sessionToken), false);
        if (body) xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(body ? JSON.stringify(body) : null);
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 200 || xhr.status >= 300 || payload?.success === false) {
          throw new Error('HTTP ' + xhr.status + ': ' + String(payload?.error || xhr.responseText || 'request_failed').slice(0, 240));
        }
        return payload?.data;
      };
      const semanticText = content => {
        const document = new DOMParser().parseFromString(String(content || ''), 'text/html');
        return String(document.body?.textContent || content || '').replace(/\s+/g, ' ').trim();
      };
      const results = [];
      for (const item of items) {
        try {
          const path = '/api/v1/notes?deal_id=' + encodeURIComponent(item.dealId) + '&start=0&limit=500';
          const current = request('GET', path) || [];
          const exact = current.filter(note => String(note.id) === item.noteId);
          const currentText = exact.length === 1 ? semanticText(exact[0].content) : '';
          const legacyMarkerMatches = item.marker && String(exact[0]?.content || '').includes(item.marker);
          const humanReadableRequestMatches = /^Fehlende Unterlagen:/i.test(currentText)
            && /angefragt\./i.test(currentText)
            && /\(Notiz von Nadine\)\s*(?:IVA-FUNDING-REQUEST:[^\s]+)?\s*$/i.test(currentText);
          if (exact.length !== 1 || (!legacyMarkerMatches && !humanReadableRequestMatches)) {
            throw new Error('safety_check_failed');
          }
          if (String(exact[0].content || '') === item.content) {
            results.push({ dealId: item.dealId, noteId: item.noteId, updated: false, unchanged: true, verified: true });
            continue;
          }
          request('PUT', '/api/v1/notes/' + encodeURIComponent(item.noteId), { content: item.content });
          const expectedText = semanticText(item.content);
          const verified = (request('GET', path) || []).filter(note => String(note.id) === item.noteId
            && semanticText(note.content) === expectedText
            && /\(Notiz von Nadine\)\s*$/i.test(semanticText(note.content))
            && !/IVA-FUNDING-REQUEST:/i.test(String(note.content || '')));
          if (verified.length !== 1) throw new Error('update_not_verified');
          results.push({ dealId: item.dealId, noteId: item.noteId, updated: true, unchanged: false, verified: true });
        } catch (error) {
          results.push({ dealId: item.dealId, noteId: item.noteId, updated: false, unchanged: false, verified: false, error: String(error?.message || error) });
        }
      }
      return JSON.stringify({ results });
    })()`, { dealId: sourceDealId, timeoutMs: 180000 }));
    if (result.fatal) throw new Error('Der angemeldete Pipedrive-Notizzugriff ist nicht verfügbar.');
    const results = result.results || [];
    return {
      requested: prepared.length,
      updated: results.filter(item => item.updated).length,
      unchanged: results.filter(item => item.unchanged).length,
      failed: results.filter(item => !item.verified).length,
      results,
      mutated: results.some(item => item.updated),
      deletedFromPipedrive: false,
    };
  } finally {
    await closeTemporaryPipedriveDealTabs(createdIds).catch(() => {});
  }
}

export async function createPipedriveFundingRequestNotes({ items } = {}) {
  const prepared = (Array.isArray(items) ? items : []).map(preparePipedriveFundingRequestNote);
  if (!prepared.length) return { requested: 0, created: 0, alreadyPresent: 0, failed: 0, results: [], mutated: false };
  if (prepared.length > 100) throw new Error('In einem Lauf duerfen hoechstens 100 Pipedrive-Notizen erzeugt werden.');
  if (new Set(prepared.map(item => item.dealId)).size !== prepared.length) throw new Error('Ein Pipedrive-Deal ist im Notizlauf mehrfach enthalten.');

  const sourceDealId = prepared.find(item => item.dealId === '8153')?.dealId || prepared[0].dealId;
  const createdIds = await openTemporaryPipedriveDealTabs([sourceDealId]);
  try {
    await activatePipedriveDealTab(sourceDealId);
    await waitForPipedriveDealTab(sourceDealId);
    const result = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
      const items = ${JSON.stringify(prepared)};
      const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
      const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
      if (!sessionToken) return JSON.stringify({ fatal: 'missing_session_token', results: [] });
      const request = (method, path, body = null) => {
        const separator = path.includes('?') ? '&' : '?';
        const xhr = new XMLHttpRequest();
        xhr.open(method, path + separator + 'strict_mode=true&session_token=' + encodeURIComponent(sessionToken), false);
        if (body) xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(body ? JSON.stringify(body) : null);
        let payload = null;
        try { payload = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status < 200 || xhr.status >= 300 || payload?.success === false) {
          throw new Error('HTTP ' + xhr.status + ': ' + String(payload?.error || xhr.responseText || 'request_failed').slice(0, 240));
        }
        return payload?.data;
      };
      const semanticText = content => {
        const document = new DOMParser().parseFromString(String(content || ''), 'text/html');
        return String(document.body?.textContent || content || '').replace(/\s+/g, ' ').trim();
      };
      const results = [];
      for (const item of items) {
        try {
          const path = '/api/v1/notes?deal_id=' + encodeURIComponent(item.dealId) + '&start=0&limit=500';
          const current = request('GET', path) || [];
          const expectedText = semanticText(item.content);
          const existing = current.find(note => semanticText(note.content) === expectedText
            && /\(Notiz von Nadine\)\s*$/i.test(semanticText(note.content)));
          if (existing) {
            results.push({ dealId: item.dealId, created: false, alreadyPresent: true, verified: true, noteId: String(existing.id || '') });
            continue;
          }
          const note = request('POST', '/api/v1/notes', { deal_id: Number(item.dealId), content: item.content });
          const verified = (request('GET', path) || []).find(candidate => semanticText(candidate.content) === expectedText
            && /\(Notiz von Nadine\)\s*$/i.test(semanticText(candidate.content))
            && !/IVA-FUNDING-REQUEST:/i.test(String(candidate.content || '')));
          if (!verified) throw new Error('note_not_verified');
          results.push({ dealId: item.dealId, created: true, alreadyPresent: false, verified: true, noteId: String(verified.id || note?.id || '') });
        } catch (error) {
          results.push({ dealId: item.dealId, created: false, alreadyPresent: false, verified: false, error: String(error?.message || error) });
        }
      }
      return JSON.stringify({ results });
    })()`, { dealId: sourceDealId, timeoutMs: 180000 }));
    if (result.fatal) throw new Error('Der angemeldete Pipedrive-Notizzugriff ist nicht verfuegbar.');
    const results = result.results || [];
    return {
      requested: prepared.length,
      created: results.filter(item => item.created).length,
      alreadyPresent: results.filter(item => item.alreadyPresent).length,
      failed: results.filter(item => !item.verified).length,
      results,
      mutated: results.some(item => item.created),
      deletedFromPipedrive: false,
    };
  } finally {
    await closeTemporaryPipedriveDealTabs(createdIds).catch(() => {});
  }
}

async function readPipedriveApiBatchAsync(batch, sourceDealId) {
  const jobId = `iva-funding-${randomUUID()}`;
  let started;
  try {
    started = await executePipedriveJavaScript(String.raw`(() => {
    const jobId = ${JSON.stringify(jobId)};
    const ids = ${JSON.stringify(batch)};
    window.__ivaFundingReadJobs = window.__ivaFundingReadJobs || {};
    window.__ivaFundingReadJobs[jobId] = { status: 'running' };
    (async () => {
      const resource = performance.getEntriesByType('resource').map(entry => entry.name).find(name => name.includes('session_token='));
      const sessionToken = resource ? new URL(resource).searchParams.get('session_token') : '';
      if (!sessionToken) throw new Error('missing_session_token');
      const request = async path => {
        const separator = path.includes('?') ? '&' : '?';
        const response = await fetch(path + separator + 'strict_mode=true&session_token=' + encodeURIComponent(sessionToken), { credentials: 'same-origin' });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload?.success === false) throw new Error('HTTP ' + response.status + ' für ' + path.split('?')[0]);
        return payload?.data;
      };
      const [fields, stages] = await Promise.all([
        request('/api/v1/dealFields?start=0&limit=500'),
        request('/api/v1/stages?pipeline_id=1&start=0&limit=500'),
      ]);
      const fieldByName = new Map((fields || []).map(field => [String(field.name || '').toLowerCase(), field]));
      const stageById = new Map((stages || []).map(stage => [String(stage.id), stage.name]));
      const personCache = new Map();
      const field = (...names) => names.map(name => fieldByName.get(name.toLowerCase())).find(Boolean) || null;
      const value = (deal, ...names) => {
        const definition = field(...names);
        return definition ? deal?.[definition.key] ?? null : null;
      };
      const enumLabel = (rawValue, definition) => definition?.options?.find(option => String(option.id) === String(rawValue))?.label || rawValue || null;
      const person = async id => {
        if (!id) return null;
        const key = String(id);
        if (!personCache.has(key)) personCache.set(key, request('/api/v1/persons/' + encodeURIComponent(key)).catch(() => null));
        return personCache.get(key);
      };
      const primaryEmail = record => {
        const emails = Array.isArray(record?.email) ? record.email : [];
        return emails.find(item => item?.primary && item?.value)?.value || emails.find(item => item?.value)?.value || null;
      };
      const items = await Promise.all(ids.map(async id => {
        try {
          const [deal, files] = await Promise.all([
            request('/api/v1/deals/' + id + '?get_activity_summary=false&get_updated_deal_stage_averages=false'),
            request('/api/v1/deals/' + id + '/files?start=0&limit=500'),
          ]);
          const customerName = String(deal?.person_name || '').trim() || null;
          const title = String(deal?.title || '').trim();
          const titleOrderNumber = title.match(/\bHH-(?:AN|AB)-[A-Z0-9-]{4,}\b/i)?.[0]?.toUpperCase() || null;
          const customerLocation = (() => {
            if (!customerName) return null;
            const tail = title.replace(/^AM:\s*/i, '').slice(customerName.length).replace(/^\s*-\s*/, '');
            const candidate = tail.split(/\s+-\s+/)[0]?.trim() || '';
            if (!candidate || candidate === '-' || /HH-(?:AN|AB)-|SOL\s*LIVING|HEAT\s*HERO|EKD/i.test(candidate)) return null;
            return candidate;
          })();
          const vpId = value(deal, 'Vertriebspartner');
          const vp = await person(vpId);
          const plantField = field('Anlage');
          const incomeBonusValue = value(deal, 'Einkommensbonus', 'Einkommens-Bonus');
          const incomeBonusRequested = incomeBonusValue == null ? null
            : /^(ja|yes|beantragt|true|1)$/i.test(String(incomeBonusValue).trim()) ? true
              : /^(nein|no|nicht beantragt|false|0)$/i.test(String(incomeBonusValue).trim()) ? false : null;
          return {
            dealId: String(deal?.id || id),
            url: window.location.origin + '/deal/' + id,
            dealTitle: title,
            pipeline: Number(deal?.pipeline_id) === 1 ? 'Auftragsmachbarkeit' : String(deal?.pipeline_id || ''),
            stage: stageById.get(String(deal?.stage_id)) || String(deal?.stage_id || ''),
            customerName,
            customerPersonId: deal?.person_id ? String(deal.person_id) : null,
            orderNumber: value(deal, 'Auftragsnummer', 'Angebotsnummer', 'Angebotsnummer (sevdesk)') || titleOrderNumber,
            customerNumber: value(deal, 'Kundennummer', 'Kunden-Nr.'),
            phoneNumber: value(deal, 'Telefonnummer', 'Telefon', 'Mobilnummer'),
            plant: enumLabel(value(deal, 'Anlage'), plantField),
            incomeBonusRequested,
            location: customerLocation,
            vpName: vp?.name || (typeof vpId === 'string' && vpId.includes('@') ? vpId : null),
            vpPersonId: vpId ? String(vpId) : null,
            vpEmail: primaryEmail(vp) || (typeof vpId === 'string' && vpId.includes('@') ? vpId.toLowerCase() : null),
            files: (files || []).map(file => String(file.name || file.file_name || '').trim()).filter(Boolean),
          };
        } catch (error) {
          return { dealId: id, error: error.message };
        }
      }));
      window.__ivaFundingReadJobs[jobId] = { status: 'complete', value: { items } };
    })().catch(error => {
      window.__ivaFundingReadJobs[jobId] = { status: 'failed', error: String(error?.message || error) };
    });
    return jobId;
  })()`, { dealId: sourceDealId });
  } catch (error) {
    throw new Error(`Start fehlgeschlagen: ${error.message}`);
  }
  if (started !== jobId) throw new Error('Der Pipedrive-Leseauftrag konnte nicht gestartet werden.');

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    let raw;
    try {
      raw = await executePipedriveJavaScript(String.raw`(() => {
      const jobs = window.__ivaFundingReadJobs || {};
      const job = jobs[${JSON.stringify(jobId)}];
      if (!job) return JSON.stringify({ status: 'missing' });
      if (job.status === 'complete' || job.status === 'failed') delete jobs[${JSON.stringify(jobId)}];
      return JSON.stringify(job);
    })()`, { dealId: sourceDealId });
    } catch (error) {
      throw new Error(`Statusabfrage fehlgeschlagen: ${error.message}`);
    }
    const status = JSON.parse(raw);
    if (status.status === 'complete') return status.value;
    if (status.status === 'failed') throw new Error(`Pipedrive-Lesezugriff fehlgeschlagen: ${status.error}`);
    await wait(250);
  }
  throw new Error('Der Pipedrive-Lesezugriff hat das Zeitlimit überschritten.');
}

export async function readPipedriveFundingDealsFast({ dealIds, batchSize = 12, onProgress } = {}) {
  const ids = [...new Set((Array.isArray(dealIds) ? dealIds : []).map(String))].filter(id => /^\d+$/.test(id));
  if (!ids.length) throw new Error('Für den Förder-Prüflauf fehlen Deal-IDs.');
  const safeBatchSize = Math.max(1, Math.min(20, Number(batchSize) || 12));
  const snapshots = [];
  const errors = [];
  const sourceDealId = ids.includes('8153') ? '8153' : ids[0];
  const sourceCreatedIds = await openTemporaryPipedriveDealTabs([sourceDealId]);
  try {
    try {
      await activatePipedriveDealTab(sourceDealId);
      await waitForPipedriveDealTab(sourceDealId);
    } catch (error) {
      throw new Error(`Pipedrive-Lesequelle konnte nicht vorbereitet werden: ${error.message}`);
    }
    for (let offset = 0; offset < ids.length; offset += safeBatchSize) {
      const batch = ids.slice(offset, offset + safeBatchSize);
      let result;
      try {
        result = await readPipedriveApiBatchAsync(batch, sourceDealId);
      } catch (error) {
        throw new Error(`Pipedrive-Leseblock ${offset + 1}-${offset + batch.length} fehlgeschlagen: ${error.message}`);
      }
      for (const item of result.items || []) {
        if (item.error) {
          errors.push({ dealId: item.dealId, error: item.error });
          continue;
        }
        snapshots.push({
          ...item,
          documents: item.files.map(fileName => classifyFundingDocumentName(fileName)),
          readOnly: true,
          mutated: false,
          source: 'pipedrive-read-api-async',
        });
      }
      if (typeof onProgress === 'function') onProgress({ processed: Math.min(offset + batch.length, ids.length), total: ids.length });
    }
  } finally {
    await closeTemporaryPipedriveDealTabs(sourceCreatedIds).catch(() => {});
  }
  return {
    requested: ids.length,
    read: snapshots.length,
    failed: errors.length,
    snapshots,
    errors,
    readOnly: true,
    mutated: false,
    source: 'pipedrive-read-api-async',
  };
}

const WRITABLE_FUNDING_FIELDS = new Set(['Auftragsnummer', 'Kundennummer', 'Telefonnummer', 'Anlage']);

export async function applyPipedriveFundingFieldUpdates({ dealId, fieldProposals, confirmApply = false } = {}) {
  if (confirmApply !== true) throw new Error('Pipedrive-Felder wurden nicht geändert: confirmApply=true fehlt.');
  if (!/^\d+$/.test(String(dealId || ''))) throw new Error('Für die Pipedrive-Feldpflege fehlt eine gültige Deal-ID.');
  const requested = (Array.isArray(fieldProposals?.proposals) ? fieldProposals.proposals : [])
    .filter(item => item?.action === 'propose_fill'
      && Number.isInteger(item.evidence?.page)
      && Number(item.evidence?.confidence) >= 0.9
      && String(item.evidence?.sourceFile || '').toLowerCase().endsWith('.pdf'))
    .map(item => ({ targetField: String(item.targetField || ''), value: String(item.proposedValue || '').trim().slice(0, 100) }))
    .filter(item => WRITABLE_FUNDING_FIELDS.has(item.targetField) && item.value);
  if (!requested.length) return { dealId: String(dealId), results: [], mutated: false, reason: 'Keine sicher befüllbaren leeren Felder.' };
  if (requested.length > WRITABLE_FUNDING_FIELDS.size) throw new Error('Zu viele Pipedrive-Feldänderungen in einem Vorgang.');

  const preflight = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const requested = ${JSON.stringify(requested)};
    const fieldNames = [...document.querySelectorAll('[data-testid="field-name"]')];
    return JSON.stringify(requested.map(item => {
      const name = fieldNames.find(element => clean(element.innerText) === item.targetField);
      const row = name?.parentElement || null;
      const value = clean(row?.querySelector('[data-testid="fields-list-row-field-components"]')?.innerText);
      return {
        ...item,
        found: Boolean(row),
        currentValue: value && value !== '-' ? value : null,
        editable: Boolean(row?.querySelector('button[aria-label="Bearbeiten"]')),
      };
    }));
  })()`, { dealId }));

  const results = [];
  for (const item of preflight) {
    if (!item.found) {
      results.push({ targetField: item.targetField, status: 'field_not_found', mutated: false });
      continue;
    }
    if (item.currentValue) {
      results.push({ targetField: item.targetField, status: 'existing_value_present', mutated: false });
      continue;
    }
    if (!item.editable) {
      results.push({ targetField: item.targetField, status: 'field_not_editable', mutated: false });
      continue;
    }
    const opened = await executePipedriveJavaScript(String.raw`(() => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const name = [...document.querySelectorAll('[data-testid="field-name"]')].find(element => clean(element.innerText) === ${JSON.stringify(item.targetField)});
      const button = name?.parentElement?.querySelector('button[aria-label="Bearbeiten"]');
      if (!button) return 'missing_edit_button';
      button.click();
      return 'opened';
    })()`, { dealId });
    if (opened !== 'opened') {
      results.push({ targetField: item.targetField, status: opened, mutated: false });
      continue;
    }
    await wait(350);
    let saved;
    if (item.targetField === 'Anlage') {
      const menu = await executePipedriveJavaScript(String.raw`(() => {
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        const name = [...document.querySelectorAll('[data-testid="field-name"]')].find(element => clean(element.innerText) === 'Anlage');
        const row = name?.parentElement;
        const open = row?.querySelector('[role="combobox"] [aria-label="open menu"]');
        if (!open) return 'missing_select_menu';
        open.click();
        return 'menu_opened';
      })()`, { dealId });
      if (menu !== 'menu_opened') saved = menu;
      else {
        await wait(250);
        saved = await executePipedriveJavaScript(String.raw`(() => {
          const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
          const name = [...document.querySelectorAll('[data-testid="field-name"]')].find(element => clean(element.innerText) === 'Anlage');
          const row = name?.parentElement;
          const options = [...document.querySelectorAll('[role="listbox"] .cui5-option')]
            .filter(option => clean(option.innerText || option.textContent).toLowerCase() === ${JSON.stringify(item.value.toLowerCase())});
          if (options.length !== 1) return options.length ? 'ambiguous_select_option' : 'select_option_not_found';
          options[0].click();
          const save = [...row.querySelectorAll('button')].find(button => clean(button.innerText) === 'Speichern');
          if (!save || save.disabled) return 'save_unavailable';
          save.click();
          return 'save_clicked';
        })()`, { dealId });
      }
    } else {
      saved = await executePipedriveJavaScript(String.raw`(() => {
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        const name = [...document.querySelectorAll('[data-testid="field-name"]')].find(element => clean(element.innerText) === ${JSON.stringify(item.targetField)});
        const row = name?.parentElement;
        const input = row?.querySelector('input[type="text"]');
        if (!input) return 'missing_input';
        if (clean(input.value)) return 'input_not_empty';
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return 'missing_value_setter';
        setter.call(input, ${JSON.stringify(item.value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const save = [...row.querySelectorAll('button')].find(button => clean(button.innerText) === 'Speichern');
        if (!save || save.disabled) return 'save_unavailable';
        save.click();
        return 'save_clicked';
      })()`, { dealId });
    }
    if (saved !== 'save_clicked') {
      await executePipedriveJavaScript(String.raw`(() => {
        const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
        const name = [...document.querySelectorAll('[data-testid="field-name"]')].find(element => clean(element.innerText) === ${JSON.stringify(item.targetField)});
        const cancel = [...(name?.parentElement?.querySelectorAll('button') || [])].find(button => clean(button.innerText) === 'Abbrechen');
        cancel?.click();
        return 'cancelled';
      })()`, { dealId }).catch(() => {});
      results.push({ targetField: item.targetField, status: saved, mutated: false });
      continue;
    }
    await wait(900);
    const verification = JSON.parse(await executePipedriveJavaScript(String.raw`(() => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const norm = value => clean(value).toLowerCase().replace(/[^\p{L}\p{N}+]/gu, '');
      const name = [...document.querySelectorAll('[data-testid="field-name"]')].find(element => clean(element.innerText) === ${JSON.stringify(item.targetField)});
      const value = clean(name?.parentElement?.querySelector('[data-testid="fields-list-row-field-components"]')?.innerText);
      return JSON.stringify({ valuePresent: Boolean(value && value !== '-'), matches: norm(value) === norm(${JSON.stringify(item.value)}) });
    })()`, { dealId }));
    results.push({
      targetField: item.targetField,
      status: verification.matches ? 'updated_and_verified' : verification.valuePresent ? 'updated_value_needs_review' : 'update_not_verified',
      mutated: verification.valuePresent,
      verified: verification.matches,
    });
  }
  return {
    dealId: String(dealId),
    results,
    mutated: results.some(item => item.mutated),
    fullyVerified: results.length > 0 && results.every(item => item.status === 'updated_and_verified'),
  };
}

export async function diagnosePipedriveChrome() {
  const script = `tell application "Google Chrome"
set matchingCount to 0
set matchingURL to ""
repeat with w in windows
  repeat with t in tabs of w
    set tabURL to URL of t
    if tabURL contains "${PIPEDRIVE_HOST}" then
      set matchingCount to matchingCount + 1
      if matchingURL is "" then set matchingURL to tabURL
    end if
  end repeat
end repeat
return (matchingCount as text) & "|" & matchingURL
end tell`;
  let tabCount = 0;
  let firstUrl = '';
  try {
    const [count, ...urlParts] = (await runAppleScript(script)).split('|');
    tabCount = Number(count || 0);
    firstUrl = urlParts.join('|');
  } catch (error) {
    return {
      chromeRunning: false,
      pipedriveTabCount: 0,
      javaScriptFromAppleEventsEnabled: false,
      readDealFields: false,
      error: error.message,
    };
  }

  let javaScriptFromAppleEventsEnabled = false;
  let javaScriptError = null;
  if (tabCount > 0) {
    const capabilityScript = `tell application "Google Chrome"
repeat with w in windows
  repeat with t in tabs of w
    if (URL of t) contains "${PIPEDRIVE_HOST}" then return execute t javascript "document.readyState"
  end repeat
end repeat
return "NO_TAB"
end tell`;
    try {
      javaScriptFromAppleEventsEnabled = (await runAppleScript(capabilityScript)) !== 'NO_TAB';
    } catch (error) {
      javaScriptError = error.message.includes('JavaScript über AppleScript ist deaktiviert')
        ? 'Chrome → Ansicht → Entwickler → JavaScript von Apple Events erlauben'
        : error.message;
    }
  }
  return {
    chromeRunning: true,
    pipedriveTabCount: tabCount,
    activeDealId: dealIdFromUrl(firstUrl),
    javaScriptFromAppleEventsEnabled,
    readDealFields: tabCount > 0 && javaScriptFromAppleEventsEnabled,
    requiredSetting: javaScriptFromAppleEventsEnabled ? null : 'Chrome → Ansicht → Entwickler → JavaScript von Apple Events erlauben',
    error: javaScriptError,
  };
}
