/* ============================================================
   The waitlist (PRD 6.1): a stay that holds no key, a release that
   holds a room for 24 hours, and the release pass a cancellation
   runs by itself. The invariants under test are the ones that keep
   the folio honest — a waitlisted stay never carries a charge, an
   offer is a record of its own, and money is only posted when the
   offer is actually taken up.
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadApp() {
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
  for (const file of ['data.js', 'store.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../assets', file), 'utf8');
    vm.runInNewContext(source, context, { filename: file });
  }
  const LHMS = context.window.LHMS;
  LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'demo1234');
  return LHMS;
}

function waitDraft(LHMS, over = {}) {
  const U = LHMS.util;
  const seed = LHMS.waitlist.queue('agm')[0];
  return Object.assign({
    propertyId: 'agm',
    roomTypeId: seed.roomTypeId,
    ratePlanId: 'flex',
    checkIn: seed.checkIn,
    checkOut: seed.checkOut,
    adults: 2,
    children: 0,
    firstName: 'Test',
    lastName: 'Wait',
    email: 'waitlist.tester@example.com',
    country: 'Nigeria'
  }, over);
}

const chargesFor = (LHMS, id) => LHMS.db.charges.filter((c) => c.reservationId === id && !c.voided);

test('the desk opens with one live release on the oldest waitlisted stay', () => {
  const LHMS = loadApp();
  const queue = LHMS.waitlist.queue('agm');
  assert.ok(queue.length >= 1, 'the seed leaves a waitlisted stay on the board');

  const offer = LHMS.waitlist.active('agm')[0];
  assert.ok(offer, 'the seed leaves a room held for that stay');
  assert.equal(offer.status, 'Offered');
  assert.equal(offer.reservationId, queue[0].id, 'the oldest stay is the one offered a room');

  const res = LHMS.get.reservation(offer.reservationId);
  assert.equal(res.status, 'Waitlist');
  assert.equal(res.roomId, null, 'a waitlisted stay holds no key');
  assert.equal(chargesFor(LHMS, res.id).length, 0, 'and carries no charge');

  const room = LHMS.get.room(offer.roomId);
  assert.equal(room.typeId, res.roomTypeId, 'the held room is of the stay’s type');
  const av = LHMS.calc.availability(res.roomTypeId, res.checkIn, res.checkOut, 'agm');
  assert.ok(av.rooms.some((r) => r.id === room.id), 'and it is free for the stay’s dates');

  const holdHours = (new Date(offer.expiresAt).getTime() - Date.now()) / 3600000;
  assert.ok(holdHours > 20 && holdHours <= LHMS.waitlist.offerHours,
    `the hold is inside the ${LHMS.waitlist.offerHours}-hour window (${holdHours.toFixed(1)}h left)`);
  assert.equal(LHMS.waitlist.position(res), 1, 'the offered stay sits at the head of the queue');
});

test('accepting a release confirms the stay and bills it at that moment', () => {
  const LHMS = loadApp();
  const offer = LHMS.waitlist.active('agm')[0];
  const res = LHMS.get.reservation(offer.reservationId);
  const before = chargesFor(LHMS, res.id).length;

  const r = LHMS.waitlist.accept(offer.id);
  assert.equal(r.ok, true, r.error);
  assert.equal(res.status, 'Confirmed');
  assert.equal(res.roomId, offer.roomId, 'the held room is now the stay’s room');
  assert.equal(res.waitlistConfirmedAt !== undefined, true);
  assert.equal(offer.status, 'Accepted');
  assert.equal(LHMS.waitlist.offerFor(res.id), null, 'the offer closes when it is taken up');

  const charges = chargesFor(LHMS, res.id);
  assert.ok(charges.length > before, 'the nights are posted at acceptance');
  assert.ok(charges.some((c) => c.department === 'Rooms'), 'a room night is on the folio');
  assert.equal(LHMS.folio(res.id).total, res.total, 'the folio totals the quoted stay');

  assert.ok(LHMS.db.activity.some((a) => a.action === 'confirmed a waitlist booking'));
  assert.ok(LHMS.db.notifications.some((n) => n.type === 'Waitlist confirmed'));

  const again = LHMS.waitlist.accept(offer.id);
  assert.equal(again.ok, false, 'an accepted offer cannot be taken twice');
});

test('a waitlist request holds no room, no deposit and no charge', () => {
  const LHMS = loadApp();
  const before = LHMS.db.reservations.length;
  const res = LHMS.actions.newBooking(waitDraft(LHMS, { waitlist: true }));

  assert.equal(LHMS.db.reservations.length, before + 1);
  assert.equal(res.status, 'Waitlist');
  assert.equal(res.roomId, null);
  assert.ok(res.total > 0, 'the stay is quoted even though it is not billed');
  assert.ok(res.roomTotal > 0);
  assert.equal(chargesFor(LHMS, res.id).length, 0, 'nothing is posted until a room is released');
  assert.equal(LHMS.db.payments.some((p) => p.reservationId === res.id), false);
  assert.ok(LHMS.db.activity.some((a) => a.action === 'joined the waitlist'));
  assert.ok(LHMS.db.notifications.some((n) => n.type === 'Added to the waitlist'));

  const queue = LHMS.waitlist.queue('agm');
  assert.equal(queue[queue.length - 1].id, res.id, 'a new request joins behind the older ones');

  const paid = LHMS.actions.newBooking(waitDraft(LHMS, { waitlist: true, deposit: 50000 }));
  assert.equal(paid.ok, false);
  assert.match(paid.error, /cannot take a deposit/);
});

test('an expired release closes itself and cannot be accepted', () => {
  const LHMS = loadApp();
  const offer = LHMS.waitlist.active('agm')[0];
  offer.expiresAt = new Date(Date.now() - 1000).toISOString();

  assert.equal(LHMS.waitlist.active('agm').some((o) => o.id === offer.id), false);

  const r = LHMS.waitlist.accept(offer.id);
  assert.equal(r.ok, false);
  assert.match(r.error, /expired/);
  assert.equal(offer.status, 'Expired');
  assert.ok(offer.closedAt, 'the close is stamped');
});

test('declining passes the room to the next matching stay', () => {
  const LHMS = loadApp();
  const held = LHMS.waitlist.active('agm')[0];
  const next = LHMS.actions.newBooking(waitDraft(LHMS, { waitlist: true }));

  const r = LHMS.waitlist.decline(held.id);
  assert.equal(r.ok, true, r.error);
  assert.equal(held.status, 'Declined');

  const offered = LHMS.waitlist.active('agm');
  assert.ok(offered.length >= 1, 'the released room is offered on the next pass');
  assert.equal(offered.some((o) => o.reservationId === held.reservationId), false,
    'the stay that declined is not offered again');
  assert.ok(offered.some((o) => o.reservationId === next.id), 'the next matching stay takes the released room');
  assert.ok(LHMS.db.activity.some((a) => a.action === 'declined a waitlist offer'));
});

test('cancelling a booking releases its room to the waitlist by itself', () => {
  const LHMS = loadApp();
  const held = LHMS.waitlist.active('agm')[0];
  LHMS.waitlist.decline(held.id);

  const wait = LHMS.waitlist.queue('agm')[0];
  const holds = [];
  let av = LHMS.calc.availability(wait.roomTypeId, wait.checkIn, wait.checkOut, 'agm');
  assert.ok(av.free > 0, 'the board has rooms to fill before the cancellation test means anything');
  while (av.free > 0) {
    holds.push(LHMS.actions.newBooking({
      guestId: 'gst_1', propertyId: 'agm', roomTypeId: wait.roomTypeId, ratePlanId: 'flex',
      checkIn: wait.checkIn, checkOut: wait.checkOut, adults: 1, children: 0
    }));
    av = LHMS.calc.availability(wait.roomTypeId, wait.checkIn, wait.checkOut, 'agm');
  }
  assert.equal(av.free, 0, 'the type is sold out for the stay’s dates');

  const r = LHMS.actions.cancelReservation(holds[0].id);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.res.status, 'Cancelled');
  assert.equal(r.offers.length, 1, 'the cancellation releases the room in the same pass');
  assert.equal(r.offers[0].reservationId, wait.id);
  assert.equal(r.offers[0].roomId, holds[0].roomId, 'the freed room is the one offered');

  assert.ok(LHMS.db.activity.some((a) => a.action === 'cancelled a reservation'));
  assert.ok(LHMS.db.activity.some((a) => a.action === 'released a waitlist room'));
  assert.ok(LHMS.db.notifications.some((n) => n.type === 'Waitlist release'));
});

test('leaving the waitlist closes the request without a charge', () => {
  const LHMS = loadApp();
  const res = LHMS.actions.newBooking(waitDraft(LHMS, { waitlist: true }));
  const r = LHMS.actions.cancelReservation(res.id);
  assert.equal(r.ok, true, r.error);
  assert.equal(res.status, 'Cancelled');
  assert.equal(chargesFor(LHMS, res.id).length, 0);

  const again = LHMS.actions.cancelReservation(res.id);
  assert.equal(again.ok, false, 'a cancelled stay cannot be cancelled twice');
});
