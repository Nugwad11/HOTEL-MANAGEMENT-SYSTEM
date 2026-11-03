/**
 * Night audit — the pack, the controls, the close and the seal it leaves.
 *
 * The seeded stay is two nights into its booking with only the first night
 * billed, so the audit owes it exactly two nights: 200,000 room plus the
 * compounding 10% service charge and 7.5% VAT, 236,500 each.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays, dstr, defaultPermissions, DAY } = require("./helpers/api");

const NIGHT = 200000 + 36500;
const ATTEST = {
  arrivals: "Reviewed with the duty manager",
  folios: "Two balances chased with the guest",
  roomtax: "Posted by this run",
  payments: "Card settlement matched to the terminal",
  currency: "Both rates read against the treasury screen",
  housekeeping: "Handed to the morning shift",
  revenue: "Pack read against the dashboard",
  audit: "Trail exported",
};

const chargeCount = async (query) => Number((await query(`SELECT COUNT(*) AS n FROM charges`)).rows[0].n);

test("the pack reports the nights nobody billed", async () => {
  const { as } = await boot();
  const pack = await as("Manager").get("/api/audit/pack?propertyId=agm");
  assert.equal(pack.status, 200, JSON.stringify(pack.body));
  assert.equal(pack.body.day, DAY);
  assert.equal(pack.body.unbilled.length, 2);
  assert.deepEqual(pack.body.unbilled.map((n) => n.date), [addDays(DAY, -1), DAY]);
  assert.equal(pack.body.unbilledTotal, NIGHT * 2);
  assert.equal(pack.body.metrics.adr, 100000);
  assert.equal(pack.body.metrics.occupancy, 50);
  assert.equal(pack.body.metrics.balanceDue, 118000);
  assert.equal(pack.body.unresolved.length, 1);
});

test("the checklist carries the figures the close will seal", async () => {
  const { as } = await boot();
  const r = await as("Manager").get("/api/audit/checks?propertyId=agm");
  assert.equal(r.status, 200);
  assert.equal(r.body.checks.length, 8);
  assert.deepEqual(r.body.checks.map((c) => c.key),
    ["arrivals", "folios", "roomtax", "payments", "currency", "housekeeping", "revenue", "audit"]);
  assert.match(r.body.checks[2].detail, /2 unbilled nights worth 473000/);
  // The fixture's contract rows sell in dollars and no fixing is on file here, so
  // the close names the money it cannot value instead of promising a clean book.
  assert.match(r.body.checks[4].detail, /USD \(missing\) cannot be valued today/);
});

test("the day stays open until every control is confirmed", async () => {
  const ctx = await boot();
  const before = await chargeCount(ctx.query);
  const partial = { arrivals: "Done", folios: "Done" };
  const r = await ctx.as("Manager").post("/api/audit/run").send({ propertyId: "agm", checks: partial });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /outstanding: Post room and tax, Reconcile payments/);
  assert.equal(await chargeCount(ctx.query), before);

  const { rows } = await ctx.query(`SELECT day FROM business_date WHERE id = 1`);
  assert.equal(dstr(rows[0].day), DAY);
});

test("a close posts the nights, seals the pack and rolls the date", async () => {
  const ctx = await boot();
  const before = await chargeCount(ctx.query);
  const r = await ctx.as("Manager").post("/api/audit/run").send({ propertyId: "agm", checks: ATTEST });
  assert.equal(r.status, 201, JSON.stringify(r.body));

  const closed = r.body.closed;
  assert.equal(closed.date, DAY);
  assert.equal(closed.rolledTo, addDays(DAY, 1));
  assert.equal(closed.posted.length, 2);
  assert.equal(closed.postedTotal, NIGHT * 2);
  assert.equal(closed.stats.balance, 118000 + NIGHT * 2);
  assert.equal(closed.stats.open, 1);

  // Room charge plus its two tax lines, twice.
  assert.equal(await chargeCount(ctx.query), before + 6);

  const { rows } = await ctx.query(
    `SELECT description, department, amount, night_audit FROM charges
     WHERE night_audit = true ORDER BY charge_date, department`
  );
  assert.equal(rows.length, 6);
  assert.equal(rows[0].description, "Room charge — Deluxe King (night audit)");
  assert.equal(Number(rows[0].amount), 200000);
  assert.equal(rows[1].department, "Taxes & service");
  assert.equal(Number(rows[1].amount), 20000);

  const date = await ctx.as("Manager").get("/api/audit/business-date");
  assert.equal(date.body.day, addDays(DAY, 1));
  assert.equal(date.body.closed, false);
});

test("a day already signed for cannot be closed twice", async () => {
  const ctx = await boot();
  const first = await ctx.as("Manager").post("/api/audit/run").send({ propertyId: "agm", checks: ATTEST });
  assert.equal(first.status, 201);

  await ctx.query(`UPDATE business_date SET day = $1 WHERE id = 1`, [DAY]);
  const again = await ctx.as("Manager").post("/api/audit/run").send({ propertyId: "agm", checks: ATTEST });
  assert.equal(again.status, 422);
  assert.match(again.body.error, /was already closed by Ifeoma Okafor/);
});

test("the sealed pack is stored, not recomputed", async () => {
  const ctx = await boot();
  await ctx.as("Manager").post("/api/audit/run").send({ propertyId: "agm", checks: ATTEST });
  const list = await ctx.as("Manager").get("/api/audit/closed");
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].date, DAY);
  assert.equal(list.body[0].by, "Ifeoma Okafor");
  assert.equal(list.body[0].postedTotal, NIGHT * 2);
  assert.equal(Object.keys(list.body[0].checks).length, 8);
  assert.equal(list.body[0].posted.length, 2);

  const trail = await ctx.as("Manager").get("/api/activity?propertyId=agm");
  assert.match(JSON.stringify(trail.body), /closed the day/);
});

test("a role that cannot close is turned away from the run", async () => {
  const { as } = await boot();
  const r = await as("Front Desk").post("/api/audit/run").send({ propertyId: "agm", checks: ATTEST });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /night_audit/);

  // Reading the pack is not the same act as sealing it.
  const pack = await as("Front Desk").get("/api/audit/pack?propertyId=agm");
  assert.equal(pack.status, 403);
});

test("the close only speaks for the property it belongs to", async () => {
  const permissions = defaultPermissions();
  permissions["Front Desk"] = Object.assign({}, permissions["Front Desk"], { night_audit: true });
  const ctx = await boot({ permissions });
  const r = await ctx.bearer(ctx.tokenFor("Front Desk", "ari")).get("/api/audit/pack?propertyId=agm");
  assert.equal(r.status, 403);
  assert.match(r.body.error, /not permitted/);

  const ikoyi = ctx.bearer(ctx.tokenFor("Front Desk", "ari"));
  const own = await ikoyi.get("/api/audit/pack?propertyId=ari");
  assert.equal(own.status, 200);
  assert.equal(own.body.propertyId, "ari");
});

test("nothing posts into a day the audit already sealed", async () => {
  const ctx = await boot();
  await ctx.as("Manager").post("/api/audit/run").send({ propertyId: "agm", checks: ATTEST });
  const before = await chargeCount(ctx.query);

  const backdated = await ctx.as("Front Desk").post("/api/reservations/res_1/charges")
    .send({ description: "Late minibar", amount: 5000, date: DAY });
  assert.equal(backdated.status, 422, JSON.stringify(backdated.body));
  assert.match(backdated.body.error, /closed and sealed/);
  assert.match(backdated.body.error, /put the correction on/, "the refusal says where the line belongs");
  assert.equal(await chargeCount(ctx.query), before, "a refused write leaves nothing to unpick");

  // The same money on the open date is accepted, so the seal redirects the line
  // rather than losing it.
  const today = await ctx.as("Front Desk").post("/api/reservations/res_1/charges")
    .send({ description: "Late minibar", amount: 5000 });
  assert.equal(today.status, 201, JSON.stringify(today.body));
  assert.equal(dstr(today.body.charge_date), addDays(DAY, 1));
  assert.equal(await chargeCount(ctx.query), before + 1);

  // Taking a line off a sealed day would unpick totals somebody signed for; a
  // void on the open date is a reversal the next close will read.
  const sealedLine = (await ctx.query(
    `SELECT id FROM charges WHERE reservation_id = 'res_1' AND charge_date = $1 AND NOT voided LIMIT 1`,
    [DAY])).rows[0];
  const refusedVoid = await ctx.as("Front Desk").post(`/api/reservations/res_1/charges/${sealedLine.id}/void`);
  assert.equal(refusedVoid.status, 422, JSON.stringify(refusedVoid.body));
  assert.match(refusedVoid.body.error, /closed and sealed/);
  assert.equal((await ctx.query(`SELECT voided FROM charges WHERE id = $1`, [sealedLine.id])).rows[0].voided, false,
    "the sealed line is untouched");

  const live = (await ctx.query(
    `SELECT id FROM charges WHERE reservation_id = 'res_1' AND charge_date = $1 AND NOT voided`,
    [addDays(DAY, 1)])).rows[0];
  const voided = await ctx.as("Front Desk").post(`/api/reservations/res_1/charges/${live.id}/void`);
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.equal(voided.body.voided, true);
  assert.equal(voided.body.voided_by, "Adamu Bello", "the reversal says whose hand took the line off");

  const f = await ctx.as("Front Desk").get("/api/reservations/res_1/folio");
  assert.equal(f.body.charges.some((c) => c.id === live.id), false, "a voided line leaves the folio");
  const twice = await ctx.as("Front Desk").post(`/api/reservations/res_1/charges/${live.id}/void`);
  assert.equal(twice.status, 422, "and it cannot be voided a second time");

  const trail = await ctx.as("Manager").get("/api/activity?propertyId=agm");
  assert.match(JSON.stringify(trail.body), /voided a charge/);
});
