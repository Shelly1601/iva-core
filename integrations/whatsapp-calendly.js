const fail = (message, code = 'CALENDLY_UNAVAILABLE', status = 503) => Object.assign(new Error(message), { code, status });
const BASE = 'https://api.calendly.com';
export function calendlyUri(value, kind = 'event_types') {
  let u; try { u = new URL(String(value)); } catch { throw fail('Eine gültige Calendly-Ereignis-ID fehlt.', 'CALENDLY_CONFIG', 400); }
  if (!['api.calendly.com', 'calendly.com'].includes(u.hostname) || u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || !new RegExp(`^/${kind}/[A-Za-z0-9_-]+(?:/invitees/[A-Za-z0-9_-]+)?$`).test(u.pathname)) throw fail('Ungültige Calendly-Ressource.', 'CALENDLY_CONFIG', 400);
  return BASE + u.pathname;
}
export function createWhatsAppCalendly({ env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function request(path, { method = 'GET', body } = {}) {
    if (!env.CALENDLY_TOKEN) throw fail('Calendly-Zugang fehlt.', 'CALENDLY_NOT_CONFIGURED');
    const url = path.startsWith(BASE + '/') ? path : BASE + path;
    if (!url.startsWith(BASE + '/')) throw fail('Ungültiges Calendly-Ziel.', 'CALENDLY_CONFIG', 400);
    let response;
    try { response = await fetchImpl(url, { method, redirect: 'error', headers: { Authorization: `Bearer ${env.CALENDLY_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('Calendly hat den Vorgang nicht bestätigt. Ein möglicher Schreibvorgang wird nur zurückgelesen, nicht wiederholt.', method === 'GET' ? 'CALENDLY_UNAVAILABLE' : 'CALENDLY_UNCERTAIN'); }
    if (!response.ok) throw fail(response.status === 403 ? 'Calendly-Zugriff fehlt: Tarif und API-Berechtigungen prüfen.' : 'Calendly hat die Anfrage nicht bestätigt.', method === 'GET' ? 'CALENDLY_UNAVAILABLE' : response.status >= 400 && response.status < 500 && response.status !== 408 ? 'CALENDLY_REJECTED' : 'CALENDLY_UNCERTAIN', response.status === 429 ? 429 : 503);
    const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
    if (text.length > 2_000_000) throw fail('Calendly-Antwort überschreitet die sichere Größe.');
    try { return JSON.parse(text); } catch { throw fail('Calendly-Antwort ist unvollständig.', method === 'GET' ? 'CALENDLY_UNAVAILABLE' : 'CALENDLY_UNCERTAIN'); }
  }
  async function eventType(uri) { const value = (await request(calendlyUri(uri))).resource; if (!value || value.active === false || calendlyUri(value.uri) !== calendlyUri(uri)) throw fail('Dieser Calendly-Ereignistyp ist nicht aktiv.', 'CALENDLY_CONFIG', 409); return value; }
  async function listEventTypes() {
    const me = (await request('/users/me')).resource, user = calendlyUri(me?.uri, 'users');
    const result = await request('/event_types?user=' + encodeURIComponent(user) + '&active=true&count=100');
    return { verifiedAt: new Date(now()).toISOString(), events: (result.collection || []).map(e => ({ uri: calendlyUri(e.uri), name: String(e.name || '').slice(0, 200), duration: e.duration, schedulingUrl: e.scheduling_url || '', active: e.active === true })), truncated: Boolean(result.pagination?.next_page_token) };
  }
  async function availability(uri, { startTime, endTime } = {}) {
    const start = new Date(startTime || now() + 120000), end = new Date(endTime || start.getTime() + 7 * 86400000);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start.getTime() < now() || end <= start || end - start > 31 * 86400000) throw fail('Ungültiger Zeitraum für freie Termine.', 'CALENDLY_CONFIG', 400);
    const type = await eventType(uri), result = await request('/event_type_available_times?' + new URLSearchParams({ event_type: calendlyUri(uri), start_time: start.toISOString(), end_time: end.toISOString() }));
    return { eventType: { uri: calendlyUri(uri), name: type.name, duration: type.duration, schedulingUrl: type.scheduling_url || '' }, checkedAt: new Date(now()).toISOString(), slots: (result.collection || []).filter(s => s.status === 'available' && s.invitees_remaining > 0 && Date.parse(s.start_time) >= start.getTime() && Date.parse(s.start_time) <= end.getTime()).map(s => ({ startTime: new Date(s.start_time).toISOString(), status: 'available' })).slice(0, 50) };
  }
  function locationFor(type, sender) {
    if (type.pooling_type === 'round_robin') return undefined;
    const locations = type.locations || []; if (!locations.length) return undefined;
    if (locations.length !== 1) throw fail('Für dieses Ereignis muss die Ortsauswahl persönlich abgestimmt werden.', 'CALENDLY_DETAILS_REQUIRED', 409);
    const location = locations[0], kind = location.kind;
    if (['zoom_conference', 'google_conference', 'microsoft_teams_conference', 'webex_conference', 'gotomeeting_conference'].includes(kind)) return { kind };
    if (kind === 'outbound_call') return { kind, location: '+' + sender };
    if (['physical', 'inbound_call', 'custom'].includes(kind) && location.location) return { kind, location: location.location };
    throw fail('Für diesen Ereignisort fehlen bestätigte Angaben.', 'CALENDLY_DETAILS_REQUIRED', 409);
  }
  async function verifyBooking(booking, receipt) {
    const eventUri = calendlyUri(receipt?.eventUri || receipt?.event, 'scheduled_events');
    const inviteeUri = calendlyUri(receipt?.inviteeUri || receipt?.uri, 'scheduled_events');
    if (!inviteeUri.startsWith(eventUri + '/invitees/')) throw fail('Buchungsbeleg gehört nicht zum Ereignis.', 'CALENDLY_UNCERTAIN');
    const [event, invitee] = await Promise.all([request(eventUri).then(r => r.resource), request(inviteeUri).then(r => r.resource)]);
    if (!event || !invitee || event.status !== 'active' || invitee.status !== 'active' || calendlyUri(event.event_type) !== calendlyUri(booking.eventTypeUri) || Date.parse(event.start_time) !== Date.parse(booking.startTime) || String(invitee.email).toLowerCase() !== booking.email.toLowerCase() || calendlyUri(invitee.event, 'scheduled_events') !== eventUri || invitee.tracking?.utm_content !== booking.id) throw fail('Der Termin konnte nicht eindeutig mit der gewünschten Buchung abgeglichen werden.', 'CALENDLY_UNCERTAIN');
    return { status: 'confirmed', verified: true, provider: 'calendly', eventUri, inviteeUri, eventTypeUri: booking.eventTypeUri, startTime: new Date(event.start_time).toISOString(), endTime: event.end_time || '', email: booking.email, name: booking.name, timezone: booking.timezone, verifiedAt: new Date(now()).toISOString() };
  }
  async function prepareBooking(booking) {
    const type = await eventType(booking.eventTypeUri);
    if ((type.custom_questions || []).some(q => q.enabled !== false && q.required)) throw fail('Dieses Ereignis erfordert weitere Pflichtangaben. Bitte den persönlichen Buchungslink verwenden.', 'CALENDLY_DETAILS_REQUIRED', 409);
    if (type.payment?.enabled || type.price > 0) throw fail('Kostenpflichtige Ereignisse werden persönlich gebucht.', 'CALENDLY_DETAILS_REQUIRED', 409);
    const availabilityResult = await availability(booking.eventTypeUri, { startTime: new Date(Math.max(now() + 1000, Date.parse(booking.startTime) - 60000)).toISOString(), endTime: new Date(Date.parse(booking.startTime) + 60000).toISOString() });
    if (!availabilityResult.slots.some(s => s.startTime === booking.startTime)) throw fail('Der ausgewählte Termin ist nicht mehr frei.', 'CALENDLY_SLOT_GONE', 409);
    return { event_type: booking.eventTypeUri, start_time: booking.startTime, invitee: { name: booking.name, email: booking.email, timezone: booking.timezone }, location: locationFor(type, booking.sender), tracking: { utm_source: 'iva-whatsapp', utm_content: booking.id } };
  }
  // The engine records its attempt before this one POST. There is intentionally
  // no guessed provider idempotency header and no automatic POST retry.
  async function createBooking(booking, prepared) { const value = (await request('/invitees', { method: 'POST', body: prepared })).resource; return { eventUri: calendlyUri(value?.event, 'scheduled_events'), inviteeUri: calendlyUri(value?.uri, 'scheduled_events') }; }
  async function reconcileBooking(booking) {
    if (booking.receipt?.eventUri && booking.receipt?.inviteeUri) return verifyBooking(booking, booking.receipt);
    const me = (await request('/users/me')).resource;
    const query = new URLSearchParams({ user: calendlyUri(me?.uri, 'users'), status: 'active', min_start_time: booking.startTime, max_start_time: new Date(Date.parse(booking.startTime) + 1000).toISOString(), count: '100' });
    const events = await request('/scheduled_events?' + query), matches = [];
    for (const event of (events.collection || []).filter(e => e.event_type === booking.eventTypeUri && Date.parse(e.start_time) === Date.parse(booking.startTime)).slice(0, 5)) {
      const eventUri = calendlyUri(event.uri, 'scheduled_events'), invitees = await request(eventUri + '/invitees?count=100');
      for (const invitee of invitees.collection || []) if (invitee.status === 'active' && invitee.email?.toLowerCase() === booking.email.toLowerCase() && invitee.tracking?.utm_content === booking.id) matches.push({ eventUri, inviteeUri: invitee.uri });
    }
    if (matches.length !== 1) return { status: 'uncertain', verified: false, message: 'Der Buchungsstatus ist noch nicht eindeutig belegt; keine erneute Buchung ausgeführt.' };
    return verifyBooking(booking, matches[0]);
  }
  return { status: () => ({ configured: Boolean(env.CALENDLY_TOKEN), verified: false, bookingAccess: 'requires-paid-plan-and-scheduled_events:write' }), listEventTypes, availability, prepareBooking, createBooking, verifyBooking, reconcileBooking };
}
