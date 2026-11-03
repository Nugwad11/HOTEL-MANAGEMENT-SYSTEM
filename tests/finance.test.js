const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The dashboard is the page people are argued with in an audit, so every test
// here recomputes the figure by hand from the raw rows and demands that the
// engine agrees — revenue that is not cash, a debt counted once, and a cost
// that stays a claim until a second signature.
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

function today(LHMS) { return LHMS.db.meta.day; }
function windowOf(LHMS, days) { return LHMS.financeCore.period(today(LHMS), days); }
function statement(LHMS, days) {
  const w = windowOf(LHMS, days);
  return LHMS.financeCore.statement(LHMS.db, PID, w.from, w.to);
}

// The same rules, written out independently of the engine.
function earnedByHand(LHMS, from, to) {
  const taxDept = LHMS.financeCore.taxDepartment;
  const resIds = new Set(LHMS.db.reservations.filter((r) => r.propertyId === PID).map((r) => r.id));
  const onFolios = LHMS.db.charges
    .filter((c) => !c.voided && resIds.has(c.reservationId) && c.department !== taxDept && c.date <= to && c.date >= from)
    .reduce((s, c) => s + c.amount, 0);
  const halls = LHMS.db.events
    .filter((e) => e.propertyId === PID && !e.reservationId && e.status !== 'Cancelled' && e.status !== 'Released' &&
      e.date <= to && e.date >= from)
    .reduce((s, e) => s + e.lines.reduce((a, l) => a + l.amount, 0), 0);
  return onFolios + halls;
}

function inScopePayments(LHMS, from, to) {
  const resIds = new Set(LHMS.db.reservations.filter((r) => r.propertyId === PID).map((r) => r.id));
  const invIds = new Set(LHMS.db.invoices.filter((i) => i.propertyId === PID).map((i) => i.id));
  return LHMS.db.payments.filter((p) => p.date <= to && p.date >= from &&
    ((p.reservationId && resIds.has(p.reservationId)) || (p.invoiceId && invIds.has(p.invoiceId))));
}

test('revenue earned is what was incurred, not what was banked', () => {
  const LHMS = asManager();
  const w = windowOf(LHMS, 365);
  const st = statement(LHMS, 365);

  assert.equal(st.revenue, earnedByHand(LHMS, w.from, w.to), 'the engine matches the hand count');
  assert.ok(st.taxBilled > 0, 'the seed does bill tax');
  assert.ok(st.revenue > st.collected, 'a hotel on the books is owed more than it has taken');
  assert.equal(st.net, st.revenue - st.expenses, 'the result is earned less approved cost');
});

test('tax, service charges and voided lines never reach revenue', () => {
  const LHMS = asManager();
  const res = LHMS.db.reservations.find((r) => r.propertyId === PID && r.status === 'In-house');
  const before = statement(LHMS, 365);

  const posted = LHMS.actions.postCharge(res.id, {
    description: 'Minibar audit', amount: 400000, department: 'Food & Beverage', date: today(LHMS)
  });
  assert.ok(posted.ok);
  assert.equal(statement(LHMS, 365).revenue, before.revenue + 400000, 'a charge earns on the date it was posted');

  const levy = LHMS.actions.postCharge(res.id, {
    description: 'Late levy', amount: 90000, department: LHMS.financeCore.taxDepartment, date: today(LHMS)
  });
  assert.ok(levy.ok);
  const afterTax = statement(LHMS, 365);
  assert.equal(afterTax.revenue, before.revenue + 400000, 'money collected for the authorities is not revenue');
  assert.equal(afterTax.taxBilled, before.taxBilled + 90000, 'and it is reported on its own line');

  LHMS.actions.voidCharge(posted.charge.id);
  assert.equal(statement(LHMS, 365).revenue, before.revenue, 'a voided line leaves the result behind');
});

test('a standalone hall booking earns even though it never touches a folio', () => {
  const LHMS = asManager();
  const w = windowOf(LHMS, 365);
  const delivered = LHMS.db.events.filter((e) =>
    e.propertyId === PID && !e.reservationId && e.status !== 'Cancelled' && e.status !== 'Released' &&
    e.date >= w.from && e.date <= w.to);
  assert.ok(delivered.length >= 2, 'the seed has delivered hall work to count');

  const halls = delivered.reduce((s, e) => s + e.lines.reduce((a, l) => a + l.amount, 0), 0);
  const st = statement(LHMS, 365);
  assert.ok(st.byDept['Events & Banqueting'] >= halls, 'the department figure carries the hall lines');
  assert.equal(st.buckets.events, st.byDept['Events & Banqueting'], 'the events bucket is that department, no more and no less');
  assert.equal(st.eventBookings, delivered.length);
});

test('cash collected is a separate number and splits by method without leaking', () => {
  const LHMS = asManager();
  const st = statement(LHMS, 365);
  const byHand = inScopePayments(LHMS, st.from, st.to);

  assert.equal(st.collected, byHand.reduce((s, p) => s + p.amount, 0));
  assert.equal(Object.keys(st.byMethod).reduce((s, k) => s + st.byMethod[k], 0), st.collected, 'the donut adds back to the till');
  assert.equal(st.reconciled + st.unreconciled, st.collected);
  assert.equal(st.netCash, st.collected - st.refunded);
  assert.ok(st.reconciled > 0, 'matched receipts exist to compare against');
});

test('a debt is counted exactly once, whatever the billing desk does to it', () => {
  const LHMS = asManager();
  const res = LHMS.db.reservations.find((r) => r.propertyId === PID && r.status === 'In-house');
  LHMS.actions.postCharge(res.id, { description: 'Airport transfer', amount: 180000, department: 'Transport', date: today(LHMS) });

  const before = statement(LHMS, 365);
  const raised = LHMS.actions.raiseInvoice({ reservationId: res.id });
  assert.ok(raised.ok, raised.error);

  const afterRaise = statement(LHMS, 365);
  assert.equal(afterRaise.outstanding, before.outstanding, 'copying a charge onto a document creates no new debt');
  assert.equal(afterRaise.docOwed, before.docOwed, 'a folio invoice never adds to the document queue');
  assert.equal(afterRaise.guestOwed, before.guestOwed, 'the guest still owes it once, on the folio');

  const paid = LHMS.actions.payInvoice(raised.invoice.id, { amount: 100000, method: 'Transfer' });
  assert.ok(paid.ok, paid.error);
  const afterPay = statement(LHMS, 365);
  assert.equal(afterPay.collected - afterRaise.collected, 100000, 'the receipt is cash in the window');
  assert.equal(afterRaise.outstanding - afterPay.outstanding, 100000, 'and it leaves the debt exactly once');
});

test('only an approved line moves the operating result', () => {
  const LHMS = asManager();
  const day = today(LHMS);
  const before = statement(LHMS, 30);

  const recorded = LHMS.actions.addExpense({
    description: 'Generator injector service', amount: 480000, category: 'Utilities', date: day, payee: 'Ozolua Motors'
  });
  assert.ok(recorded.ok, recorded.error);
  assert.equal(recorded.expense.status, 'Pending', 'a recorded cost is a claim');

  const afterRecord = statement(LHMS, 30);
  assert.equal(afterRecord.expenses, before.expenses, 'a claim enters no result');
  assert.equal(afterRecord.expensesPending, before.expensesPending + 480000);
  assert.equal(afterRecord.net, before.net);
  assert.equal(afterRecord.expenseCount, before.expenseCount + 1);

  const approved = LHMS.actions.decideExpense(recorded.expense.id, true, 'Checked against the supplier invoice.');
  assert.ok(approved.ok, approved.error);

  const afterApprove = statement(LHMS, 30);
  assert.equal(afterApprove.expenses, before.expenses + 480000);
  assert.equal(afterApprove.net, before.net - 480000, 'the result is revenue earned less approved cost');
  assert.equal(afterApprove.expenseCount, afterRecord.expenseCount, 'approving does not invent a line');
  assert.equal(afterApprove.expByCat.Utilities, (before.expByCat.Utilities || 0) + 480000);
});

test('a refused cost keeps its reason and never reaches the result', () => {
  const LHMS = asManager();
  const recorded = LHMS.actions.addExpense({
    description: 'Team dinner charged as a cost', amount: 120000, category: 'Other operating', date: today(LHMS)
  });
  const before = statement(LHMS, 30);

  const refused = LHMS.actions.decideExpense(recorded.expense.id, false, 'Hospitality of staff is not an operating cost.');
  assert.ok(refused.ok, refused.error);
  assert.equal(refused.expense.status, 'Rejected');
  assert.equal(refused.expense.decisionNote, 'Hospitality of staff is not an operating cost.');

  const after = statement(LHMS, 30);
  assert.equal(after.expenses, before.expenses, 'a refusal changes nothing in the result');
  assert.equal(after.net, before.net);
  assert.equal(after.pendingCount, before.pendingCount - 1);
  assert.equal(after.rejectedCount, before.rejectedCount + 1);

  const again = LHMS.actions.decideExpense(recorded.expense.id, true, 'changed my mind');
  assert.equal(again.ok, false);
  assert.match(again.error, /already rejected/, 'one decision per line — correcting it means recording again');
});

test('a cost is validated where it is written, not in the page', () => {
  const LHMS = asManager();
  const day = today(LHMS);
  const cases = [
    [{ description: 'Zero', amount: 0, category: 'Utilities', date: day }, /greater than zero/],
    [{ description: 'Negative', amount: -5000, category: 'Utilities', date: day }, /greater than zero/],
    [{ description: 'No category', amount: 50000, category: 'Petrolem', date: day }, /Choose an expense category/],
    [{ description: '', amount: 50000, category: 'Utilities', date: day }, /Describe what the money bought/],
    [{ description: 'Tomorrow', amount: 50000, category: 'Utilities', date: LHMS.util.addDays(day, 3) }, /future/],
    [{ description: 'Absurd', amount: 9e9, category: 'Utilities', date: day }, /group office/]
  ];
  const count = LHMS.db.expenses.length;
  cases.forEach(([data, pattern]) => {
    const result = LHMS.actions.addExpense(data);
    assert.equal(result.ok, false, JSON.stringify(data) + ' should be refused');
    assert.match(result.error, pattern);
  });
  assert.equal(LHMS.db.expenses.length, count, 'nothing invalid reached the ledger');

  const good = LHMS.actions.addExpense({ description: 'Water treatment salt', amount: 42000, category: 'Utilities', date: day });
  assert.ok(good.ok, good.error);
  assert.equal(good.expense.propertyId, LHMS.session.propertyId, 'a cost belongs to one property');
});

test('recording and approving are different rights on different roles', () => {
  const desk = asFrontDesk();
  assert.equal(desk.can('record_expenses'), false);
  assert.match(desk.actions.addExpense({ description: 'Bulb', amount: 5000, category: 'Technology' }).error, /cannot record/);
  assert.match(desk.actions.decideExpense('exp_1', true).error, /cannot approve/);

  const hk = asHousekeeping();
  assert.equal(hk.can('record_expenses'), true, 'a supervisor can raise a supplier cost');
  assert.equal(hk.can('approve_expenses'), false, 'and cannot sign off their own');
  const raised = hk.actions.addExpense({ description: 'Linen restock', amount: 88000, category: 'Housekeeping', date: today(hk) });
  assert.ok(raised.ok, raised.error);
  assert.match(hk.actions.decideExpense(raised.expense.id, true).error, /cannot approve/);

  const revenue = asRevenue();
  assert.equal(revenue.can('record_expenses'), false);
  assert.match(revenue.actions.decideExpense(raised.expense.id, true).error, /cannot approve/);

  const manager = asManager();
  assert.equal(manager.can('record_expenses') && manager.can('approve_expenses'), true);
});

test('the period tiles backwards without a gap and the prior window is the same length', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  [1, 7, 30, 365].forEach((days) => {
    const w = windowOf(LHMS, days);
    assert.equal(w.to, today(LHMS));
    assert.equal(U.nights(w.from, w.to) + 1, days, days + ' days inclusive');
    assert.equal(U.nights(w.prevFrom, w.prevTo) + 1, days, 'the comparison window is the same length');
    assert.equal(U.nights(w.prevTo, w.from), 1, 'and butts up to the window without double-counting a day');
  });
});

test('the daily series adds back to the statement, empty days and all', () => {
  const LHMS = asManager();
  [7, 30, 365].forEach((days) => {
    const w = windowOf(LHMS, days);
    const st = LHMS.financeCore.statement(LHMS.db, PID, w.from, w.to);
    const series = LHMS.financeCore.series(LHMS.db, PID, w.from, w.to);
    assert.equal(series.length, days, 'one row per calendar day');
    assert.equal(series[0].date, w.from);
    assert.equal(series[series.length - 1].date, w.to);
    assert.equal(series.reduce((s, d) => s + d.revenue, 0), st.revenue, 'the chart cannot disagree with the statement');
    assert.equal(series.reduce((s, d) => s + d.collected, 0), st.collected);
    assert.equal(series.reduce((s, d) => s + d.expenses, 0), st.expenses);
  });
});

test('the drill-down to transactions reconciles with the department figure', () => {
  const LHMS = asManager();
  const w = windowOf(LHMS, 365);
  const st = LHMS.financeCore.statement(LHMS.db, PID, w.from, w.to);
  const depts = Object.keys(st.byDept);
  assert.ok(depts.length >= 4, 'the seed trades across several departments');

  depts.forEach((dept) => {
    const txns = LHMS.financeTxns(dept, w.from, w.to);
    assert.equal(txns.reduce((s, t) => s + t.amount, 0), st.byDept[dept], dept + ' totals to the bar on the dashboard');
    txns.forEach((t) => assert.ok(t.href && t.date >= w.from && t.date <= w.to, 'every row is in the window and links somewhere'));
  });
});

test('a delta is measured against the window before it, in both directions', () => {
  const LHMS = asManager();
  const FC = LHMS.financeCore;
  assert.equal(FC.delta(150, 100), 50);
  assert.equal(FC.delta(75, 100), -25);
  assert.equal(FC.delta(100, 0), 100, 'from nothing, any figure is a full period of growth');
  assert.equal(FC.delta(0, 0), 0, 'and nothing changed nothing');

  const f = LHMS.finance(30);
  assert.equal(typeof f.delta('revenue'), 'number');
  assert.equal(f.delta('revenue'), FC.delta(f.now.revenue, f.prev.revenue), 'the facade compares the same two windows');
  assert.ok(f.prev.expenses > 0, 'a year of seeded cost means the comparison window is not empty');
});

test('the dashboard facade reads the live database, not a snapshot', () => {
  const LHMS = asManager();
  const day = today(LHMS);
  const before = LHMS.finance(30);

  LHMS.actions.addExpense({ description: 'Fire alarm certification', amount: 300000, category: 'Statutory', date: day });
  const pendingOnly = LHMS.finance(30);
  assert.equal(pendingOnly.now.net, before.now.net, 'a claim alone does not move the facade either');

  const pending = LHMS.db.expenses.filter((e) => e.status === 'Pending' && e.amount === 300000).pop();
  LHMS.actions.decideExpense(pending.id, true);
  const after = LHMS.finance(30);
  assert.equal(after.now.net, before.now.net - 300000, 'one signature later, the same call reports the cost');
  assert.equal(after.series.length, 30);
});
