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
