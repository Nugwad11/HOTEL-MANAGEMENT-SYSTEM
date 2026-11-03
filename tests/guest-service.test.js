const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Orders and loyalty both move real money on the folio, so they are tested
// against the seed and store rather than mocks.
function loadPortal(role = 'Guest') {
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
  for (const file of ['data.js', 'store.js', 'pages-guest.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../assets', file), 'utf8');
    vm.runInNewContext(source, context, { filename: file });
  }
  const LHMS = context.window.LHMS;
  if (role === 'Guest') {
    LHMS.signIn('guest@aureliagrand.com', 'demo1234');
  } else {
    LHMS.signIn('ifeoma.okafor@aureliagrand.com', 'demo1234');
  }
  return LHMS;
}

function stay(LHMS) {
  const res = LHMS.guestStay();
  assert.ok(res, 'the demo guest has a stay in house');
  return res;
}

test('an order posts one folio line per item at the menu price', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const before = LHMS.folio(res.id).total;
  const jollof = LHMS.get.menu('ina_jollof');
  const suya = LHMS.get.menu('ina_suya');

  const result = LHMS.guestPortal.order({
    lines: [{ id: 'ina_jollof', qty: 2 }, { id: 'ina_suya', qty: 1 }, { id: 'ina_burger', qty: 0 }],
    when: '20:30', notes: 'No peanuts'
  });

  assert.equal(result.ok, true, result.error);
  const expected = jollof.item.price * 2 + suya.item.price;
  assert.equal(result.total, expected);
  assert.equal(LHMS.folio(res.id).total, before + expected);
  assert.equal(result.charges.length, 2, 'the zero-quantity line posts nothing');

  const line = result.charges[0];
  assert.equal(line.qty, 2);
  assert.equal(line.department, 'Food & Beverage');
  assert.equal(line.postedBy, 'Guest app');
  assert.match(line.description, /2 × Jollof rice & grilled chicken · In-room dining/);
});

test('an order raises one task for the department, not one per line', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const before = LHMS.db.tasks.length;
  const result = LHMS.guestPortal.order({
    lines: [{ id: 'ina_jollof', qty: 1 }, { id: 'ina_dessert', qty: 2 }], when: '20:30', notes: ''
  });

  assert.equal(LHMS.db.tasks.length, before + 1);
  const task = LHMS.db.tasks[0];
  assert.equal(task.source, 'Guest app');
  assert.equal(task.guestId, res.guestId);
  assert.equal(task.roomId, res.roomId);
  assert.equal(task.slaMins, LHMS.get.outlet('out_ina').sla);
  assert.match(task.title, /In-room dining — 1 × Jollof rice & grilled chicken, 2 × Chocolate/);
  assert.match(task.detail, /Serve by 20:30/);
  assert.match(task.detail, /Posted to the folio/);
});

test('a spa order is routed to the wellness department', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const result = LHMS.guestPortal.order({ lines: [{ id: 'spa_signature', qty: 1 }], when: '16:00', notes: '' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.charges[0].department, 'Spa & Wellness');
  assert.equal(LHMS.folio(res.id).charges.slice(-1)[0].amount, LHMS.get.menu('spa_signature').item.price);
});

test('an order is refused before anything is posted when a line is not on the menu', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const before = LHMS.folio(res.id).total;
  const result = LHMS.guestPortal.order({
    lines: [{ id: 'ina_jollof', qty: 1 }, { id: 'ina_ghost', qty: 1 }]
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer on the menu/);
  assert.equal(LHMS.folio(res.id).total, before, 'the valid line was not posted either');
});

test('an order with nothing chosen posts nothing', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const before = LHMS.folio(res.id).total;
  assert.match(LHMS.guestPortal.order({ lines: [{ id: 'ina_jollof', qty: 0 }] }).error, /at least one item/);
  assert.equal(LHMS.folio(res.id).total, before);
});

test('a guest with no stay in house cannot order through the portal', () => {
  const staff = loadPortal('Manager');
  assert.match(staff.guestPortal.order({ lines: [{ id: 'ina_jollof', qty: 1 }] }).error, /Only the guest/);

  const LHMS = loadPortal();
  const res = stay(LHMS);
  LHMS.actions.checkOut(res.id, { settle: true });
  assert.match(LHMS.guestPortal.order({ lines: [{ id: 'ina_jollof', qty: 1 }] }).error, /active stay/);
  assert.match(LHMS.guestPortal.redeem({ points: 2000 }).error, /active stay/);
});

test('ordering raises the folio balance that settlement then clears', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const before = LHMS.folio(res.id).balance;
  const result = LHMS.guestPortal.order({ lines: [{ id: 'mini_soft', qty: 3 }] });
  assert.equal(LHMS.folio(res.id).balance, before + result.total);
  assert.equal(LHMS.guestPortal.settle({ confirm: true }).ok, true);
  assert.equal(LHMS.folio(res.id).balance, 0);
});

/* ---------------- loyalty ---------------- */
test('check-out credits points for the settled spend at the tier rate', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const guest = LHMS.get.guest(res.guestId);
  const f = LHMS.folio(res.id);
  const expected = LHMS.loyalty.pointsFor(f.total, guest.tier);
  const before = guest.loyaltyPoints;

  assert.ok(expected > 0, 'the seeded stay is worth points');
  const out = LHMS.actions.checkOut(res.id, { settle: true });
  assert.equal(out.ok, true);
  assert.equal(out.points, expected);
  assert.equal(guest.loyaltyPoints, before + expected);
});

test('a second check-out does not award the stay twice', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const guest = LHMS.get.guest(res.guestId);
  const first = LHMS.actions.checkOut(res.id, { settle: true });
  const after = guest.loyaltyPoints;
  const second = LHMS.actions.checkOut(res.id, { settle: true });
  assert.equal(second.points, 0);
  assert.equal(guest.loyaltyPoints, after);
  assert.equal(first.points > 0, true);
});

test('pending points show what an in-house stay will earn and stop once awarded', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const pending = LHMS.loyalty.pending(res.id);
  assert.ok(pending > 0);
  LHMS.actions.checkOut(res.id, { settle: true });
  assert.equal(LHMS.loyalty.pending(res.id), 0);
});

test('tier multipliers change what the same spend earns', () => {
  const LHMS = loadPortal();
  assert.equal(LHMS.loyalty.pointsFor(100000, 'Member'), 100);
  assert.equal(LHMS.loyalty.pointsFor(100000, 'Platinum'), 200);
  assert.equal(LHMS.loyalty.multiplierFor('Inventor'), 1, 'an unknown tier earns at the base rate');
});

test('a guest redeems points as a credit against the folio', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const guest = LHMS.get.guest(res.guestId);
  const held = guest.loyaltyPoints;
  const before = LHMS.folio(res.id);
  const points = 2000;
  const credit = LHMS.loyalty.creditFor(points);

  const result = LHMS.guestPortal.redeem({ points });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.credit, credit);
  assert.equal(guest.loyaltyPoints, held - points);
  const f = LHMS.folio(res.id);
  assert.equal(f.total, before.total - credit);
  assert.equal(f.balance, before.balance - credit);
  const line = f.charges[f.charges.length - 1];
  assert.equal(line.department, 'Loyalty');
  assert.equal(line.postedBy, 'Guest app');
  assert.equal(line.amount, -credit);
  assert.equal(line.description, 'Aurelia Club — 2,000 points redeemed');
  // A credit on a folio reads "-₦10,000", not "₦-10,000".
  assert.equal(LHMS.util.money(line.amount), '-\u20a610,000');
});

test('voiding a redemption puts the points back on the guest', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const guest = LHMS.get.guest(res.guestId);
  const held = guest.loyaltyPoints;
  const before = LHMS.folio(res.id).total;

  const done = LHMS.guestPortal.redeem({ points: 2000 });
  assert.equal(done.ok, true, done.error);
  assert.equal(LHMS.actions.voidCharge(done.charge.id).ok, true);

  assert.equal(guest.loyaltyPoints, held, 'a voided credit is not free money');
  assert.equal(LHMS.folio(res.id).total, before);
});

test('redemptions that overdraw points or the folio are refused', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const guest = LHMS.get.guest(res.guestId);
  const held = guest.loyaltyPoints;

  assert.match(LHMS.guestPortal.redeem({ points: 500 }).error, /at least 2000/);
  assert.match(LHMS.guestPortal.redeem({ points: held + 1000 }).error, /points are available/);
  assert.equal(guest.loyaltyPoints, held, 'a refused redemption spends nothing');

  LHMS.actions.takePayment(res.id, { amount: LHMS.folio(res.id).balance - 5000 });
  assert.match(LHMS.guestPortal.redeem({ points: 2000 }).error, /outstanding/);
  assert.equal(guest.loyaltyPoints, held);
});

test('awarded points are recorded against the guest for the front desk to see', () => {
  const LHMS = loadPortal();
  const res = stay(LHMS);
  const guest = LHMS.get.guest(res.guestId);
  LHMS.actions.checkOut(res.id, { settle: true });
  assert.equal(res.pointsAwarded, LHMS.loyalty.pointsFor(LHMS.folio(res.id).total, guest.tier));
  assert.ok(LHMS.db.activity.some((a) => a.action === 'earned loyalty points'), 'the ledger records the award');
});
