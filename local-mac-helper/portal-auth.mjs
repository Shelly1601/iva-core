import { spawn } from 'node:child_process';
import {
  IVA_CREDENTIAL_SERVICES,
  credentialServiceStatus,
  currentTotpForService,
  readCredentialField,
} from './credential-broker.mjs';
import { withMacWakeGuard } from './mac-wake-guard.mjs';
import { typePanasonicTotpFromEnte } from './ente-auth.mjs';

const MAX_OUTPUT_BYTES = 128 * 1024;
const DEFAULT_WAIT_MS = 2_500;

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function profileFor(value) {
  const id = String(value || '').trim().toLowerCase();
  const profile = IVA_CREDENTIAL_SERVICES[id];
  if (!profile) throw new Error('Dieses Portal ist nicht für die automatische IVA-Anmeldung freigegeben.');
  return profile;
}

function appleScriptString(value) {
  return JSON.stringify(String(value || ''));
}

function runAppleScript(script, { timeoutMs = 20_000, sensitive = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Die lokale Portalsteuerung hat das Zeitlimit überschritten.'));
    }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout.trim());
      const detail = sensitive ? '' : String(stderr || stdout || '').trim().slice(0, 500);
      return reject(new Error(detail ? `Portalsteuerung fehlgeschlagen: ${detail}` : 'Portalsteuerung fehlgeschlagen.'));
    });
    child.stdin.end(script);
  });
}

function hostCondition(hosts) {
  return hosts.map(host => `(URL of t contains ${appleScriptString(host)})`).join(' or ');
}

async function openPortalTab(profile) {
  const condition = hostCondition(profile.allowedHosts);
  const script = `tell application "Google Chrome"
activate
if (count of windows) is 0 then make new window
repeat with w in windows
  repeat with tabIndex from 1 to (count of tabs of w)
    set t to tab tabIndex of w
    if ${condition} then
      set active tab index of w to tabIndex
      set index of w to 1
      return "FOUND"
    end if
  end repeat
end repeat
make new tab at end of tabs of front window with properties {URL:${appleScriptString(profile.loginUrl)}}
return "OPENED"
end tell`;
  const result = await runAppleScript(script);
  return { opened: result === 'OPENED', found: result === 'FOUND' };
}

function probeJavascript(serviceId) {
  return `(() => {
    const visible = element => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').toLowerCase();
    const username = [...document.querySelectorAll('input')].find(element => visible(element) && (
      element.type === 'email' || element.autocomplete === 'username' || /(?:email|e-mail|login|user|benutzer)/i.test([element.id, element.name, element.placeholder, element.getAttribute('aria-label')].join(' '))
    ));
    const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
    const totp = [...document.querySelectorAll('input')].find(element => visible(element) && (
      element.autocomplete === 'one-time-code' || /(?:otp|totp|one.?time|verification|code|einmal)/i.test([element.id, element.name, element.placeholder, element.getAttribute('aria-label')].join(' '))
    ));
    const visibleCaptcha = [...document.querySelectorAll('iframe')].some(frame => visible(frame) && /captcha/i.test([frame.src, frame.title].join(' ')))
      || [...document.querySelectorAll('[class*="captcha" i],[id*="captcha" i]')].some(visible);
    const ssoStart = [...document.querySelectorAll('a,button')].some(element => visible(element) && (
      /startSSO/i.test(element.href || '') || /^(jetzt )?anmelden$/i.test(String(element.innerText || '').trim())
    ));
    const host = location.hostname.toLowerCase();
    const path = location.pathname;
    let authenticated = false;
    if (${JSON.stringify(serviceId)} === 'panasonic') authenticated = host === 'promatch.panasonicproclub.com' && !/\\/page\\/login/i.test(location.hash) && !password && !totp;
    if (${JSON.stringify(serviceId)} === 'bosch') authenticated = host === 'bosch-de-home.thernovo.com' && !ssoStart && !password && (Boolean(document.querySelector('#text_SearchTerm')) || /home|dashboard|portal/.test(path + ' ' + text));
    if (${JSON.stringify(serviceId)} === 'pipedrive') authenticated = host === 'simplegategmbh.pipedrive.com' && !/^\\/auth\\/login/i.test(path) && !password;
    if (${JSON.stringify(serviceId)} === 'airtable') authenticated = host === 'airtable.com' && !/\\/(?:login|signin)(?:\\/|$)/i.test(path) && !password;
    if (${JSON.stringify(serviceId)} === 'planbar') authenticated = host === 'heathero-partner-a.planbar365.com' && !/\\/(?:login|signin)(?:\\/|$)/i.test(path) && !password;
    return JSON.stringify({
      host,
      path: String(path || '/').slice(0, 160),
      authenticated,
      usernameVisible: Boolean(username),
      passwordVisible: Boolean(password),
      totpVisible: Boolean(totp),
      captchaVisible: Boolean(visibleCaptcha),
      ssoStartVisible: Boolean(ssoStart),
      loginVisible: Boolean(username || password || totp || ssoStart),
    });
  })()`;
}

async function executeJavascript(profile, javascript, { sensitive = false, hosts = profile.allowedHosts } = {}) {
  const scans = hosts.map(host => `repeat with w in windows
  repeat with t in tabs of w
    if (URL of t contains ${appleScriptString(host)}) then return (execute t javascript ${appleScriptString(javascript)})
  end repeat
end repeat`).join('\n');
  const script = `tell application "Google Chrome"
${scans}
return "NO_TAB"
end tell`;
  const output = await runAppleScript(script, { sensitive });
  if (output === 'NO_TAB') return null;
  return output;
}

async function probePortal(profile) {
  const hosts = profile.id === 'panasonic'
    ? ['hvac-key.eu.panasonic.com', 'promatch.panasonicproclub.com']
    : profile.allowedHosts;
  const raw = await executeJavascript(profile, probeJavascript(profile.id), { hosts });
  if (!raw) return { tabFound: false, authenticated: false, loginVisible: false };
  try { return { tabFound: true, ...JSON.parse(raw) }; }
  catch { throw new Error(`${profile.name} konnte seinen Anmeldestatus nicht sicher bestimmen.`); }
}

async function startPortalLogin(profile) {
  const javascript = `(() => {
    const visible = element => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    const candidates = [...document.querySelectorAll('a,button')].filter(element => visible(element));
    const target = candidates.find(element => /startSSO/i.test(element.href || ''))
      || candidates.find(element => /^(jetzt )?anmelden$/i.test(String(element.innerText || '').trim()));
    if (!target) return 'NO_LOGIN_START';
    target.click();
    return 'STARTED';
  })()`;
  return executeJavascript(profile, javascript);
}

function credentialFillJavascript(username, password) {
  return `(() => {
    const visible = element => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    const dispatch = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(element, value); else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const usernameInput = inputs.find(element => element.type === 'email' || element.autocomplete === 'username' || /(?:email|e-mail|login|user|benutzer)/i.test([element.id, element.name, element.placeholder, element.getAttribute('aria-label')].join(' ')));
    const passwordInput = inputs.find(element => element.type === 'password');
    if (usernameInput) dispatch(usernameInput, ${JSON.stringify(String(username || ''))});
    if (passwordInput) dispatch(passwordInput, ${JSON.stringify(String(password || ''))});
    const submit = [...document.querySelectorAll('button,input[type="submit"]')].find(element => visible(element) && (element.type === 'submit' || /anmeld|login|sign in|fortfahren|weiter/i.test(String(element.innerText || element.value || ''))));
    if (submit && (usernameInput || passwordInput)) submit.click();
    return JSON.stringify({ usernameFilled: Boolean(usernameInput), passwordFilled: Boolean(passwordInput), submitted: Boolean(submit && (usernameInput || passwordInput)) });
  })()`;
}

async function submitCredentials(profile, username, password) {
  const raw = await executeJavascript(profile, credentialFillJavascript(username, password), { sensitive: true });
  if (!raw) throw new Error(`${profile.name} hat kein freigegebenes Anmeldefenster geöffnet.`);
  try { return JSON.parse(raw); }
  catch { throw new Error(`${profile.name} konnte die gespeicherten Zugangsdaten nicht einsetzen.`); }
}

function totpFillJavascript(code) {
  return `(() => {
    const visible = element => Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const target = inputs.find(element => element.autocomplete === 'one-time-code' || /(?:otp|totp|one.?time|verification|code|einmal)/i.test([element.id, element.name, element.placeholder, element.getAttribute('aria-label')].join(' ')));
    if (!target) return JSON.stringify({ filled: false, submitted: false });
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(target, ${JSON.stringify(String(code))}); else target.value = ${JSON.stringify(String(code))};
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    const submit = [...document.querySelectorAll('button,input[type="submit"]')].find(element => visible(element) && (element.type === 'submit' || /fortfahren|weiter|verify|bestät|anmeld|login/i.test(String(element.innerText || element.value || ''))));
    if (submit) submit.click();
    return JSON.stringify({ filled: true, submitted: Boolean(submit) });
  })()`;
}

async function submitTotp(profile, code) {
  const raw = await executeJavascript(profile, totpFillJavascript(code), { sensitive: true });
  if (!raw) throw new Error(`${profile.name} hat kein freigegebenes 2FA-Fenster geöffnet.`);
  try { return JSON.parse(raw); }
  catch { throw new Error(`${profile.name} konnte den lokalen Einmalcode nicht einsetzen.`); }
}

export function createPortalTransport() {
  return Object.freeze({
    open: openPortalTab,
    probe: probePortal,
    startLogin: startPortalLogin,
    submitCredentials,
    submitTotp,
    submitAuthenticator: typePanasonicTotpFromEnte,
    wait,
  });
}

async function ensurePortalLoginCore(serviceId, {
  transport = createPortalTransport(),
  readSecret = readCredentialField,
  createTotp = currentTotpForService,
  keychainStatus = credentialServiceStatus,
} = {}) {
  const profile = profileFor(serviceId);
  await transport.open(profile);
  await transport.wait(900);
  let credentialsSubmitted = false;
  let totpSubmitted = false;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const state = await transport.probe(profile);
    if (state.authenticated) {
      return {
        service: profile.id,
        name: profile.name,
        status: 'authenticated',
        credentialsSubmitted,
        totpSubmitted,
        secretValuesReturned: false,
      };
    }
    if (state.captchaVisible) {
      return { service: profile.id, name: profile.name, status: 'blocked', blocker: 'captcha', secretValuesReturned: false };
    }
    if (state.totpVisible) {
      if (profile.id === 'panasonic') {
        if (typeof transport.submitAuthenticator !== 'function') {
          return { service: profile.id, name: profile.name, status: 'blocked', blocker: 'ente-auth-unavailable', secretValuesReturned: false };
        }
        const result = await transport.submitAuthenticator(profile);
        if (!result?.typed || !result?.submitted) {
          return { service: profile.id, name: profile.name, status: 'blocked', blocker: 'ente-auth-code-not-available', secretValuesReturned: false };
        }
        totpSubmitted = true;
        await transport.wait(DEFAULT_WAIT_MS);
        continue;
      }
      const status = await keychainStatus(profile.id);
      if (!status.configured.totp) {
        return { service: profile.id, name: profile.name, status: 'setup_required', missingFields: ['totp'], secretValuesReturned: false };
      }
      const code = await createTotp(profile.id);
      const result = await transport.submitTotp(profile, code);
      if (!result?.filled) return { service: profile.id, name: profile.name, status: 'blocked', blocker: 'totp-field-not-found', secretValuesReturned: false };
      totpSubmitted = true;
      await transport.wait(DEFAULT_WAIT_MS);
      continue;
    }
    if (state.ssoStartVisible) {
      const result = await transport.startLogin(profile);
      if (result !== 'STARTED') return { service: profile.id, name: profile.name, status: 'blocked', blocker: 'login-start-not-found', secretValuesReturned: false };
      await transport.wait(DEFAULT_WAIT_MS);
      continue;
    }
    if (state.usernameVisible || state.passwordVisible) {
      const status = await keychainStatus(profile.id);
      const required = ['username', 'password'].filter(field => !status.configured[field]);
      if (required.length) {
        return { service: profile.id, name: profile.name, status: 'setup_required', missingFields: required, secretValuesReturned: false };
      }
      const username = await readSecret(profile.id, 'username');
      const password = await readSecret(profile.id, 'password');
      const result = await transport.submitCredentials(profile, username, password);
      if (!result?.usernameFilled && !result?.passwordFilled) {
        return { service: profile.id, name: profile.name, status: 'blocked', blocker: 'credential-fields-not-found', secretValuesReturned: false };
      }
      credentialsSubmitted = true;
      await transport.wait(DEFAULT_WAIT_MS);
      continue;
    }
    await transport.wait(1_000);
  }

  const finalState = await transport.probe(profile);
  if (finalState.authenticated) {
    return { service: profile.id, name: profile.name, status: 'authenticated', credentialsSubmitted, totpSubmitted, secretValuesReturned: false };
  }
  return {
    service: profile.id,
    name: profile.name,
    status: 'blocked',
    blocker: finalState.loginVisible ? 'authentication-rejected-or-incomplete' : 'external-confirmation-or-page-change',
    secretValuesReturned: false,
  };
}

export async function ensurePortalLogin(serviceId, options = {}) {
  const wakeGuard = options.wakeGuard || withMacWakeGuard;
  const coreOptions = { ...options };
  delete coreOptions.wakeGuard;
  return wakeGuard(() => ensurePortalLoginCore(serviceId, coreOptions), { maxSeconds: 180, sleepDisplays: true });
}

export function portalAuthPolicy() {
  return Object.freeze({
    services: Object.keys(IVA_CREDENTIAL_SERVICES),
    browser: 'Google Chrome on Nadines Mac',
    arbitraryHosts: false,
    arbitraryJavascript: false,
    credentialsViaProcessArguments: false,
    secretsReturnedToRailway: false,
    secretsReturnedToModel: false,
    captchaAction: 'block-and-report',
    sessionReuseFirst: true,
    wakeGuard: true,
    displaySleepAfterStandaloneLogin: true,
    panasonicAuthenticator: 'Ente Auth direct local typing',
  });
}

export const portalAuthInternals = Object.freeze({
  credentialFillJavascript,
  probeJavascript,
  totpFillJavascript,
});
