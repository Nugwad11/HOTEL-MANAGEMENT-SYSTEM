/**
 * The Aurelia Club over the API — the port of the loyalty rules the browser
 * app enforces, proven against the same SQL and the same money path.
 *
 * The figures are the browser's, to the naira: a Platinum stay on a folio of
 * ₦218,000 earns 436 points and nothing else, 2,000 points are worth ₦10,000 of
 * credit, and a credit taken back puts the points on the profile again. What the
 * ledger kept is asked straight from the tables, so a page cannot be the proof.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, defaultPermissions, USERS } = require("./helpers/api");

const DESK = "Adamu Bello";        // the Front Desk identity the fixture signs in
const MGR = "Ifeoma Okafor";

const folioOf = async (ctx, id) => (await ctx.as("Front Desk").get(`/api/reservations/${id}/folio`)).body;
const stayOf = async (ctx, id) => (await ctx.as("Front Desk").get(`/api/reservations/${id}`)).body;
const guestOf = async (ctx, id) => (await ctx.query(`SELECT * FROM guests WHERE id = $1`, [id])).rows[0];
const givePoints = (ctx, guestId, pts) =>
  ctx.query(`UPDATE guests SET loyalty_pts = $2 WHERE id = $1`, [guestId, pts]);
const redeem = (ctx, id, points, role = "Front Desk") =>
  ctx.as(role).post(`/api/reservations/${id}/redeem`).send({ points });

test("a departure credits the stay at the guest's tier rate, once", async () => {
  const ctx = await boot();
  // The seeded in-house stay is billed ₦218,000 and has ₦100,000 against it.
  const before = await folioOf(ctx, "res_1");
  assert.equal(before.baseTotal, 218000);
  assert.equal(before.balance, 118000);

  const out = await ctx.as("Front Desk").post("/api/reservations/res_1/check-out").send({ settle: true });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.points, 436, '₦218,000 at Platinum is 436 points');
  assert.equal(out.body.points_awarded, 436);

  assert.equal(Number((await guestOf(ctx, "gst_1")).loyalty_pts), 436);
  const trail = (await ctx.query(
    `SELECT * FROM activity_log WHERE action = 'earned loyalty points'`)).rows;
  assert.equal(trail.length, 1);
  assert.equal(trail[0].actor, DESK, 'the award is recorded under the hand that checked the guest out');
  assert.match(trail[0].detail, /436 pts · AGM-0001/);
});

test("a second departure is refused and cannot award the stay again", async () => {
  const ctx = await boot();
  assert.equal((await ctx.as("Front Desk").post("/api/reservations/res_1/check-out")
    .send({ settle: true })).status, 200);

  const again = await ctx.as("Front Desk").post("/api/reservations/res_1/check-out").send({ settle: true });
  assert.equal(again.status, 422);
  assert.match(again.body.error, /not currently checked in/);
  assert.equal(Number((await guestOf(ctx, "gst_1")).loyalty_pts), 436, 'a refused departure spends no points');

  // The award itself is idempotent, so a caller that reaches it twice — the
  // audit, a replay — still credits the stay once.
  const LOY = require("../src/lib/loyalty");
  const stay = (await ctx.query(`SELECT * FROM reservations WHERE id = 'res_1'`)).rows[0];
  assert.equal((await LOY.award(ctx, { stay, baseTotal: 218000, actor: MGR })).points, 0);
});

test("pending points show what a stay will earn and stop once it has earned them", async () => {
  const ctx = await boot();
  assert.equal((await stayOf(ctx, "res_1")).pointsPending, 436);
  await ctx.as("Front Desk").post("/api/reservations/res_1/check-out").send({ settle: true });
  assert.equal((await stayOf(ctx, "res_1")).pointsPending, 0);
});

test("the tier multiplier changes what the same spend earns", async () => {
  const ctx = await boot();
  const LOY = require("../src/lib/loyalty");
  assert.equal(LOY.pointsFor(100000, "Member"), 100);
  assert.equal(LOY.pointsFor(100000, "Platinum"), 200);
  assert.equal(LOY.multiplierFor("Inventor"), 1, 'an unknown tier earns at the base rate');

  // And on the ledger: the same ₦100,000 on a Gold profile is worth 150 points.
  const posted = await ctx.as("Front Desk").post("/api/reservations/res_3/charges")
    .send({ description: "Room charge · Deluxe King", department: "Rooms", amount: 100000 });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.equal((await stayOf(ctx, "res_3")).pointsPending, 150);
});

test("a guest redeems points as a credit against the folio", async () => {
  const ctx = await boot();
  await givePoints(ctx, "gst_1", 5000);
  const before = await folioOf(ctx, "res_1");

  const out = await redeem(ctx, "res_1", 2000);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.credit, 10000, '2,000 points at ₦5');

  const line = out.body.charge;
  assert.equal(Number(line.amount), -10000, 'a credit is a negative line, not a deletion');
  assert.equal(line.department, "Loyalty");
  assert.equal(Number(line.points), 2000);
  assert.equal(line.description, "Aurelia Club — 2,000 points redeemed");
  assert.equal(line.posted_by, DESK);
  assert.equal(line.currency, "NGN");

  const after = await folioOf(ctx, "res_1");
  assert.equal(after.total, before.total - 10000);
  assert.equal(after.balance, before.balance - 10000);
  assert.equal(Number((await guestOf(ctx, "gst_1")).loyalty_pts), 3000);
  assert.equal((await ctx.query(`SELECT * FROM activity_log WHERE action = 'redeemed loyalty points'`)).rows.length, 1);

  // The same money may not be written as an ordinary line: the desk's charge door
  // only takes positive amounts, so a credit has to come through the club.
  const smuggled = await ctx.as("Front Desk").post("/api/reservations/res_1/charges")
    .send({ description: "hand-made credit", amount: -10000 });
  assert.equal(smuggled.status, 422);
});

test("voiding a redemption puts the points back on the guest", async () => {
  const ctx = await boot();
  await givePoints(ctx, "gst_1", 5000);
  const before = await folioOf(ctx, "res_1");

  const done = await redeem(ctx, "res_1", 2000);
  assert.equal(done.status, 201, JSON.stringify(done.body));
  const voided = await ctx.as("Front Desk").post(
    `/api/reservations/res_1/charges/${done.body.charge.id}/void`).send({});
  assert.equal(voided.status, 200, JSON.stringify(voided.body));

  assert.equal(Number((await guestOf(ctx, "gst_1")).loyalty_pts), 5000, 'a voided credit is not free money');
  const after = await folioOf(ctx, "res_1");
  assert.equal(after.total, before.total);
  assert.equal(after.balance, before.balance);
});

test("a redemption that overdraws points or the folio is refused", async () => {
  const ctx = await boot();
  const held = Number((await guestOf(ctx, "gst_1")).loyalty_pts);
  assert.equal(held, 0, 'the fixture gives the club nothing to start with');

  const tooFew = await redeem(ctx, "res_1", 500);
  assert.equal(tooFew.status, 422);
  assert.match(tooFew.body.error, /at least 2000/);

  const tooMany = await redeem(ctx, "res_1", 2000);
  assert.equal(tooMany.status, 422);
  assert.match(tooMany.body.error, /points are available/);

  await givePoints(ctx, "gst_1", 5000);
  const paid = await ctx.as("Front Desk").post("/api/reservations/res_1/payments")
    .send({ amount: 113000, method: "Card" });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal((await folioOf(ctx, "res_1")).balance, 5000);

  const tooWide = await redeem(ctx, "res_1", 2000);
  assert.equal(tooWide.status, 422);
  assert.match(tooWide.body.error, /outstanding on the folio/);
  assert.equal(Number((await guestOf(ctx, "gst_1")).loyalty_pts), 5000, 'a refused redemption spends nothing');
  assert.equal((await folioOf(ctx, "res_1")).balance, 5000, 'and writes no line');
});

test("club credit stays on the side of the ledger it was earned on", async () => {
  const ctx = await boot();
  const filed = await ctx.as("Manager").post("/api/fx/rates")
    .send({ code: "USD", perBase: 1550, note: "Treasury fixing" });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));

  // A dollar folio owes more than the credit is worth, so the refusal a desk
  // reads is the one about money and not the one about the balance.
  const posted = await ctx.as("Front Desk").post("/api/reservations/res_3/charges")
    .send({ description: "Contract night · Deluxe King", department: "Rooms", amount: 20000, currency: "USD" });
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  await givePoints(ctx, "gst_2", 5000);

  const out = await redeem(ctx, "res_3", 2000);
  assert.equal(out.status, 422);
  assert.equal(out.body.error,
    "Aurelia Club credit is worth NGN and cannot settle a folio billed in USD.");
  assert.equal(Number((await guestOf(ctx, "gst_2")).loyalty_pts), 5000);
});

test("the redeem door is the desk's charge permission, and an Auditor has neither", async () => {
  const ctx = await boot();
  await givePoints(ctx, "gst_1", 5000);
  const perms = defaultPermissions();
  assert.equal(perms["Front Desk"].post_charges, true);

  const housekeeping = await redeem(ctx, "res_1", 2000, "Housekeeping");
  assert.equal(housekeeping.status, 403);
  assert.match(housekeeping.body.error, /Permission 'post_charges' is required/);

  const auditor = await redeem(ctx, "res_1", 2000, "Auditor");
  assert.equal(auditor.status, 403);

  // And a point balance is not money the club pays out: nothing on this route
  // moves a payment, so the folio still owes what it owed.
  const before = await folioOf(ctx, "res_1");
  assert.equal(before.balance, 118000);
  assert.equal(USERS["Finance Manager"].name, "Emeka Balogun");
});
