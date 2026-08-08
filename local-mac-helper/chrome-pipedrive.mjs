import { spawn } from 'node:child_process';

const PIPEDRIVE_HOST = 'simplegategmbh.pipedrive.com';
const MAX_OUTPUT_BYTES = 256 * 1024;

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
    const fileButton = document.querySelector('[data-testid="filter-button-files"]');
    const fileButtonActive = fileButton?.getAttribute('aria-pressed') === 'true' || /active|selected/i.test(String(fileButton?.className || ''));
    if (fileButton && !fileButtonActive) fileButton.click();
    return JSON.stringify({
      url: location.href,
      dealId: location.pathname.match(/\/deal\/(\d+)/)?.[1] || null,
      dealTitle: document.title.replace(/\s*-\s*Deals\s*$/i, '').trim(),
      pipeline: (document.body?.innerText || '').split(/\n+/).map(clean).some(line => line === 'Auftragsmachbarkeit') ? 'Auftragsmachbarkeit' : null,
      stage: activeStage || null,
      customerName: customer?.name || null,
      customerPersonId: customer?.href.match(/\/person\/(\d+)/)?.[1] || null,
      orderNumber: fieldValue('Auftragsnummer') || fieldValue('Angebotsnummer') || fieldValue('Angebotsnummer (sevdesk)'),
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
  return { ...core, ...JSON.parse(secondPass), readOnly: true, mutated: false };
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
