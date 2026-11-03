/**
 * Billing API — the document, the money against it, and the two gates
 * (a sealed day and a second signature) that decide whether a write happens.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays, DAY } = require("./helpers/api");

async function raisedInvoice(role = "Front Desk") {
  const ctx = await boot();
  const res = await ctx.as(role).post("/api/billing/invoices").send({ reservationId: "res_1" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { ...ctx, inv: res.body };
}

test("a folio invoice copies the unbilled charges and takes a group number", async () => {
  const { inv } = await raisedInvoice();
  assert.equal(inv.kind, "folio");
  assert.equal(inv.number, "AGM-INV-0001");
  assert.equal(inv.status, "Unpaid");
  assert.deepEqual(inv.totals, {
    lines: 218000, adjustments: 0, total: 218000, paid: 0, refunded: 0,
    settled: 0, balance: 218000, status: "Unpaid",
    // Nothing on this folio is foreign, so the money of account reads exactly
    // like the money the guest holds.
    base: {
      lines: 218000, adjustments: 0, total: 218000, paid: 0, refunded: 0,
      settled: 0, balance: 218000,
    },
  });
  assert.equal(inv.lines.length, 2);
});

test("the second raise finds nothing left to bill", async () => {
  const { as, inv } = await raisedInvoice();
  const again = await as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_1" });
  assert.equal(again.status, 422);
  assert.match(again.body.error, /already invoiced/);
  const listed = await as("Front Desk").get("/api/billing/invoices?propertyId=agm");
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].id, inv.id);
});

test("a payment above the balance is refused and an exact one settles", async () => {
  const { as, inv } = await raisedInvoice();
  const tooMuch = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`)
    .send({ amount: inv.totals.total + 1 });
  assert.equal(tooMuch.status, 422);
  assert.match(tooMuch.body.error, /is outstanding/);

  const paid = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`)
    .send({ amount: inv.totals.total, method: "Card" });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.totals.status, "Paid");
  assert.equal(paid.body.totals.balance, 0);
  assert.equal(paid.body.payment.receipt, `${inv.number}-1`);

  const doc = await as("Front Desk").get(`/api/billing/invoices/${inv.id}`);
  assert.equal(doc.body.status, "Paid");
});

test("a refund larger than the money actually received is refused", async () => {
  const { as, inv } = await raisedInvoice();
  await as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`).send({ amount: 100000 });
  const over = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/refunds`)
    .send({ amount: 150000, reason: "Guest left early" });
  assert.equal(over.status, 422);
  assert.match(over.body.error, /has actually been received/);
});

// The refund is inside the money on file but above the property's approval
// limit, and Front Desk cannot sign — so nothing moves and a request is opened.
// res_2 is the suite folio: 1,250,000 settled, so 600,000 clears the money test
// and fails the 500,000 limit test.
test("a gated refund queues a request without touching the ledger", async () => {
  const ctx = await boot();
  const raised = await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_2" });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  const inv = raised.body;
  const paid = await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`)
    .send({ amount: inv.totals.total });
  assert.equal(paid.status, 201);
  assert.equal(paid.body.totals.settled, 1250000);

  const r = await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/refunds`)
    .send({ amount: 600000, reason: "Sponsor asked for a concession" });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.queued.kind, "refund");
  assert.equal(r.body.queued.amount, 600000);

  const doc = await ctx.as("Front Desk").get(`/api/billing/invoices/${inv.id}`);
  assert.equal(doc.body.refunds.length, 0);
  assert.equal(doc.body.totals.status, "Paid");

  // The same request from someone who can sign moves immediately.
  const signed = await ctx.as("Manager").post(`/api/billing/invoices/${inv.id}/refunds`)
    .send({ amount: 600000, reason: "Sponsor asked for a concession" });
  assert.equal(signed.status, 201);
  assert.equal(signed.body.invoice.totals.status, "Partially paid");
});

test("a discount past the ceiling queues; one inside it applies", async () => {
  const { as, inv } = await raisedInvoice();
  const big = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/discounts`)
    .send({ amount: 50000, reason: "Partner concession" });
  assert.equal(big.status, 202);
  assert.equal(big.body.queued.kind, "discount");

  const small = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/discounts`)
    .send({ amount: 10000, reason: "Goodwill" });
  assert.equal(small.status, 201);
  assert.equal(small.body.invoice.totals.adjustments, -10000);
  assert.equal(small.body.invoice.totals.total, 208000);
});

test("a signed-off day refuses money", async () => {
  const { as, inv, query } = await raisedInvoice();
  await query(`INSERT INTO closed_days (date,rolled_to,closed_at,closed_by,stats)
               VALUES ($1,$2,now(),'Ifeoma Okafor','{}')`, [addDays(DAY, -1), DAY]);
  const r = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`)
    .send({ amount: 5000, date: addDays(DAY, -1) });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /closed and sealed/);

  const today = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`)
    .send({ amount: 5000 });
  assert.equal(today.status, 201);
});

test("a role without the billing right is refused before anything is read", async () => {
  const ctx = await boot();
  const r = await ctx.as("Revenue").post("/api/billing/invoices").send({ reservationId: "res_1" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /manage_billing/);
});

test("an invoice with money on file cannot be voided", async () => {
  const { as, inv, query } = await raisedInvoice();
  await as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`).send({ amount: 20000 });
  const v = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/void`).send({ reason: "Duplicate" });
  assert.equal(v.status, 422);
  assert.match(v.body.error, /Refund 20000 first/);

  const refund = await as("Manager").post(`/api/billing/invoices/${inv.id}/refunds`)
    .send({ amount: 20000, reason: "Reversing to void" });
  assert.equal(refund.status, 201);
  const v2 = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/void`).send({ reason: "Duplicate" });
  assert.equal(v2.status, 200);
  assert.equal(v2.body.invoice.status, "Void");

  // The void hands its lines back to the folio so a corrected document can go up.
  const carried = await query(`SELECT invoice_id FROM charges WHERE reservation_id='res_1'`);
  assert.deepEqual(carried.rows.map((c) => c.invoice_id), [null, null]);
});

test("a split moves lines and re-numbers, never duplicating a charge", async () => {
  const { as, inv, query } = await raisedInvoice();
  const s = await as("Front Desk").post(`/api/billing/invoices/${inv.id}/split`)
    .send({ indexes: [1] });
  assert.equal(s.status, 201);
  assert.equal(s.body.split.number, "AGM-INV-0002");
  assert.equal(s.body.original.lines.length, 1);
  assert.equal(s.body.split.lines.length, 1);
  assert.equal(s.body.original.totals.total, 200000);
  assert.equal(s.body.split.totals.total, 18000);

  const carried = await query(`SELECT id, invoice_id FROM charges WHERE reservation_id='res_1' ORDER BY id`);
  const bySplit = carried.rows.filter((c) => c.invoice_id === s.body.split.id);
  assert.equal(bySplit.length, 1);
  assert.equal(bySplit[0].invoice_id, s.body.split.id);
});

test("a manual document is numbered in the same series as a folio", async () => {
  const { inv, as } = await raisedInvoice();
  const m = await as("Manager").post("/api/billing/invoices").send({
    propertyId: "agm", notes: "Courtesy minibar on the closing night",
    lines: [{ description: "Minibar replenishment", amount: 45000 }],
  });
  assert.equal(m.status, 201);
  assert.equal(m.body.number, "AGM-INV-0002");
  assert.equal(m.body.kind, "manual");
  assert.equal(m.body.totals.total, 45000);
  assert.equal(inv.number, "AGM-INV-0001");
});

test("the ledger list filters, and never opens another property's book", async () => {
  const { as, inv, bearer, tokenFor } = await raisedInvoice();
  await as("Manager").post("/api/billing/invoices").send({
    propertyId: "agm", lines: [{ description: "Hall dressing for the awards night", amount: 250000 }],
  });

  const every = await as("Manager").get("/api/billing/invoices?propertyId=agm");
  assert.equal(every.body.length, 2);

  const unpaid = await as("Manager").get("/api/billing/invoices?propertyId=agm&status=Unpaid");
  assert.deepEqual(unpaid.body.map((i) => i.kind), ["manual", "folio"]); // newest document first

  const only = await as("Manager").get("/api/billing/invoices?propertyId=agm&kind=manual");
  assert.equal(only.body.length, 1);
  assert.equal(only.body[0].reservationId, null);

  const byStay = await as("Manager").get(`/api/billing/invoices?propertyId=agm&reservationId=res_1`);
  assert.deepEqual(byStay.body.map((i) => i.id), [inv.id]);

  // In the browser the session decides which property's money is on screen, so
  // naming another one in the query is a refusal, not a filter.
  const ikoyi = bearer(tokenFor("Front Desk", "ari"));
  const pried = await ikoyi.get("/api/billing/invoices?propertyId=agm");
  assert.equal(pried.status, 403);
  assert.match(pried.body.error, /not permitted/);
  const own = await ikoyi.get("/api/billing/invoices");
  assert.equal(own.body.length, 0);
});

test("the receipts list carries folio money and document money alike", async () => {
  const { as, inv } = await raisedInvoice();
  const doc = await as("Manager").post("/api/billing/invoices").send({
    propertyId: "agm", lines: [{ description: "Hall dressing for the awards night", amount: 250000 }],
  });
  await as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`).send({ amount: 118000, method: "Cash" });
  await as("Manager").post(`/api/billing/invoices/${doc.body.id}/payments`).send({ amount: 250000, method: "Transfer" });

  const all = await as("Manager").get("/api/billing/payments?propertyId=agm");
  assert.equal(all.status, 200);
  // Two seeded deposits, one part-payment on the folio, one settled document.
  assert.equal(all.body.length, 4);
  assert.deepEqual(all.body.map((p) => p.amount).sort((a, b) => b - a), [312500, 250000, 118000, 100000]);

  const onDoc = all.body.find((p) => p.invoiceId === doc.body.id);
  assert.equal(onDoc.receipt, `${doc.body.number}-1`);
  assert.equal(onDoc.reconciled, false);
  assert.equal(onDoc.takenBy, "Ifeoma Okafor");
  // The seeded deposits were taken against a folio, never a document.
  assert.equal(all.body.filter((p) => !p.invoiceId).length, 2);

  // Every payment in the list belongs to the property that was asked for.
  assert.deepEqual([...new Set(all.body.map((p) => p.method))].sort(),
    ["Bank transfer", "Card", "Cash", "Transfer"]);
});

test("a receipt is matched to the till, and un-matched, with the trail to say which", async () => {
  const { as } = await raisedInvoice();
  const on = await as("Front Desk").patch("/api/billing/payments/pay_1/reconcile").send({ reconciled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.reconciled, true);
  assert.equal(on.body.amount, 100000);

  const off = await as("Front Desk").patch("/api/billing/payments/pay_1/reconcile").send({ reconciled: false });
  assert.equal(off.body.reconciled, false);

  const missing = await as("Front Desk").patch("/api/billing/payments/pay_none/reconcile").send({ reconciled: true });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Payment not found/);

  const shape = await as("Front Desk").patch("/api/billing/payments/pay_1/reconcile").send({});
  assert.equal(shape.status, 422);

  // Housekeeping cleans rooms; it does not sign the till in or out.
  const blocked = await as("Housekeeping").patch("/api/billing/payments/pay_1/reconcile").send({ reconciled: true });
  assert.equal(blocked.status, 403);

  const trail = await as("Manager").get("/api/activity?propertyId=agm");
  assert.deepEqual(trail.body.filter((a) => a.entity === "folio").map((a) => a.action).sort(),
    ["reconciled a payment", "unmatched a payment"]);
});

test("refunds are listed against the document that carries them", async () => {
  const ctx = await boot();
  const raised = await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_2" });
  const inv = raised.body;
  await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`).send({ amount: inv.totals.total });
  const back = await ctx.as("Manager").post(`/api/billing/invoices/${inv.id}/refunds`)
    .send({ amount: 600000, reason: "Sponsor asked for a concession" });
  assert.equal(back.status, 201);

  const listed = await ctx.as("Manager").get("/api/billing/refunds?propertyId=agm");
  assert.equal(listed.body.length, 1);
  assert.equal(listed.body[0].amount, 600000);
  assert.equal(listed.body[0].invoiceId, inv.id);
  assert.equal(listed.body[0].reason, "Sponsor asked for a concession");
  assert.equal(listed.body[0].by, "Ifeoma Okafor");

  // A desk at another property never sees this one's money, and asking for
  // another property's refunds is refused before the query runs.
  const ikoyi = ctx.bearer(ctx.tokenFor("Front Desk", "ari"));
  const scoped = await ikoyi.get("/api/billing/refunds");
  assert.equal(scoped.body.length, 0);
  const pried = await ikoyi.get("/api/billing/refunds?propertyId=agm");
  assert.equal(pried.status, 403);
});
