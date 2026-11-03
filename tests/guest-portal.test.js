const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadGuestPortal(role, guestId, opts = {}) {
  const stay = {
    id: 'res-1', reference: 'AGM-101', propertyId: 'hotel-1', guestId: 'guest-1',
    roomId: 'room-12', roomTypeId: 'type-1', ratePlanId: 'plan-1',
    checkIn: opts.checkIn || '2026-10-27', checkOut: opts.checkOut || '2026-10-29',
    status: opts.status || 'In-house', notes: '', adults: 1, children: 0
  };
  const created = [];
  const LHMS = {
    db: {
      guests: [{ id: 'guest-1', name: 'A Guest' }], tasks: [], roomTypes: [],
      reservations: opts.reservations || [],
      properties: [{ id: 'hotel-1', name: 'Aurelia Grand Marina', short: 'Grand Marina', city: 'Lagos' }],
      ratePlans: [{ id: 'plan-1', name: 'Flexible Rate', includes: 'Breakfast', cancel: 'Free until 48h' }]
    },
    session: { role, propertyId: 'hotel-1', guestId },
    pages: {}, uiActions: {}, forms: {},
    guestStay() { return stay; },
    folio: () => opts.folio || { charges: [], payments: [], total: 0, paid: 0, balance: 0 },
    get: {
      guest(id) { return id === 'guest-1' ? { id, name: 'A Guest' } : null; },
      roomType(id) { return { id, name: 'Deluxe King', occupancy: 2, rate: 185000 }; },
      property() { return { id: 'hotel-1', short: 'Grand Marina' }; },
      reservation(id) { return id === stay.id ? stay : null; }
    },
    actions: {
      createRequest(data) { const t = { id: 'task-1', ...data }; created.push(data); return t; },
      checkIn(id, o) { LHMS._in = { id, o }; return { ok: true }; },
      checkOut(id, o) { LHMS._out = { id, o }; return { ok: true }; },
      takePayment(id, d) { LHMS._pay = { id, d }; return { ok: true, payment: { id: 'pay-1', ...d } }; },
      updateGuest(id, patch) { LHMS._pref = { id, patch }; return { ok: true }; }
    }
  };
  const context = {
    window: { LHMS }, console, Date, Math, JSON, Object, Array, String, Number,
    setInterval: () => 0, clearInterval: () => {}
  };
  const source = fs.readFileSync(path.join(__dirname, '../assets/pages-guest.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'pages-guest.js' });
  LHMS.util = {
    today: () => '2026-10-27', pretty: () => '27 Oct', money: (n) => '₦' + n,
    addDays: (s, n) => new Date(Date.parse(s + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10),
    nights: (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000)
  };
  return { LHMS, created, stay };
}

test('guest requests require the signed-in guest to match the active stay', () => {
  const { LHMS, created } = loadGuestPortal('Guest', 'another-guest');
  const result = LHMS.guestPortal.request({ title: 'Extra towels' });
  assert.equal(result.ok, false);
  assert.equal(created.length, 0);
});

test('guest requests bind to the guest’s own room and property', () => {
  const { LHMS, created } = loadGuestPortal('Guest', 'guest-1');
  const result = LHMS.guestPortal.request({ title: 'Extra towels', detail: 'Two bath towels' });
  assert.equal(result.ok, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].guestId, 'guest-1');
  assert.equal(created[0].roomId, 'room-12');
  assert.equal(created[0].propertyId, 'hotel-1');
});

test('staff cannot submit a guest portal request', () => {
  const { LHMS, created } = loadGuestPortal('Front Desk', 'guest-1');
  assert.equal(LHMS.guestPortal.request({ title: 'Extra towels' }).ok, false);
  assert.equal(created.length, 0);
});

test('a request without a title is rejected before anything is created', () => {
  const { LHMS, created } = loadGuestPortal('Guest', 'guest-1');
  assert.equal(LHMS.guestPortal.request({ title: '   ' }).ok, false);
  assert.equal(created.length, 0);
});

test('digital check-in is refused before the arrival date', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1', { status: 'Confirmed', checkIn: '2026-11-04' });
  const result = LHMS.guestPortal.checkIn({});
  assert.equal(result.ok, false);
  assert.match(result.error, /arrival day/);
  assert.equal(LHMS._in, undefined);
});

test('digital check-in runs the front-desk check-in action on arrival day', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1', { status: 'Confirmed' });
  assert.equal(LHMS.guestPortal.checkIn({ eta: '14:30', mobileKey: true }).ok, true);
  assert.equal(LHMS._in.id, 'res-1');
  assert.equal(LHMS._in.o.mobileKey, true);
});

test('a guest already in house cannot check in twice', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1');
  assert.equal(LHMS.guestPortal.checkIn({}).ok, false);
  assert.equal(LHMS._in, undefined);
});

test('express checkout is blocked while the folio has a balance', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1', { folio: { charges: [], payments: [], total: 90000, paid: 40000, balance: 50000 } });
  const result = LHMS.guestPortal.checkOut();
  assert.equal(result.ok, false);
  assert.match(result.error, /balance/);
  assert.equal(LHMS._out, undefined);
});

test('express checkout settles nothing and releases the room when the folio is clear', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1');
  assert.equal(LHMS.guestPortal.checkOut().ok, true);
  assert.equal(LHMS._out.id, 'res-1');
});

test('staff cannot check a guest in through the portal', () => {
  const { LHMS } = loadGuestPortal('Manager', 'guest-1', { status: 'Confirmed' });
  assert.equal(LHMS.guestPortal.checkIn({}).ok, false);
  assert.equal(LHMS._in, undefined);
});

test('personalization writes only to the signed-in guest profile', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1');
  const result = LHMS.guestPortal.savePreferences({ pillow: 'Buckwheat', marketing: true });
  assert.equal(result.ok, true);
  assert.equal(LHMS._pref.id, 'guest-1');
  assert.equal(LHMS._pref.patch.preferences.pillow, 'Buckwheat');
  assert.equal(LHMS._pref.patch.consent.marketing, true);
});

test('a guest cannot save an empty preference over a recorded one', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1');
  LHMS.guestPortal.savePreferences({ pillow: '  ', beverage: 'Espresso' });
  assert.deepEqual(Object.keys(LHMS._pref.patch.preferences), ['beverage']);
});

test('settling from the app posts the exact balance and is attributed to the guest app', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1', { folio: { charges: [], payments: [], total: 90000, paid: 40000, balance: 50000 } });
  const result = LHMS.guestPortal.settle({ confirm: true, method: 'Bank transfer' });
  assert.equal(result.ok, true);
  assert.equal(LHMS._pay.id, 'res-1');
  assert.equal(LHMS._pay.d.amount, 50000);
  assert.equal(LHMS._pay.d.method, 'Bank transfer');
  assert.equal(LHMS._pay.d.takenBy, 'Guest app');
});

test('an unconfirmed settle posts nothing', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1', { folio: { charges: [], payments: [], total: 90000, paid: 40000, balance: 50000 } });
  assert.equal(LHMS.guestPortal.settle({ method: 'Card' }).ok, false);
  assert.equal(LHMS._pay, undefined);
});

test('settling an already clear folio does nothing', () => {
  const { LHMS } = loadGuestPortal('Guest', 'guest-1');
  assert.equal(LHMS.guestPortal.settle({ confirm: true }).ok, false);
  assert.equal(LHMS._pay, undefined);
});

test('staff cannot settle a folio through the portal', () => {
  const { LHMS } = loadGuestPortal('Manager', 'guest-1', { folio: { charges: [], payments: [], total: 90000, paid: 40000, balance: 50000 } });
  assert.equal(LHMS.guestPortal.settle({ confirm: true }).ok, false);
  assert.equal(LHMS._pay, undefined);
});

test('clearing the balance in the app is what unlocks express checkout', () => {
  const folio = { charges: [], payments: [], total: 90000, paid: 40000, balance: 50000 };
  const { LHMS } = loadGuestPortal('Guest', 'guest-1', { folio });
  LHMS.actions.takePayment = (id, d) => {
    folio.paid += d.amount; folio.balance = 0; LHMS._pay = { id, d };
    return { ok: true };
  };
  assert.equal(LHMS.guestPortal.checkOut().ok, false);
  assert.equal(LHMS.guestPortal.settle({ confirm: true }).ok, true);
  assert.equal(LHMS.guestPortal.checkOut().ok, true);
  assert.equal(LHMS._out.id, 'res-1');
});

test('the portal page renders without a stay instead of throwing', () => {
  const { LHMS, stay } = loadGuestPortal('Guest', 'another-guest');
  LHMS.ui = { esc: (s) => String(s), icon: () => '<svg></svg>', timeGreeting: () => 'Good evening' };
  LHMS.get.property = () => ({ short: 'Grand Marina' });
  LHMS.session.signedIn = true;
  stay.guestId = 'guest-1';
  const html = LHMS.pages.guest('stay');
  assert.match(html, /No active stay/);
});
