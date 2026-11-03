/**
 * The commercial policies and the integration register against the API — the
 * port of the manager's Hotel setup page. Two rules carry the whole module: the
 * money of account stops being a free choice the moment the books hold money,
 * because every stored figure then silently means another currency; and a trail
 * line names only a term whose value actually differs, because the page posts
 * its whole form back and a save that moved nothing must not claim otherwise.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./helpers/api");

const SET = "/api/properties/agm/settings";
const NAME = "Aurelia Grand Marina";

const settingsRow = async (query, pid) =>
  (await query(`SELECT data FROM settings WHERE property_id = $1`, [pid])).rows[0];
const blobOf = async (query, pid) => {
  const row = await settingsRow(query, pid);
  return typeof row.data === "string" ? JSON.parse(row.data) : row.data;
};
const linesFor = async (query, entity) =>
  (await query(`SELECT action, actor, detail FROM activity_log WHERE entity = $1 ORDER BY created_at DESC`, [entity])).rows;

/** Every term the form carries, moved off the seeded figure but for the money. */
const FULL_POLICY = {
  depositPct: 30, checkInTime: "14:00", checkOutTime: "11:00",
  currency: "NGN", language: "French", overbooking: 0,
  cancellation: "Free cancellation until 72 hours before arrival.",
};
const FULL_LINE = [
  "deposit 25% → 30%",
  "check-in 15:00 → 14:00",
  "check-out 12:00 → 11:00",
  "language English (UK) → French",
  "overbooking allowance 2 → 0",
  'cancellation "Free cancellation up to 48 hours before arrival. One night charged thereafter." → "Free cancellation until 72 hours before arrival."',
].join(" · ");

test("the policies move the figures that moved and sign them", async () => {
  const { as, query } = await boot();
  const before = await blobOf(query, "agm");
  assert.equal([before.depositPct, before.checkInTime, before.overbooking].join("|"), "25|15:00|2",
    "the fixture opens on the policies the browser seeds");

  const r = await as("Manager").patch(SET).send(FULL_POLICY);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The money of account was posted back unchanged, so it is not in the line.
  assert.equal(r.body.changed.join(" · "), FULL_LINE);
  const after = await blobOf(query, "agm");
  assert.equal(after.depositPct, 30);
  assert.equal(after.checkInTime, "14:00");
  assert.equal(after.checkOutTime, "11:00");
  assert.equal(after.language, "French");
  assert.equal(after.overbooking, 0);
  assert.equal(after.cancellation, "Free cancellation until 72 hours before arrival.");
  assert.equal(after.currency, "NGN");
  assert.equal(after.finance.approvalAmount, 500000, "the finance block rides through a policy write untouched");
  assert.equal(after.integrations.crm, true, "and so do the connections");

  const [line] = await linesFor(query, "settings");
  assert.equal(line.action, "updated hotel settings");
  assert.equal(line.actor, "Ifeoma Okafor");
  assert.equal(line.detail, `${NAME} · ${FULL_LINE}`);

  // The page posts its whole form back, so a save that moves nothing says so in
  // the trail rather than naming figures that held.
  const again = await as("Manager").patch(SET).send(FULL_POLICY);
  assert.equal(again.status, 200);
  assert.equal(again.body.changed.length, 0);
  const [second] = await linesFor(query, "settings");
  assert.equal(second.detail, `${NAME} · nothing moved`);
  assert.equal((await linesFor(query, "settings")).length, 2);
});

test("a policy the form would not accept is refused before it reaches the settings", async () => {
  const { as, query } = await boot();
  const untouched = JSON.stringify(await blobOf(query, "agm"));
  const wrote = (await linesFor(query, "settings")).length;

  const cases = [
    [{ depositPct: 25.5 }, "A deposit is a whole percentage."],
    [{ depositPct: -5 }, "A deposit cannot be negative."],
    [{ depositPct: 120 }, "A deposit cannot be more than the stay."],
    [{ overbooking: 1.5 }, "An overbooking allowance is a whole room."],
    [{ overbooking: -1 }, "An allowance cannot be negative."],
    [{ overbooking: 11 }, "Ten rooms is the most an allowance may hold."],
    [{ checkInTime: "3pm" }, "Arrival and departure times are written as HH:MM."],
    // Two digits, a colon and two digits is a shape, not a clock.
    [{ checkOutTime: "25:00" }, "Arrival and departure times are written as HH:MM."],
    [{ checkOutTime: "12:75" }, "Arrival and departure times are written as HH:MM."],
    [{ currency: "JPY" }, "This property holds money in NGN, USD, GBP, EUR, GHS, XAF. JPY is not among them."],
    [{ language: "Yoruba" }, "The desk writes in English (UK), English (US) or French."],
    [{ cancellation: "   " }, "Write the cancellation terms the guest is shown."],
    [{ cancellation: "x".repeat(401) }, "The cancellation terms have to fit on the confirmation."],
    [{}, "Nothing to update."],
  ];
  for (const [patch, error] of cases) {
    const r = await as("Manager").patch(SET).send(patch);
    assert.equal(r.status, 422, `${JSON.stringify(patch)} — ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, error);
  }

  // A key the form does not carry is refused rather than written beside it, so a
  // caller cannot move the finance rules or the connections through this door.
  for (const smuggle of [
    { finance: { approvalAmount: 1 } },
    { integrations: { crm: false } },
    { depositPct: 30, propertyId: "ari" },
  ]) {
    const r = await as("Manager").patch(SET).send(smuggle);
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.match(r.body.error, /Unrecognized key/);
  }

  assert.equal(JSON.stringify(await blobOf(query, "agm")), untouched, "every refusal left the row alone");
  assert.equal((await linesFor(query, "settings")).length, wrote, "and none of them reached the trail");
});

test("only the manager may write the policies or a connection", async () => {
  const { as, anon, query } = await boot();
  for (const role of ["Front Desk", "Housekeeping", "Revenue", "Auditor", "Finance Manager"]) {
    const r = await as(role).patch(SET).send({ depositPct: 30 });
    assert.equal(r.status, 403, `${role} — ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, "Your role cannot perform this action.");
    const t = await as(role).post("/api/properties/agm/integrations/crm/toggle");
    assert.equal(t.status, 403, `${role} reached the connection door`);
  }
  assert.equal((await blobOf(query, "agm")).depositPct, 25);
  assert.equal((await blobOf(query, "agm")).integrations.crm, true);

  assert.equal((await anon.patch(SET).send({ depositPct: 30 })).status, 401);
  assert.equal((await anon.post("/api/properties/agm/integrations/crm/toggle")).status, 401);
});

test("the money of account is a free choice only where the books are empty", async () => {
  const { as, query } = await boot();
  // Three charges and two payments, all on this property's stays.
  const refused = await as("Manager").patch(SET).send({ currency: "USD" });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error,
    "This property keeps its books in NGN and 5 money records are already valued in it. " +
    "Switching to USD would leave every one of them counting NGN without saying so. " +
    "Settle the folios and raise no more documents, or open the second currency as a rate on the NGN books instead.");
  assert.equal((await blobOf(query, "agm")).currency, "NGN", "the refusal left the rule alone");

  // The count is the property's own: the sister hotel has taken no money, so its
  // money of account is still whoever opened it decides.
  const fresh = await as("Manager").patch("/api/properties/ari/settings").send({ currency: "USD" });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.changed.join(" · "), "money of account NGN → USD");
  assert.equal((await blobOf(query, "ari")).currency, "USD");

  // A deposit is a policy; a plan's deposit is what a stay is actually asked for.
  // Moving one through this door must not touch the other.
  const moved = await as("Manager").patch(SET).send({ depositPct: 40 });
  assert.equal(moved.status, 200);
  assert.equal(Number((await query(`SELECT deposit_pct FROM rate_plans WHERE id = 'flex'`)).rows[0].deposit_pct), 25);
  assert.equal(Number((await query(`SELECT amount FROM prices WHERE id = 'prc_dk_std'`)).rows[0].amount), 200000);
  assert.equal((await query(`SELECT id FROM approvals`)).rows.length, 0,
    "a policy is not a price move, so it asks nobody for a second signature");
});

test("a connection is flipped for a service the register knows and signed either way", async () => {
  const { as, query } = await boot();
  const TOGGLE = "/api/properties/agm/integrations";

  const off = await as("Manager").post(`${TOGGLE}/crm/toggle`);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.key, "crm");
  assert.equal(off.body.connected, false);
  assert.equal(off.body.integrations.crm, false);
  assert.equal((await blobOf(query, "agm")).integrations.crm, false);
  let [line] = await linesFor(query, "integration");
  assert.equal(line.action, "disconnected an integration");
  assert.equal(line.actor, "Ifeoma Okafor");
  assert.equal(line.detail, "crm");

  const on = await as("Manager").post(`${TOGGLE}/crm/toggle`);
  assert.equal(on.body.connected, true);
  [line] = await linesFor(query, "integration");
  assert.equal(line.action, "connected an integration");

  // A key nobody authored is not a service the hotel has, so the register does
  // not remember it: the page can only ask about the six it shows.
  const ghost = await as("Manager").post(`${TOGGLE}/satellitePhone/toggle`);
  assert.equal(ghost.status, 422);
  assert.equal(ghost.body.error, "That service is not on the integration register.");
  assert.equal((await blobOf(query, "agm")).integrations.satellitePhone, undefined, "the refusal wrote no key");
  assert.equal((await linesFor(query, "integration")).length, 2, "and left no trail line either");

  // The other five are each reachable, so the register is the list and not one
  // hard-coded key.
  for (const key of ["channelManager", "paymentGateway", "doorLocks", "accounting", "whatsapp"]) {
    const r = await as("Manager").post(`${TOGGLE}/${key}/toggle`);
    assert.equal(r.status, 200, `${key} — ${JSON.stringify(r.body)}`);
    assert.equal(r.body.connected, key === "accounting", "five were on, one was not");
  }
});

test("a settings write refuses a property the books do not have", async () => {
  const { as, query } = await boot();
  const r = await as("Manager").patch("/api/properties/nowhere/settings").send({ depositPct: 30 });
  assert.equal(r.status, 404);
  assert.equal(r.body.error, "Property settings not found.");
  assert.equal((await query(`SELECT property_id FROM settings WHERE property_id = 'nowhere'`)).rows.length, 0,
    "and a door that cannot find the row does not create one");

  const t = await as("Manager").post("/api/properties/nowhere/integrations/crm/toggle");
  assert.equal(t.status, 404);
  assert.equal(t.body.error, "Property settings not found.");
});
