import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const html = await readFile(new URL('../public/cockpit.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/cockpit-v9.css', import.meta.url), 'utf8');
const js = await readFile(new URL('../public/cockpit-v9.js', import.meta.url), 'utf8');
const avatarUrl = new URL('../public/assets/iva-avatar-v4-research.png', import.meta.url);
const avatar = await readFile(avatarUrl);
const avatarStat = await stat(avatarUrl);

assert.doesNotThrow(() => new Function(js), 'Das zusätzliche Cockpit-Script muss syntaktisch gültig sein');
for (const [, inlineScript] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (inlineScript.trim()) assert.doesNotThrow(() => new Function(inlineScript), 'Das eingebettete Cockpit-Script muss syntaktisch gültig sein');
}
assert.equal(avatar.subarray(1, 4).toString('ascii'), 'PNG', 'IVA-Avatar muss als PNG ausgeliefert werden');
assert.ok(avatarStat.size > 100_000, 'IVA-Avatar darf kein leerer Platzhalter sein');
assert.equal(avatar[25], 6, 'IVA-Avatar muss einen echten RGBA-Alphakanal statt eines schwarzen Bildhintergrunds besitzen');

assert.match(html, /id="ivaPresence"/);
assert.match(html, /src="\.\/assets\/iva-avatar-v4-research\.png\?v=4"/);
assert.match(html, /KI-Wissenschaftlerin mit Analysevisier/, 'IVA braucht den abgestimmten wissenschaftlichen Research-Look');
assert.doesNotMatch(html, /Laborkittel/i, 'Die verworfene Laborkittel-Variante darf nicht mehr eingebunden sein');
assert.match(html, /id="presenceVoiceBtn"/);
assert.match(html, /class="mini-iva"/, 'Der kleine IVA-Bildschirmagent muss erhalten bleiben');
assert.match(html, /id="homeApps"/);
assert.match(html, /id="homeApps"[^>]+aria-hidden="true"/, 'Das App-Raster muss standardmäßig verborgen sein');
assert.match(html, /id="desktopAppsButton"[^>]+aria-expanded="false"/, 'Desktop braucht einen eindeutigen Apps-Schalter');
assert.match(html, /id="dockWidgets"[^>]+aria-controls="homeApps"[^>]+aria-expanded="false"/, 'Der mobile Apps-Schalter muss dasselbe Raster steuern');
assert.match(html, /id="workflowEntry" href="\/control"/);
assert.match(html, /id="widgetDrawer"/);
assert.match(html, /data-widget-panel="todos"/);
assert.ok((html.match(/class="app-tile/g) || []).length >= 16, 'Die Startseite braucht ein vollständiges kompaktes App-Raster');
assert.ok((html.match(/<symbol id="iva-icon-/g) || []).length >= 16, 'Jedes IVA-Modul braucht ein eigenes technisches SVG-Symbol');
assert.ok((html.match(/class="app-module"/g) || []).length >= 16, 'Das Cockpit braucht das eigenständige eckige IVA-Modulsystem');
assert.doesNotMatch(html, /app-squircle/, 'Apple-artige Squircles dürfen im IVA-Modulraster nicht zurückkehren');
assert.ok((html.match(/class="control-glyph"/g) || []).length >= 7, 'Auch die Cockpit-Steuerleiste braucht das technische IVA-Iconsystem');
assert.doesNotMatch(html, /[💬👂🎙🔊📅🔥]/u, 'Emoji-Appsymbole dürfen nicht in das technische IVA-Cockpit zurückkehren');
assert.match(html, /function blueprint\(/, 'Der Hintergrund braucht die wissenschaftliche Neural-Kreisarchitektur');
assert.match(html, /function dataVeil\(/, 'Der Hintergrund braucht fließende Daten- und Partikelbahnen');
assert.match(html, /function neuralMark\(/, 'Die schwebenden Module brauchen eigene neuronale Glyphen');
assert.match(html, /seed\(INNER,0\.28,26\);seed\(OUTER,0\.44,20\)/, 'Die schwebenden Bereiche müssen deutlich größer als zuvor gerendert werden');
assert.match(html, /function setAppsOpen\(open\)/, 'Das App-Raster braucht einen gemeinsamen Desktop-/Mobil-Schaltzustand');
assert.doesNotMatch(html, /<form[^>]+id="chatForm"/, 'Der mobile Chat darf keinen nativen Formular-Submit auslösen');
assert.match(html, /id="chatComposer"[^>]+role="form"/, 'Der Chat-Composer muss semantisch als Formular erkennbar bleiben');
assert.match(html, /id="chatSend"[^>]+type="button"|type="button"[^>]+id="chatSend"/, 'Der Senden-Button darf auf iOS keine Seitennavigation auslösen');
assert.match(html, /enterkeyhint="send"/, 'Die mobile Tastatur muss eine Senden-Aktion anbieten');
assert.match(html, /chatSend'\)\.addEventListener\('click',triggerChatSend\)/, 'Der Senden-Button braucht einen direkten Klick-Handler');
assert.match(html, /chatIn'\)\.addEventListener\('keydown'/, 'Enter muss weiterhin direkt senden');
assert.match(html, /function keepChatOpen\(\)/, 'Der Chat muss während des gesamten Sendevorgangs offen bleiben');
assert.match(html, /\.wrap\{[^}]*z-index:auto/, 'Der mobile Wrapper darf Chat- und App-Ebenen nicht unter dem Backdrop einsperren');
assert.match(html, /\.hud-stage\{[^}]*z-index:auto/, 'Die mobile Bühne darf interaktive Overlays nicht unter dem Backdrop einsperren');
assert.doesNotMatch(html, /popup=yes|window\.open\(/, 'Das neue Cockpit darf keine Browser-Pop-ups öffnen');

for (const state of ['listening', 'thinking', 'speaking']) {
  assert.match(css, new RegExp(`data-state="${state}"`), `Der Avatar braucht einen sichtbaren Zustand für ${state}`);
}
assert.match(css, /grid-template-columns:\s*repeat\(4/, 'Das App-Raster muss auf kleinen Handys vier Spalten nutzen');
assert.match(css, /body\.apps-open \.home-apps/, 'Das App-Raster darf erst nach dem Apps-Klick sichtbar werden');
assert.match(css, /body\.apps-open \.app-tile:nth-child/, 'Die App-Module müssen gestaffelt hochploppen');
assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\) auto/, 'Die mobile Eingabe muss den Senden-Button innerhalb des Viewports halten');
assert.match(css, /\.chat \.ask input \{ width: 100%; height: 48px/, 'Das mobile Eingabefeld braucht eine sichere Touch-Größe');
assert.match(css, /prefers-reduced-motion/, 'Animationen müssen Rücksicht auf reduzierte Bewegung nehmen');
assert.match(js, /MutationObserver/, 'Der Avatar muss auf echte Voice-Zustandswechsel reagieren');
assert.match(js, /openWidget/, 'Daten-Apps müssen sich innerhalb des Cockpits öffnen');

console.log('PASS Cockpit v9.6: IVA-first Bühne, mobiler Chat ohne Seitennavigation, direkter Versand und Apps geprüft.');
