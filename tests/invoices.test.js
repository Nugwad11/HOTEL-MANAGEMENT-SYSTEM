const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// An invoice is the document a guest argues about, so every rule here is about
// money that has already been counted: what was copied, what arrived, what went
// back out, and who was allowed to move it.
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
const asFrontDesk = () => loadApp('adamu.bello@aureliagrand.com');

function stay(LHMS) {
  return LHMS.db.reservations.find((r) => r.status === 'In-house' && r.propertyId === 'agm');
}

// Two lines on purpose: one that came from the pricing engine with its own
// snapshot and one plain charge, because a real folio is a mixture.
function billable(LHMS) {
  const res = stay(LHMS);
  LHMS.actions.postCharge(res.id, {
    description: 'Room charge — Deluxe King', amount: 240000, department: 'Rooms', qty: 1,
    unitPrice: 240000, serviceId: 'svc_dk', priceId: 'prc_dk_std', listId: 'pl_std', listName: 'Standard 2026'
  });
  LHMS.actions.postCharge(res.id, { description: 'Laundry — express', amount: 53200, department: 'Laundry', qty: 1, unitPrice: 53200 });
  return LHMS.actions.raiseInvoice({ reservationId: res.id });
}

test('raising an invoice copies the open charges and takes them off the folio', () => {
  const LHMS = asManager();
  const res = stay(LHMS);
  const raised = billable(LHMS);
  const open = LHMS.folio(res.id);

  assert.equal(LHMS.unbilledCharges(res.id).length, 0, 'billed charges cannot be invoiced twice');
  assert.equal(raised.invoice.lines.length, open.charges.length);
  assert.equal(raised.totals.total, open.total);
  assert.equal(raised.totals.status, 'Unpaid', 'a document is not money');
});

test('a second raise refuses until something new is posted', () => {
  const LHMS = asManager();
  const res = stay(LHMS);
  billable(LHMS);
  const again = LHMS.actions.raiseInvoice({ reservationId: res.id });
  assert.equal(again.ok, false);
  assert.match(again.error, /already invoiced/);

  LHMS.actions.postCharge(res.id, { description: 'Minibar', amount: 12500, department: 'In-room dining' });
  const supplement = LHMS.actions.raiseInvoice({ reservationId: res.id });
  assert.equal(supplement.ok, true);
  assert.equal(supplement.invoice.lines.length, 1, 'the new document carries only what was unbilled');
});

test('re-pricing a service after invoicing does not move the document', () => {
  const LHMS = asManager();
  const inv = billable(LHMS).invoice;
  const total = LHMS.invoiceMoney(inv).total;
  const room = inv.lines.find((l) => l.priceId === 'prc_dk_std');

  const moved = LHMS.actions.setPrice('prc_dk_std', { amount: 480000 }, 'Test re-price');
  assert.equal(moved.ok, true);
  assert.equal(LHMS.invoiceMoney(inv).total, total, 'the invoice keeps the rate it was raised at');
  assert.equal(room.unitPrice, 240000);
  assert.equal(room.listName, 'Standard 2026', 'the list it was sold from travels with the line');

  const now = LHMS.price.priceRow('prc_dk_std').amount;
  assert.equal(now, 480000, 'a fresh quote after the change uses the new rate');
});

test('an invoice only becomes Paid when the money is on file', () => {
  const LHMS = asManager();
  const inv = billable(LHMS).invoice;
  const total = LHMS.invoiceMoney(inv).total;

  const half = LHMS.actions.payInvoice(inv.id, { amount: Math.round(total / 2), method: 'Card' });
  assert.equal(half.ok, true);
  assert.equal(half.totals.status, 'Partially paid');
  assert.equal(half.totals.balance, total - Math.round(total / 2));
  assert.ok(half.payment.receipt.startsWith(inv.number), 'the receipt is traceable to the document');

  const rest = LHMS.actions.payInvoice(inv.id, { amount: half.totals.balance, method: 'Bank transfer' });
  assert.equal(rest.totals.status, 'Paid');
  assert.equal(rest.totals.balance, 0);
  assert.notEqual(rest.payment.receipt, half.payment.receipt, 'each receipt is its own number');
});

test('overpayment is refused before anything is written', () => {
  const LHMS = asManager();
  const inv = billable(LHMS).invoice;
  const total = LHMS.invoiceMoney(inv).total;
  const payments = LHMS.db.payments.length;

  const tooMuch = LHMS.actions.payInvoice(inv.id, { amount: total + 1000 });
  assert.equal(tooMuch.ok, false);
  assert.match(tooMuch.error, /outstanding|is more than/);
  assert.equal(LHMS.db.payments.length, payments, 'a refused payment leaves no row behind');
  assert.equal(LHMS.invoiceMoney(inv).status, 'Unpaid');
});

test('a refund takes value back without rewriting the payment it refers to', () => {
  const LHMS = asManager();
  const inv = billable(LHMS).invoice;
  const total = LHMS.invoiceMoney(inv).total;
  LHMS.actions.payInvoice(inv.id, { amount: total, method: 'Cash' });
  const paidRows = LHMS.db.payments.filter((p) => p.invoiceId === inv.id).slice();

  const back = LHMS.actions.refundInvoice(inv.id, { amount: 20000, reason: 'Air conditioning fault, agreed by the duty manager' });
  assert.equal(back.ok, true);
  assert.equal(back.totals.status, 'Partially paid');
  assert.equal(back.totals.balance, 20000);
  assert.deepEqual(LHMS.db.payments.filter((p) => p.invoiceId === inv.id), paidRows, 'the original receipt stands');

  const beyond = LHMS.actions.refundInvoice(inv.id, { amount: total, reason: 'Too much' });
  assert.equal(beyond.ok, false);
  assert.match(beyond.error, /actually been received/);
});

test('a void needs the money returned first and puts the charges back on the folio', () => {
  const LHMS = asManager();
  const res = stay(LHMS);
  const inv = billable(LHMS).invoice;
  LHMS.actions.payInvoice(inv.id, { amount: 5000, method: 'Card' });

  const blocked = LHMS.actions.voidInvoice(inv.id, { reason: 'Wrong rate' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Refund/);

  LHMS.actions.refundInvoice(inv.id, { amount: 5000, reason: 'Returned to guest' });
  const voided = LHMS.actions.voidInvoice(inv.id, { reason: 'Re-raised on the corrected rate' });
  assert.equal(voided.ok, true);
  assert.equal(inv.status, 'Void');
  assert.ok(LHMS.unbilledCharges(res.id).length >= 2, 'a void hands the charges back to be billed again');
  assert.ok(LHMS.folio(res.id).total > 0, 'the folio itself is never unwound');

  const again = LHMS.actions.raiseInvoice({ reservationId: res.id });
  assert.equal(again.ok, true, 'the corrected document can be raised straight away');

  const noReason = LHMS.actions.voidInvoice(again.invoice.id, {});
  assert.equal(noReason.ok, false, 'a void without a reason is not a correction, it is a cover-up');
});

test('a split moves whole lines and the two documents still add up', () => {
  const LHMS = asManager();
  const inv = billable(LHMS).invoice;
  const total = LHMS.invoiceMoney(inv).total;
  const room = inv.lines.find((l) => l.department === 'Rooms');

  const split = LHMS.actions.splitInvoice(inv.id, { chargeIds: [room.chargeId], notes: 'Company pays the room' });
  assert.equal(split.ok, true);
  assert.notEqual(split.split.number, inv.number);
  assert.equal(LHMS.invoiceMoney(inv).total + LHMS.invoiceMoney(split.split).total, total);
  assert.equal(split.split.lines.length, 1);
  assert.equal(LHMS.db.charges.find((c) => c.id === room.chargeId).invoiceId, split.split.id,
    'the folio line follows its new document');

  const empty = LHMS.actions.splitInvoice(inv.id, { chargeIds: [] });
  assert.equal(empty.ok, false);
});

test('a split waits for the money to be returned first', () => {
  const LHMS = asManager();
  const inv = billable(LHMS).invoice;
  LHMS.actions.payInvoice(inv.id, { amount: 1000, method: 'Cash' });
  const split = LHMS.actions.splitInvoice(inv.id, { indexes: [0] });
  assert.equal(split.ok, false);
  assert.match(split.error, /Refund the/);
});

test('an adjustment needs a reason, a name and a limit', () => {
  const LHMS = asManager();
  const inv = billable(LHMS).invoice;
  const total = LHMS.invoiceMoney(inv).total;

  assert.equal(LHMS.actions.discountInvoice(inv.id, { amount: 5000 }).ok, false);
  const cut = LHMS.actions.discountInvoice(inv.id, { amount: 5000, label: 'Loyalty gesture', reason: 'Second stay in a month' });
  assert.equal(cut.ok, true);
  assert.equal(cut.totals.total, total - 5000);
  assert.equal(cut.invoice.adjustments[0].by, 'Ifeoma Okafor', 'who approved it is on the document');
  assert.equal(LHMS.actions.discountInvoice(inv.id, { amount: total, reason: 'Too far' }).ok, false);
});

test('invoice numbers are unique and keep counting', () => {
  const LHMS = asManager();
  const a = billable(LHMS).invoice;
  LHMS.actions.postCharge(stay(LHMS).id, { description: 'Airport transfer', amount: 45000, department: 'Other' });
  const b = LHMS.actions.raiseInvoice({ reservationId: stay(LHMS).id }).invoice;
  assert.notEqual(a.number, b.number);
  assert.ok(/^AGM-INV-\d{4}$/.test(b.number), b.number);
  assert.equal(Number(b.number.slice(-4)), Number(a.number.slice(-4)) + 1);
});

test('a booking billed on a folio is invoiced with the stay, not on its own', () => {
  const LHMS = asManager();
  const onFolio = LHMS.db.events.find((e) => e.reservationId && e.status === 'Confirmed');
  const solo = LHMS.db.events.find((e) => !e.reservationId && e.status === 'Confirmed');
  if (onFolio) {
    const dup = LHMS.actions.raiseInvoice({ eventId: onFolio.id });
    assert.equal(dup.ok, false);
    assert.match(dup.error, /folio/i);
  }
  if (solo) {
    const inv = LHMS.actions.raiseInvoice({ eventId: solo.id });
    assert.equal(inv.ok, true);
    assert.equal(inv.invoice.kind, 'event');
    assert.equal(inv.totals.total, solo.total, 'the document matches what the desk quoted');
  }
});

test('billing is a permission, not a page everyone can drive', () => {
  const LHMS = asManager();
  const target = billable(LHMS).invoice;
  as(LHMS, 'grace.mensah@aureliagrand.com');

  assert.equal(LHMS.actions.raiseInvoice({ reservationId: stay(LHMS).id }).ok, false);
  assert.equal(LHMS.actions.payInvoice(target.id, { amount: 1000 }).ok, false);
  assert.equal(LHMS.actions.refundInvoice(target.id, { amount: 100, reason: 'Test' }).ok, false);
  assert.equal(LHMS.actions.voidInvoice(target.id, { reason: 'Test' }).ok, false);
  assert.equal(LHMS.invoiceMoney(target).status, 'Unpaid', 'a refused act changes nothing');
});

test('the front desk bills and settles, and reconciliation is a separate act', () => {
  const LHMS = asFrontDesk();
  const inv = billable(LHMS).invoice;
  const paid = LHMS.actions.payInvoice(inv.id, { amount: LHMS.invoiceMoney(inv).total, method: 'POS' });
  assert.equal(paid.ok, true);
  assert.equal(paid.payment.reconciled, false, 'money taken is not money confirmed');
  assert.equal(LHMS.actions.setPaymentReconciled(paid.payment.id, true).ok, true);
  assert.equal(LHMS.db.payments.find((p) => p.id === paid.payment.id).reconciled, true);

  as(LHMS, 'grace.mensah@aureliagrand.com');
  assert.equal(LHMS.actions.setPaymentReconciled(paid.payment.id, false).ok, false);
});

test('the seeded demo opens with documents in every state', () => {
  const LHMS = asManager();
  const statuses = LHMS.invoicesOf('agm').map((i) => LHMS.invoiceMoney(i).status);
  assert.ok(statuses.length >= 3);
  assert.ok(statuses.includes('Paid'), 'closed folios arrive already settled');
  assert.ok(statuses.includes('Unpaid'), 'a hall booking without a room account still needs invoicing');
  LHMS.invoicesOf('agm').forEach((i) => {
    const t = LHMS.invoiceMoney(i);
    assert.equal(t.total, Math.round(t.lines + t.adjustments));
    assert.ok(i.lines.every((l) => l.amount > 0), 'no line is a rounding artefact');
  });
});
