const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Multi-currency. The books keep one money, the catalogue sells in more than one,
// and every figure between them has to say which it is. Each test below moves
// money and asks the ledger what it kept — never what a page prints.
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

const as = (LHMS, email) => { LHMS.signIn(email, 'demo1234'); return LHMS; };
const asManager = () => loadApp('ifeoma.okafor@aureliagrand.com');
const asRevenue = () => loadApp('chiamaka.obi@aureliagrand.com');
const asAuditor = () => loadApp('auditor@aureliagrand.com');
const asFrontDesk = () => loadApp('adamu.bello@aureliagrand.com');

const PID = 'agm';
const USD = 1550;      // the treasury fixing the seed opens on
const GBP = 1965;      // nine days old, so the books no longer trust it

// A foreign line is only worth what the books said on the day it moved.
const baseOf = (LHMS, amount, code) => LHMS.fx.toBase(amount, code).base;

// A folio with nothing on it yet. The first line picks the money for every line
// after it, so anything about a folio's currency needs a clean account.
function cleanFolio(LHMS, index) {
  const res = LHMS.db.reservations
    .filter((r) => r.status === 'In-house' && r.propertyId === PID)[index || 0];
  LHMS.db.charges = LHMS.db.charges.filter((c) => c.reservationId !== res.id);
  LHMS.db.payments = LHMS.db.payments.filter((p) => p.reservationId !== res.id);
  return res;
}

// Re-pricing a room type moves every open folio of that type at every property,
// so a test about one night has to leave the engine one night to value.
function soloNight(LHMS, res) {
  LHMS.db.reservations.forEach((r) => {
    if (r.status === 'In-house' && r.roomTypeId === res.roomTypeId && r.id !== res.id) r.status = 'Checked out';
  });
  LHMS.db.charges = LHMS.db.charges.filter((c) => c.reservationId !== res.id);
  LHMS.db.payments = LHMS.db.payments.filter((p) => p.reservationId !== res.id);
  const svc = LHMS.price.forRef('room', res.roomTypeId);
  assert.equal(LHMS.actions.setPrice(LHMS.price.baseRow(svc.id).id, { currency: 'USD', amount: 200 },
    'Nights sold in dollars').ok, true);
  return res;
}

// Objects built inside the sandbox are not the test's own arrays, so a list of
// nights is read as one line of figures rather than compared by structure.
const moniesOf = (nights) => nights.map((n) => n.quote.nightly[0].currency)
  .filter((c, i, all) => all.indexOf(c) === i).join('+');

// The business date is a value the app owns, so ageing a rate is a matter of
// letting the day run on, not of rewriting the rate table.
function ageTheDay(LHMS, days) {
  LHMS.db.meta.day = LHMS.util.addDays(LHMS.day, days);
  return LHMS.day;
}

/* ---------------- the rate table ---------------- */

test('a rate is read as of the day asked for, newest on or before it winning', () => {
  const LHMS = asManager();
  const CORE = LHMS.fxCore;
  const rates = LHMS.db.fxRates;
  // The seed files the two dollar fixings a walk back from the day the book was
  // opened, so the days asked about are counted the same way. A date written out
  // in full would be true only on the day the test was first run.
  const U = LHMS.util;
  const day = LHMS.day;

  assert.equal(CORE.rateOn(rates, 'USD', U.addDays(day, -4)).perBase, 1512,
    'mid-week the Monday fixing was the live one');
  assert.equal(CORE.rateOn(rates, 'USD', U.addDays(day, -1)).perBase, USD,
    'the treasury fixing took over the day it was filed');
  assert.equal(CORE.rateOn(rates, 'USD', U.addDays(day, -12)), null,
    'before the first row on file there is nothing to read, not the next one');
  assert.equal(CORE.rateOn(rates, 'GBP', LHMS.day).perBase, GBP, 'a rate older than the window is still the rate on file');
});

test('the money of account needs no rate and is always worth one of itself', () => {
  const LHMS = asManager();
  const st = LHMS.fx.state('NGN');
  assert.equal(st.state, 'base');
  assert.equal(st.rate, 1);
  assert.equal(st.usable, true, 'a property can always bill in the money it keeps');
  assert.equal(st.error, null);
  assert.equal(LHMS.fx.toBase(250000, 'NGN').base, 250000, 'a base figure is its own base figure');
  assert.equal(LHMS.fx.gate('NGN'), null);
  assert.equal(LHMS.fx.state('ngn').code, 'NGN', 'a money is a code, however it is typed in');
});

test('fresh, stale and missing are three different answers with three different sentences', () => {
  const LHMS = asManager();

  const usd = LHMS.fx.state('USD');
  assert.equal(usd.state, 'fresh');
  assert.equal(usd.rate, USD);
  assert.equal(usd.usable, true);
  assert.ok(usd.ageDays <= usd.maxAgeDays, 'inside the window the money trades');

  const gbp = LHMS.fx.state('GBP');
  assert.equal(gbp.state, 'stale');
  assert.equal(gbp.usable, false, 'a rate nobody revisited is not a price the books will hold');
  assert.ok(gbp.ageDays > gbp.maxAgeDays);
  assert.match(gbp.error, /GBP rate was set on/, 'the refusal says how old the figure is');

  const eur = LHMS.fx.state('EUR');
  assert.equal(eur.state, 'missing');
  assert.equal(eur.rate, null);
  assert.equal(eur.usable, false);
  assert.match(eur.error, /EUR rate on file/, 'a money with no row at all is refused in the same breath');

  assert.equal(LHMS.fx.gate('USD'), null);
  assert.equal(LHMS.fx.gate('GBP').state, 'stale', 'the gate hands back the state that refused');
});

test('the window a rate is trusted for is a rule on the property, not a constant', () => {
  const LHMS = asManager();
  assert.equal(LHMS.fx.state('GBP').usable, false, 'nine days is outside a three-day window');
  assert.equal(LHMS.fx.state('GBP').maxAgeDays, LHMS.financeSettings(PID).rateMaxAgeDays,
    'the answer reads the rule the settings page edits');

  assert.equal(LHMS.actions.setFinanceSettings({ rateMaxAgeDays: 30 }).ok, true);
  const widened = LHMS.fx.state('GBP');
  assert.equal(widened.state, 'fresh', 'the same rate is usable again once the property agrees to stand behind it longer');
  assert.equal(widened.rate, GBP, 'widening the window never changes the figure, only the trust in it');

  assert.equal(LHMS.actions.setFinanceSettings({ rateMaxAgeDays: 1 }).ok, true);
  assert.equal(LHMS.fx.state('GBP').state, 'stale', 'and it closes again when the property stops trusting its own history');

  // A one-day window reaches the day the books are kept on, not only the table.
  assert.equal(LHMS.fx.state('USD').state, 'fresh', 'yesterday is exactly one day old, which a one-day window still accepts');
  ageTheDay(LHMS, 1);
  assert.equal(LHMS.fx.state('USD').state, 'stale', 'two days is outside it');
});

test('letting the day run on ages a rate out of use without anyone touching it', () => {
  const LHMS = asManager();
  assert.equal(LHMS.fx.state('USD').usable, true, 'the seed opens with the dollar on the air');

  ageTheDay(LHMS, 3);
  const stale = LHMS.fx.state('USD');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.ageDays, 4);
  assert.equal(stale.usable, false, 'the fixing did not change; the books just stopped believing it');

  assert.equal(LHMS.price.amount('svc_dk', { listId: 'pl_corp' }), null,
    'a dollar contract price cannot be quoted while the dollar cannot be valued');
  assert.equal(LHMS.price.nightRateOf('dk', { listId: 'pl_corp' }), null);
  assert.equal(LHMS.price.nightRate('dk', { listId: 'pl_corp' }), 0);
  assert.ok(LHMS.price.amount('svc_dk'), 'the naira row on the same service still sells');

  const refused = LHMS.actions.postCharge(cleanFolio(LHMS).id, {
    description: 'Minibar — dollar account', amount: 40, currency: 'USD'
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /USD/);

  const filed = LHMS.actions.setFxRate({ code: 'USD', perBase: 1560, effective: LHMS.day, note: 'Treasury refresh' });
  assert.equal(filed.ok, true);
  const back = LHMS.price.amount('svc_dk', { listId: 'pl_corp' });
  assert.equal(back.unit, 150, 'the price row never moved, only the rate beside it');
  assert.equal(back.currency, 'USD');
});

/* ---------------- filing a rate ---------------- */

test('a rate is only filed by a hand that can price, and only in full sentences', () => {
  const refusals = [
    [asFrontDesk(), 'manage_financial_settings'],
    [asRevenue(), 'manage_financial_settings'],
    [asAuditor(), 'manage_financial_settings']
  ];
  refusals.forEach(([LHMS, perm]) => {
    assert.equal(LHMS.can(perm), false, LHMS.session.role + ' does not hold the settings');
    assert.equal(LHMS.actions.setFxRate({ code: 'USD', perBase: 1600, note: 'A screen reading' }).ok, false,
      LHMS.session.role + ' cannot move the money the books are kept in');
  });

  const LHMS = asManager();
  const U = LHMS.util;
  const rows = LHMS.db.fxRates.length;
  assert.equal(LHMS.actions.setFxRate({ code: 'USD', perBase: 0, note: 'x' }).ok, false, 'a rate is a number above zero');
  assert.equal(LHMS.actions.setFxRate({ code: 'NGN', perBase: 1, note: 'x' }).ok, false,
    'the money of account always stands at one and is not filed');
  assert.equal(LHMS.actions.setFxRate({ code: 'ZAR', perBase: 1, note: 'x' }).ok, false,
    'a money the group does not hold is not offered');
  assert.equal(LHMS.actions.setFxRate({ code: 'usd', perBase: 'abc', note: 'x' }).ok, false);
  assert.equal(LHMS.actions.setFxRate({ code: 'EUR', perBase: 1700, effective: U.addDays(LHMS.day, 5), note: 'x' }).ok, false,
    'nothing takes effect on a day that has not arrived');
  assert.equal(LHMS.actions.setFxRate({ code: 'EUR', perBase: 1700, effective: '30 Oct 2026', note: 'x' }).ok, false);
  assert.equal(LHMS.actions.setFxRate({ code: 'EUR', perBase: 1700, effective: LHMS.day }).ok, false,
    'a rate without a source is not a rate');
  assert.equal(LHMS.db.fxRates.length, rows, 'every refusal above filed nothing');

  const euro = LHMS.actions.setFxRate({ code: 'EUR', perBase: 1700, effective: LHMS.day, note: 'ECB fixing' });
  assert.equal(euro.ok, true);
  assert.equal(euro.previous, null, 'there was no earlier euro rate to hand over from');
  assert.equal(LHMS.fx.state('EUR').usable, true, 'the money is on the books from the moment the row exists');

  // Re-filing a day already on file is a correction to that row, not a twin of it.
  // Asked as the day the seed filed it, a walk back from the day the book opened.
  const treasuryDay = U.addDays(LHMS.day, -1);
  const usd29 = LHMS.db.fxRates.filter((r) => r.code === 'USD' && r.effective === treasuryDay)[0];
  const before = LHMS.db.fxRates.length;
  const corrected = LHMS.actions.setFxRate({
    code: 'USD', perBase: 1555, effective: treasuryDay, note: 'Correction to the treasury fixing'
  });
  assert.equal(corrected.ok, true);
  assert.equal(LHMS.db.fxRates.length, before, 'the same day cannot hold two fixings');
  assert.equal(LHMS.db.fxRates.filter((r) => r.id === usd29.id)[0].perBase, 1555, 'the row keeps its identity');
  assert.match(LHMS.db.activity[0].action, /set the USD rate/);
  assert.equal(LHMS.db.activity[0].entity, 'currency', 'the trail files it under the money, not the price');
  assert.match(LHMS.db.activity[0].detail, /1 USD = /);
  assert.match(LHMS.db.activity[0].detail, /was ₦1,550/, 'and says what it replaced');
});

test('a rate filed by a hand that cannot sign waits for a second signature', () => {
  const LHMS = asRevenue();
  // The revenue desk may put a fixing on paper; it may not decide what the books
  // are worth. That split is the whole reason the register exists.
  LHMS.db.permissions.Revenue.manage_financial_settings = true;
  LHMS.db.permissions.Revenue.approve_financial_changes = false;
  assert.equal(LHMS.canApproveFinancial(), false);

  const asked = LHMS.actions.setFxRate({ code: 'USD', perBase: 1700, effective: LHMS.day, note: 'Bank screen' });
  assert.equal(asked.ok, true, 'the request is accepted');
  assert.equal(asked.queued.kind, 'fx');
  assert.equal(asked.queued.currency, 'NGN', 'a rate is quoted in the money of account');
  assert.equal(asked.queued.amount, 1700 - USD, 'the request is judged on the gap it moves');
  assert.equal(asked.queued.from, USD);
  assert.equal(asked.queued.to, 1700);
  assert.equal(LHMS.fx.state('USD').rate, USD, 'nothing landed while it waited');
  assert.equal(LHMS.db.fxRates.filter((r) => r.perBase === 1700).length, 0);

  assert.equal(LHMS.actions.decideApproval(asked.queued.id, true, 'I filed this myself').ok, false,
    'the asker cannot clear their own request');

  as(LHMS, 'ifeoma.okafor@aureliagrand.com');
  const cleared = LHMS.actions.decideApproval(asked.queued.id, true, 'Signed against the bank screen');
  assert.equal(cleared.ok, true);
  assert.equal(LHMS.fx.state('USD').rate, 1700, 'clearing it files the rate the approver read');

  // A rate somebody else moved while the request waited sends it back, rather
  // than silently overwriting the newer figure.
  as(LHMS, 'chiamaka.obi@aureliagrand.com');
  const second = LHMS.actions.setFxRate({ code: 'GBP', perBase: 2000, effective: LHMS.day, note: 'Sterling memo' });
  assert.equal(second.ok, true);
  as(LHMS, 'ifeoma.okafor@aureliagrand.com');
  LHMS.actions.setFxRate({ code: 'GBP', perBase: 1990, effective: LHMS.day, note: 'A later bank screen' });
  const stale = LHMS.actions.decideApproval(second.queued.id, true, 'Clearing the older ask');
  assert.equal(stale.ok, false);
  assert.match(stale.error, /moved since this was asked/);
  assert.equal(LHMS.fx.state('GBP').rate, 1990, 'the newer figure stands');
});

/* ---------------- money onto the books ---------------- */

test('a foreign charge keeps the rate it moved at', () => {
  const LHMS = asManager();
  const posted = LHMS.actions.postCharge(cleanFolio(LHMS).id, {
    description: 'Executive floor — dollar contract', amount: 100, currency: 'USD', department: 'Rooms'
  });
  assert.equal(posted.ok, true);
  const c = posted.charge;
  assert.equal(c.amount, 100, 'the guest holds the figure they agreed');
  assert.equal(c.currency, 'USD');
  assert.equal(c.fxRate, USD);
  assert.equal(c.baseAmount, baseOf(LHMS, 100, 'USD'));
  assert.equal(c.baseAmount, 155000, 'the books keep what it was worth on the day');
  assert.equal(LHMS.fx.baseOf(c), 155000);

  ageTheDay(LHMS, 6);
  LHMS.actions.setFxRate({ code: 'USD', perBase: 2000, effective: LHMS.day, note: 'A wide move' });
  const kept = LHMS.db.charges.filter((x) => x.id === c.id)[0];
  assert.equal(LHMS.fx.baseOf(kept), 155000, 'a later fixing cannot rewrite yesterday');

  const folio = LHMS.folio(kept.reservationId);
  assert.equal(folio.total, 100, 'the balance the guest settles is in the money they were billed in');
  assert.equal(folio.currency, 'USD');
  assert.equal(folio.baseTotal, 155000, 'and the balance the books hold is in naira');
});

test('a folio is billed in one money, and the first line picks it and its rate', () => {
  const LHMS = asManager();
  const res = cleanFolio(LHMS);
  assert.equal(LHMS.folio(res.id).currency, LHMS.fx.base(PID), 'an empty account is kept in the money of the house');

  const opened = LHMS.actions.postCharge(res.id, { description: 'Dollar line', amount: 100, currency: 'USD' });
  assert.equal(opened.ok, true);
  const clash = LHMS.actions.postCharge(res.id, { description: 'Naira line', amount: 5000 });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /billed in USD, not NGN/);
  assert.match(clash.error, /one currency/, 'the sentence says what to do about it');
  assert.equal(LHMS.db.charges.filter((c) => c.reservationId === res.id).length, 1, 'the refused line wrote nothing');

  // The account is now a dollar account: a second dollar line is taken at the
  // rate the folio opened at, whatever the treasury has filed since.
  LHMS.actions.setFxRate({ code: 'USD', perBase: 2000, effective: LHMS.day, note: 'Treasury jump' });
  const again = LHMS.actions.postCharge(res.id, { description: 'Second dollar line', amount: 50, currency: 'USD' });
  assert.equal(again.ok, true);
  assert.equal(again.charge.fxRate, USD, 'the stay was agreed at one rate and is kept at it');
  assert.equal(again.charge.baseAmount, 77500);
  assert.equal(LHMS.folio(res.id).baseTotal, 232500, 'both lines fold onto the books at the pinned figure');
});

test('a document that mixes monies is refused before a line is written', () => {
  const LHMS = asManager();
  const items = LHMS.db.outlets[0].items;
  assert.equal(LHMS.actions.setPrice('prc_ina_jollof_std', { currency: 'USD', amount: 25 }, 'Contract menu in dollars').ok, true);
  assert.deepEqual(LHMS.fx.inCatalogue().sort(), ['USD']);

  const res = cleanFolio(LHMS, 1);
  const before = LHMS.db.charges.filter((c) => c.reservationId === res.id).length;
  const mixed = LHMS.actions.orderItems(res.id, [{ id: items[0].id, qty: 1 }, { id: items[1].id, qty: 1 }]);
  assert.equal(mixed.ok, false);
  assert.match(mixed.error, /mix USD and NGN/, 'the two monies are named in the refusal');
  assert.equal(LHMS.db.charges.filter((c) => c.reservationId === res.id).length, before,
    'a refused order posts none of its lines, not the first of them');

  const single = LHMS.actions.orderItems(res.id, [{ id: items[1].id, qty: 2 }]);
  assert.equal(single.ok, true, 'the same folio takes an order that stays in one money');
  assert.equal(single.currency, 'NGN');
  assert.equal(single.total, single.charges.reduce((s, c) => s + c.amount, 0));
});

test('an order and a menu card both say which money their figures are in', () => {
  const LHMS = asManager();
  const item = LHMS.db.outlets[0].items[0];
  const hit = LHMS.get.menu(item.id);
  assert.equal(hit.item.price, LHMS.price.itemPrice(item.id));
  assert.equal(hit.item.priceCurrency, 'NGN', 'the card carries the money, so a page cannot invent one');
  const offer = LHMS.price.itemPriceOf(item.id);
  assert.equal(offer.amount, hit.item.price);
  assert.equal(offer.currency, hit.item.priceCurrency);
  assert.equal(LHMS.price.itemPriceOf('not_an_item'), null, 'a thing not on the menu has no price at all');

  assert.equal(LHMS.actions.setPrice('prc_ina_jollof_std', { currency: 'USD', amount: 25 }, 'Contract menu in dollars').ok, true);
  ageTheDay(LHMS, 3);
  assert.equal(LHMS.get.menu(item.id), null,
    'a dollar item the books cannot value is not offered, and not quietly offered in naira either');
  assert.equal(LHMS.actions.setFxRate({ code: 'USD', perBase: 1580, effective: LHMS.day, note: 'Refresh' }).ok, true);
  assert.equal(LHMS.get.menu(item.id).item.priceCurrency, 'USD', 'the same card reopens in its own money');
});

test('a document pins the rate it was raised at and settles at it', () => {
  const LHMS = asManager();
  const res = cleanFolio(LHMS);
  LHMS.actions.postCharge(res.id, { description: 'Board hire — dollars', amount: 2000, currency: 'USD', department: 'Rooms' });
  const raised = LHMS.actions.raiseInvoice({ reservationId: res.id });
  assert.equal(raised.ok, true);
  const inv = raised.invoice;
  assert.equal(inv.currency, 'USD', 'the invoice is written in the money the account is kept in');
  assert.equal(inv.fxRate, USD, 'and carries the rate it was raised at');
  assert.equal(inv.lines[0].fxRate, USD, 'every line converts at the document rate');
  assert.equal(LHMS.invoiceMoney(inv).total, 2000, 'the guest owes two thousand dollars');
  assert.equal(LHMS.invoiceMoney(inv).base.total, 3100000, 'the books hold three million one hundred thousand naira');

  LHMS.actions.setFxRate({ code: 'USD', perBase: 1900, effective: LHMS.day, note: 'A later fixing' });
  const paid = LHMS.actions.payInvoice(inv.id, { amount: 1000, method: 'Transfer' });
  assert.equal(paid.ok, true);
  assert.equal(paid.payment.currency, 'USD', 'money handed in for a dollar document is taken in dollars');
  assert.equal(paid.payment.fxRate, USD, 'at the document rate, not the figure filed this morning');
  assert.equal(paid.payment.baseAmount, 1550000);
  const money = LHMS.invoiceMoney(inv);
  assert.equal(money.balance, 1000);
  assert.equal(money.base.balance, 1550000, 'the debt left on the books is the same debt in naira');
});

test('a foreign document cannot be raised in a money the books have stopped valuing', () => {
  const LHMS = asManager();
  const res = cleanFolio(LHMS);
  LHMS.actions.postCharge(res.id, { description: 'Dollars while the dollar trades', amount: 100, currency: 'USD' });
  ageTheDay(LHMS, 4);
  const late = LHMS.actions.raiseInvoice({ reservationId: res.id });
  assert.equal(late.ok, false);
  assert.match(late.error, /USD/, 'the refusal names the money that has gone off the air');
  assert.equal(LHMS.db.invoices.filter((i) => i.reservationId === res.id).length, 0, 'no half-valued document was written');
});

/* ---------------- what the books add up to ---------------- */

test('every aggregate folds foreign money onto the books before it adds', () => {
  const LHMS = asManager();
  const rooms = () => (LHMS.calc.departmentRevenue(PID).find((d) => d.name === 'Rooms') || { amount: 0 }).amount;
  const balance = () => LHMS.calc.metrics(PID).balanceDue;
  const spendOf = (gid) => LHMS.calc.guestStats(gid).spend;
  const postedToday = () => LHMS.auditPack().chargesTotal;

  const dollar = cleanFolio(LHMS, 0);
  const naira = cleanFolio(LHMS, 1);
  const rooms0 = rooms(), balance0 = balance(), spend0 = spendOf(dollar.guestId), pack0 = postedToday();

  LHMS.actions.postCharge(naira.id, { description: 'Naira room', amount: 100000, currency: 'NGN', department: 'Rooms' });
  assert.equal(rooms() - rooms0, 100000, 'a naira line adds its own figure');
  assert.equal(postedToday() - pack0, 100000, 'and the revenue pack counts it once');

  LHMS.actions.postCharge(dollar.id, { description: 'Dollar room', amount: 100, currency: 'USD', department: 'Rooms' });
  assert.equal(rooms() - rooms0, 255000, 'a dollar line and a naira line add as naira, never as 200');
  assert.equal(postedToday() - pack0, 255000, 'the pack the manager signs is the books, not the two monies side by side');
  assert.equal(balance() - balance0, 255000, 'balance in house counts the dollar folio at its book value');

  LHMS.actions.postCharge(dollar.id, { description: 'Second dollar line', amount: 10, currency: 'USD' });
  assert.equal(spendOf(dollar.guestId) - spend0, 170500, 'lifetime spend across two monies is counted in one');

  const mixed = LHMS.auditPack();
  assert.ok(mixed.charges.every((c) => typeof LHMS.fx.baseOf(c) === 'number'));
});

test('a hall booked in a money the books cannot value is not sold', () => {
  const LHMS = asManager();
  const hall = LHMS.price.forRef('hall', 'hall_board');
  const row = LHMS.price.baseRow(hall.id);
  assert.equal(LHMS.actions.setPrice(row.id, { currency: 'USD', amount: 200 }, 'Boardroom in dollars').ok, true);
  const priced = LHMS.price.hallQuote(hall.id, { date: LHMS.day, start: '09:00', end: '12:00' });
  assert.ok(priced, 'while the dollar trades the hall is on sale');
  assert.equal(priced.currency, 'USD');

  ageTheDay(LHMS, 4);
  assert.equal(LHMS.price.hallQuote(LHMS.price.forRef('hall', 'hall_board').id, {
    date: LHMS.day, start: '09:00', end: '12:00'
  }), null, 'the same hall cannot be quoted once the rate behind it goes stale');
});

/* ---------------- the register ---------------- */

test('an approval request says what money each of its own figures is in', () => {
  const LHMS = asRevenue();
  const row = LHMS.price.priceRow('prc_dk_corp');
  assert.equal(row.currency, 'USD');
  assert.equal(row.amount, 150);

  const asked = LHMS.actions.setPrice(row.id, { amount: 900 }, 'Corporate re-pricing in dollars');
  assert.equal(asked.ok, true);
  assert.equal(asked.queued.kind, 'price');
  assert.equal(asked.queued.from, 150);
  assert.equal(asked.queued.to, 900);
  assert.equal(asked.queued.fromCurrency, 'USD', 'the two figures a signer compares are the row money');
  assert.equal(asked.queued.toCurrency, 'USD');
  assert.equal(asked.queued.amount, 1162500, 'the limit is tested on what the move is worth on the books');
  assert.equal(asked.queued.currency, 'NGN', 'and the gap is stated in the money of account');
  assert.equal(LHMS.price.priceRow(row.id).amount, 150, 'a seven-hundred-and-fifty-dollar move waited instead of landing');

  const fd = asFrontDesk();
  const res = cleanFolio(fd);
  fd.actions.postCharge(res.id, { description: 'Dollar board', amount: 2000, currency: 'USD', department: 'Rooms' });
  const inv = fd.actions.raiseInvoice({ reservationId: res.id }).invoice;
  fd.actions.payInvoice(inv.id, { amount: 1000, method: 'Transfer' });
  fd.db.settings[PID].approvalAmount = 100000;

  const refund = fd.actions.refundInvoice(inv.id, { amount: 400, reason: 'Over-billed on the board' });
  assert.equal(refund.ok, true);
  assert.equal(refund.queued.kind, 'refund');
  assert.equal(refund.queued.to, 400);
  assert.equal(refund.queued.toCurrency, 'USD', 'the money handed back is the document money');
  assert.equal(refund.queued.amount, 620000, 'the limit is judged on the naira it hands back');
  assert.equal(refund.queued.currency, 'NGN');

  const discount = fd.actions.discountInvoice(inv.id, { amount: 300, label: 'Goodwill', reason: 'Service slip' });
  assert.equal(discount.ok, true);
  assert.equal(discount.queued.kind, 'discount');
  assert.equal(discount.queued.amount, 300);
  assert.equal(discount.queued.currency, 'USD', 'a discount is gated on its share of its own document');
});

test('the money of account cannot be moved once the ledger holds money', () => {
  const LHMS = asManager();
  const held = LHMS.moneyRecordsOnFile(PID);
  assert.ok(held > 0, 'the seeded books are full of money already valued');
  assert.ok(held < LHMS.moneyRecordsOnFile(),
    "the count is the property's own, not every record the group holds");
  const refused = LHMS.actions.saveSettings(PID, { currency: 'USD' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, new RegExp('keeps its books in NGN and ' + held + ' money records'),
    'the refusal counts the records it is protecting');
  assert.match(refused.error, /USD/);
  assert.equal(LHMS.db.settings[PID].currency, 'NGN', 'the refusal left the rule alone');
  assert.equal(LHMS.fx.base(PID), 'NGN');

  // With nothing on file the money of account is a free choice, and every rate
  // question turns on the answer.
  const fresh = asManager();
  fresh.db.charges = [];
  fresh.db.payments = [];
  fresh.db.invoices = [];
  fresh.db.expenses = [];
  assert.equal(fresh.moneyRecordsOnFile('apa'), 0);
  assert.equal(fresh.actions.saveSettings('apa', { currency: 'GHS' }).ok, true);
  assert.equal(fresh.fx.base('apa'), 'GHS');
  assert.equal(fresh.fx.state('GHS', { propertyId: 'apa' }).state, 'base');
  assert.equal(fresh.fx.state('NGN', { propertyId: 'apa' }).state, 'missing',
    'naira is now a foreign money at that property, with no rate on file for it');
});

/* ---------------- the day closing ---------------- */

test('the night audit names the money it cannot value before the day is signed off', () => {
  const LHMS = asManager();
  assert.deepEqual(LHMS.fx.unusable(), [], 'on the seeded date every catalogue money has a trusted rate');
  const pack = LHMS.auditPack();
  assert.equal(pack.rates.length, 0);
  assert.match(LHMS.auditChecks(pack).find((c) => c.key === 'currency').detail, /Every currency the catalogue sells in/);

  ageTheDay(LHMS, 4);
  const later = LHMS.auditPack();
  assert.deepEqual(later.rates.map((r) => r.code + ':' + r.state), ['USD:stale'],
    'the money that has gone off the air is named, not skipped');
  assert.equal(LHMS.fx.unusable()[0].state, 'stale');
  assert.match(LHMS.auditChecks(later).find((c) => c.key === 'currency').detail, /USD \(stale\) cannot be valued today/);
});

test('a night whose money has no rate at all stops the close instead of half-billing the day', () => {
  const LHMS = asManager();
  const res = soloNight(LHMS, cleanFolio(LHMS));

  // The dollar the nights are owed in is taken off the air entirely: not stale
  // behind a window, simply not filed. That refuses on every date, so the close
  // cannot argue its way around it with a later fixing.
  LHMS.db.fxRates = LHMS.db.fxRates.filter((r) => r.code !== 'USD');
  ageTheDay(LHMS, 1);
  assert.equal(LHMS.fx.state('USD').state, 'missing');

  // A night the price read refuses is not a night nobody owes. The quote simply
  // has no figure for it, so it is invisible to the list of nights owed — and a
  // close built from that list alone would seal the day with the guest still
  // owing. The money that cannot be valued is found and named instead.
  assert.equal(LHMS.unbilledNights().filter((n) => n.res.id === res.id).length, 0,
    'the price read gives no quote for a money it cannot value');
  const blocked = LHMS.unbillableNights().filter((n) => n.res.id === res.id);
  assert.ok(blocked.length, 'but the close knows the nights are owed in it');
  assert.equal(blocked.map((n) => n.price.currency).filter((c, i, all) => all.indexOf(c) === i).join('+'), 'USD');

  const pack = LHMS.auditPack();
  const others = pack.unbilled.filter((n) => n.res.id !== res.id);
  const othersValued = others.reduce((s, n) => {
    const b = LHMS.fx.toBase(n.quote.nightly[0].rate + n.quote.taxes, n.quote.nightly[0].currency,
      { propertyId: n.res.propertyId, date: n.date });
    return s + (b.ok ? b.base : 0);
  }, 0);
  assert.ok(others.length, 'other stays owe nights the books can value');
  assert.equal(pack.unbilledTotal, othersValued,
    'the pack promises only the nights it can put a figure on, and the dollar nights are not one');
  assert.equal(pack.unbillable.length, blocked.length, 'and it carries the nights it cannot promise');
  assert.equal(pack.rates.map((r) => r.code + ':' + r.state).join('+'), 'USD:missing');
  assert.match(LHMS.auditChecks(pack).find((c) => c.key === 'roomtax').detail, /priced in USD cannot be valued/);
  assert.match(LHMS.auditChecks(pack).find((c) => c.key === 'roomtax').detail, /this run stops/);

  const checks = {};
  LHMS.auditChecks().forEach((c) => { checks[c.key] = true; });
  const chargesBefore = LHMS.db.charges.length;
  const run = LHMS.actions.runNightAudit({ checks: checks });
  assert.equal(run.ok, false);
  assert.match(run.error, /cannot post every open night/);
  assert.match(run.error, /USD/, 'the refusal names the money that has no rate');
  assert.equal(LHMS.db.charges.length, chargesBefore, 'nothing was posted, so nothing has to be unpicked');
  assert.equal(LHMS.closedOn(LHMS.day), null, 'the day is still open');

  // File the missing fixing and the same close goes through, still in dollars.
  // It has to be dated the first night the books owe, not today: a rate is read
  // as of the day it is asked about, so a fixing filed this morning says nothing
  // about a night two days gone.
  assert.equal(LHMS.actions.setFxRate({
    code: 'USD', perBase: 1550, effective: blocked[0].date, note: 'The fixing was never filed'
  }).ok, true);
  assert.equal(LHMS.unbillableNights().length, 0, 'the nights are billable again the moment the money is worth something');
  const owed = LHMS.unbilledNights().filter((n) => n.res.id === res.id);
  assert.equal(owed.length, blocked.length, 'and they are the same nights the close refused over');
  assert.equal(moniesOf(owed), 'USD', 'still owed in dollars');

  const sealed = LHMS.actions.runNightAudit({ checks: checks });
  assert.equal(sealed.ok, true, sealed.error);
  const ours = sealed.posted.filter((p) => p.reservationId === res.id);
  assert.equal(ours.length, owed.length, 'the close billed every night that was open on the folio');
  const nights = LHMS.db.charges
    .filter((c) => c.reservationId === res.id && c.department === 'Rooms')
    .map((c) => c.date).sort();
  assert.equal(nights.join('+'), ours.map((o) => o.date).sort().join('+'),
    'and the folio holds one room charge per night, not the refused run twice over');
  // The close rolls the date, so the stay now owes the night it has just walked
  // into. That is a fresh debt on the open day, not a night billed twice.
  assert.equal(LHMS.unbilledNights().filter((n) => n.res.id === res.id).map((n) => n.date).join('+'), LHMS.day,
    'only the day the run rolled onto is still unbilled');

  const room = LHMS.db.charges.filter((c) => c.reservationId === res.id && c.department === 'Rooms')[0];
  assert.equal(room.currency, 'USD', 'each night keeps the money it was agreed in');
  assert.equal(room.fxRate, 1550, 'and the rate the close found on the day it billed');
  assert.equal(room.baseAmount, LHMS.fxCore.round(room.amount * 1550), 'the books hold the conversion, frozen');
  const seal = LHMS.db.closedDays.filter((c) => c.date === sealed.closed.date)[0];
  assert.equal(seal.postedTotal, seal.posted.reduce((s, p) => s + p.baseAmount, 0),
    'the seal totals the close in the money of account, not in the two monies it billed in');
  assert.equal(LHMS.closedOn(sealed.rolledTo), null, 'the seal sits on the day it closed, not the one it rolled to');
});

/* ---------------- the two figures a page shows ---------------- */

test('a foreign figure is shown beside its book value, or said as unvalued', () => {
  const LHMS = asManager();
  assert.equal(LHMS.fx.pair(100, 'USD'), '$100 · \u20a6155,000');
  assert.equal(LHMS.fx.pair(5000, 'NGN'), '\u20a65,000', 'the money of account has one figure to show, not two');
  ageTheDay(LHMS, 4);
  assert.equal(LHMS.fx.pair(100, 'USD'), '$100 · no usable USD rate',
    'an unvalued figure is said as unvalued rather than guessed at');
});

test('a figure with no money on it prints in the money of account, and an unknown one says so', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  assert.equal(U.money(155000), '\u20a6155,000', 'the default printer is the books');
  assert.equal(U.money(155000, 'USD'), '$155,000', 'naming a money changes the sign, not the number');
  assert.match(U.money(100, 'ZAR'), /^ZAR ?100$/, 'a money the house does not keep prints its own letters, never the naira sign');
  assert.equal(LHMS.fx.symbolOf('USD'), '$');
  assert.equal(LHMS.fx.nameOf('GBP'), 'British Pound');
  assert.equal(LHMS.fx.symbolOf('ZAR'), null, 'a money the house does not keep has no sign to borrow');
});
