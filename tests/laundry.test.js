const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Laundry is where a small rounding error becomes a guest complaint, so the
// order, the folio line and the express uplift are all checked against the
// engine rather than against a number written into the test.
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
const asHousekeeping = () => loadApp('grace.mensah@aureliagrand.com');
const asFrontDesk = () => loadApp('adamu.bello@aureliagrand.com');

const sameShape = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

// One database, two pairs of hands: pricing is a Manager act and taking the
// order is a Housekeeping act, and the test has to show both in one store.
const as = (LHMS, email) => { LHMS.signIn(email, 'demo1234'); return LHMS; };

function inHouse(LHMS) {
  return LHMS.db.reservations.find((r) => r.status === 'In-house' && r.propertyId === 'agm');
}

function order(LHMS, over) {
  return LHMS.actions.createLaundryOrder(Object.assign({
    reservationId: inHouse(LHMS).id, items: { ld_shirt: 4, ld_suit: 1 }
  }, over || {}));
}

test('the express uplift is a percentage of the listed price, not a new price', () => {
  const LHMS = asManager();
  const plain = LHMS.price.laundryQuote([{ id: 'ld_shirt', qty: 4 }], {});
  const fast = LHMS.price.laundryQuote([{ id: 'ld_shirt', qty: 4 }], { express: true });

  assert.equal(plain.lines[0].unitPrice, 2500);
  assert.equal(plain.lines[0].amount, 10000);
  assert.equal(fast.lines[0].unitPrice, 3750, 'shirts carry a 50% express surcharge');
  assert.equal(fast.lines[0].amount, 15000);
  sameShape(fast.lines[0].added, [{ label: 'Express service', amount: 5000 }]);
  assert.equal(fast.etaMins, plain.etaMins / 2, 'express work is promised in half the turnaround');
});

test('an order posts its priced lines and its taxes to the guest folio', () => {
  const LHMS = asHousekeeping();
  const res = inHouse(LHMS);
  const before = LHMS.folio(res.id).total;
  const done = order(LHMS, { express: true });
  assert.ok(done.ok);

  const o = done.order;
  assert.equal(o.status, 'Received');
  assert.equal(o.roomNumber, LHMS.get.room(res.roomId).number);
  assert.equal(LHMS.folio(res.id).total - before, o.total, 'the folio moved by exactly what was quoted');
  assert.equal(o.charges.length, o.lines.length + o.taxLines.length);
  const charged = LHMS.db.charges.filter((c) => o.charges.indexOf(c.id) !== -1);
  assert.equal(charged.reduce((s, c) => s + c.amount, 0), o.total);
  assert.equal(o.subtotal + o.tax, o.total);
  sameShape(o.lines.map((l) => l.amount), [15000, 11250]);
  o.lines.forEach((l) => {
    assert.equal(l.unitPrice * l.qty, l.amount);
    assert.ok(l.priceId && l.listId && l.basePrice, 'each line keeps the price it was taken at');
  });
  assert.ok(new Date(o.dueAt) > new Date(o.createdAt), 'and promises a collection time');
});

test('an unpriced or unrecognised service cannot be ordered', () => {
  const LHMS = asManager();
  assert.ok(LHMS.actions.setServiceActive('svc_ld_towel', false, 'Linen shortage').ok);
  as(LHMS, 'grace.mensah@aureliagrand.com');

  const done = order(LHMS, { items: { ld_towel: 6 } });
  assert.match(done.error, /Choose at least one service that is being offered/);
  assert.equal(LHMS.db.laundry.length, 2, 'a refused order leaves nothing behind');

  assert.equal(LHMS.price.laundryQuote([{ id: 'ld_towel', qty: 6 }], {}), null);
  assert.equal(LHMS.price.laundryQuote([{ id: 'not_a_service', qty: 2 }], {}), null);
  assert.match(order(LHMS, { items: {} }).error, /Choose at least one service/);
});

test('a price change cannot rewrite laundry already taken', () => {
  const LHMS = asHousekeeping();
  const res = inHouse(LHMS);
  const o = order(LHMS).order;
  const sold = o.lines.map((l) => l.unitPrice);
  const charged = LHMS.folio(res.id).total;

  as(LHMS, 'ifeoma.okafor@aureliagrand.com');
  assert.ok(LHMS.actions.setPrice('prc_ld_shirt_std', { amount: 9999 }, 'Detergent costs').ok);

  assert.equal(LHMS.db.laundry.find((x) => x.id === o.id).total, o.total, 'the stored order is untouched');
  sameShape(o.lines.map((l) => l.unitPrice), sold);
  assert.equal(LHMS.folio(res.id).total, charged);
  assert.equal(LHMS.price.laundryQuote([{ id: 'ld_shirt', qty: 1 }], {}).lines[0].unitPrice, 10000);
});

test('work only moves forward through the board', () => {
  const LHMS = asHousekeeping();
  const o = order(LHMS).order;
  assert.equal(o.status, 'Received');
  assert.ok(LHMS.actions.setLaundryStatus(o.id, 'In progress').ok);
  assert.ok(LHMS.actions.setLaundryStatus(o.id, 'Ready').ok);
  const notices = LHMS.db.notifications.filter((n) => n.type === 'Laundry ready');
  assert.equal(notices.length, 1, 'the room is told when it can be collected');

  const back = LHMS.actions.setLaundryStatus(o.id, 'Received');
  assert.match(back.error, /cannot go back from Ready/);
  assert.equal(o.status, 'Ready');

  assert.ok(LHMS.actions.setLaundryStatus(o.id, 'Collected').ok);
  assert.ok(o.returnedAt, 'collecting stamps the hand-over time');
  assert.match(LHMS.actions.setLaundryStatus(o.id, 'Unknown').error, /Unknown stage/);
  assert.match(LHMS.actions.setLaundryStatus('lda_missing', 'Ready').error, /Order not found/);
});

test('a role without the laundry capability cannot take or move orders', () => {
  const LHMS = asFrontDesk();
  assert.match(order(LHMS).error, /cannot take laundry orders/);
  assert.match(LHMS.actions.setLaundryStatus(LHMS.db.laundry[0].id, 'Ready').error, /cannot update laundry/);
  assert.equal(LHMS.db.laundry[0].status, 'In progress', 'the seeded board is untouched');
});

test('laundry belongs to a guest who is actually here', () => {
  const LHMS = asHousekeeping();
  const gone = LHMS.db.reservations.find((r) => r.status === 'Checked out');
  assert.match(order(LHMS, { reservationId: gone.id }).error, /staying with us/);
  assert.match(order(LHMS, { reservationId: 'res_nope' }).error, /Choose the guest/);
});

test('the seeded orders reconcile with the folios they charged', () => {
  const LHMS = asManager();
  const orders = LHMS.db.laundry;
  assert.equal(orders.length, 2);
  orders.forEach((o) => {
    assert.equal(o.subtotal + o.tax, o.total);
    assert.equal(o.lines.reduce((s, l) => s + l.amount, 0), o.subtotal);
    const charged = LHMS.db.charges.filter((c) => o.charges.indexOf(c.id) !== -1);
    assert.equal(charged.length, o.charges.length, o.ref + ' keeps every line it posted');
    assert.equal(charged.reduce((s, c) => s + c.amount, 0), o.total);
    assert.ok(o.charges.every((id) => LHMS.db.charges.some((c) => c.id === id)), 'no charge is invented');
    const first = LHMS.db.charges.find((c) => c.id === o.lines[0].chargeId);
    assert.ok(LHMS.price.snapshotOf(first), 'and each posted line can be traced back to its price row');
  });
  const express = orders.filter((o) => o.express);
  assert.equal(express.length, 1);
  express[0].lines.forEach((l) => assert.ok(l.added.length, 'the uplift is shown on the line, not buried in the rate'));
});
