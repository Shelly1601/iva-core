import assert from 'node:assert/strict';
import {
  DISPLAY_SLEEP_POLICY,
  assessDisplaySleepAfterRun,
  isNightHour,
  parseMacInputIdleSeconds,
  requestDisplaySleepAfterRun,
} from '../local-mac-helper/display-sleep-policy.mjs';

assert.equal(DISPLAY_SLEEP_POLICY.minimumIdleSeconds, 3600);
assert.equal(DISPLAY_SLEEP_POLICY.activeUserAlwaysProtected, true);
assert.equal(isNightHour(21), false);
assert.equal(isNightHour(22), true);
assert.equal(isNightHour(6), true);
assert.equal(isNightHour(7), false);
assert.equal(parseMacInputIdleSeconds('"HIDIdleTime" = 2500000000'), 2.5);
assert.equal(parseMacInputIdleSeconds('kein Wert'), null);

const calls = [];
const activeExec = async (command, args) => {
  calls.push([command, args]);
  return { stdout: '"HIDIdleTime" = 30000000000' };
};
const activeNight = await requestDisplaySleepAfterRun({
  now: new Date(2026, 7, 30, 23, 30),
  exec: activeExec,
  platform: 'darwin',
});
assert.equal(activeNight.requested, false);
assert.equal(activeNight.reason, 'user-active');
assert.deepEqual(calls.map(item => item[0]), ['/usr/sbin/ioreg']);

calls.length = 0;
const idleDay = await requestDisplaySleepAfterRun({
  now: new Date(2026, 7, 30, 14, 0),
  exec: activeExec,
  platform: 'darwin',
});
assert.equal(idleDay.requested, false);
assert.equal(idleDay.reason, 'outside-night-window');
assert.equal(calls.length, 0);

calls.length = 0;
const unattendedExec = async (command, args) => {
  calls.push([command, args]);
  if (command === '/usr/sbin/ioreg') return { stdout: '"HIDIdleTime" = 7200000000000' };
  return { stdout: '' };
};
const unattendedNight = await requestDisplaySleepAfterRun({
  now: new Date(2026, 7, 30, 2, 0),
  exec: unattendedExec,
  platform: 'darwin',
});
assert.equal(unattendedNight.requested, true);
assert.equal(unattendedNight.reason, 'unattended-night-run');
assert.deepEqual(calls.map(item => item[0]), ['/usr/sbin/ioreg', '/usr/bin/pmset']);

const unknownIdle = await assessDisplaySleepAfterRun({
  now: new Date(2026, 7, 30, 2, 0),
  exec: async () => ({ stdout: 'HIDIdleTime fehlt' }),
  platform: 'darwin',
});
assert.equal(unknownIdle.allowed, false);
assert.equal(unknownIdle.reason, 'input-idle-unknown');

console.log('PASS Display-Schlaf: tagsüber und bei aktiver Nutzung gesperrt, nur nachts nach 60 Minuten Inaktivität erlaubt.');
