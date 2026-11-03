const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Halls are the part of the price list most easily got wrong twice — a package,
// an add-on and a deposit all have to agree with the folio — so these run
// against the real seed and store rather than a hand-built fixture.
function loadApp(email) {
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
  LHMS.signIn(email, 'demo1234');
  return LHMS;
}

const asManager = () => loadApp('ifeoma.okafor@aureliagrand.com');
const asFrontDesk = () => loadApp('adamu.bello@aureliagrand.com');
const asHousekeeping = () => loadApp('grace.mensah@aureliagrand.com');

// Values come from inside the vm, so their prototypes differ from the test's;
// compare them by shape rather than by identity.
const sameShape = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

function nextDay(LHMS, weekend) {
  const U = LHMS.util;
  let d = U.addDays(U.today(), 1);
  for (let i = 0; i < 8; i++) {
    if (U.isWeekend(d) === weekend) return d;
    d = U.addDays(d, 1);
  }
  throw new Error('no matching weekday found');
}

// A slot the seeded board does not already hold.
function freeDate(LHMS, offset) {
  return LHMS.util.addDays(LHMS.util.today(), offset || 5);
}

function book(LHMS, over) {
  return LHMS.actions.createEvent(Object.assign({
    hallId: 'hall_grand', date: freeDate(LHMS), start: '10:00', end: '14:00',
    package: null, title: 'Test booking', organizer: 'Test organiser', guests: 40
  }, over || {}));
}

test('a hall is quoted hourly, as a half day or as a full day from the same price row', () => {
  const LHMS = asManager();
  const weekday = nextDay(LHMS, false);
  const weekend = nextDay(LHMS, true);

  const hourly = LHMS.price.hallQuote('svc_hall_grand', { date: weekday, start: '10:00', end: '14:00' });
  assert.equal(hourly.hours, 4);
  assert.equal(hourly.lines[0].unitPrice, 850000);
  assert.equal(hourly.lines[0].amount, 3400000, 'four hours at the listed hourly rate');

  const half = LHMS.price.hallQuote('svc_hall_grand', { date: weekday, start: '10:00', end: '14:00', package: 'half' });
  assert.equal(half.lines[0].unitPrice, 3400000, 'the package replaces the hourly line rather than adding to it');
  assert.equal(half.lines[0].basePrice, 3400000);

  const uplifted = LHMS.price.hallQuote('svc_hall_grand', { date: weekend, start: '10:00', end: '14:00', package: 'full' });
  assert.equal(uplifted.lines[0].unitPrice, 7440000, 'the weekend uplift moves the package with the hourly rate');
  assert.equal(uplifted.lines[0].basePrice, 6200000, 'the list price is kept beside the charge so the uplift is visible');
});

test('a festive list reprices the hall without the caller naming it', () => {
  const LHMS = asManager();
  const plain = LHMS.price.hallQuote('svc_hall_grand', { date: '2026-11-20', start: '10:00', end: '18:00' });
  const festive = LHMS.price.hallQuote('svc_hall_grand', { date: '2026-12-25', start: '10:00', end: '18:00' });
  assert.equal(plain.list.id, 'pl_std');
  assert.equal(festive.list.id, 'pl_fest');
  assert.equal(festive.lines[0].unitPrice, 977500, 'and the engine rounds the uplift to the naira step');
});

test('add-ons are priced into the booking and itemised beside the hall', () => {
  const LHMS = asManager();
  const q = LHMS.price.hallQuote('svc_hall_grand', {
    date: nextDay(LHMS, false), start: '10:00', end: '12:00',
    addons: [{ id: 'evt_sound', qty: 2 }, { id: 'evt_catering', qty: 50 }, { id: 'hall_garden', qty: 1 }]
  });
  const extras = q.lines.filter((l) => l.kind === 'addon');
  assert.equal(extras.length, 2, 'another hall cannot be added to itself as an extra');
  sameShape(extras.map((e) => e.amount), [500000, 625000]);
  assert.equal(q.subtotal, 1700000 + 500000 + 625000);
  assert.equal(q.deposit, LHMS.price.round(q.total * 0.5), 'the deposit is the percentage the price row carries');
});

test('a hall cannot be double-booked, but back-to-back slots are allowed', () => {
  const LHMS = asManager();
  const seeded = LHMS.db.events.length;
  const date = freeDate(LHMS);
  const first = book(LHMS, { date: date, start: '10:00', end: '14:00' });
  assert.ok(first.ok);

  const overlap = book(LHMS, { date: date, start: '13:00', end: '15:00' });
  assert.notEqual(overlap.error, undefined);
  assert.match(overlap.error, /Clash/);
  assert.equal(overlap.conflict.id, first.event.id, 'the refusal names the booking in the way');

  const same = book(LHMS, { date: date, start: '10:00', end: '14:00', title: 'Other function' });
  assert.match(same.error, /Clash/);

  assert.equal(LHMS.hallConflict('hall_grand', date, '14:00', '18:00'), null, 'touching the end of the previous booking is fine');
  const after = book(LHMS, { date: date, start: '14:00', end: '18:00', title: 'Evening reception' });
  assert.ok(after.ok);

  const otherHall = book(LHMS, { hallId: 'hall_garden', date: date, start: '10:00', end: '14:00' });
  assert.ok(otherHall.ok, 'a different hall at the same time is not a clash');

  assert.equal(LHMS.db.events.length, seeded + 3, 'three bookings took, two were refused');
});

test('a confirmed booking on a folio posts its lines and its taxes', () => {
  const LHMS = asManager();
  const res = LHMS.db.reservations.find((r) => r.status === 'In-house');
  const before = LHMS.folio(res.id).total;
  const done = book(LHMS, { reservationId: res.id, addons: { evt_sound: 1 } });
  assert.ok(done.ok);
  assert.equal(done.posted, true);

  const evt = done.event;
  assert.equal(LHMS.folio(res.id).total - before, evt.total, 'the folio moved by exactly what was quoted');
  assert.equal(evt.charges.length, evt.lines.length + evt.taxLines.length);
  const lines = LHMS.db.charges.filter((c) => evt.charges.indexOf(c.id) !== -1);
  assert.equal(lines.filter((c) => c.department === 'Events & Banqueting')[0].priceId, evt.priceId, 'the charge carries the price row it was sold from');
  assert.equal(lines.reduce((s, c) => s + c.amount, 0), evt.total);
});

test('a hold reserves the time but agrees no money until it is confirmed', () => {
  const LHMS = asManager();
  const res = LHMS.db.reservations.find((r) => r.status === 'In-house');
  const before = LHMS.folio(res.id).total;
  const held = book(LHMS, { reservationId: res.id, status: 'Hold' });
  assert.ok(held.ok);
  assert.equal(held.posted, false);
  assert.equal(LHMS.folio(res.id).total, before, 'a hold leaves the folio alone');

  const confirmed = LHMS.actions.confirmEvent(held.event.id);
  assert.ok(confirmed.ok);
  assert.equal(LHMS.folio(res.id).total - before, held.event.total, 'confirming posts the lines the hold was quoted on');
  assert.equal(LHMS.actions.confirmEvent(held.event.id).error, 'Only a hold can be confirmed.');
});

test('re-pricing a hall does not rewrite a booking or the charges it posted', () => {
  const LHMS = asManager();
  const res = LHMS.db.reservations.find((r) => r.status === 'In-house');
  // A weekday, so the weekend uplift on the seeded hall cannot be mistaken for
  // the new list price the assertion is about.
  const evt = book(LHMS, { reservationId: res.id, package: 'full', date: nextDay(LHMS, false) }).event;
  const charged = LHMS.folio(res.id).total;
  const soldAt = evt.lines[0].unitPrice;

  const moved = LHMS.actions.setPrice('prc_hall_grand_std', {
    amount: 9999999, surcharges: { halfDay: 8888888, fullDay: 9999999 }
  }, 'Pressures for next year');
  assert.ok(moved.ok);

  assert.equal(evt.lines[0].unitPrice, soldAt, 'the booking keeps the rate it was sold on');
  assert.equal(LHMS.db.charges.filter((c) => evt.charges.indexOf(c.id) !== -1).reduce((s, c) => s + c.amount, 0), evt.total);
  assert.equal(LHMS.folio(res.id).total, charged, 'and the folio is untouched by the new list');
  assert.equal(LHMS.price.hallQuote('svc_hall_grand', { date: evt.date, start: evt.start, end: evt.end, package: 'full' }).lines[0].unitPrice,
    10000000, 'a fresh booking is quoted on the new package, rounded to the naira step');
});

test('cancelling voids the posted lines, charges the agreed fee and keeps the history', () => {
  const LHMS = asManager();
  const res = LHMS.db.reservations.find((r) => r.status === 'In-house');
  // The seeded notice window is 72 hours, so a boardroom booked for the day
  // after tomorrow is cancelled inside it.
  const evt = book(LHMS, {
    hallId: 'hall_board', guests: 12, reservationId: res.id,
    date: LHMS.util.addDays(LHMS.util.today(), 2), start: '09:00', end: '11:00'
  }).event;
  const paid = LHMS.folio(res.id).paid;

  assert.equal(LHMS.price.cancellationFee(evt), LHMS.price.round(evt.total * 0.5));
  const done = LHMS.actions.cancelEvent(evt.id, 'Organiser postponed the summit');
  assert.ok(done.ok);
  assert.equal(done.fee, evt.cancelFee);
  assert.equal(evt.status, 'Cancelled');
  assert.equal(evt.cancelReason, 'Organiser postponed the summit');

  const voided = LHMS.db.charges.filter((c) => evt.voidedCharges.indexOf(c.id) !== -1);
  assert.equal(voided.length, evt.voidedCharges.length, 'the original lines are still on the database');
  assert.ok(voided.every((c) => c.voided), 'and every one of them is voided rather than deleted');
  assert.equal(evt.charges.length, 1, 'one cancellation line replaces them');
  const feeCharge = LHMS.db.charges.find((c) => c.id === evt.charges[0]);
  assert.equal(feeCharge.amount, done.fee);
  assert.equal(feeCharge.priceId, evt.priceId, 'the fee is traced to the same price row');
  assert.equal(LHMS.folio(res.id).paid, paid, 'voiding charges never moves a payment');
});

test('a cancellation outside the notice window costs nothing', () => {
  const LHMS = asManager();
  const evt = book(LHMS, { date: LHMS.util.addDays(LHMS.util.today(), 30) }).event;
  assert.equal(LHMS.price.cancellationFee(evt), 0, '30 days away is beyond the 72 hour notice');
  assert.ok(LHMS.actions.cancelEvent(evt.id, 'Plans changed').ok);
  assert.equal(evt.cancelFee, 0);
});

test('an unreasonable booking is refused before anything is written', () => {
  const LHMS = asManager();
  const date = freeDate(LHMS, 6);
  const count = LHMS.db.events.length;
  const bad = [
    { hallId: 'svc_dk', error: /Choose a hall/ },
    { date: date, start: '10:00', end: '14:00', hallId: 'hall_grand', title: '  ', error: /event a name/ },
    { date: date, start: '10:00', end: '14:00', organizer: '', error: /booking is for/ },
    { date: 'not-a-date', start: '10:00', end: '14:00', error: /event date/ },
    { date: LHMS.util.addDays(LHMS.util.today(), -1), start: '10:00', end: '14:00', error: /past/ },
    { date: date, start: '14:00', end: '10:00', error: /Check the times/ },
    { date: date, start: '10:00', end: '10:00', error: /at least an hour/ },
    { date: date, start: '10:00', end: '14:00', guests: 400, error: /licensed for 320/ }
  ];
  bad.forEach((row) => {
    const out = LHMS.actions.createEvent(Object.assign({
      hallId: 'hall_grand', date: date, start: '10:00', end: '14:00',
      title: 'Test', organizer: 'Org', guests: 40
    }, row));
    assert.match(out.error || '', row.error, JSON.stringify(row));
    assert.equal(out.ok, false);
  });
  assert.equal(LHMS.db.events.length, count, 'a refused booking leaves no trace');
});

test('a deposit is only taken where the money can actually be reconciled', () => {
  const LHMS = asManager();
  const res = LHMS.db.reservations.find((r) => r.status === 'In-house');
  const evt = book(LHMS, { reservationId: res.id }).event;
  assert.equal(evt.depositPaid, 0);
  const paid = LHMS.actions.takeEventDeposit(evt.id, 'Transfer');
  assert.ok(paid.ok);
  assert.equal(evt.depositPaid, evt.deposit);
  assert.equal(LHMS.folio(res.id).paid >= evt.deposit, true);
  assert.match(LHMS.actions.takeEventDeposit(evt.id).error, /already recorded/);

  const standalone = book(LHMS, { hallId: 'hall_board', guests: 12, date: freeDate(LHMS, 8) });
  assert.ok(standalone.ok);
  assert.match(LHMS.actions.takeEventDeposit(standalone.event.id).error, /not on a guest folio/);
});

test('a role without the events capability cannot book, confirm or cancel', () => {
  const LHMS = asHousekeeping();
  assert.match(book(LHMS).error, /cannot book halls/);
  assert.equal(LHMS.db.events.length, LHMS.buildSeed().events.length, 'the seeded board is untouched');
  assert.match(LHMS.actions.cancelEvent('evt_1', 'because').error, /cannot cancel/);
  assert.match(LHMS.actions.confirmEvent('evt_3').error, /cannot confirm hall/);
  assert.match(LHMS.actions.takeEventDeposit('evt_1').error, /cannot take event payments/);

  const desk = asFrontDesk();
  assert.ok(book(desk).ok, 'the front desk can book a hall');
});

test('the seeded board demonstrates a booked, an invoiced and a held event', () => {
  const LHMS = asManager();
  const events = LHMS.db.events;
  assert.equal(events.length, 5);
  assert.equal(events.filter((e) => e.status === 'Hold').length, 1);
  const standalone = events.filter((e) => !e.reservationId);
  assert.equal(standalone.length, 3, 'three events are billed to their own account');
  assert.equal(standalone.filter((e) => e.date < LHMS.db.meta.day).length, 2,
    'two are already delivered, so a trading period has hall revenue in it');
  assert.ok(standalone[0].deposit > 0, 'and each carries the deposit its invoice will ask for');
  standalone.forEach((e) => assert.equal(e.charges.length, 0, 'while nothing is invented as revenue'));
  events.forEach((e) => {
    assert.equal(e.subtotal + e.tax, e.total, e.title + ' reconciles');
    assert.equal(e.lines.reduce((s, l) => s + l.amount, 0), e.subtotal);
    assert.equal(e.service + e.vat, e.tax);
    assert.ok(e.priceId && e.listId, 'and remembers how it was priced');
    e.lines.forEach((l) => {
      assert.equal(l.unitPrice * l.qty, l.amount, l.name + ' is a plain multiple of its quantity');
      assert.ok(l.priceId && l.listId && l.currency, 'each line keeps its own price row');
    });
    // Demo data has to satisfy the rules the app enforces. The terrace's wedding
    // used to carry more guests than the licence the booking form refuses, which
    // made the board show a booking nobody could take twice.
    const svc = LHMS.db.services.filter((s) => s.id === e.hallServiceId)[0];
    assert.ok(svc.capacity, e.title + ' is booked on a hall with a licence to read');
    assert.ok(e.guests <= svc.capacity,
      e.title + ' puts ' + e.guests + ' guests in a hall licensed for ' + svc.capacity);
  });
});
