const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Prices are the one number this app must never get wrong twice, so these run
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

// The weekend spans two consecutive days, and the stay below has to start on
// the first of them — so the anchor is a pair, not whichever day is next.
function nextWeekendStart(LHMS) {
  const U = LHMS.util;
  let d = U.addDays(U.today(), 1);
  for (let i = 0; i < 9; i++) {
    if (U.isWeekend(d) && U.isWeekend(U.addDays(d, 1))) return d;
    d = U.addDays(d, 1);
  }
  throw new Error('no weekend start ahead');
}

test('a plain night resolves to the standard list and a festive night to the seasonal list', () => {
  const LHMS = asManager();
  const plain = nextDay(LHMS, false);

  const weekday = LHMS.price.applicable('svc_dk', { date: plain });
  assert.equal(weekday.list.id, 'pl_std');
  assert.equal(LHMS.price.amount('svc_dk', { date: plain }).unit, 185000);

  const festive = LHMS.price.amount('svc_dk', { date: '2026-12-24' });
  assert.equal(festive.list.id, 'pl_fest', 'the higher-priority seasonal list wins inside its window');
  assert.equal(festive.unit, 231250);

  const dayUse = LHMS.price.amount('svc_dk', { date: plain, listId: 'pl_day' });
  assert.equal(dayUse.unit, 111000, 'day use is 60% of the overnight rate and only when named');
});

test('weekend uplift applies on a Friday and not on a weekday', () => {
  const LHMS = asManager();
  assert.equal(LHMS.price.nightRate('dk', { date: nextDay(LHMS, false) }), 185000);
  assert.equal(LHMS.price.nightRate('dk', { date: nextDay(LHMS, true) }), 212750);
});

test('occupancy beyond the room and an extra bed are itemised, not buried in the rate', () => {
  const LHMS = asManager();
  const q = LHMS.price.amount('svc_dk', { date: nextDay(LHMS, false), adults: 3, extraBed: true });
  assert.equal(q.unit, 225200);
  sameShape(q.added.map((a) => a.label), ['Extra person × 1', 'Extra bed']);
  sameShape(q.added.map((a) => a.amount), [22200, 18000]);
});

test('taxes compound in order so VAT lands on top of the service charge', () => {
  const LHMS = asManager();
  const t = LHMS.price.taxes(185000, 'room');
  sameShape(t.lines.map((l) => [l.label, l.amount]), [
    ['Service charge (10%)', 18500],
    ['VAT (7.5%)', 15250]
  ]);
  assert.equal(t.total, 33750);
  assert.equal(t.grand, 218750);
});

test('a price change is audited and never rewrites a charge already on a folio', () => {
  const LHMS = asManager();
  const charge = LHMS.db.charges.find((c) => c.department === 'Rooms' && c.serviceId === 'svc_dk');
  assert.ok(charge, 'the seed posts nightly room charges');
  const soldAt = charge.unitPrice;

  const row = LHMS.price.baseRow('svc_dk');
  const result = LHMS.actions.setPrice(row.id, { amount: 250000 }, 'December rate review');
  assert.equal(result.ok, true, result.error);

  assert.equal(charge.unitPrice, soldAt, 'the posted line keeps the price it was sold at');
  assert.equal(LHMS.price.nightRate('dk', { date: nextDay(LHMS, false) }), 250000, 'new quotes use the new price');

  const entry = LHMS.price.history('svc_dk')[0];
  assert.equal(entry.reason, 'December rate review');
  assert.equal(entry.from.amount, 185000);
  assert.equal(entry.to.amount, 250000);
  assert.ok(LHMS.db.activity.some((a) => /changed a price/.test(a.action || a.text || JSON.stringify(a))));
});

test('an unreasonable price edit is refused before anything is written', () => {
  const LHMS = asManager();
  const row = LHMS.price.baseRow('svc_dk');
  const written = LHMS.price.history('svc_dk').length;

  assert.equal(LHMS.actions.setPrice(row.id, { amount: 0 }, 'Test').ok, false);
  assert.equal(LHMS.actions.setPrice(row.id, { amount: -500 }, 'Test').ok, false);
  assert.equal(LHMS.actions.setPrice(row.id, { amount: 'abc' }, 'Test').ok, false);
  assert.equal(LHMS.actions.setPrice(row.id, { amount: 200000 }, '').ok, false, 'a reason is mandatory');
  assert.equal(LHMS.actions.setPrice(row.id, { from: '2026-12-01', to: '2026-11-01' }, 'Test').ok, false);
  assert.equal(LHMS.actions.setPrice('prc_nope', { amount: 200000 }, 'Test').ok, false);

  assert.equal(LHMS.price.priceRow(row.id).amount, 185000, 'every refusal left the catalogue untouched');
  assert.equal(LHMS.price.history('svc_dk').length, written, 'refusals write no history');
});

test('a role without the pricing capability cannot change a price or a tax rule', () => {
  const LHMS = asFrontDesk();
  assert.equal(LHMS.can('configure_prices'), false);
  assert.equal(LHMS.actions.setPrice(LHMS.price.baseRow('svc_dk').id, { amount: 1 }, 'because').ok, false);
  assert.equal(LHMS.actions.setTaxRule('tax_vat', { pct: 40 }, 'because').ok, false);
  assert.equal(LHMS.price.baseRow('svc_dk').amount, 185000);
});

test('the menu is priced by the engine and a switched-off item leaves the menu', () => {
  const LHMS = asManager();
  const jollof = LHMS.get.menu('ina_jollof');
  assert.equal(jollof.item.price, LHMS.price.itemPrice('ina_jollof'));

  const result = LHMS.actions.setPrice(LHMS.price.baseRow('svc_ina_jollof').id, { active: false }, 'Kitchen sourcing gap');
  assert.equal(result.ok, true, result.error);
  assert.equal(LHMS.price.itemPrice('ina_jollof'), 0, 'nothing is quoted from an inactive price');
  assert.equal(LHMS.get.menu('ina_jollof'), null, 'the guest app cannot offer it');
  assert.equal(LHMS.get.menuOf('out_ina').items.some((i) => i.id === 'ina_jollof'), false);
});

test('a new service and its first price are created together', () => {
  const LHMS = asManager();
  const result = LHMS.actions.createService({
    category: 'laundry', name: 'Shoe shine', code: 'LY10', unit: 'pair',
    amount: 4000, listId: 'pl_std', turnaroundMins: 120, expressPct: 50,
    reason: 'Concierge service requested by the Residences'
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(LHMS.price.baseRow(result.service.id).amount, 4000);
  assert.equal(LHMS.price.history(result.service.id).length, 1);

  const express = LHMS.price.amount(result.service.id, { express: true, qty: 2 });
  assert.equal(express.unit, 6000);
  assert.equal(express.lines, 12000, 'the express surcharge scales with the quantity ordered');

  assert.equal(LHMS.actions.createService({ category: 'laundry', name: 'Duplicate', code: 'LY10', amount: 1000, reason: 'x' }).ok, false);
  assert.equal(LHMS.actions.createService({ category: 'laundry', name: 'No reason', code: 'LY11', amount: 1000 }).ok, false);
});

test('a room type with every price switched off cannot be sold', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  LHMS.price.prices('svc_dk').forEach((p) => LHMS.actions.setPrice(p.id, { active: false }, 'House use'));

  const ci = U.addDays(U.today(), 2);
  const types = LHMS.price.pricedRoomTypes(ci, U.addDays(ci, 2));
  assert.equal(types.some((t) => t.id === 'dk'), false);
  assert.equal(LHMS.calc.quote('dk', 'flex', ci, U.addDays(ci, 2)).available, false);
  assert.ok(types.length, 'other room types are still sellable');
});

test('a tax rule change moves new quotes only', () => {
  const LHMS = asManager();
  const before = LHMS.price.taxes(185000, 'room');
  const result = LHMS.actions.setTaxRule('tax_vat', { pct: 10 }, 'Statutory VAT change');
  assert.equal(result.ok, true, result.error);

  const after = LHMS.price.taxes(185000, 'room');
  assert.equal(before.lines[1].amount, 15250);
  assert.equal(after.lines[1].amount, 20350, '10% of the total that already carries the service charge');
  assert.equal(LHMS.price.rules()[1].updatedAt && true, true, 'the rule records who changed it');
});

test('a multi-night stay is priced night by night, so a weekend inside it is charged once', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  const friday = nextWeekendStart(LHMS);
  const q = LHMS.price.stay('dk', 'flex', friday, U.addDays(friday, 3), 2);
  assert.equal(q.available, true);
  assert.equal(q.nights, 3);
  sameShape(q.nightly.map((n) => n.rate), [212750, 212750, 185000].sort((a, b) => b - a));
  assert.equal(q.roomTotal, 212750 + 212750 + 185000);
  assert.ok(q.extras > 0, 'the weekend uplift is visible as an addition, not hidden in the rate');
});

test('editing a plan moves the quote a stay is booked on and signs the trail for it', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  const ci = nextDay(LHMS, false);
  const co = U.addDays(ci, 2);
  const before = LHMS.price.stay('dk', 'flex', ci, co, 2);
  assert.equal(before.roomTotal, 370000, 'two nights at the ₦185,000 the standard list sells');
  assert.equal(before.deposit, 109400, 'and the deposit the plan asks for is 25% of the ₦437,550 stay');

  const result = LHMS.actions.updatePlan('flex', { modifier: 0.9, depositPct: 30 },
    'Shoulder-season push agreed on the Tuesday revenue call');
  assert.equal(result.ok, true, result.error);
  sameShape(result.moved, ['modifier 100% → 90%', 'deposit 25% → 30%']);

  // The plan is the multiplier every quote runs through, so the same two nights
  // are now 90% of the list rate and the deposit is 30% of the stay that makes.
  const after = LHMS.price.stay('dk', 'flex', ci, co, 2);
  assert.equal(after.roomTotal, 333000);
  assert.equal(after.total, 393750);
  assert.equal(after.deposit, 118150);

  assert.equal(LHMS.db.activity[0].entity, 'rate plan');
  assert.equal(LHMS.db.activity[0].action, 'changed a rate plan');
  assert.equal(LHMS.db.activity[0].actor, LHMS.session.name);
  assert.equal(LHMS.db.activity[0].detail,
    'Flexible Rate · modifier 100% → 90% · deposit 25% → 30% · Shoulder-season push agreed on the Tuesday revenue call');

  // The page posts its whole form back, terms it never touched included: a write
  // that moves nothing says so in the trail rather than naming figures that held.
  const current = LHMS.get.ratePlan('flex');
  const unchanged = LHMS.actions.updatePlan('flex',
    { modifier: current.modifier, depositPct: current.depositPct, includes: current.includes, cancel: current.cancel },
    'Posted back from the form with nothing changed');
  assert.equal(unchanged.ok, true, unchanged.error);
  sameShape(unchanged.moved, []);
  assert.equal(LHMS.db.activity[0].detail,
    'Flexible Rate · nothing moved · Posted back from the form with nothing changed');
});

test('a plan edit is refused by the bounds the form itself carries', () => {
  const LHMS = asManager();
  const REASON = 'December diary review ahead of the festive bookings';
  const ghost = 'pl_ghost';
  // [patch, reason, plan id, refusal] — the reason and the plan are arguments of
  // the action, so a refusal is tested against the one thing actually wrong.
  const cases = [
    [{ modifier: 0.4 }, REASON, 'flex', 'A modifier below 0.50 is not a rate plan.'],
    [{ modifier: 2.5 }, REASON, 'flex', 'A plan cannot sell above twice the base rate.'],
    [{ depositPct: 12.5 }, REASON, 'flex', 'A deposit is a whole percentage.'],
    [{ depositPct: -5 }, REASON, 'flex', 'A deposit cannot be negative.'],
    [{ depositPct: 105 }, REASON, 'flex', 'A deposit cannot be more than the stay.'],
    [{ includes: '  ' }, REASON, 'flex', 'Name what the plan includes.'],
    [{ cancel: '' }, REASON, 'flex', 'Write the cancellation terms the guest is shown.'],
    [{ modifier: 0.9 }, '', 'flex', 'A reason is required for the audit trail.'],
    [{ modifier: 0.9 }, '   ', 'flex', 'A reason is required for the audit trail.'],
    [{}, REASON, 'flex', 'Nothing to update.'],
    [{ code: 'HIJACK', deposit_pct: 90 }, REASON, 'flex', 'Nothing to update.'],
    [{ modifier: 0.9 }, REASON, ghost, 'Rate plan not found.'],
  ];
  const seeded = JSON.stringify(LHMS.get.ratePlan('flex'));
  const planLines = () => LHMS.db.activity.filter((a) => a.entity === 'rate plan').length;
  const linesBefore = planLines();

  for (const [patch, reason, planId, error] of cases) {
    const out = LHMS.actions.updatePlan(planId, patch, reason);
    assert.equal(out.ok, false, JSON.stringify([patch, reason, out]));
    assert.equal(out.error, error);
  }
  assert.equal(JSON.stringify(LHMS.get.ratePlan('flex')), seeded, 'not one term of the plan moved');
  assert.equal(planLines(), linesBefore, 'a refused write leaves no trail');

  const desk = asFrontDesk();
  const refused = desk.actions.updatePlan('flex', { modifier: 0.9 }, REASON);
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'Your role cannot change rate plans.');
  assert.equal(desk.get.ratePlan('flex').modifier, 1);
});
