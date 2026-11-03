/**
 * Harness smoke test — proves the in-memory database, the seeded stay and the
 * signed role tokens all behave before any financial route is trusted.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, dstr, DAY, addDays } = require("./helpers/api");

test("health is open and the rest of the API is not", async () => {
  const { anon, as } = await boot();
  assert.equal((await anon.get("/health")).status, 200);
  assert.equal((await anon.get("/api/pricing/taxes")).status, 401);
  assert.equal((await as("Revenue").get("/api/pricing/taxes")).status, 200);
});

test("the seed gives a readable stay with unbilled nights", async () => {
  const { query } = await boot();
  const res = await query(`SELECT id, status, check_in, check_out FROM reservations ORDER BY id`);
  assert.deepEqual(res.rows.map((r) => r.id), ["res_1", "res_2", "res_3"]);
  assert.equal(res.rows[0].status, "In-house");
  assert.equal(dstr(res.rows[0].check_in), addDays(DAY, -2));

  const nights = await query(
    `SELECT charge_date, description FROM charges WHERE reservation_id='res_1' ORDER BY charge_date`
  );
  assert.equal(nights.rows.length, 2, "res_1 is billed for the night of day-2 only");
  assert.ok(nights.rows.every((r) => dstr(r.charge_date) === addDays(DAY, -2)));
});

test("a role is capped by the permission keys in its token", async () => {
  const { as } = await boot();
  const perms = await as("Housekeeping").get("/api/staff/permissions");
  assert.equal(perms.status, 200);
  assert.equal(perms.body.Housekeeping.record_expenses, true);
  assert.equal(perms.body.Housekeeping.take_payments, false);

  const denied = await as("Housekeeping").post("/api/reservations/res_1/payments").send({ amount: 1000 });
  assert.equal(denied.status, 403);
  const allowed = await as("Front Desk").post("/api/reservations/res_1/payments").send({ amount: 1000 });
  assert.notEqual(allowed.status, 403);
});

test("an Auditor token holds exactly the right to look", async () => {
  const { as } = await boot();
  const denied = await as("Auditor").patch("/api/pricing/taxes/tax_service").send({ pct: 5, reason: "probe" });
  assert.equal(denied.status, 403);
  assert.equal((await as("Auditor").get("/api/pricing/taxes")).status, 200);
});

test("a second boot answers from its own database", async () => {
  const first = await boot();
  await first.query(`INSERT INTO guests (id,name) VALUES ('gst_extra','Extra Guest')`);
  const second = await boot();
  const seen = await second.query(`SELECT 1 FROM guests WHERE id='gst_extra'`);
  assert.equal(seen.rows.length, 0);
});
