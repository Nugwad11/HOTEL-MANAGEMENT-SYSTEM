/* ============================================================
   The shipped surface is the one thing a deployment cannot take back: every
   file under assets/ and index.html is published by `npm start`, so anything
   left in them ships. Two promises are checked here.

   The first is that the demonstration framing is gone: no screen offers a
   perspective switch, no setup tab offers to reset the workspace, and no
   shipped text calls the product a demo. The datasource may still be fictional
   — DEPLOYMENT.md says so — but the product no longer presents itself as one.

   The second is that removing that framing did not remove the engine: the
   sign-in must stay synchronous (the form reads `result.ok` off the return
   value; a Promise would toast an empty error), and the role switch the
   automation drives must still exist even though no button offers it.
   ============================================================ */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MANAGER = 'ifeoma.okafor@aureliagrand.com';

function boot() {
  const cache = {};
  const storage = {
    getItem: (k) => (k in cache ? cache[k] : null),
    setItem: (k, v) => { cache[k] = String(v); },
    removeItem: (k) => { delete cache[k]; }
  };
  const context = {
    window: {}, console: { warn() {}, log() {}, info() {}, error() {} },
    localStorage: storage, sessionStorage: storage,
    document: { querySelector: () => null, addEventListener() {} },
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error, Promise,
    encodeURIComponent, parseInt, parseFloat, isNaN,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: (fn) => fn, clearTimeout: () => {}
  };
  for (const file of ['data.js', 'store.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'assets', file), 'utf8'),
      context, { filename: file });
  }
  return context.window.LHMS;
}

function shippedSources() {
  const files = ['index.html', 'assets/styles.css'].map((f) => path.join(ROOT, f));
  for (const name of fs.readdirSync(path.join(ROOT, 'assets'))) {
    if (name.endsWith('.js')) files.push(path.join(ROOT, 'assets', name));
  }
  return files.map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
}

test('the workspace ships the staff accounts and nothing demo-shaped', () => {
  const LHMS = boot();
  assert.equal(LHMS.STAFF_ACCOUNTS.length, 7, 'every seeded desk is still signable');
  assert.equal(LHMS.DEMO_ACCOUNTS, undefined, 'the old demo account export is gone');
  assert.equal(typeof LHMS.resetDemo, 'undefined', 'a deployed workspace cannot be reset from the UI');
});

test('sign-in is synchronous, as the form reads it', () => {
  const LHMS = boot();
  const result = LHMS.signIn(MANAGER, 'demo1234');
  assert.equal(typeof result.then, 'undefined', 'a Promise here toasts an empty sign-in error');
  assert.equal(result.ok, true);
  assert.equal(LHMS.session.propertyId, 'agm');
  assert.equal(LHMS.session.role, 'Manager');
  assert.equal(LHMS.signIn('nobody@example.com', 'demo1234').role, 'Front Desk',
    'an unknown email can never sign in as Manager');
});

test('the automation door survives the removal of the UI switch', () => {
  const LHMS = boot();
  LHMS.signIn(MANAGER, 'demo1234');
  assert.equal(typeof LHMS.switchRole, 'function', 'tests/shoot.js drives captures through it');
  LHMS.switchRole('housekeeping');
  assert.equal(LHMS.session.role, 'housekeeping');
});

test('no shipped file calls the product a demo', () => {
  for (const { file, text } of shippedSources()) {
    assert.doesNotMatch(text, /\bdemo\b/i, path.relative(ROOT, file) + ' still frames the product as a demo');
  }
});

test('the sign-in page offers no pre-filled credentials and no perspective switch', () => {
  const html = fs.readFileSync(path.join(ROOT, 'assets/app.js'), 'utf8');
  assert.doesNotMatch(html, /View as/i, 'the role selector is gone from the top bar');
  assert.doesNotMatch(html, /data-change="role"/, 'no control writes a role change');
  assert.doesNotMatch(html, /demo-hint/, 'the demo credentials note is gone');
  assert.doesNotMatch(html, /value="ifeoma\.okafor@aureliagrand\.com"/, 'the email field starts empty');
});

test('Hotel setup reports the system, not a demo reset', () => {
  const js = fs.readFileSync(path.join(ROOT, 'assets/pages-admin.js'), 'utf8');
  assert.doesNotMatch(js, /reset-demo-open/, 'nothing in the UI can wipe the workspace');
  assert.doesNotMatch(js, /\["demo",/, 'the setup tab is named for the system it reports');
  assert.match(js, /\["system", "System &amp; data"\]/);
});

test('the page policy allows its own origin but no external connections', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /connect-src 'none'/, 'the policy would block a same-origin API');
});
