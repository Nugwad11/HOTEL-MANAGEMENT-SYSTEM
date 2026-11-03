const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// §9 and §10: a setting is only real if an action reads it, and a limit is only
// real if a change crosses it and stops. Every test below asks the money to move
// and checks whether it moved, waited, or was refused — never what the page says.
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
const asFrontDesk = (LHMS) => as(LHMS, 'adamu.bello@aureliagrand.com');
const asFinance = () => loadApp('emeka.balogun@aureliagrand.com');

const PID = 'agm';
const SUITE = 'prc_ps_std';
const suiteRow = (LHMS) => LHMS.db.prices.find((r) => r.id === SUITE);
const historyLength = (LHMS) => LHMS.db.priceHistory.length;
// Objects built inside the sandbox are not the test's own objects, so they are
// compared as a line of figures rather than by identity.
const rulesLine = (LHMS, pid) => {
  const f = LHMS.financeSettings(pid);
  return [f.invoicePrefix, f.paymentDays, f.approvalAmount, f.discountPct].join('|');
};

function stay(LHMS) {
  return LHMS.db.reservations.find((r) => r.status === 'In-house' && r.propertyId === PID);
}

// A document raised here has two lines and a total the test controls, so a
// percentage of it is an exact figure rather than a guess about the seed, and a
// split has something to keep on each side.
function freshInvoice(LHMS, amount) {
  const res = stay(LHMS);
  LHMS.actions.postCharge(res.id, {
    description: 'Room charge — Presidential Suite', amount: amount || 1800000, department: 'Rooms',
    qty: 1, unitPrice: amount || 1800000, serviceId: 'svc_ps', priceId: SUITE, listId: 'pl_std', listName: 'Standard 2026'
  });
  LHMS.actions.postCharge(res.id, {
    description: 'Laundry — express', amount: 53200, department: 'Laundry', qty: 1, unitPrice: 53200
  });
  return LHMS.actions.raiseInvoice({ reservationId: res.id }).invoice;
}

test('the four money rules are read from the property, and a missing block falls back', () => {
  const LHMS = asManager();
  assert.equal(rulesLine(LHMS, PID), 'AGM|7|500000|10', 'the desk opens on the seeded rules');
  assert.equal(rulesLine(LHMS, 'nowhere'), rulesLine(LHMS, PID),
    'a property with no saved block is still priced by defaults, not by nothing');
});

test('a document takes its number and its due date from the settings', () => {
  const LHMS = asManager();
  const U = LHMS.util;
  const first = freshInvoice(LHMS);
  assert.match(first.number, /^AGM-INV-\d{4}$/, 'the seeded prefix numbers it');
  assert.equal(first.dueDate, U.addDays(first.date, 7), 'and the seeded terms date it');
  const raisedNumber = first.number;

  const saved = LHMS.actions.setFinanceSettings({ invoicePrefix: 'lagos 9', paymentDays: 14 });
  assert.equal(saved.ok, true);
  assert.equal(saved.settings.invoicePrefix, 'LAGOS9', 'a prefix is kept to what a document can carry');

  const second = freshInvoice(LHMS);
  assert.match(second.number, /^LAGOS9-INV-\d{4}$/, 'the next document follows the new rule');
  assert.equal(second.dueDate, U.addDays(second.date, 14), 'and is dated by them');
  assert.equal(LHMS.get.invoice(first.id).number, raisedNumber,
    'a document already raised keeps the number it was given');

  const split = LHMS.actions.splitInvoice(second.id, { indexes: [0] });
  assert.ok(split.ok, 'a split is still allowed on an unpaid document');
  assert.match(split.split.number, /^LAGOS9-INV-\d{4}$/, 'and it is numbered in the same series, not a stray one');
});

test('the settings refuse a figure that cannot be worked with', () => {
  const LHMS = asManager();
  assert.equal(LHMS.actions.setFinanceSettings({ paymentDays: 400 }).ok, false, 'no terms of a year');
  assert.equal(LHMS.actions.setFinanceSettings({ discountPct: -5 }).ok, false, 'no negative ceiling');
  assert.equal(LHMS.actions.setFinanceSettings({ invoicePrefix: ' · ' }).ok, false, 'no prefix of punctuation');
  assert.equal(LHMS.actions.setFinanceSettings({ paymentDays: 7 }).ok, false,
    'and a save that changes nothing is refused, not logged as a change');
  assert.equal(LHMS.db.settings[PID].finance.paymentDays, 7, 'the untouched rule is still the seeded one');
});

test('a price move over the limit waits for a second signature', () => {
  const LHMS = asRevenue();
  const was = suiteRow(LHMS).amount;
  const before = historyLength(LHMS);
  const res = LHMS.actions.setPrice(SUITE, { amount: was + 600000 }, 'Festive re-rate');

  assert.equal(res.ok, true, 'the request is accepted, not rejected');
  assert.ok(res.queued, 'and it arrives as a request');
  assert.equal(res.queued.kind, 'price');
  assert.equal(res.queued.amount, 600000, 'the figure on the request is the gap it opens');
  assert.equal(res.queued.from, was);
  assert.equal(res.queued.to, was + 600000);
  assert.equal(res.queued.status, 'Pending');
  assert.equal(res.queued.requestedBy, LHMS.session.name, 'the register records who asked');
  assert.equal(suiteRow(LHMS).amount, was, 'the price row is untouched until the second hand falls');
  assert.equal(historyLength(LHMS), before, 'and no history is written for a change that has not happened');
  assert.ok(LHMS.db.activity[0].detail.indexOf('awaiting a second signature') !== -1,
    'the trail says what is waiting, and why');

  const small = LHMS.actions.setPrice(SUITE, { amount: was + 100000 }, 'Shoulder-season trim');
  assert.equal(small.queued, undefined, 'the same role may move a price inside the limit alone');
  assert.equal(small.ok, true);
  assert.equal(suiteRow(LHMS).amount, was + 100000, 'and that change lands at once');
});

test('a cut of the same size is the same risk', () => {
  const LHMS = asRevenue();
  const was = suiteRow(LHMS).amount;
  const res = LHMS.actions.setPrice(SUITE, { amount: was - 600000 }, 'Loss-leader week');
  assert.ok(res.queued, 'a discount off the rate card is held as surely as a rise');
  assert.equal(res.queued.amount, 600000);
  assert.equal(suiteRow(LHMS).amount, was);
});

test('a manager holding the approving right needs no second signature', () => {
  const LHMS = asManager();
  const was = suiteRow(LHMS).amount;
  const res = LHMS.actions.setPrice(SUITE, { amount: was + 600000 }, 'Owner instruction');
  assert.equal(res.queued, undefined);
  assert.equal(suiteRow(LHMS).amount, was + 600000, 'the authority sits with the role, not with the amount');
});

test('a signed-off request is applied by the rules the desk would have met', () => {
  const LHMS = asManager();
  const before = historyLength(LHMS);
  const res = LHMS.actions.decideApproval('apr_seed_price', true, 'Agreed — the refurbishment pays for itself');

  assert.equal(res.ok, true);
  assert.equal(res.approval.status, 'Approved');
  assert.equal(res.approval.decidedBy, LHMS.session.name, 'the second hand is named');
  assert.equal(res.approval.decisionNote, 'Agreed — the refurbishment pays for itself');
  assert.equal(suiteRow(LHMS).amount, res.approval.to, 'and the price the approver read is the price on the row');
  assert.equal(historyLength(LHMS), before + 1, 'the applied change writes the same history entry any other would');
  assert.equal(LHMS.db.priceHistory[0].by, LHMS.session.name,
    'under the name of the one who signed, not the one who asked');
});

test('the person who asked cannot be the one who signs', () => {
  const LHMS = asManager();
  const was = suiteRow(LHMS).amount;
  LHMS.queueApproval({
    kind: 'price', subject: 'Self-raised request', subjectId: SUITE,
    change: { patch: { amount: was + 900000 }, reason: 'my own request' },
    amount: 900000, from: was, to: was + 900000, reason: 'my own request'
  });
  const mine = LHMS.db.approvals[0];
  assert.equal(mine.requestedBy, LHMS.session.name, 'this one the approver raised themselves');

  const res = LHMS.actions.decideApproval(mine.id, true, 'I agree with myself');
  assert.equal(res.ok, false, 'a request is refused while its author holds the pen');
  assert.match(res.error, /second pair of hands/i);
  assert.equal(suiteRow(LHMS).amount, was, 'and nothing moved');

  assert.equal(LHMS.actions.decideApproval('apr_seed_price', true, 'Checked against the comp set').ok, true,
    'the same hands may clear the request the revenue desk raised');
  assert.equal(suiteRow(LHMS).amount, LHMS.db.approvals.find((a) => a.id === 'apr_seed_price').to);
});

test('a request without a note, or decided twice, is refused', () => {
  const LHMS = asManager();
  assert.equal(LHMS.actions.decideApproval('apr_seed_discount', true, '').ok, false, 'a blank note is refused');
  assert.match(LHMS.actions.decideApproval('apr_seed_discount', true, '').error, /audit trail/i);
  assert.equal(LHMS.actions.decideApproval('apr_seed_discount', true, 'Concession agreed with the sponsor').ok, true);
  const twice = LHMS.actions.decideApproval('apr_seed_discount', true, 'again');
  assert.equal(twice.ok, false, 'and a closed request cannot be reopened');
  assert.match(twice.error, /already approved/i);
});

test('a price that moved while the request waited is refused, not forced through', () => {
  const LHMS = asManager();
  const was = suiteRow(LHMS).amount;
  LHMS.actions.setPrice(SUITE, { amount: was + 100000 }, 'Interim trim');
  const res = LHMS.actions.decideApproval('apr_seed_price', true, 'Signing the old request');
  assert.equal(res.ok, false, 'the row no longer matches the figure the approver read');
  assert.match(res.error, /has moved since/i);
  assert.equal(suiteRow(LHMS).amount, was + 100000, 'so the later change stands and the stale one does not');
  assert.equal(suiteRow(LHMS).updatedBy, LHMS.session.name);
});

test('a rejected request changes nothing but its own status', () => {
  const LHMS = asManager();
  const was = suiteRow(LHMS).amount;
  const before = historyLength(LHMS);
  const res = LHMS.actions.decideApproval('apr_seed_price', false, 'Too far ahead of the comp set — hold at the current rate');
  assert.equal(res.ok, true);
  assert.equal(res.approval.status, 'Rejected');
  assert.equal(suiteRow(LHMS).amount, was, 'the rate card is exactly as it was');
  assert.equal(historyLength(LHMS), before, 'and no price history is written for a change that never happened');
});

test('a discount past the ceiling waits, one under it lands', () => {
  const LHMS = asManager();
  const inv = freshInvoice(LHMS);
  asFrontDesk(LHMS);
  const t = LHMS.invoiceMoney(LHMS.get.invoice(inv.id));
  const twenty = Math.round(t.total * 0.2);
  const five = Math.round(t.total * 0.05);

  const big = LHMS.actions.discountInvoice(inv.id, { amount: twenty, reason: 'Partner concession' });
  assert.ok(big.queued, '20% of a document is more than the desk gives alone');
  assert.equal(big.queued.kind, 'discount');
  assert.equal(LHMS.get.invoice(inv.id).adjustments.length, 0, 'the document keeps no trace of an unagreed cut');
  assert.equal(LHMS.invoiceMoney(LHMS.get.invoice(inv.id)).total, t.total, 'and its total is unchanged');

  const small = LHMS.actions.discountInvoice(inv.id, { amount: five, reason: 'Loyalty gesture' });
  assert.equal(small.queued, undefined, '5% sits under the ceiling and is applied at once');
  assert.equal(small.ok, true);
  assert.equal(LHMS.get.invoice(inv.id).adjustments.length, 1);

  as(LHMS, 'ifeoma.okafor@aureliagrand.com');
  const ok = LHMS.actions.decideApproval(big.queued.id, true, 'The concession is honoured');
  assert.equal(ok.ok, true, 'the controller clears the request the desk raised');
  assert.equal(LHMS.get.invoice(inv.id).adjustments.length, 2, 'and only then does the document carry it');
  assert.equal(LHMS.invoiceMoney(LHMS.get.invoice(inv.id)).total, t.total - twenty - five, 'both cuts reach the total');
});

test('an approval is re-checked against the ledger before it moves money', () => {
  const LHMS = asManager();
  const held = freshInvoice(LHMS, 2400000);
  LHMS.actions.payInvoice(held.id, { amount: LHMS.invoiceMoney(held).balance, method: 'Transfer' });
  const paid = LHMS.invoiceMoney(LHMS.get.invoice(held.id)).settled;

  asFrontDesk(LHMS);
  const res = LHMS.actions.refundInvoice(held.id, { amount: paid, reason: 'Guest billed twice' });
  assert.ok(res.queued, 'handing back a whole document is a two-signature act');
  assert.equal(res.queued.kind, 'refund');
  assert.equal(LHMS.db.refunds.filter((r) => r.invoiceId === held.id).length, 0, 'no money has left yet');

  const small = LHMS.actions.refundInvoice(held.id, { amount: 50000, reason: 'Minibar correction' });
  assert.equal(small.ok, true, 'a correction inside the limit is issued at once');
  assert.equal(small.queued, undefined);

  as(LHMS, 'ifeoma.okafor@aureliagrand.com');
  const late = LHMS.actions.decideApproval(res.queued.id, true, 'Confirmed duplicate receipt');
  assert.equal(late.ok, false, 'and by sign-off the document cannot return what it no longer holds');
  assert.match(late.error, /less than this refund/i);
  assert.equal(LHMS.db.refunds.filter((r) => r.invoiceId === held.id).length, 1, 'the held request issued nothing');
});

test('an approved refund moves the money at the moment it is signed', () => {
  const LHMS = asManager();
  const inv = freshInvoice(LHMS, 2400000);
  LHMS.actions.payInvoice(inv.id, { amount: LHMS.invoiceMoney(inv).balance, method: 'Transfer' });
  const paid = LHMS.invoiceMoney(LHMS.get.invoice(inv.id)).settled;

  asFrontDesk(LHMS);
  const res = LHMS.actions.refundInvoice(inv.id, { amount: paid, reason: 'The whole stay was double-charged' });
  assert.ok(res.queued);

  as(LHMS, 'ifeoma.okafor@aureliagrand.com');
  const ok = LHMS.actions.decideApproval(res.queued.id, true, 'Duplicate receipt confirmed with the bank');
  assert.equal(ok.ok, true);
  const onDoc = LHMS.db.refunds.filter((r) => r.invoiceId === inv.id);
  assert.equal(onDoc.length, 1, 'the held refund is the only one on the document');
  assert.equal(onDoc[0].amount, paid);
  assert.equal(LHMS.invoiceMoney(LHMS.get.invoice(inv.id)).settled, 0, 'and the document is settled back to nothing');
});

test('a document voided while its request waited cannot be adjusted', () => {
  const LHMS = asManager();
  const inv = freshInvoice(LHMS);
  asFrontDesk(LHMS);
  const held = LHMS.actions.discountInvoice(inv.id, {
    amount: Math.round(LHMS.invoiceMoney(inv).total * 0.5), reason: 'Half back'
  });
  assert.ok(held.queued);
  LHMS.actions.voidInvoice(inv.id, { reason: 'Raised against the wrong folio' });
  as(LHMS, 'ifeoma.okafor@aureliagrand.com');
  const res = LHMS.actions.decideApproval(held.queued.id, true, 'Signing anyway');
  assert.equal(res.ok, false, 'the approver cannot sign a change onto a cancelled document');
  assert.match(res.error, /voided while this waited/i);
});

test('the queue opens on the work and keeps decisions behind it', () => {
  const LHMS = asManager();
  assert.equal(LHMS.approvals().length, 2, 'the seed opens with two things waiting');
  assert.equal(LHMS.approvals().map((a) => a.status).join(','), 'Pending,Pending');
  LHMS.actions.decideApproval('apr_seed_price', false, 'Hold');
  const list = LHMS.approvals();
  assert.equal(list.length, 2);
  assert.equal(list[0].status, 'Pending', 'the pending request comes first whatever the order of events');
  assert.equal(list[1].status, 'Rejected');
  assert.equal(LHMS.approvals('Pending').length, 1, 'and the page can ask for one side of the register');
  assert.equal(LHMS.approvals().every((a) => a.propertyId === PID), true, 'no other property bleeds into this queue');
});

test('a held change is described as held, not as saved', () => {
  const LHMS = asRevenue();
  const was = suiteRow(LHMS).amount;
  const res = LHMS.actions.setPrice(SUITE, { amount: was + 600000 }, 'Festive re-rate');
  const held = LHMS.outcome(res, 'Saved and audited.');
  assert.equal(held.kind, 'queued');
  assert.doesNotMatch(held.text, /saved/i, 'the desk is never told a change landed when it did not');
  assert.match(held.text, /second signature/i);
  const applied = LHMS.outcome({ ok: true, price: suiteRow(LHMS) }, 'Saved and audited.');
  assert.equal(applied.kind, 'applied');
  assert.equal(applied.text, 'Saved and audited.');
});

test('an auditor reads the figures and moves none of them', () => {
  const LHMS = asAuditor();
  assert.equal(LHMS.can('view_reports'), true, 'the right to look is the whole of the role');
  assert.equal(LHMS.can('configure_prices'), false);
  assert.equal(LHMS.can('manage_billing'), false);
  assert.equal(LHMS.can('manage_financial_settings'), false);
  assert.equal(LHMS.can('approve_financial_changes'), false);
  assert.equal(LHMS.session.role, 'Auditor');

  const statement = LHMS.report('dept-revenue', 30);
  assert.ok(statement.rows.length, 'and the reports open to them');

  const was = suiteRow(LHMS).amount;
  assert.equal(LHMS.actions.setPrice(SUITE, { amount: was + 10000 }, 'read-only').ok, false);
  assert.equal(LHMS.actions.setFinanceSettings({ paymentDays: 30 }).ok, false);
  assert.equal(LHMS.actions.decideApproval('apr_seed_price', true, 'as auditor').ok, false);
  assert.equal(LHMS.approvals('Pending').length, 2, 'the register is still waiting for the people who may clear it');
  assert.equal(suiteRow(LHMS).amount, was);
  assert.equal(LHMS.db.settings[PID].finance.paymentDays, 7, 'nothing the auditor touched moved');
});

test('a role cannot widen its own limits', () => {
  const LHMS = asRevenue();
  const res = LHMS.actions.setFinanceSettings({ approvalAmount: 50000000 });
  assert.equal(res.ok, false, 'the revenue desk prices but does not set who has to be cleared');
  assert.equal(LHMS.financeSettings(PID).approvalAmount, 500000, 'the limit is the one it was seeded with');
  const was = suiteRow(LHMS).amount;
  assert.ok(LHMS.actions.setPrice(SUITE, { amount: was + 600000 }, 'after my own limit').queued,
    'and the change still waits, because the setting was never lowered by them');
});

/* ── the Financial Controller: the second pair of hands, and nothing else ── */

test('the controller holds the signature and none of the asks', () => {
  const LHMS = asFinance();
  assert.equal(LHMS.session.role, 'Finance Manager', 'a named person in the books, not a permission slip');
  assert.equal(LHMS.session.name, 'Emeka Balogun');

  for (const held of ['manage_billing', 'approve_expenses', 'manage_financial_settings',
    'approve_financial_changes', 'view_reports']) {
    assert.equal(LHMS.can(held), true, `the controller should hold ${held}`);
  }
  for (const refused of ['configure_prices', 'manage_rates', 'record_expenses', 'post_charges',
    'take_payments', 'check_in_out', 'book_events', 'run_laundry', 'manage_staff', 'night_audit']) {
    assert.equal(LHMS.can(refused), false, `the second hand must not hold ${refused}`);
  }

  // The two rights are different things: to sign, and to cross a limit alone.
  assert.equal(LHMS.canApproveFinancial(), true);
  assert.equal(LHMS.movesMoneyAlone(), false, 'and their own wide move still waits');
  assert.equal(asManager().movesMoneyAlone(), true, 'the General Manager answers for the estate alone');

  assert.equal(LHMS.actions.setPermission('Finance Manager', 'record_expenses', true).ok, false,
    'the separation is fixed, not a checkbox on the matrix');
});

test('the controller clears the ask the revenue desk raised', () => {
  const LHMS = asRevenue();
  const was = suiteRow(LHMS).amount;
  const res = LHMS.actions.setPrice(SUITE, { amount: was + 600000 }, 'Festive re-rate');
  assert.ok(res.queued, 'the desk owes a second signature');

  asFrontDesk(LHMS);
  const desk = LHMS.actions.decideApproval(res.queued.id, true, 'I can sign it now');
  assert.equal(desk.ok, false, 'a hand without the signing right is turned away at the door');
  assert.match(desk.error, /cannot sign off/i);

  as(LHMS, 'emeka.balogun@aureliagrand.com');
  const signed = LHMS.actions.decideApproval(res.queued.id, true, 'Checked against the comp set before signing');
  assert.equal(signed.ok, true, JSON.stringify(signed.error));
  assert.equal(signed.approval.decidedBy, 'Emeka Balogun');
  assert.equal(suiteRow(LHMS).amount, was + 600000, 'and the row moves under their name');
  assert.equal(LHMS.db.priceHistory[0].by, 'Emeka Balogun', 'the history carries the signer, not the asker');
});

test('a wide refund the controller asks for waits for a hand that is not theirs', () => {
  const LHMS = asManager();
  const inv = freshInvoice(LHMS, 2400000);
  LHMS.actions.payInvoice(inv.id, { amount: LHMS.invoiceMoney(inv).balance, method: 'Transfer' });
  const paid = LHMS.invoiceMoney(LHMS.get.invoice(inv.id)).settled;

  as(LHMS, 'emeka.balogun@aureliagrand.com');
  const held = LHMS.actions.refundInvoice(inv.id, { amount: paid, reason: 'Sponsor billed twice' });
  assert.ok(held.queued, 'holding the signing right is not a licence to hand money back alone');
  assert.equal(held.queued.requestedBy, 'Emeka Balogun');

  const own = LHMS.actions.decideApproval(held.queued.id, true, 'I asked and I agree');
  assert.equal(own.ok, false);
  assert.match(own.error, /second pair of hands/i);
  assert.equal(LHMS.db.refunds.filter((r) => r.invoiceId === inv.id).length, 0, 'nothing left the till yet');

  as(LHMS, 'ifeoma.okafor@aureliagrand.com');
  const cleared = LHMS.actions.decideApproval(held.queued.id, true, 'Duplicate receipt confirmed with the bank');
  assert.equal(cleared.ok, true);
  assert.equal(LHMS.db.refunds.filter((r) => r.invoiceId === inv.id).length, 1);
});

test('the controller keeps the ledger without recording, pricing, ordering or sealing it', () => {
  const LHMS = asFinance();
  const was = suiteRow(LHMS).amount;
  assert.equal(LHMS.actions.setPrice(SUITE, { amount: was + 50000 }, 'my own rate').ok, false,
    'they clear a price ask; they do not raise one');
  assert.equal(suiteRow(LHMS).amount, was);

  assert.equal(LHMS.actions.addExpense({ category: 'Utilities', amount: 20000, description: 'Diesel' }).ok, false,
    'the cost they approve is one another hand recorded');

  // The folio line itself is a primitive the point-of-sale, events and laundry
  // flows all write through, so it carries no role check; the doors a person
  // opens are guarded, and the controller opens none of these.
  assert.equal(LHMS.actions.createLaundryOrder({
    reservationId: stay(LHMS).id, items: [{ serviceId: 'svc_lnd_press', qty: 1 }]
  }).ok, false, 'the boards belong to the rooms, not to the ledger');

  assert.equal(LHMS.actions.runNightAudit({ checks: { all: true } }).ok, false,
    'the day is closed by the manager, not by the signer');

  // What the role is for: a cost in, a figure read, a limit moved.
  as(LHMS, 'grace.mensah@aureliagrand.com');
  const raised = LHMS.actions.addExpense({
    category: 'Utilities', amount: 145000, description: 'Diesel for the generator', payee: 'Indastar'
  });
  assert.equal(raised.ok, true, JSON.stringify(raised.error));

  as(LHMS, 'emeka.balogun@aureliagrand.com');
  const decided = LHMS.actions.decideExpense(raised.expense.id, true, 'Matched to the fuel log');
  assert.equal(decided.ok, true, JSON.stringify(decided.error));
  assert.equal(decided.expense.decidedBy, 'Emeka Balogun');
  assert.equal(LHMS.report('dept-revenue', 30).rows.length > 0, true, 'and the reports open to them');

  const widened = LHMS.actions.setFinanceSettings({ approvalAmount: 750000 });
  assert.equal(widened.ok, true, 'the limit is theirs to set');
  const after = LHMS.actions.setFxRate({ code: 'USD', perBase: 1600, note: 'Treasury line for today' });
  assert.ok(after.queued, 'but a rate that revalues every foreign figure still waits for the manager');
});

/* ---------------- the commercial policies and the connections ---------------- */

const policyLines = (LHMS, entity) =>
  LHMS.db.activity.filter((a) => a.entity === entity);

test('the policies a stay is booked under move the figures that moved and sign them', () => {
  const LHMS = asManager();
  const before = LHMS.get.settings(PID);
  assert.equal([before.depositPct, before.checkInTime, before.checkOutTime, before.overbooking].join('|'),
    '25|15:00|12:00|2', 'the desk opens on the seeded policies');

  const saved = LHMS.actions.saveSettings(PID, {
    depositPct: 30, checkInTime: '14:00', checkOutTime: '11:00',
    currency: 'NGN', language: 'French', overbooking: 0,
    cancellation: 'Free cancellation until 72 hours before arrival.'
  });
  assert.equal(saved.ok, true, JSON.stringify(saved.error));

  // The money of account was posted back unchanged, so it is not in the line:
  // a trail that names a figure which held is a trail nobody can trust.
  assert.equal(saved.changed.join(' · '), [
    'deposit 25% → 30%',
    'check-in 15:00 → 14:00',
    'check-out 12:00 → 11:00',
    'language English (UK) → French',
    'overbooking allowance 2 → 0',
    'cancellation "Free cancellation up to 48 hours before arrival. One night charged thereafter." → "Free cancellation until 72 hours before arrival."'
  ].join(' · '));
  const after = LHMS.get.settings(PID);
  assert.equal(after.depositPct, 30);
  assert.equal(after.checkInTime, '14:00');
  assert.equal(after.checkOutTime, '11:00');
  assert.equal(after.language, 'French');
  assert.equal(after.overbooking, 0);
  assert.equal(after.cancellation, 'Free cancellation until 72 hours before arrival.');
  assert.equal(after.currency, 'NGN', 'the money of account is not a policy an editor moves by accident');

  const line = policyLines(LHMS, 'settings')[0];
  assert.equal(line.action, 'updated hotel settings');
  assert.equal(line.actor, LHMS.session.name);
  assert.equal(line.detail, LHMS.get.property(PID).name + ' · ' + saved.changed.join(' · '));

  // The page posts its whole form back, so a save that moves nothing says so in
  // the trail rather than naming figures that held.
  const again = LHMS.actions.saveSettings(PID, {
    depositPct: 30, checkInTime: '14:00', checkOutTime: '11:00',
    currency: 'NGN', language: 'French', overbooking: 0,
    cancellation: 'Free cancellation until 72 hours before arrival.'
  });
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.equal(again.changed.length, 0);
  assert.equal(policyLines(LHMS, 'settings')[0].detail,
    LHMS.get.property(PID).name + ' · nothing moved');
});

test('a policy the form would not accept is refused before it reaches the settings', () => {
  const LHMS = asManager();
  const untouched = JSON.stringify(LHMS.get.settings(PID));
  const wrote = policyLines(LHMS, 'settings').length;

  const cases = [
    [{ depositPct: 25.5 }, 'A deposit is a whole percentage.'],
    [{ depositPct: -5 }, 'A deposit cannot be negative.'],
    [{ depositPct: 120 }, 'A deposit cannot be more than the stay.'],
    [{ overbooking: 1.5 }, 'An overbooking allowance is a whole room.'],
    [{ overbooking: -1 }, 'An allowance cannot be negative.'],
    [{ overbooking: 11 }, 'Ten rooms is the most an allowance may hold.'],
    [{ checkInTime: '3pm' }, 'Arrival and departure times are written as HH:MM.'],
    [{ checkOutTime: '25:00' }, 'Arrival and departure times are written as HH:MM.'],
    [{ currency: 'JPY' }, 'This property holds money in ' + LHMS.fx.codes.join(', ') + '. JPY is not among them.'],
    [{ language: 'Yoruba' }, 'The desk writes in English (UK), English (US) or French.'],
    [{ cancellation: '   ' }, 'Write the cancellation terms the guest is shown.'],
    [{ cancellation: 'x'.repeat(401) }, 'The cancellation terms have to fit on the confirmation.'],
    [{ integrations: { crm: false } }, 'The policies form does not carry integrations.'],
    [{}, 'Nothing to update.'],
  ];
  cases.forEach(([patch, error]) => {
    const refused = LHMS.actions.saveSettings(PID, patch);
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(refused.error, error);
  });

  assert.equal(JSON.stringify(LHMS.get.settings(PID)), untouched, 'every refusal left the row alone');
  assert.equal(policyLines(LHMS, 'settings').length, wrote, 'and none of them reached the trail');
});

test('a connection is flipped for a service the register knows and signed either way', () => {
  const LHMS = asManager();
  const wrote = policyLines(LHMS, 'integration').length;
  assert.equal(LHMS.get.settings(PID).integrations.crm, true, 'the seeded book has the CRM on');

  const off = LHMS.actions.toggleIntegration(PID, 'crm');
  assert.equal(off.ok, true, JSON.stringify(off.error));
  assert.equal(off.connected, false);
  assert.equal(off.integrations.crm, false);
  assert.equal(LHMS.get.settings(PID).integrations.crm, false);
  assert.equal(policyLines(LHMS, 'integration')[0].action, 'disconnected an integration');
  assert.equal(policyLines(LHMS, 'integration')[0].detail, 'crm');

  const on = LHMS.actions.toggleIntegration(PID, 'crm');
  assert.equal(on.connected, true);
  assert.equal(policyLines(LHMS, 'integration')[0].action, 'connected an integration');

  // A key nobody authored is not a service the hotel has, so the register does
  // not remember it: a page can only ask about the six it shows.
  const ghost = LHMS.actions.toggleIntegration(PID, 'satellitePhone');
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error, 'That service is not on the integration register.');
  assert.equal(LHMS.get.settings(PID).integrations.satellitePhone, undefined,
    'the refusal wrote no key');
  assert.equal(policyLines(LHMS, 'integration').length, wrote + 2,
    'and a refusal leaves no trail line either');
});
