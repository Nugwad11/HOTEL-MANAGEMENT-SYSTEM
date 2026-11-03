const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// The night audit is the hour the house actually runs on. These tests do not ask
// what the end-of-day page shows: they ask whether a day can be closed by the
// wrong hands, whether the money the folios were owed gets billed, whether the
// date rolls for everything, and whether a sealed day still accepts an entry.
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
const PID = 'agm';

const allChecks = (LHMS) => {
  const attest = {};
  LHMS.auditChecks().forEach((c) => { attest[c.key] = true; });
  return attest;
};

const roomsChargesOn = (LHMS, date) =>
  LHMS.db.charges.filter((c) => !c.voided && c.department === 'Rooms' && c.date === date);

// A folio stays in-house past the nights it was billed for: the desk never
// actioned the departure, so the night is owed and nobody has billed it. This is
// the money a night audit exists to find.
function makeOverstay(LHMS) {
  const res = LHMS.db.reservations.find((r) => r.status === 'In-house' && r.propertyId === PID);
  const day = LHMS.bizDay();
  res.checkOut = day;
  LHMS.db.charges = LHMS.db.charges.filter((c) => !(c.reservationId === res.id && c.date === day));
  return res;
}

test('the close belongs to whoever holds the night audit right, not to a job title', () => {
  const LHMS = asFrontDesk();
  const day = LHMS.bizDay();
  const before = LHMS.db.charges.length;

  const refused = LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /night audit|close the business date/i);
  assert.equal(LHMS.db.closedDays.length, 0);
  assert.equal(LHMS.bizDay(), day);
  assert.equal(LHMS.db.charges.length, before);

  LHMS.actions.setPermission('Front Desk', 'night_audit', true);
  const allowed = LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });
  assert.equal(allowed.ok, true);
  assert.equal(LHMS.db.closedDays.length, 1);
});

test('a day stays open while any control is still unconfirmed', () => {
  const LHMS = asManager();
  const day = LHMS.bizDay();
  const before = LHMS.db.charges.length;

  const r = LHMS.actions.runNightAudit({ checks: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /outstanding/i);
  assert.equal(LHMS.db.closedDays.length, 0, 'an unconfirmed run seals nothing');
  assert.equal(LHMS.bizDay(), day, 'an unconfirmed run rolls nothing');
  assert.equal(LHMS.db.charges.length, before, 'an unconfirmed run bills nothing');

  const partial = allChecks(LHMS);
  delete partial.roomtax;
  assert.equal(LHMS.actions.runNightAudit({ checks: partial }).ok, false);
});

test('closing the day bills the nights nobody billed, at the engine rate', () => {
  const LHMS = asManager();
  const res = makeOverstay(LHMS);
  const day = LHMS.bizDay();
  const owed = LHMS.unbilledNights().filter((n) => n.res.id === res.id);
  assert.equal(owed.length, 1, 'the overstay night is visible before the run');
  const expected = owed[0].quote.nightly[0].rate;
  const folioBefore = LHMS.folio(res.id).total;

  const r = LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });
  assert.equal(r.ok, true);
  assert.equal(r.posted.length, 1);
  assert.equal(r.posted[0].amount, expected);

  const posted = LHMS.db.charges.filter((c) => c.reservationId === res.id && c.date === day && c.department === 'Rooms');
  assert.equal(posted.length, 1);
  assert.match(posted[0].description, /night audit/);
  assert.equal(posted[0].amount, expected);
  assert.equal(posted[0].unitPrice, expected, 'the line carries the rate it was posted at');
  assert.equal(LHMS.folio(res.id).total, folioBefore + expected + r.posted[0].tax, 'tax travels with the night');
});

test('a night is billed once: the run after the roll finds nothing to add', () => {
  const LHMS = asManager();
  const res = makeOverstay(LHMS);
  const day = LHMS.bizDay();

  assert.equal(LHMS.actions.runNightAudit({ checks: allChecks(LHMS) }).ok, true);
  assert.equal(LHMS.unbilledNights().filter((n) => n.res.id === res.id).length, 0,
    'the night the audit just posted is no longer owed');

  // Standing the date back where it was is the only way to ask the same question
  // twice, and the register answers that the day is already closed.
  LHMS.db.meta.day = day;
  const again = LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });
  assert.equal(again.ok, false);
  assert.match(again.error, /already closed/i);
  assert.equal(roomsChargesOn(LHMS, day).filter((c) => c.reservationId === res.id).length, 1,
    'a repeat run cannot bill the guest twice');
});

test('the business date rolls and takes the whole house with it', () => {
  const LHMS = asManager();
  const day = LHMS.bizDay();
  const chargesOnDay = LHMS.db.charges.filter((c) => c.date === day).length;
  assert.ok(chargesOnDay > 0, 'the seed puts money on today');

  assert.equal(LHMS.finance(7).period.to, day);
  const r = LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });
  assert.equal(r.rolledTo, LHMS.util.addDays(day, 1));
  assert.equal(LHMS.bizDay(), LHMS.util.addDays(day, 1));

  const pack = LHMS.auditPack();
  assert.equal(pack.day, LHMS.bizDay(), 'the close screen is now reporting the new date');
  assert.equal(pack.charges.filter((c) => c.date === day).length, 0, 'yesterday is no longer today');
  LHMS.calc.arrivals(PID).forEach((res) => assert.equal(res.checkIn, LHMS.bizDay()));
  assert.equal(LHMS.finance(7).period.to, LHMS.bizDay(), 'the reporting window follows the roll');
});

test('a sealed day refuses money, and points the correction at the open date', () => {
  const LHMS = asManager();
  const res = makeOverstay(LHMS);
  const sealedDay = LHMS.bizDay();
  const r = LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });
  assert.equal(r.ok, true);

  assert.equal(LHMS.dayIsClosed(sealedDay), true);
  assert.equal(LHMS.dayIsClosed(LHMS.bizDay()), false);

  const chargesBefore = LHMS.db.charges.length;
  const backdated = LHMS.actions.postCharge(res.id, { description: 'Late minibar', amount: 45000, date: sealedDay });
  assert.equal(backdated.ok, false);
  assert.match(backdated.error, /closed and sealed/i);
  assert.equal(LHMS.db.charges.length, chargesBefore, 'a refusal writes nothing');

  const expense = LHMS.actions.addExpense({
    description: 'Supplier invoice dated yesterday', amount: 120000, category: LHMS.EXPENSE_CATEGORIES[0], date: sealedDay
  });
  assert.equal(expense.ok, false);
  assert.match(expense.error, /closed and sealed/i);

  const sealedCharge = LHMS.db.charges.find((c) => c.date === sealedDay && !c.voided);
  const voided = LHMS.actions.voidCharge(sealedCharge.id);
  assert.equal(voided.ok, false);
  assert.match(voided.error, /closed and sealed/i);
  assert.equal(LHMS.db.charges.find((c) => c.id === sealedCharge.id).voided, undefined,
    'the sealed line is untouched');

  const owed = LHMS.db.invoices.find((i) => i.status !== 'Void' && LHMS.invoiceMoney(i).balance > 0);
  assert.ok(owed, 'the seed leaves at least one invoice with a balance');
  const invoicePayment = LHMS.actions.payInvoice(owed.id, { amount: 1, date: sealedDay });
  assert.equal(invoicePayment.ok, false);
  assert.match(invoicePayment.error, /closed and sealed/i);

  const today = LHMS.actions.postCharge(res.id, { description: 'Minibar, posted tonight', amount: 45000 });
  assert.equal(today.ok, true);
});

test('the pack seals the money as it stood after the audit had posted', () => {
  const LHMS = asManager();
  makeOverstay(LHMS);
  const sealedDay = LHMS.bizDay();

  const r = LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });
  const sealed = LHMS.closedOn(sealedDay);
  assert.equal(sealed.date, sealedDay);
  assert.equal(sealed.rolledTo, LHMS.util.addDays(sealedDay, 1));

  // What the pack holds must equal what the register holds, recomputed from the
  // live lines rather than from a figure somebody typed into a form.
  const live = LHMS.db.reservations.filter((x) => x.propertyId === PID).map((x) => x.id);
  const expected = LHMS.db.charges
    .filter((c) => !c.voided && c.date === sealedDay && live.includes(c.reservationId))
    .reduce((s, c) => s + c.amount, 0);
  assert.equal(sealed.stats.charges, expected);
  assert.ok(sealed.stats.charges > 0);
  assert.equal(sealed.posted.length, 1);
});

test('a rolled date is not a stale seed', () => {
  const LHMS = asManager();
  const day = LHMS.bizDay();
  assert.equal(LHMS.db.meta.seededOn, LHMS.util.today(), 'the seed remembers the calendar day it was built for');

  LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });
  assert.notEqual(LHMS.bizDay(), day);
  assert.equal(LHMS.db.meta.seededOn, LHMS.util.today(),
    'closing the day does not move the calendar, so the snapshot stays valid');
});

test('the close is recorded where the money trail is read', () => {
  const LHMS = asManager();
  makeOverstay(LHMS);
  const sealedDay = LHMS.bizDay();
  LHMS.actions.runNightAudit({ checks: allChecks(LHMS) });

  const entry = LHMS.db.activity.find((a) => a.entity === 'night audit');
  assert.ok(entry, 'the run leaves an activity record');
  assert.match(entry.action, /closed/i);
  assert.match(entry.detail, new RegExp(sealedDay.slice(0, 4)));
  assert.ok(LHMS.db.notifications.some((n) => n.type === 'Night audit'));
});
