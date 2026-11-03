const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// A report is only worth printing if it agrees with the statement the dashboard
// is built from. Every test here runs a report and then demands that its totals
// land on LHMS.financeCore.statement for the same window — same rows, same
// rules, cut a different way.
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
const asRevenue = () => loadApp('chiamaka.obi@aureliagrand.com');

const PID = 'agm';
const TYPES = ['text', 'money', 'count', 'pct', 'date'];

function today(LHMS) { return LHMS.db.meta.day; }
function windowOf(LHMS, days) { return LHMS.financeCore.period(today(LHMS), days); }
function statement(LHMS, days) {
  const w = windowOf(LHMS, days);
  return LHMS.financeCore.statement(LHMS.db, PID, w.from, w.to);
}
function run(LHMS, key, days) {
  const w = windowOf(LHMS, days || 30);
  return LHMS.reportCore.run(LHMS.db, PID, key, w.from, w.to);
}
function sumCol(rep, i) {
  return rep.rows.reduce((s, r) => s + (Number(r[i]) || 0), 0);
}

test('every catalogue report runs and is shaped the way the page and the CSV both need', () => {
  const LHMS = asManager();
  const keys = LHMS.reportCore.keys;
  assert.equal(keys.length, 10, 'the spec lists ten reports');
  // Nine reports cut the seeded trading, receipts, debt and re-pricing into rows.
  // Nothing in the seed gives money back, so the reversals report is honestly
  // empty until an action creates one — the test below does exactly that.
  const trading = keys.filter((key) => key !== 'discounts-refunds');
  keys.forEach((key) => {
    const rep = run(LHMS, key, 365);
    assert.ok(rep, key + ' built');
    assert.equal(rep.key, key);
    assert.ok(rep.title && rep.sub && rep.note, key + ' explains itself');
    assert.ok(rep.columns.length, key + ' has columns');
    rep.columns.forEach((c) => {
      assert.ok(TYPES.indexOf(c.type) !== -1, key + ' column type ' + c.type);
    });
    rep.rows.forEach((r) => {
      assert.equal(r.length, rep.columns.length, key + ' row width matches its header');
    });
    assert.equal(rep.totals.length, rep.columns.length, key + ' totals line matches its header');
    if (trading.indexOf(key) !== -1) {
      assert.ok(rep.rows.length, key + ' found something to report on a year of trading');
    } else {
      assert.equal(rep.rows.length, 0, key + ' lists an event the seed never had');
      assert.equal(rep.totals.filter((t) => typeof t === 'number' && t !== 0).length, 0,
        key + ' totals nothing it did not list');
    }
  });
});

test('revenue by department and revenue by service are two cuts of one number', () => {
  const LHMS = asManager();
  const st = statement(LHMS, 30);
  const dept = run(LHMS, 'dept-revenue', 30);
  const svc = run(LHMS, 'service-revenue', 30);

  assert.equal(sumCol(dept, 1), st.revenue, 'departments add up to revenue earned');
  assert.equal(dept.totals[1], st.revenue, 'and so does its totals line');
  assert.ok(Math.abs(sumCol(dept, 3) - 100) < 0.5, 'the shares make a whole');
  assert.ok(dept.rows.every((r, i, all) => i === 0 || all[i - 1][1] >= r[1]), 'biggest department first');
  assert.ok(!dept.rows.some((r) => r[0] === LHMS.financeCore.taxDepartment),
    'tax billed to a guest is never called revenue');

  assert.equal(sumCol(svc, 4), st.revenue, 'the same revenue split by service');
  assert.equal(svc.rows.length > 0, true);
  assert.ok(svc.rows.every((r) => r[0] && r[1]), 'every line names a service and a department');
});

test('revenue by payment method reconciles to cash collected, matched plus unmatched', () => {
  const LHMS = asManager();
  const st = statement(LHMS, 30);
  const rep = run(LHMS, 'payment-method', 30);

  assert.equal(sumCol(rep, 2), st.collected, 'collected by method equals collected');
  assert.equal(sumCol(rep, 1), st.paymentCount, 'and every receipt is on a row');
  rep.rows.forEach((r) => {
    assert.equal(r[3] + r[4], r[2], r[0] + ': matched plus unmatched is the money taken');
  });
  assert.equal(rep.totals[3], st.reconciled);
  assert.equal(rep.totals[4], st.unreconciled);
});

test('daily cash collection covers every day in the window, quiet ones included', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  const st = statement(LHMS, 30);
  const rep = run(LHMS, 'daily-cash', 30);

  assert.equal(rep.rows.length, 30, 'one row per day, not one per trading day');
  const dates = rep.rows.map((r) => r[0]);
  assert.equal(new Set(dates).size, 30, 'and no day appears twice');
  assert.ok(dates.every((d) => d >= st.from && d <= st.to), 'every row is inside the window');
  assert.equal(sumCol(rep, 2), st.collected);
  assert.equal(sumCol(rep, 5), st.refunded, 'money back out is on the day it left');
  assert.equal(sumCol(rep, 6), st.netCash, 'and net cash is the two of them together');
  assert.ok(rep.rows.every((r, i, all) => i === 0 || all[i - 1][0] >= r[0]), 'newest day first');
  assert.equal(U.nights(rep.rows[rep.rows.length - 1][0], rep.rows[0][0]), 29);
});

test('outstanding balances are a position counted once, folios and documents apart', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  const st = statement(LHMS, 30);
  const rep = run(LHMS, 'outstanding', 30);

  assert.equal(sumCol(rep, 6), st.outstanding, 'the report totals to the dashboard figure');
  const folios = rep.rows.filter((r) => r[1] === 'Guest folio');
  const docs = rep.rows.filter((r) => r[1] === 'Document');
  assert.equal(folios.reduce((s, r) => s + r[6], 0), st.guestOwed, 'guest debt measured on the folio');
  assert.equal(docs.reduce((s, r) => s + r[6], 0), st.docOwed, 'and hall or corporate debt on its document');
  assert.ok(rep.rows.every((r) => r[6] > 0), 'nothing settled belongs on an arrears list');
  assert.ok(rep.rows.every((r) => r[5] <= r[4]), 'settled never exceeds billed');
  assert.ok(rep.rows.every((r) => r[7] >= 0), 'age is counted forward, not back');

  // A window that closed two months ago cannot un-age a debt: the balances are a
  // position taken today, so ageing them to the window's last day would call
  // every account zero days old and hide which one to chase first.
  const last = U.addDays(today(LHMS), -60);
  const past = LHMS.reportCore.run(LHMS.db, PID, 'outstanding', U.addDays(last, -30), last);
  assert.equal(sumCol(past, 6), st.outstanding, 'and the same debt is listed whatever window is asked for');
  assert.ok(past.rows.some((r) => r[7] > 0), 'with the older accounts still showing their age');
});

test('a charge copied onto a document still appears once in the arrears report', () => {
  const LHMS = asManager();
  const before = run(LHMS, 'outstanding', 30);
  const open = LHMS.unbilledAcross(PID).filter((q) => q.kind === 'folio')[0];
  const raised = LHMS.actions.raiseInvoice({ reservationId: open.res.id });
  assert.equal(raised.ok, true);
  const after = run(LHMS, 'outstanding', 30);

  assert.equal(sumCol(after, 6), sumCol(before, 6), 'invoicing moves a debt, it does not add one');
  assert.ok(!after.rows.some((r) => r[2] === raised.invoice.number),
    'a folio document stays inside its folio row instead of joining as a second debt');
});

test('discounts and refunds each land in the one column they belong to', () => {
  const LHMS = asManager();
  const st = statement(LHMS, 365);
  const rep = run(LHMS, 'discounts-refunds', 365);

  const refundSum = rep.rows.filter((r) => r[1] === 'Refund').reduce((s, r) => s + r[3], 0);
  const discountSum = rep.rows.filter((r) => r[1] === 'Discount').reduce((s, r) => s + r[3], 0);
  const adjustSum = rep.rows.filter((r) => r[1] === 'Adjustment').reduce((s, r) => s + r[3], 0);
  assert.equal(refundSum, st.refunded, 'refunds agree with the statement');
  assert.equal(discountSum, st.discounts, 'so do discounts');
  assert.equal(adjustSum, st.adjustments, 'and positive adjustments');
  assert.equal(rep.totals[3], st.refunded + st.discounts + st.adjustments);
  assert.ok(rep.rows.every((r) => r[0] >= st.from && r[0] <= st.to), 'every reversal is dated in the window');
  assert.ok(rep.rows.every((r) => r[6] && String(r[6]).length > 4), 'and every one carries a reason');
});

test('a discount and a refund both reach the report with the person who authorised them', () => {
  const LHMS = asManager();
  const open = LHMS.unbilledAcross(PID).filter((q) => q.kind === 'folio')[0];
  const inv = LHMS.actions.raiseInvoice({ reservationId: open.res.id }).invoice;
  const billed = LHMS.invoiceMoney(inv);
  assert.equal(LHMS.actions.payInvoice(inv.id, { amount: billed.total, method: 'Transfer' }).ok, true);
  assert.equal(LHMS.actions.discountInvoice(inv.id, { amount: 50000, reason: 'Loyalty gesture approved by the GM' }).ok, true);
  assert.equal(LHMS.actions.refundInvoice(inv.id, {
    amount: 20000, method: 'Bank transfer', reason: 'Transfer paid twice, one returned'
  }).ok, true);

  const rep = run(LHMS, 'discounts-refunds', 30);
  const discount = rep.rows.filter((r) => r[1] === 'Discount' && r[2] === inv.number)[0];
  const refund = rep.rows.filter((r) => r[1] === 'Refund' && r[2] === inv.number)[0];
  assert.ok(discount, 'the discount is on the report');
  assert.equal(discount[3], 50000, 'as a positive amount, signed by whoever approved it');
  assert.match(discount[6], /Loyalty gesture/);
  assert.ok(refund, 'and so is the refund');
  assert.equal(refund[3], 20000);
  assert.equal(refund[4], 'Bank transfer', 'the method it went back by is on the row');
  assert.match(refund[6], /paid twice/);
});

test('only approved costs reach the result, and the ledger keeps the rest visible', () => {
  const LHMS = asManager();
  const st = statement(LHMS, 30);
  const rep = run(LHMS, 'expenses', 30);

  assert.equal(sumCol(rep, 2), st.expenses, 'approved column is the figure the net result uses');
  assert.equal(sumCol(rep, 3), st.expensesPending, 'awaiting decisions are reported but not spent');
  assert.equal(sumCol(rep, 5), sumCol(rep, 2) + sumCol(rep, 3) + sumCol(rep, 4),
    'the last column is the whole ledger, not a fourth kind of money');
  assert.equal(sumCol(rep, 1), st.expenseCount, 'every recorded line is counted once');
});

test('tax and service charges are billed, reported and kept out of revenue', () => {
  const LHMS = asManager();
  const st = statement(LHMS, 30);
  const rep = run(LHMS, 'taxes', 30);

  assert.equal(sumCol(rep, 4), st.taxBilled, 'the rules add up to what was billed on top');
  assert.ok(st.revenue + st.taxBilled > st.revenue, 'and that money is on top of revenue, never inside it');
  assert.ok(rep.rows.every((r) => r[0] !== 'Revenue earned'), 'the report does not mix its own totals in');
});

test('price-change history reports the changes and nothing else', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  const w = windowOf(LHMS, 365);
  const target = LHMS.price.baseRow('svc_dk');
  const prev = target.amount;
  const shown = (n) => U.money(n, target.currency);
  LHMS.actions.setPrice(target.id, { amount: 175000 }, 'Test re-pricing');
  const rep = run(LHMS, 'price-history', 365);

  assert.ok(rep.rows.length >= 1);
  assert.equal(rep.rows[0][7], 'Test re-pricing', 'the newest change is first and carries its reason');
  // Both halves are printed in the money the row is priced in, so the sign the
  // reader sees is the sign the catalogue sells in.
  assert.equal(rep.rows[0][3], shown(prev), 'the price it moved from is the one that was on the record');
  assert.equal(rep.rows[0][4], shown(175000), 'and the price it moved to');
  assert.equal(rep.rows[0][5], Math.round((175000 - prev) / prev * 1000) / 10, 'with the percentage between them');
  rep.rows.forEach((r) => {
    assert.ok(r[0] >= w.from && r[0] <= w.to, 'no change from outside the window');
    assert.ok(/\d/.test(String(r[4])), 'every change has a new amount');
  });
  const narrow = LHMS.reportCore.run(LHMS.db, PID, 'price-history', U.addDays(w.to, -6), w.to);
  assert.ok(narrow.rows.length <= rep.rows.length, 'a shorter window cannot find more changes');
  assert.ok(narrow.rows.some((r) => r[7] === 'Test re-pricing'), 'made today it is inside any window');
});

test('profitability is revenue less approved costs, month by month', () => {
  const LHMS = asManager();
  const st = statement(LHMS, 365);
  const rep = run(LHMS, 'profitability', 365);

  assert.equal(sumCol(rep, 1), st.revenue, 'months tile the window and add up to the statement');
  assert.equal(sumCol(rep, 3), st.expenses, 'costs are the approved ones');
  assert.equal(sumCol(rep, 4), st.net, 'and the result is the dashboard net operating result');
  rep.rows.forEach((r) => {
    assert.equal(r[1] - r[3], r[4], r[0] + ': the month stands on its own');
    assert.equal(r[5], r[1] ? Math.round(r[4] / r[1] * 1000) / 10 : null,
      r[0] + ': margin is result over revenue, and absent revenue has none');
  });
});

test('an unapproved cost stays out of the profitability report until a second signature', () => {
  const LHMS = asManager();
  const before = run(LHMS, 'profitability', 30);
  const added = LHMS.actions.addExpense({
    description: 'Boiler service', amount: 300000, category: 'Repairs & maintenance',
    method: 'Transfer', payee: 'HydroWorks Nigeria'
  });
  assert.equal(added.ok, true);
  const pending = run(LHMS, 'profitability', 30);
  assert.equal(sumCol(pending, 4), sumCol(before, 4), 'a claim moves nothing');

  const approved = LHMS.actions.decideExpense(added.expense.id, 'Approved', 'Signed off');
  assert.equal(approved.ok, true);
  const after = run(LHMS, 'profitability', 30);
  assert.equal(sumCol(after, 3), sumCol(before, 3) + 300000, 'the signature puts the cost in');
  assert.equal(sumCol(after, 4), sumCol(before, 4) - 300000, 'and the result takes the hit');
});

test('a role without the reporting right is refused rather than shown an empty page', () => {
  const LHMS = asFrontDesk();
  assert.equal(LHMS.canSeeReports(), false);
  assert.equal(LHMS.report('dept-revenue', 30).denied, true, 'front desk cannot run one');

  const hk = asHousekeeping();
  assert.equal(hk.canSeeReports(), false);
  assert.equal(hk.report('expenses', 30).denied, true);

  const rev = asRevenue();
  assert.equal(rev.canSeeReports(), true);
  const rep = rev.report('dept-revenue', 30);
  assert.ok(!rep.denied && rep.rows.length, 'the revenue office can');

  const mgr = asManager();
  assert.equal(mgr.canSeeReports(), true);
  assert.ok(!mgr.report('profitability', 30).denied);
});

test('a window someone types is checked before the engine totals anything', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  const t = today(LHMS);
  const from = U.addDays(t, -300);
  const to = U.addDays(t, -30);

  const rep = LHMS.reportBetween('dept-revenue', from, to);
  const st = LHMS.financeCore.statement(LHMS.db, PID, from, to);
  assert.ok(!rep.error, 'a past window runs');
  assert.equal(rep.from, from);
  assert.equal(rep.to, to);
  assert.equal(rep.totals[1], st.revenue, 'and totals the same money as the dashboard over those dates');

  assert.equal(LHMS.reportBetween('dept-revenue', '', to).error, 'Pick both a first and a last day.');
  assert.equal(LHMS.reportBetween('dept-revenue', 'last Tuesday', to).error, 'Pick both a first and a last day.');
  assert.equal(LHMS.reportBetween('dept-revenue', to, from).error, 'The first day has to come before the last.');
  assert.equal(LHMS.reportBetween('expenses', U.addDays(t, -900), t).error,
    'Keep a window to two years or less — longer reports cannot be read.');
  assert.equal(asFrontDesk().reportBetween('dept-revenue', from, to).denied, true, 'and the right is still the gate');
});

test('an unknown report key is refused, and an empty window reports empty honestly', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  assert.equal(LHMS.reportCore.run(LHMS.db, PID, 'made-up-report', '2026-01-01', '2026-01-31'), null);

  const quiet = LHMS.reportCore.run(LHMS.db, PID, 'dept-revenue', '2019-01-01', '2019-01-31');
  assert.equal(quiet.rows.length, 0, 'nothing traded, nothing listed');
  assert.equal(quiet.totals[1], 0, 'and the total says so instead of hiding');
  const cash = LHMS.reportCore.run(LHMS.db, PID, 'daily-cash', '2019-01-01', '2019-01-03');
  assert.equal(cash.rows.length, 3, 'a quiet window still shows its days');
  assert.equal(sumCol(cash, 2), 0);
  assert.ok(U.today() > '2019-01-31', 'the window really is behind the seeded history');
});
