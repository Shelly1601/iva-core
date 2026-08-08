import { spawn } from 'node:child_process';
import { classifyFundingDocumentName } from './funding-document-extractor.mjs';

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

async function executePipedriveJavaScript(javascript, { dealId = '' } = {}) {
  const target = dealId ? `pipedrive.com/deal/${String(dealId).replace(/\D/g, '')}` : PIPEDRIVE_HOST;
  const script = `tell application "Google Chrome"
repeat with w in windows
  repeat with t in tabs of w
    if (URL of t) contains "${target}" then return execute t javascript ${JSON.stringify(String(javascript))}
  end repeat
end repeat
return "NO_TAB"
end tell`;
  const output = await runAppleScript(script, { timeoutMs: 15000 });
  if (output === 'NO_TAB') throw new Error(`Kein geöffneter Pipedrive-Deal ${dealId || ''} gefunden.`.trim());
  return output;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    const allButton = document.querySelector('[data-testid="filter-button-all"]');
    if (allButton) allButton.click();
    return JSON.stringify({
      url: location.href,
      dealId: location.pathname.match(/\/deal\/(\d+)/)?.[1] || null,
      dealTitle,
      pipeline: (document.body?.innerText || '').split(/\n+/).map(clean).some(line => line === 'Auftragsmachbarkeit') ? 'Auftragsmachbarkeit' : null,
      stage: activeStage || null,
      customerName: customer?.name || null,
      customerPersonId: customer?.href.match(/\/person\/(\d+)/)?.[1] || null,
      orderNumber: fieldValue('Auftragsnummer') || fieldValue('Angebotsnummer') || fieldValue('Angebotsnummer (sevdesk)'),
      customerNumber: fieldValue('Kundennummer') || fieldValue('Kunden-Nr.'),
      phoneNumber: fieldValue('Telefonnummer') || fieldValue('Telefon') || fieldValue('Mobilnummer'),
      plant: fieldValue('Anlage'),
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
