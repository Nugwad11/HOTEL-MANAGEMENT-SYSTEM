/* ============================================================
   assets/api.js is loaded on every page, so two things have to be true of it
   and neither is obvious from reading it: it must leave the local engine in
   charge of the app's figures — the login form reads `result.ok` straight off
   LHMS.signIn, and a client that replaced that call with a Promise made the
   form fail with an empty error toast, which is exactly what this file used to
   do once an api-base was set — and each of its doors must send the one request
   the router declares. The server's own copy of that contract lives in
   server/tests/api-client.test.js; what is proved here is the behaviour, in
   the same sandbox the pages run in.
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const BASE = 'http://api.test';

/* The page's own boot order, in miniature: the engine, then the client, with
   an api-base meta only when the test asks for one. */
function boot(opts) {
  const o = opts || {};
  const cache = {};
  const storage = {
    getItem: (k) => (k in cache ? cache[k] : null),
    setItem: (k, v) => { cache[k] = String(v); },
    removeItem: (k) => { delete cache[k]; }
  };
  const sent = [];
  const context = {
    window: {}, console: { warn() {}, log() {}, info() {}, error() {} },
    localStorage: storage, sessionStorage: storage,
    document: { querySelector: (sel) => (sel === 'meta[name="api-base"]' && o.base ? { content: o.base } : null) },
    fetch: (url, init) => {
      sent.push({ url, method: init.method, body: init.body, headers: init.headers });
      const answer = typeof o.reply === 'function' ? o.reply(url, init) : o.reply;
      return Promise.resolve(answer || { ok: true, status: 200, json: () => Promise.resolve({}) });
    },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    URLSearchParams, encodeURIComponent,
    parseInt, parseFloat, isNaN, setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => fn, clearTimeout: () => {}
  };
  for (const file of ['data.js', 'store.js', 'api.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets', file), 'utf8'),
      context, { filename: file });
  }
  return { LHMS: context.window.LHMS, sent, storage };
}

const MANAGER = 'ifeoma.okafor@aureliagrand.com';

test("with no api-base the client does not enter the app at all", () => {
  const { LHMS } = boot();
  assert.equal(LHMS.api, undefined, 'there is nothing to call when there is nowhere to call');
  const signedIn = LHMS.signIn(MANAGER, 'demo1234');
  assert.equal(signedIn.ok, true, 'the engine signs in exactly as it always did');
});

test("a configured base gives the pages a client without taking the engine away", () => {
  const { LHMS, sent } = boot({ base: BASE });
  assert.equal(typeof LHMS.api.folio, 'function', 'the doors are there');
  assert.equal(typeof LHMS.api.saveHotelSettings, 'function', 'including the settings writes');
  const signedIn = LHMS.signIn(MANAGER, 'demo1234');
  // The whole defect, in one assertion: the login form reads this synchronously.
  assert.equal(typeof signedIn.then, 'undefined', 'sign-in is still the store, not a request');
  assert.equal(signedIn.ok, true, 'and it still answers with the shape the form expects');
  assert.equal(sent.length, 0, 'signing in through the engine touches no network');
});

test("a door sends the one request the router declares", async () => {
  const { LHMS, sent } = boot({ base: BASE + '/' });
  await LHMS.api.postCharge('res_9', { amount: 5000, department: 'In-Agusto' });
  // Field by field, because the header object was built inside the sandbox and
  // a whole-object comparison would be arguing about prototypes.
  assert.equal(sent[0].url, BASE + '/api/reservations/res_9/charges',
    'a trailing slash on the base does not double up');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].body, JSON.stringify({ amount: 5000, department: 'In-Agusto' }),
    'the body travels as written');
  assert.equal(sent[0].headers['Content-Type'], 'application/json');
  assert.equal(sent[0].headers.Authorization, undefined, 'a door opened before signing in sends no token');

  await LHMS.api.roomAvailability('rt_dk', { checkIn: '2026-11-01', checkOut: '2026-11-03' });
  assert.equal(sent[1].method, 'GET');
  assert.equal(sent[1].url, BASE + '/api/rooms/types/rt_dk/availability?checkIn=2026-11-01&checkOut=2026-11-03');
  assert.equal(sent[1].body, undefined, 'a read carries no body');

  await LHMS.api.toggleIntegration('agm', 'crm');
  assert.equal(sent[2].url, BASE + '/api/properties/agm/integrations/crm/toggle');
  assert.equal(sent[2].method, 'POST');

  await LHMS.api.voidCharge('res_9', 'chg_3');
  assert.equal(sent[3].url, BASE + '/api/reservations/res_9/charges/chg_3/void',
    'two placeholders fill in the order the path reads them');
});

test("an unfilled placeholder refuses rather than asking for a doubled slash", () => {
  const { LHMS, sent } = boot({ base: BASE });
  assert.throws(() => LHMS.api.folio(), /reservationId is required/,
    '"/api/reservations//folio" would come back as somebody else\'s 404');
  assert.throws(() => LHMS.api.markNotification('', { read: true }), /notificationId is required/);
  assert.equal(sent.length, 0, 'a door that cannot be named is not sent');
});

test("signing in through the client hands the rest of the doors the token", async () => {
  const { LHMS, sent, storage } = boot({
    base: BASE,
    reply: (url) => (url.indexOf('/api/auth/login') !== -1
      ? { ok: true, status: 200, json: () => Promise.resolve({ token: 'tkn_1', user: { role: 'Manager' } }) }
      : { ok: true, status: 200, json: () => Promise.resolve({}) })
  });
  const data = await LHMS.api.login(MANAGER, 'demo1234');
  assert.equal(data.user.role, 'Manager');
  assert.equal(storage.getItem('aurelia.lhms.token'), 'tkn_1', 'the session is kept out of the code path that reads it');
  await LHMS.api.expenses({ propertyId: 'agm' });
  assert.equal(sent[1].headers.Authorization, 'Bearer tkn_1');
  assert.equal(sent[1].url, BASE + '/api/finance/expenses?propertyId=agm');

  await LHMS.api.logout();
  assert.equal(storage.getItem('aurelia.lhms.token'), null, 'signing out drops it, whatever the answer');
  assert.equal(sent[2].method, 'POST');
  assert.equal(sent[2].headers.Authorization, 'Bearer tkn_1',
    'the sign-out door itself still has to be believed, so the token goes with it');
  await LHMS.api.health();
  assert.equal(sent[3].headers.Authorization, undefined, 'a door after sign-out sends no token');
});

test("a refusal comes back as the server's sentence, not a swallowed one", async () => {
  const { LHMS } = boot({
    base: BASE,
    reply: () => ({ ok: false, status: 422, json: () => Promise.resolve({ error: 'A deposit cannot be more than the stay.' }) })
  });
  await assert.rejects(() => LHMS.api.saveHotelSettings('agm', { depositPct: 120 }),
    (err) => {
      assert.equal(err.message, 'A deposit cannot be more than the stay.',
        'the page can put the API\'s own words in front of the user');
      assert.equal(err.status, 422);
      assert.equal(err.data.error, 'A deposit cannot be more than the stay.');
      return true;
    });
});
