import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const html = await readFile(new URL('../public/cockpit.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/cockpit-v9.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/cockpit-v9.js', import.meta.url), 'utf8');
const avatarUrl = new URL('../public/assets/iva-avatar-v3-transparent.png', import.meta.url);
const avatar = await readFile(avatarUrl);
const avatarStat = await stat(avatarUrl);

assert.doesNotThrow(() => new Function(js), 'Das zusätzliche Cockpit-Script muss syntaktisch gültig sein');
assert.equal(avatar.subarray(1, 4).toString('ascii'), 'PNG', 'IVA-Avatar muss als PNG ausgeliefert werden');
assert.ok(avatarStat.size > 100_000, 'IVA-Avatar darf kein leerer Platzhalter sein');
assert.equal(avatar[25], 6, 'IVA-Avatar muss einen echten RGBA-Alphakanal statt eines schwarzen Bildhintergrunds besitzen');

assert.match(html, /id="ivaPresence"/);
assert.match(html, /src="\/assets\/iva-avatar-v3-transparent\.png\?v=3"/);
assert.doesNotMatch(html, /Laborkittel/i, 'Die verworfene Laborkittel-Variante darf nicht mehr eingebunden sein');
assert.match(html, /id="presenceVoiceBtn"/);
assert.match(html, /class="mini-iva"/, 'Der kleine IVA-Bildschirmagent muss erhalten bleiben');
assert.match(html, /id="homeApps"/);
assert.match(html, /id="workflowEntry" href="\/control"/);
assert.match(html, /id="widgetDrawer"/);
assert.match(html, /data-widget-panel="todos"/);
assert.ok((html.match(/class="app-tile/g) || []).length >= 16, 'Die Startseite braucht ein vollständiges kompaktes App-Raster');
assert.doesNotMatch(html, /popup=yes|window\.open\(/, 'Das neue Cockpit darf keine Browser-Pop-ups öffnen');

for (const state of ['listening', 'thinking', 'speaking']) {
  assert.match(css, new RegExp(`data-state="${state}"`), `Der Avatar braucht einen sichtbaren Zustand für ${state}`);
}
assert.match(css, /grid-template-columns:\s*repeat\(4/, 'Das App-Raster muss auf kleinen Handys vier Spalten nutzen');
assert.match(css, /prefers-reduced-motion/, 'Animationen müssen Rücksicht auf reduzierte Bewegung nehmen');
assert.match(js, /MutationObserver/, 'Der Avatar muss auf echte Voice-Zustandswechsel reagieren');
assert.match(js, /openWidget/, 'Daten-Apps müssen sich innerhalb des Cockpits öffnen');

console.log('PASS Cockpit v9: IVA-Avatar, lebendige Zustände, Mascot, App-Raster, interne Detailflächen und pop-up-freie Navigation geprüft.');
