/**
 * Bulk price update — the spreadsheet path into the catalogue.
 *
 * A file is only a convenience if it lands through the same door as a form: the
 * reason, the history entry, the rounding and the approval limit all have to
 * hold when fifty prices arrive at once. These run against the real seed, so
 * the figures are the ones the rate card was loaded with.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

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
const asRevenue = () => loadApp('chiamaka.obi@aureliagrand.com');
const asFrontDesk = () => loadApp('adamu.bello@aureliagrand.com');

// Values come from inside the vm, so their prototypes differ from the test's;
// compare them by shape rather than by identity.
const sameShape = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

// The header the page's own export writes, in a shape a test can shorten.
const line = (...cells) => cells;
const file = (header, lines, sep = ',') =>
  [header].concat(lines).map((cells) => cells.join(sep)).join('\r\n');
const dk = (L) => L.price.priceRow('prc_dk_std');

// The engine prices tonight by default, and tonight can be a weekend night
// carrying the uplift — a fixed figure has to be read on a fixed weekday.
const nextWeekday = (L) => {
  const U = L.util;
  let d = U.addDays(U.today(), 1);
  for (let i = 0; i < 8; i++) {
    if (!U.isWeekend(d)) return d;
    d = U.addDays(d, 1);
  }
  throw new Error('no weekday ahead');
};

test('a file that repeats the current values changes nothing', () => {
  const LHMS = asManager();
  const before = LHMS.price.history('svc_dk').length;
  const plan = LHMS.price.planImport(
    file(['Price ID', 'Amount'], [line('prc_dk_std', dk(LHMS).amount)]), 'Q4 rate card');
  assert.equal(plan.ok, true);
  sameShape(plan.counts, { change: 0, queue: 0, unchanged: 1, reject: 0 });
  assert.equal(plan.changes.length, 0);

  const result = LHMS.actions.applyPriceImport(plan);
  assert.equal(result.ok, true);
  assert.equal(result.applied, 0);
  assert.equal(dk(LHMS).amount, 185000, 'a no-op file is a no-op');
  assert.equal(LHMS.price.history('svc_dk').length, before, 'and it writes no history');
});

test('an edited amount lands through the same door the edit form uses', () => {
  const LHMS = asManager();
  const plan = LHMS.price.planImport(
    file(['Price ID', 'Amount'], [line('prc_dk_std', '205000')]), 'Festive repricing');
  assert.equal(plan.counts.change, 1);
  sameShape(plan.rows[0].diff, [['amount', 185000, 205000]]);

  const result = LHMS.actions.applyPriceImport(plan);
  assert.equal(result.applied, 1);
  assert.equal(dk(LHMS).amount, 205000);
  assert.equal(LHMS.price.nightRate('dk', { date: nextWeekday(LHMS) }), 205000,
    'the engine reads the new figure immediately');

  const entry = LHMS.price.history('svc_dk')[0];
  assert.equal(entry.priceId, 'prc_dk_std');
  assert.equal(entry.reason, 'Festive repricing');
  assert.equal(entry.by, 'Ifeoma Okafor');
  sameShape([entry.from.amount, entry.to.amount], [185000, 205000]);

  const logged = LHMS.db.activity.find((a) => a.action === 'imported prices from a file');
  assert.ok(logged, 'the import itself is an audit event');
  assert.match(logged.detail, /1 price updated/);
});

test('a cell typed the way a desk types it still parses, and still rounds', () => {
  const LHMS = asManager();
  const plan = LHMS.price.planImport(
    file(['Price ID', 'Amount'], [line('prc_dk_std', '"₦199,990"')]), 'Mid-year review');
  assert.equal(plan.counts.change, 1);
  LHMS.actions.applyPriceImport(plan);
  // The engine rounds to the nearest 50, so the stored figure is the one a
  // quote would produce, not the one that was typed.
  assert.equal(dk(LHMS).amount, 200000);

  // The same figure written without its quotes is two cells, and guessing which
  // half of a price to keep is not on the table.
  const loose = LHMS.price.planImport(
    file(['Price ID', 'Amount'], [line('prc_dk_std', '₦180,000')]), 'Loose typing');
  assert.equal(loose.counts.reject, 1);
  assert.match(loose.rejected[0].error, /quote any cell that contains a comma/);
});

test('a status column takes a price out of sale', () => {
  const LHMS = asManager();
  const plan = LHMS.price.planImport(
    file(['Price ID', 'Status'], [line('prc_dk_std', 'off')]), 'Rooms out for renovation');
  assert.equal(plan.rows[0].state, 'change');
  LHMS.actions.applyPriceImport(plan);
  assert.equal(dk(LHMS).active, false);
  assert.equal(LHMS.price.nightRate('dk'), 0, 'nothing is sold from a switched-off row');
});

test('a revenue manager’s large move is held for a second signature, then lands', () => {
  const LHMS = asRevenue();
  const plan = LHMS.price.planImport(
    file(['Price ID', 'Amount'], [line('prc_dk_std', '900000')]), 'Peak season uplift');
  assert.equal(plan.rows[0].state, 'queue', 'the move is wider than the property limit');
  assert.equal(plan.counts.queue, 1);

  const result = LHMS.actions.applyPriceImport(plan);
  assert.equal(result.applied, 0);
  assert.equal(result.queued, 1);
  assert.equal(dk(LHMS).amount, 185000, 'and the row is untouched until someone else signs');

  const asked = LHMS.approvals('Pending')[0];
  assert.equal(asked.kind, 'price');
  assert.equal(asked.subjectId, 'prc_dk_std');
  assert.equal(asked.change.patch.amount, 900000);
  assert.equal(asked.reason, 'Peak season uplift');

  // The bulk request is an ordinary request: the same decision applies it.
  LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'demo1234');
  const decided = LHMS.actions.decideApproval(asked.id, true, 'Agreed with revenue');
  assert.equal(decided.ok, true, JSON.stringify(decided));
  assert.equal(dk(LHMS).amount, 900000);
});

test('a row the reader cannot use is reported, and the good rows still land', () => {
  const LHMS = asManager();
  const plan = LHMS.price.planImport(file(['Price ID', 'Amount'], [
    line('prc_dk_std', '200000'),
    line('prc_never_seeded', '210000'),
    line('prc_ps_std', 'free breakfast'),
    line('prc_dk_std', '220000'),
  ]), 'Autumn card');
  assert.equal(plan.counts.reject, 3);
  assert.match(plan.rejected[0].error, /No price record matches id prc_never_seeded/);
  assert.match(plan.rejected[1].error, /not a number/);
  assert.match(plan.rejected[2].error, /appears twice in the file — line 2/);
  assert.equal(plan.rejected[0].line, 3, 'a desk correcting a file needs the line it came in on');

  const result = LHMS.actions.applyPriceImport(plan);
  assert.equal(result.applied, 1);
  assert.equal(result.rejected, 3);
  assert.equal(dk(LHMS).amount, 200000);
  assert.equal(LHMS.price.priceRow('prc_ps_std').amount, 1250000, 'a rejected row writes nothing');
});

test('a column the file leaves out is left alone; one it names and empties is cleared', () => {
  const LHMS = asManager();
  LHMS.actions.setPrice('prc_dk_std', {
    from: '2026-11-01', to: '2026-12-20', surcharges: { extraAdult: 24000 },
  }, 'Festive window set');
  assert.equal(dk(LHMS).from, '2026-11-01');

  // An amount-only file says nothing about the window or the surcharges.
  LHMS.actions.applyPriceImport(LHMS.price.planImport(
    file(['Price ID', 'Amount'], [line('prc_dk_std', '210000')]), 'Quiet week'));
  assert.equal(dk(LHMS).from, '2026-11-01');
  assert.equal(dk(LHMS).to, '2026-12-20');
  assert.equal(dk(LHMS).surcharges.extraAdult, 24000);

  // The same column present and blank is an instruction to clear it.
  const cleared = LHMS.price.planImport(
    file(['Price ID', 'Effective from', 'Effective to'], [line('prc_dk_std', '', '')]), 'Window ended');
  assert.equal(cleared.rows[0].state, 'change');
  LHMS.actions.applyPriceImport(cleared);
  assert.equal(dk(LHMS).from, null);
  assert.equal(dk(LHMS).to, null);
});

test('a paste out of Excel is tab separated and reads the same file', () => {
  const LHMS = asManager();
  const plan = LHMS.price.planImport(
    file(['Price ID', 'Amount', 'weekendPct'], [line('prc_dk_std', '215000', '20')], '\t'),
    'Weekend demand');
  assert.equal(plan.counts.change, 1);
  sameShape(plan.rows[0].diff, [['amount', 185000, 215000], ['weekendPct', 15, 20]]);
  LHMS.actions.applyPriceImport(plan);
  assert.equal(dk(LHMS).amount, 215000);
  assert.equal(dk(LHMS).surcharges.weekendPct, 20);
  assert.equal(dk(LHMS).surcharges.extraAdult, 22200, 'a surcharge the file did not name survives');
});

test('a code and a list name find the row when the file has no ids', () => {
  const LHMS = asManager();
  const plan = LHMS.price.planImport(
    file(['Code', 'Price list', 'Amount'], [line('DLK', 'Standard 2026', '199000')]), 'Supplier review');
  assert.equal(plan.counts.change, 1);
  assert.equal(plan.rows[0].priceId, 'prc_dk_std');
  LHMS.actions.applyPriceImport(plan);
  assert.equal(dk(LHMS).amount, 199000);
});

test('a role without the pricing key can review a file but cannot apply it', () => {
  const LHMS = asFrontDesk();
  const queuedBefore = LHMS.approvals('Pending').length;
  const plan = LHMS.price.planImport(
    file(['Price ID', 'Amount'], [line('prc_dk_std', '250000')]), 'Desk attempt');
  assert.equal(plan.ok, true, 'reading the file asks nothing of the database');
  assert.equal(plan.counts.change, 1);

  const result = LHMS.actions.applyPriceImport(plan);
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot change prices/);
  assert.equal(dk(LHMS).amount, 185000);
  assert.equal(LHMS.approvals('Pending').length, queuedBefore, 'and it queues nothing either');
});

test('a file with no reason, no rows or an unknown list is refused before it is planned', () => {
  const LHMS = asManager();
  assert.match(LHMS.price.planImport(file(['Price ID', 'Amount'], [line('prc_dk_std', '200000')]), '').error,
    /reason is required/);
  assert.match(LHMS.price.planImport('Price ID,Amount', 'Too short').error,
    /header line and at least one price/);
  const bad = LHMS.price.planImport(
    file(['Price ID', 'Price list', 'Amount'], [line('prc_dk_std', 'Gamma 2031', '200000')]), 'Wrong list');
  assert.equal(bad.counts.reject, 1);
  assert.match(bad.rejected[0].error, /No price list is called “Gamma 2031”/);
});
