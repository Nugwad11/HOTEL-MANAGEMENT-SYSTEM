/**
 * The approvals register — who may hold a change, who may sign it, and what an
 * approval actually writes when it lands.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, USERS } = require("./helpers/api");
const { sign } = require("../src/lib/jwt");

async function gatedPriceRequest(role = "Revenue") {
  const ctx = await boot();
  const r = await ctx.as(role).patch("/api/pricing/prices/prc_dk_std")
    .send({ amount: 900000, reason: "Festive demand on deluxe" });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  return { ...ctx, queued: r.body.queued };
}

const priceAmount = async (query) => {
  const { rows } = await query(`SELECT amount FROM prices WHERE id = 'prc_dk_std'`);
  return Number(rows[0].amount);
};

test("a price move over the limit is held, and the row keeps the old rate", async () => {
  const { queued, query } = await gatedPriceRequest();
  assert.equal(queued.kind, "price");
  assert.equal(queued.amount, 700000);
  assert.equal(queued.from, 200000);
  assert.equal(queued.to, 900000);
  assert.equal(await priceAmount(query), 200000);
});

test("the person who raised a request cannot be the one who signs it", async () => {
  const ctx = await boot();
  const raised = await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_2" });
  await ctx.as("Front Desk").post(`/api/billing/invoices/${raised.body.id}/payments`).send({ amount: 1250000 });
  const held = await ctx.as("Front Desk").post(`/api/billing/invoices/${raised.body.id}/refunds`)
    .send({ amount: 600000, reason: "Sponsor asked for a concession" });
  assert.equal(held.status, 202);

  // A wider grant for the same human is still the same hands on both sides.
  const signedTwice = sign(Object.assign(
    {}, USERS["Front Desk"], { role: "Front Desk", propertyId: "agm", guestId: null,
      permissions: { approve_financial_changes: true } }));
  const own = await ctx.bearer(signedTwice).post(`/api/approvals/${held.body.queued.id}/decide`)
    .send({ approve: true, note: "I hold the right now" });
  assert.equal(own.status, 422, JSON.stringify(own.body));
  assert.match(own.body.error, /second pair of hands/);

  const noteless = await ctx.as("Manager").post(`/api/approvals/${held.body.queued.id}/decide`)
    .send({ approve: true });
  assert.equal(noteless.status, 422);
  assert.match(noteless.body.error, /needs a note/);
});

test("a second signature applies the patch and writes the same history", async () => {
  const { as, queued, query } = await gatedPriceRequest();
  const decided = await as("Manager").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: true, note: "Verified against the festive compset" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.approval.status, "Approved");
  assert.equal(decided.body.approval.decidedBy, "Ifeoma Okafor");
  assert.equal(await priceAmount(query), 900000);

  const { rows } = await query(`SELECT reason, recorded_by FROM price_history WHERE price_id = 'prc_dk_std'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "Festive demand on deluxe");
  assert.equal(rows[0].recorded_by, "Ifeoma Okafor");
});

test("a rate that moved while the request waited goes back to the front of the queue", async () => {
  const { as, queued, query } = await gatedPriceRequest();
  const moved = await as("Manager").patch("/api/pricing/prices/prc_dk_std")
    .send({ amount: 300000, reason: "Mid-year repricing" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  const decided = await as("Manager").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: true, note: "Still worth doing" });
  assert.equal(decided.status, 422);
  assert.match(decided.body.error, /has moved since this was asked/);
  assert.equal(await priceAmount(query), 300000);
});

test("an approved refund lands on the invoice exactly as an ungated one would", async () => {
  const ctx = await boot();
  const raised = await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_2" });
  const inv = raised.body;
  await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`).send({ amount: 1250000 });
  const held = await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/refunds`)
    .send({ amount: 600000, reason: "Sponsor asked for a concession" });
  assert.equal(held.status, 202);

  const decided = await ctx.as("Manager").post(`/api/approvals/${held.body.queued.id}/decide`)
    .send({ approve: true, note: "Approved by GM" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.applied.totals.settled, 650000);
  assert.equal(decided.body.applied.totals.status, "Partially paid");

  const doc = await ctx.as("Front Desk").get(`/api/billing/invoices/${inv.id}`);
  assert.equal(doc.body.refunds.length, 1);
  assert.equal(doc.body.refunds[0].by, "Ifeoma Okafor");
});

test("a rejected request leaves the ledger untouched", async () => {
  const { as, queued, query } = await gatedPriceRequest();
  const decided = await as("Manager").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: false, note: "Compset does not support it" });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.approval.status, "Rejected");
  assert.equal(decided.body.approval.decisionNote, "Compset does not support it");
  assert.equal(await priceAmount(query), 200000);
});

test("a role without the right to sign is turned away before the register is read", async () => {
  const { as, queued } = await gatedPriceRequest();
  const probe = await as("Auditor").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: true, note: "Looking" });
  assert.equal(probe.status, 403);
  assert.match(probe.body.error, /approve_financial_changes/);
});

test("the queue opens on pending work and answers for the property named", async () => {
  const { as, queued } = await gatedPriceRequest();
  const list = await as("Manager").get("/api/approvals?propertyId=agm");
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].id, queued.id);
  assert.equal(list.body[0].status, "Pending");

  const other = await as("Manager").get("/api/approvals?propertyId=ari");
  assert.equal(other.body.length, 0);
});

test("one request reads back whole, and only to its own property", async () => {
  const ctx = await gatedPriceRequest();
  const one = await ctx.as("Revenue").get(`/api/approvals/${ctx.queued.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.id, ctx.queued.id);
  assert.equal(one.body.status, "Pending");
  assert.equal(one.body.requestedBy, "Chiamaka Obi");
  assert.equal(one.body.reason, "Festive demand on deluxe");
  // The payload the desk was refused is stored verbatim, so signing it applies
  // that exact change rather than whatever the queue page shows.
  assert.equal(one.body.change.patch.amount, 900000);
  assert.equal(one.body.decidedBy, null);

  const missing = await ctx.as("Manager").get("/api/approvals/apr_nobody");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /not in the register/);

  // A desk at another property cannot even read the request across.
  const ikoyi = ctx.bearer(ctx.tokenFor("Front Desk", "ari"));
  const pried = await ikoyi.get(`/api/approvals/${ctx.queued.id}`);
  assert.equal(pried.status, 403);
  assert.match(pried.body.error, /not permitted/);
});

test("a request only closes once", async () => {
  const { as, queued } = await gatedPriceRequest();
  const first = await as("Manager").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: true, note: "Agreed" });
  assert.equal(first.status, 200);
  const second = await as("Manager").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: false, note: "Changed my mind" });
  assert.equal(second.status, 422);
  assert.match(second.body.error, /already approved/);
});

/* ── the Finance Manager: the second hand, and nothing else ── */

test("the controller clears an ask the desk cannot, and the row moves with it", async () => {
  const { as, queued, query } = await gatedPriceRequest();

  // A desk with the ledger but without the signing right cannot clear it either.
  const refused = await as("Front Desk").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: true, note: "I can sign it now" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /approve_financial_changes/);

  const decided = await as("Finance Manager").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: true, note: "Checked against the compset before signing" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.approval.decidedBy, "Emeka Balogun");
  assert.equal(await priceAmount(query), 900000);

  const { rows } = await query(`SELECT recorded_by FROM price_history WHERE price_id = 'prc_dk_std'`);
  assert.equal(rows[0].recorded_by, "Emeka Balogun", "the history carries the signer, not the asker");
});

test("a wide move the controller asks for still waits for a hand that is not theirs", async () => {
  const ctx = await boot();
  const raised = await ctx.as("Finance Manager").post("/api/billing/invoices").send({ reservationId: "res_2" });
  const inv = raised.body;
  await ctx.as("Finance Manager").post(`/api/billing/invoices/${inv.id}/payments`).send({ amount: 1250000 });

  // Holding the signing right is not a licence to hand back money on one's own
  // word: the ask goes in the queue like anybody else's.
  const held = await ctx.as("Finance Manager").post(`/api/billing/invoices/${inv.id}/refunds`)
    .send({ amount: 600000, reason: "Sponsor billed twice" });
  assert.equal(held.status, 202, JSON.stringify(held.body));
  assert.equal(held.body.queued.requestedBy, "Emeka Balogun");

  const own = await ctx.as("Finance Manager").post(`/api/approvals/${held.body.queued.id}/decide`)
    .send({ approve: true, note: "I asked and I agree" });
  assert.equal(own.status, 422, JSON.stringify(own.body));
  assert.match(own.body.error, /second pair of hands/);
  const waiting = await ctx.query(`SELECT COUNT(*)::int AS n FROM refunds WHERE invoice_id = $1`, [inv.id]);
  assert.equal(waiting.rows[0].n, 0, "and no money has left while it waits");

  const cleared = await ctx.as("Manager").post(`/api/approvals/${held.body.queued.id}/decide`)
    .send({ approve: true, note: "Duplicate receipt confirmed with the bank" });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.applied.totals.settled, 650000);
});

test("the controller signs money but sells, prices, costs and seals nothing", async () => {
  const { as } = await boot();
  const price = await as("Finance Manager").patch("/api/pricing/prices/prc_dk_std")
    .send({ amount: 900000, reason: "Festive demand on deluxe" });
  assert.equal(price.status, 403);
  assert.match(price.body.error, /configure_prices/, "they clear a price ask; they do not raise one");

  const cost = await as("Finance Manager").post("/api/finance/expenses")
    .send({ category: "Utilities", amount: 145000, description: "Diesel for the generator" });
  assert.equal(cost.status, 403);
  assert.match(cost.body.error, /record_expenses/, "the cost they approve is one another hand recorded");

  const charge = await as("Finance Manager").post("/api/reservations/res_1/charges")
    .send({ description: "Room charge · Deluxe King", department: "Rooms", amount: 200000 });
  assert.equal(charge.status, 403);
  assert.match(charge.body.error, /post_charges/);

  const laundry = await as("Finance Manager").post("/api/laundry").send({ reservationId: "res_1" });
  assert.equal(laundry.status, 403);
  assert.match(laundry.body.error, /run_laundry/, "the boards belong to the rooms, not to the ledger");

  const sealed = await as("Finance Manager").post("/api/audit/run").send({ propertyId: "agm" });
  assert.equal(sealed.status, 403);
  assert.match(sealed.body.error, /night_audit/, "the day is closed by the manager, not by the signer");
});

test("the ledger the controller keeps: a cost in, a figure read, a limit moved", async () => {
  const ctx = await boot();
  const recorded = await ctx.as("Housekeeping").post("/api/finance/expenses").send({
    category: "Utilities", amount: 145000, description: "Diesel for the generator", payee: "Indastar",
  });
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));

  const decided = await ctx.as("Finance Manager").post(`/api/finance/expenses/${recorded.body.id}/decide`)
    .send({ approve: true, note: "Matched to the fuel log" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.decidedBy, "Emeka Balogun");

  // Signed for, so it is a cost the statement counts.
  const statement = await ctx.as("Finance Manager").get("/api/finance/statement?propertyId=agm&days=30");
  assert.equal(statement.status, 200);
  assert.equal(statement.body.now.expenses, 145000);

  const settings = await ctx.as("Finance Manager").patch("/api/finance/settings")
    .send({ propertyId: "agm", approvalAmount: 750000 });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
  assert.deepEqual(settings.body.changed, ["approval limit 500000 to 750000"]);

  // But a wider limit does not let them cross it alone — the ask still waits.
  const raised = await ctx.as("Finance Manager").post("/api/billing/invoices").send({ reservationId: "res_2" });
  await ctx.as("Finance Manager").post(`/api/billing/invoices/${raised.body.id}/payments`).send({ amount: 1250000 });
  const held = await ctx.as("Finance Manager").post(`/api/billing/invoices/${raised.body.id}/refunds`)
    .send({ amount: 800000, reason: "The whole conference was double-charged" });
  assert.equal(held.status, 202, JSON.stringify(held.body));
});

test("one signature per property: the controller at the Reserve cannot sign across", async () => {
  const ctx = await gatedPriceRequest();
  const ikoyi = ctx.bearer(ctx.tokenFor("Finance Manager", "ari"));
  const pried = await ikoyi.post(`/api/approvals/${ctx.queued.id}/decide`)
    .send({ approve: true, note: "Signing from the other property" });
  assert.equal(pried.status, 403);
  assert.match(pried.body.error, /not permitted/);
});
