import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResearchSchedule, nextResearchRunAt } from '../knowledge/research-schedule.js';

const next = (schedule, after) => nextResearchRunAt(schedule, after);
const daily = { frequency: 'daily', time: '09:00' };

test('normalization supplies stable defaults without mutating the input', () => {
  const input = Object.freeze({});
  assert.deepEqual(normalizeResearchSchedule(input), {
    frequency: 'once', time: '09:00', weekday: 1, dayOfMonth: 1, timeZone: 'Europe/Berlin',
  });
  assert.equal(next(input, '2026-09-16T00:00:00Z'), null);
});

test('partial updates preserve prior fields and normalize HTML numeric fields and legacy timezone', () => {
  const existing = Object.freeze({ frequency: 'weekly', time: '15:45', weekday: 3, dayOfMonth: 22, timezone: 'Europe/Berlin' });
  assert.deepEqual(normalizeResearchSchedule({ weekday: '7', dayOfMonth: '31' }, existing), {
    frequency: 'weekly', time: '15:45', weekday: 7, dayOfMonth: 31, timeZone: 'Europe/Berlin',
  });
  assert.equal(normalizeResearchSchedule({ time: undefined }, existing).time, '15:45');
});

test('invalid schedule values are rejected instead of silently changing cadence or timezone', () => {
  for (const input of [
    null, [], false, 'daily', { frequency: 'hourly' }, { frequency: '' }, { frequency: null },
    { time: '9:00' }, { time: '24:00' }, { time: '12:60' }, { time: null }, { time: 900 },
    { weekday: 0 }, { weekday: 8 }, { weekday: 1.5 }, { weekday: true }, { weekday: '' },
    { dayOfMonth: 0 }, { dayOfMonth: 32 }, { dayOfMonth: '1.5' }, { dayOfMonth: null },
    { timeZone: 'UTC' }, { timezone: 'Europe/Paris' }, { timeZone: null },
    { timeZone: 'Europe/Berlin', timezone: 'UTC' },
  ]) {
    assert.throws(() => normalizeResearchSchedule(input), error => error.status === 400 && error.code === 'INVALID_RESEARCH_SCHEDULE', JSON.stringify(input));
  }
});

test('daily schedules use Berlin summer and winter time', () => {
  assert.equal(next(daily, '2026-09-16T06:59:59.999Z'), '2026-09-16T07:00:00.000Z');
  assert.equal(next(daily, '2026-12-16T07:59:59.999Z'), '2026-12-16T08:00:00.000Z');
});

test('an occurrence is strictly future, including exact minute and millisecond boundaries', () => {
  assert.equal(next(daily, '2026-09-16T07:00:00Z'), '2026-09-17T07:00:00.000Z');
  assert.equal(next(daily, '2026-09-16T07:00:00.001Z'), '2026-09-17T07:00:00.000Z');
  assert.equal(next(daily, new Date('2026-09-16T06:59:59.999Z')), '2026-09-16T07:00:00.000Z');
  assert.equal(next(daily, Date.parse('2026-09-16T06:59:59.999Z')), '2026-09-16T07:00:00.000Z');
});

test('local midnight and year rollover use the Berlin calendar day', () => {
  assert.equal(next({ frequency: 'daily', time: '00:00' }, '2026-09-15T21:59:59Z'), '2026-09-15T22:00:00.000Z');
  assert.equal(next({ frequency: 'daily', time: '00:00' }, '2026-09-15T22:00:00Z'), '2026-09-16T22:00:00.000Z');
  assert.equal(next({ frequency: 'daily', time: '00:00' }, '2026-12-31T23:00:00Z'), '2027-01-01T23:00:00.000Z');
});

test('weekly weekdays are Monday 1 through Sunday 7 with no duplicate at the boundary', () => {
  assert.equal(next({ frequency: 'weekly', weekday: 1 }, '2026-09-20T06:00:00Z'), '2026-09-21T07:00:00.000Z');
  assert.equal(next({ frequency: 'weekly', weekday: 7 }, '2026-09-20T06:00:00Z'), '2026-09-20T07:00:00.000Z');
  assert.equal(next({ frequency: 'weekly', weekday: 7 }, '2026-09-20T07:00:00Z'), '2026-09-27T07:00:00.000Z');
  assert.equal(next({ frequency: 'weekly', weekday: 1, time: '00:15' }, '2026-09-20T22:00:00Z'), '2026-09-20T22:15:00.000Z');
});

test('monthly day 31 clamps to February but remains anchored to 31 in March', () => {
  const schedule = { frequency: 'monthly', dayOfMonth: 31 };
  assert.equal(next(schedule, '2026-02-01T00:00:00Z'), '2026-02-28T08:00:00.000Z');
  assert.equal(next(schedule, '2026-02-28T08:00:00Z'), '2026-03-31T07:00:00.000Z');
  assert.equal(next(schedule, '2026-04-01T00:00:00Z'), '2026-04-30T07:00:00.000Z');
  assert.equal(next(schedule, '2026-04-30T07:00:00Z'), '2026-05-31T07:00:00.000Z');
});

test('monthly schedules handle leap years and year boundaries', () => {
  assert.equal(next({ frequency: 'monthly', dayOfMonth: 31 }, '2028-02-01T00:00:00Z'), '2028-02-29T08:00:00.000Z');
  assert.equal(next({ frequency: 'monthly', dayOfMonth: 31 }, '2026-12-31T08:00:00Z'), '2027-01-31T08:00:00.000Z');
  assert.equal(next({ frequency: 'monthly', dayOfMonth: 1 }, '2026-09-16T00:00:00Z'), '2026-10-01T07:00:00.000Z');
});

test('spring gap maps missing Berlin 02:30 to first valid 03:00, not 03:30', () => {
  const schedule = { frequency: 'daily', time: '02:30' };
  assert.equal(next(schedule, '2026-03-29T00:59:59.999Z'), '2026-03-29T01:00:00.000Z');
  assert.equal(next(schedule, '2026-03-29T01:00:00Z'), '2026-03-30T00:30:00.000Z');
  assert.equal(next({ frequency: 'daily', time: '02:00' }, '2026-03-29T00:59:00Z'), '2026-03-29T01:00:00.000Z');
  assert.equal(next({ frequency: 'daily', time: '02:59' }, '2026-03-29T00:59:00Z'), '2026-03-29T01:00:00.000Z');
});

test('weekly and monthly schedules apply the same spring-gap policy', () => {
  assert.equal(next({ frequency: 'weekly', weekday: 7, time: '02:30' }, '2026-03-28T12:00:00Z'), '2026-03-29T01:00:00.000Z');
  assert.equal(next({ frequency: 'monthly', dayOfMonth: 29, time: '02:30' }, '2026-03-28T12:00:00Z'), '2026-03-29T01:00:00.000Z');
});

test('autumn repeated hour selects only its earlier occurrence and then the next local day', () => {
  const schedule = { frequency: 'daily', time: '02:30' };
  assert.equal(next(schedule, '2026-10-25T00:29:59.999Z'), '2026-10-25T00:30:00.000Z');
  for (const after of ['2026-10-25T00:30:00Z', '2026-10-25T00:45:00Z', '2026-10-25T01:00:00Z', '2026-10-25T01:29:59Z', '2026-10-25T01:30:00Z']) {
    assert.equal(next(schedule, after), '2026-10-26T01:30:00.000Z', after);
  }
});

test('weekly and monthly autumn schedules skip the second instance as well', () => {
  assert.equal(next({ frequency: 'weekly', weekday: 7, time: '02:30' }, '2026-10-25T00:30:00Z'), '2026-11-01T01:30:00.000Z');
  assert.equal(next({ frequency: 'monthly', dayOfMonth: 25, time: '02:30' }, '2026-10-25T00:30:00Z'), '2026-11-25T01:30:00.000Z');
});

test('invalid or timezone-less reference dates are rejected and explicit offsets work', () => {
  for (const after of [null, false, {}, [], '', 'not a date', '2026-09-16', '2026-09-16T09:00:00', new Date(NaN), Infinity]) {
    assert.throws(() => next(daily, after), error => error.code === 'INVALID_RESEARCH_SCHEDULE');
  }
  assert.equal(next(daily, '2026-09-16T08:59:59+02:00'), '2026-09-16T07:00:00.000Z');
});

test('impossible ISO dates and times cannot silently normalize to another day', () => {
  for (const after of [
    '2026-02-30T09:00:00Z', '2026-02-29T09:00:00Z', '2026-04-31T09:00:00Z',
    '2026-00-01T09:00:00Z', '2026-01-00T09:00:00Z', '2026-13-01T09:00:00Z',
    '2026-09-16T24:00:00Z', '2026-09-16T09:00:60Z', '2026-09-16T09:60:00Z',
    '2026-09-16T09:00:00+24:00', '2026-09-16T09:00:00+02:60',
  ]) {
    assert.throws(() => next(daily, after), error => error.code === 'INVALID_RESEARCH_SCHEDULE', after);
  }
  assert.equal(next(daily, '2028-02-29T07:00:00Z'), '2028-02-29T08:00:00.000Z');
});
