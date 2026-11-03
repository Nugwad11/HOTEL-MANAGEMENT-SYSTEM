const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The booking flow is pricing- and availability-dependent, so it is tested
// against the real seed and store rather than mocks.
function loadPortal() {
  const cache = {};
  const storage = {
    getItem: (k) => (k in cache ? cache[k] : null),
    setItem: (k, v) => { cache[k] = String(v); },
    removeItem: (k) => { delete cache[k]; }
  };
  const context = {
    window: {}, console: { warn() {}, log() {}, error() {} },
    localStorage: storage, sessionStorage: storage,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
    parseInt, parseFloat, isNaN, setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => fn, clearTimeout: () => {}
  };
  for (const file of ['data.js', 'store.js', 'pages-guest.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../assets', file), 'utf8');
    vm.runInNewContext(source, context, { filename: file });
  }
  const LHMS = context.window.LHMS;
  LHMS.signIn('guest@aureliagrand.com', 'demo1234');
  return LHMS;
}

function draft(LHMS, over = {}) {
  const U = LHMS.util;
  return Object.assign({
    propertyId: 'agm',
    roomTypeId: 'dk',
    ratePlanId: 'flex',
    checkIn: U.addDays(U.today(), 120),
    checkOut: U.addDays(U.today(), 122),
    adults: 2,
    children: 0,
    notes: 'High floor if possible'
  }, over);
}

test('a guest books a future stay from the portal', () => {
  const LHMS = loadPortal();
  const before = LHMS.db.reservations.length;
  const result = LHMS.guestPortal.book(draft(LHMS));
  assert.equal(result.ok, true, result.error);
  assert.equal(LHMS.db.reservations.length, before + 1);

  const res = LHMS.db.reservations[0];
  assert.equal(res.guestId, 'gst_1');
  assert.equal(res.propertyId, 'agm');
  assert.equal(res.status, 'Confirmed');
  assert.equal(res.source, 'Guest app');
  assert.equal(res.channel, 'Direct');
  assert.ok(res.roomId, 'a room is allocated from the availability pool');
  assert.equal(LHMS.get.room(res.roomId).typeId, 'dk');
  assert.equal(res.notes, 'High floor if possible');
});

test('the booked price matches the front-desk quote and folio', () => {
  const LHMS = loadPortal();
  const d = draft(LHMS);
  const result = LHMS.guestPortal.book(d);
  const quote = LHMS.calc.quote(d.roomTypeId, d.ratePlanId, d.checkIn, d.checkOut, d.adults, d.children);
  const res = LHMS.db.reservations[0];
  assert.equal(result.quote.total, quote.total);
  assert.equal(res.total, quote.total);
  assert.equal(LHMS.folio(res.id).total, quote.total);
  assert.equal(LHMS.folio(res.id).balance, quote.total, 'nothing is prepaid at booking');
});

test('the new booking appears as upcoming in the portal and on the staff arrivals board', () => {
  const LHMS = loadPortal();
  const d = draft(LHMS);
  LHMS.guestPortal.book(d);
  const upcoming = LHMS.guestPortal.upcomingBookings('gst_1');
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].id, LHMS.db.reservations[0].id);
  assert.ok(LHMS.calc.arrivals('agm', d.checkIn).some((r) => r.id === upcoming[0].id));
});

test('booking does not move the portal off the stay it is already speaking for', () => {
  const LHMS = loadPortal();
  const liveBefore = LHMS.guestStay().id;
  LHMS.guestPortal.book(draft(LHMS));
  assert.equal(LHMS.guestStay().id, liveBefore);
});

test('a guest with nothing in house is still identified and can book', () => {
  const LHMS = loadPortal();
  LHMS.guestStay().status = 'Checked out';
  LHMS.save();
  assert.equal(LHMS.guestStay(), null);
  assert.equal(LHMS.resolveGuestId(), 'gst_1');
  const result = LHMS.guestPortal.book(draft(LHMS));
  assert.equal(result.ok, true, result.error);
  assert.equal(LHMS.db.reservations[0].guestId, 'gst_1');
});

test('an arrival date in the past is refused', () => {
  const LHMS = loadPortal();
  const today = LHMS.util.today();
  const result = LHMS.guestPortal.book(draft(LHMS, {
    checkIn: LHMS.util.addDays(today, -2),
    checkOut: today
  }));
  assert.equal(result.ok, false);
  assert.match(result.error, /past/);
  assert.equal(LHMS.db.reservations[0].checkIn !== LHMS.util.addDays(today, -2), true);
});

test('a departure that is not after arrival is refused', () => {
  const LHMS = loadPortal();
  const ci = LHMS.util.addDays(LHMS.util.today(), 90);
  const result = LHMS.guestPortal.book(draft(LHMS, { checkIn: ci, checkOut: ci }));
  assert.equal(result.ok, false);
  assert.match(result.error, /after arrival/);
});

test('a party larger than the room sleeps is refused', () => {
  const LHMS = loadPortal();
  const result = LHMS.guestPortal.book(draft(LHMS, { roomTypeId: 'dk', adults: 3, children: 1 }));
  assert.equal(result.ok, false);
  assert.match(result.error, /sleeps 2/);
});

test('an overlapping booking of the last room of a type is refused', () => {
  const LHMS = loadPortal();
  const first = LHMS.guestPortal.book(draft(LHMS, { propertyId: 'apa', roomTypeId: 'ps' }));
  assert.equal(first.ok, true, first.error);
  const second = LHMS.guestPortal.book(draft(LHMS, { propertyId: 'apa', roomTypeId: 'ps' }));
  assert.equal(second.ok, false);
  assert.match(second.error, /is free from/);
});

test('an unknown room type or rate plan is refused rather than priced by default', () => {
  const LHMS = loadPortal();
  assert.match(LHMS.guestPortal.book(draft(LHMS, { roomTypeId: 'nope' })).error, /room type/);
  assert.match(LHMS.guestPortal.book(draft(LHMS, { ratePlanId: 'nope' })).error, /rate plan/);
});

test('staff cannot create a booking through the guest portal', () => {
  const LHMS = loadPortal();
  LHMS.switchRole('Front Desk');
  const result = LHMS.guestPortal.book(draft(LHMS));
  assert.equal(result.ok, false);
  assert.match(result.error, /Only the guest/);
});
