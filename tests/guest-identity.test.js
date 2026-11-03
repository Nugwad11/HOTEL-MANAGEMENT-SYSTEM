const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Loads the real seed + store into a sandbox so the guest-identity resolver is
// exercised against the same data the browser demo runs on.
function loadStore() {
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
  return context.window.LHMS;
}

function liveStaysOf(LHMS, guestId) {
  const today = LHMS.util.today();
  return LHMS.db.reservations.filter((r) => r.guestId === guestId && (
    r.status === 'In-house' ||
    (r.status === 'Confirmed' && r.checkIn <= today && r.checkOut > today)
  ));
}

function demoStay(LHMS) {
  const stay = LHMS.guestStay();
  if (!stay) throw new Error('the seed no longer gives the demo guest a live stay');
  return stay;
}

test('the seed gives the demo guest exactly one live stay', () => {
  const LHMS = loadStore();
  assert.equal(liveStaysOf(LHMS, 'gst_1').length, 1);
});

test('guest sign-in binds the session to the live stay and its property', () => {
  const LHMS = loadStore();
  const result = LHMS.signIn('guest@aureliagrand.com', 'demo1234');
  const stay = demoStay(LHMS);
  assert.equal(result.ok, true);
  assert.equal(result.role, 'Guest');
  assert.equal(LHMS.session.guestId, 'gst_1');
  assert.equal(LHMS.resolveGuestId(), 'gst_1');
  assert.equal(stay.guestId, 'gst_1');
  assert.equal(LHMS.session.propertyId, stay.propertyId);
});

test('staff sessions never resolve a guest identity', () => {
  const LHMS = loadStore();
  LHMS.signIn('adamu.bello@aureliagrand.com', 'demo1234');
  assert.equal(LHMS.resolveGuestId(), null);
});

test('a confirmed arrival dated today is a stay, so digital check-in is reachable', () => {
  const LHMS = loadStore();
  LHMS.signIn('guest@aureliagrand.com', 'demo1234');
  const stay = demoStay(LHMS);
  stay.status = 'Confirmed';
  stay.mobileKey = false;
  LHMS.save();
  assert.equal(LHMS.guestStay().id, stay.id);
  assert.equal(LHMS.resolveGuestId(), 'gst_1');
});

test('an arrival dated tomorrow is not a stay yet, but the guest is still identified', () => {
  const LHMS = loadStore();
  LHMS.signIn('guest@aureliagrand.com', 'demo1234');
  const stay = demoStay(LHMS);
  stay.status = 'Confirmed';
  stay.checkIn = LHMS.util.addDays(LHMS.util.today(), 1);
  stay.checkOut = LHMS.util.addDays(stay.checkIn, 2);
  LHMS.save();
  assert.equal(LHMS.guestStay(), null);
  assert.equal(LHMS.resolveGuestId(), 'gst_1');
});

test('a departed stay is no longer what the portal speaks for', () => {
  const LHMS = loadStore();
  LHMS.signIn('guest@aureliagrand.com', 'demo1234');
  demoStay(LHMS).status = 'Checked out';
  LHMS.save();
  assert.equal(LHMS.guestStay(), null);
});

test('checking the guest in through the front desk moves the portal to in-house', () => {
  const LHMS = loadStore();
  LHMS.signIn('guest@aureliagrand.com', 'demo1234');
  const stay = demoStay(LHMS);
  stay.status = 'Confirmed';
  LHMS.save();
  const result = LHMS.actions.checkIn(stay.id, { mobileKey: true, eta: '14:30' });
  assert.equal(result.ok, true);
  assert.equal(LHMS.guestStay().status, 'In-house');
  assert.equal(LHMS.guestStay().mobileKey, true);
  assert.equal(LHMS.guestStay().eta, '14:30');
});
