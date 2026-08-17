import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import assert from 'assert/strict';

const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'iva-scheduling-'));
process.env.DATA_DIR = testDir;

try {
  const store = await import('../scheduling/store.js?verify=' + Date.now());
  const type = await store.createAppointmentType({
    name: 'Strategiegespräch', slug: 'strategie', durationMinutes: 30, minNoticeHours: 1, maxDaysAhead: 14,
    availability: { sun: [{ start: '09:00', end: '17:00' }], mon: [{ start: '09:00', end: '17:00' }], tue: [{ start: '09:00', end: '17:00' }], wed: [{ start: '09:00', end: '17:00' }], thu: [{ start: '09:00', end: '17:00' }], fri: [{ start: '09:00', end: '17:00' }], sat: [{ start: '09:00', end: '17:00' }] },
  });
  assert.equal(type.active, false, 'neue Terminarten starten als Entwurf');
  await assert.rejects(store.updateAppointmentType(type.id, { active: true }), /Live-Buchung/);
  const active = await store.updateAppointmentType(type.id, { active: true }, { allowActivation: true });
  assert.equal(active.active, true);
  assert.equal((await store.getAppointmentTypeBySlug('strategie')).id, type.id);

  const slots = await store.listAvailableSlots(active, { days: 14 });
  assert.ok(slots.length > 0, 'mindestens ein freier Termin wird erzeugt');
  await assert.rejects(store.createBooking('strategie', { startAt: slots[0].startAt, customerName: 'Mara Muster', customerEmail: 'mara@example.test' }), /Datenschutzeinwilligung/);
  const result = await store.createBooking('strategie', { startAt: slots[0].startAt, customerName: 'Mara Muster', customerEmail: 'mara@example.test', privacyConsent: true });
  assert.equal(result.booking.status, 'confirmed');
  const remaining = await store.listAvailableSlots(active, { days: 14 });
  assert.equal(remaining.some(slot => slot.startAt === slots[0].startAt), false, 'gebuchter Termin verschwindet aus den Slots');
  assert.match(store.createBookingIcs(result.booking, active), /BEGIN:VEVENT/);
  console.log('PASS scheduling: Entwurfs-Gate, Slots, Buchung, Doppelbuchungsschutz und ICS');
} finally {
  await fs.rm(testDir, { recursive: true, force: true });
}
