/**
 * The guest portal over the API — the port of LHMS.guestPortal.
 *
 * The figures are the browser's to the naira: a folio that reads ₦118,000 in the
 * desk's read must read ₦118,000 in the guest's, a tray of two jollof and a
 * dessert is ₦46,500 on both sides, and a Platinum stay on ₦264,500 earns 529
 * points. What is proven here is that a guest can reach those figures through a
 * live token at all — and cannot reach anything else. The booking journey is held
 * to the same rule: the two nights a guest books from the app cost what the same
 * two nights cost at the counter, and they are on the folio before anybody
 * arrives.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays } = require("./helpers/api");

const ADAEZE = "adaeze@meridian.ng";
const KUNLE = "kunle@pole.ng";

const signIn = (ctx, body) => ctx.anon.post("/api/auth/guest").send(body);
const portal = (ctx, token) => ctx.bearer(token);
const guestToken = async (ctx, body) => {
  const out = await signIn(ctx, body);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.token;
};
const deskFolio = (ctx) => ctx.as("Front Desk").get("/api/reservations/res_1/folio");

test("the portal door opens on the contact the booking was made with", async () => {
  const ctx = await boot();
  // Matched without regard to how the guest capitalised it, exactly as the desk
  // finds a name when somebody walks in and asks for their key.
  const out = await signIn(ctx, { email: "  Adaeze@Meridian.NG " });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.user.role, "Guest");
  assert.equal(out.body.user.guestId, "gst_1");
  assert.equal(out.body.guest.name, "Adaeze Nwankwo");
  assert.equal(out.body.guest.tier, "Platinum");
  assert.equal(out.body.stay.reference, "AGM-0001");
  assert.equal(out.body.stay.status, "In-house");
  assert.equal(out.body.stay.roomNumber, "101");
  assert.equal(out.body.stay.propertyId, "agm");

  // The payload is this guest's own. There is no list of who else is in the
  // building for a token to be handed out to a stranger.
  const text = JSON.stringify(out.body);
  assert.ok(!text.includes("gst_2") && !text.includes("Kunle"), "no other guest travels with the token");

  const { verify } = require("../src/lib/jwt");
  const claims = verify(out.body.token);
  assert.equal(claims.role, "Guest");
  assert.deepEqual(claims.permissions, {}, "a guest token carries no staff permissions");
});

test("a phone number is matched on its digits, not on the way it was typed", async () => {
  const ctx = await boot();
  // The book keeps "+234 802 555 0101"; the guest types the same number with
  // different punctuation. It is the same person, so it is the same door.
  for (const typed of ["+2348025550101", "(234) 802 555 0101", "+234-802-555-0101"]) {
    const out = await signIn(ctx, { phone: typed });
    assert.equal(out.status, 200, `${typed} → ${JSON.stringify(out.body)}`);
    assert.equal(out.body.user.guestId, "gst_1");
    assert.equal(out.body.stay.reference, "AGM-0001");
  }

  const wrong = await signIn(ctx, { phone: "+234 802 555 0102" });
  assert.equal(wrong.status, 401);
});

test("an unknown contact, a stranger's booking and no contact are each refused", async () => {
  const ctx = await boot();
  const missing = await signIn(ctx, { email: "nobody@example.com" });
  assert.equal(missing.status, 401);
  assert.match(missing.body.error, /could not match those details/);

  // Kunle knows a real booking reference — it is not his, and the door says the
  // same sentence it says to a stranger so the book cannot be walked.
  const borrowed = await signIn(ctx, { email: KUNLE, reference: "AGM-0001" });
  assert.equal(borrowed.status, 401);
  assert.equal(borrowed.body.error, missing.body.error, "one refusal for both failures");

  // His own reference resolves: the stay is a booking ten days off, so the door
  // opens and names no live stay for it.
  const named = await signIn(ctx, { email: KUNLE, reference: "AGM-0003" });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(named.body.user.guestId, "gst_2");
  assert.equal(named.body.stay, null);

  const bare = await signIn(ctx, { reference: "AGM-0001" });
  assert.equal(bare.status, 422);
  assert.match(bare.body.error, /email or the phone number/);
});

test("the portal is the only door a guest token opens", async () => {
  const ctx = await boot();
  const anon = await ctx.anon.get("/api/guest/stay");
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error, "No token provided.");

  const bad = await ctx.bearer("not-a-token").get("/api/guest/stay");
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /Token invalid or expired/);

  const token = await guestToken(ctx, { email: ADAEZE });
  const asGuest = portal(ctx, token);
  for (const url of ["/api/reservations/res_1/folio", "/api/guests", "/api/laundry",
    "/api/tasks", "/api/rooms", "/api/reservations"]) {
    const out = await asGuest.get(url);
    assert.equal(out.status, 403, `${url} answered ${out.status}: ${JSON.stringify(out.body)}`);
    assert.match(out.body.error, /Only the guest in house/, url);
  }

  // And the reverse: a staff account has no guest identity to speak for, so the
  // portal asks for one rather than defaulting to whoever is in the building.
  const staff = await ctx.as("Front Desk").get("/api/guest/folio");
  assert.equal(staff.status, 422);
  assert.match(staff.body.error, /Sign in with your guest account/);
});

test("the guest reads their own folio balance — the figure the desk reads too", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const out = await portal(ctx, token).get("/api/guest/folio");
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.total, 218000);
  assert.equal(out.body.paid, 100000);
  assert.equal(out.body.balance, 118000);
  assert.equal(out.body.currency, "NGN");
  assert.deepEqual(out.body, (await deskFolio(ctx)).body, "one folio, one reading of it");

  const stay = await portal(ctx, token).get("/api/guest/stay");
  assert.equal(stay.status, 200, JSON.stringify(stay.body));
  assert.equal(stay.body.folio.balance, 118000);
  assert.equal(stay.body.pointsPending, 436, "₦218,000 at Platinum is 436 points");
  assert.equal(stay.body.upcoming.length, 0, "nothing else booked on this profile");
  assert.equal(stay.body.openRequests, 0);
  assert.equal(stay.body.stay.roomType, "Deluxe King");
});

test("an order from the portal posts to the folio and reaches the pass", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const out = await portal(ctx, token).post("/api/guest/orders").send({
    lines: [{ id: "ina_jollof", qty: 2 }, { id: "ina_dessert", qty: 1 }],
    when: "20:00",
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.total, 46500);
  assert.equal(out.body.currency, "NGN");
  assert.equal(out.body.charges.length, 2);
  assert.equal(out.body.charges[0].amount, 37000, "2 × ₦18,500");
  assert.equal(out.body.charges[0].description, "2 × Jollof rice & grilled chicken · In-room dining");
  assert.equal(out.body.charges[0].department, "Food & Beverage", "the outlet's own ledger, not a page's guess");
  assert.equal(out.body.charges[0].posted_by, "Guest app");
  assert.equal(out.body.charges[0].list_name, "Standard 2026");

  // One card for the whole tray, on the minutes the outlet asked for.
  assert.equal(out.body.task.title,
    "In-room dining — 2 × Jollof rice & grilled chicken, 1 × Chocolate & hibiscus dessert");
  assert.match(out.body.task.detail, /Serve by 20:00\. Ordered from the guest app\./);
  assert.match(out.body.task.detail, /Posted to the folio: NGN 46,500\./);
  assert.equal(out.body.task.source, "Guest app");
  assert.equal(out.body.task.sla_mins, 40);
  assert.equal(out.body.task.room_id, "agm_101");

  // The money is on the desk's folio, at the desk's figure.
  assert.equal(out.body.folio.balance, 164500);
  assert.equal((await deskFolio(ctx)).body.balance, 164500, "the two layers cannot disagree");
});

test("a tray that cannot be priced is refused whole, before a line is written", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const asGuest = portal(ctx, token);

  const empty = await asGuest.post("/api/guest/orders").send({ lines: [{ id: "ina_jollof", qty: 0 }] });
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /Choose at least one item/);

  const ghost = await asGuest.post("/api/guest/orders")
    .send({ lines: [{ id: "ina_jollof", qty: 1 }, { id: "not_on_the_menu", qty: 1 }] });
  assert.equal(ghost.status, 422);
  assert.match(ghost.body.error, /no longer on the menu/);

  await ctx.query(`UPDATE services SET active = false WHERE id = 'svc_ina_suya'`);
  const shut = await asGuest.post("/api/guest/orders")
    .send({ lines: [{ id: "ina_jollof", qty: 1 }, { id: "ina_suya", qty: 2 }] });
  assert.equal(shut.status, 422);
  assert.match(shut.body.error, /Suya platter is not being sold right now/);

  // Nothing of the refused trays reached the folio.
  assert.equal((await asGuest.get("/api/guest/folio")).body.balance, 118000);
  assert.equal((await ctx.query(`SELECT count(*) AS n FROM charges WHERE posted_by = 'Guest app'`)).rows[0].n, 0);
});

test("settlement confirms before it charges, and the guest never names the amount", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const asGuest = portal(ctx, token);

  const smuggled = await asGuest.post("/api/guest/payments").send({ amount: 1, balance: 0, currency: "USD" });
  assert.equal(smuggled.status, 422);
  assert.match(smuggled.body.error, /Confirm the charge to settle NGN 118,000/,
    "the money fields the page sent are dropped; the folio's own balance is the only amount");
  assert.equal((await asGuest.get("/api/guest/folio")).body.balance, 118000, "a refused settlement writes nothing");

  const paid = await asGuest.post("/api/guest/payments").send({ confirm: true, method: "Bank transfer" });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal(paid.body.payment.amount, 118000);
  assert.equal(paid.body.payment.method, "Bank transfer");
  assert.equal(paid.body.payment.taken_by, "Guest app");
  assert.equal(paid.body.folio.balance, 0);

  const twice = await asGuest.post("/api/guest/payments").send({ confirm: true });
  assert.equal(twice.status, 422);
  assert.match(twice.body.error, /nothing outstanding/);
});

test("the club spends points on the folio through the portal, on the ledger's sentences", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  await ctx.query(`UPDATE guests SET loyalty_pts = 30000 WHERE id = 'gst_1'`);
  const asGuest = portal(ctx, token);

  const few = await asGuest.post("/api/guest/redeem").send({ points: 1500 });
  assert.equal(few.status, 422);
  assert.match(few.body.error, /Redeem at least 2000 points/);

  const more = await asGuest.post("/api/guest/redeem").send({ points: 50000 });
  assert.equal(more.status, 422);
  assert.match(more.body.error, /Only 30,000 points are available/);

  // ₦125,000 of credit is more than the ₦118,000 the folio owes, so the club
  // refuses the whole idea rather than opening a credit balance.
  const tooBig = await asGuest.post("/api/guest/redeem").send({ points: 25000 });
  assert.equal(tooBig.status, 422);
  assert.match(tooBig.body.error, /more than the NGN 118,000 outstanding/);

  const out = await asGuest.post("/api/guest/redeem").send({ points: 2000 });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.credit, 10000);
  assert.equal(out.body.charge.department, "Loyalty");
  assert.equal(out.body.charge.amount, -10000);
  assert.equal(out.body.charge.posted_by, "Guest app");
  assert.equal(out.body.guest.loyaltyPoints, 28000);
  assert.equal(out.body.folio.balance, 108000);

  // The refusal of a folio kept in a money the club does not deal in is the
  // ledger's own, so the portal reads it from there rather than restating it.
  await ctx.query(`UPDATE charges SET currency = 'USD', fx_rate = 1500 WHERE id = 'chg_1'`);
  const foreign = await asGuest.post("/api/guest/redeem").send({ points: 2000 });
  assert.equal(foreign.status, 422, JSON.stringify(foreign.body));
});

test("nothing departs with money owing, and a settled stay earns on the way out", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const asGuest = portal(ctx, token);

  await asGuest.post("/api/guest/orders").send({ lines: [{ id: "ina_suya", qty: 1 }] });
  const stuck = await asGuest.post("/api/guest/check-out").send({});
  assert.equal(stuck.status, 422);
  assert.match(stuck.body.error, /outstanding balance of NGN 132,000\. Settle it to depart/);
  assert.equal((await ctx.query(`SELECT status FROM reservations WHERE id = 'res_1'`)).rows[0].status, "In-house",
    "a refused departure leaves the stay where it was");

  await asGuest.post("/api/guest/payments").send({ confirm: true });
  const out = await asGuest.post("/api/guest/check-out").send({});
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.stay.status, "Checked out");
  // ₦218,000 + ₦14,000 suya = ₦232,000 on the books, at Platinum.
  assert.equal(out.body.folio.baseTotal, 232000);
  assert.equal(out.body.points, 464);

  const again = await asGuest.post("/api/guest/check-out").send({});
  assert.equal(again.status, 422, "the stay has left the portal's window");
  assert.match(again.body.error, /could not find an active stay/);
  const room = (await ctx.query(`SELECT hk_status FROM rooms WHERE id = 'agm_101'`)).rows[0];
  assert.equal(room.hk_status, "Dirty");
  const clean = (await ctx.query(`SELECT * FROM tasks WHERE type = 'Departure clean'`)).rows;
  assert.equal(clean.length, 1);
  assert.equal(clean[0].source, "Front desk");
  assert.equal(Number((await ctx.query(`SELECT loyalty_pts FROM guests WHERE id = 'gst_1'`)).rows[0].loyalty_pts), 464);
});

test("a checked-out stay or a booking that has not arrived has no portal to bill", async () => {
  const ctx = await boot();
  // Kunle has one checked-out stay and one arrival ten days off: neither is a
  // stay the portal can act on, so the doors that bill say so.
  const token = await guestToken(ctx, { email: KUNLE });
  const asGuest = portal(ctx, token);

  assert.equal((await asGuest.get("/api/guest/stay")).body.stay, null);
  for (const url of ["/api/guest/folio", "/api/guest/orders", "/api/guest/payments", "/api/guest/check-out"]) {
    const out = url.endsWith("orders") || url.endsWith("payments") || url.endsWith("check-out")
      ? await asGuest.post(url).send(url.endsWith("orders") ? { lines: [{ id: "ina_jollof", qty: 1 }] } : { confirm: true })
      : await asGuest.get(url);
    assert.equal(out.status, 422, `${url} answered ${JSON.stringify(out.body)}`);
    assert.match(out.body.error, /could not find an active stay/, url);
  }

  // The identity-only doors still answer: a guest with nothing in house is still
  // a guest, and still only sees their own thread.
  assert.deepEqual((await asGuest.get("/api/guest/requests")).body, []);
  const prefs = await asGuest.patch("/api/guest/preferences").send({ beverage: "Ginger tea" });
  assert.equal(prefs.status, 200, JSON.stringify(prefs.body));
  assert.equal(prefs.body.guest.preferences.beverage, "Ginger tea");

  // The folio that was never opened on this profile cannot be reached at all.
  const stranger = await asGuest.get("/api/guest/stay?reservationId=res_1");
  assert.equal(stranger.body.stay, null, "a query parameter does not choose whose stay the portal speaks for");
});

test("express check-in turns a booking into an arrival, once", async () => {
  const ctx = await boot();
  await ctx.query(`UPDATE reservations SET check_in = $1, check_out = $2 WHERE id = 'res_3'`,
    [ctx.day, addDays(ctx.day, 2)]);
  const token = await guestToken(ctx, { email: KUNLE, reference: "AGM-0003" });
  const asGuest = portal(ctx, token);

  const stay = await asGuest.get("/api/guest/stay");
  assert.equal(stay.body.stay.reference, "AGM-0003");
  assert.equal(stay.body.stay.status, "Confirmed");

  const arrived = await asGuest.post("/api/guest/check-in").send({ eta: "18:30" });
  assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
  assert.equal(arrived.body.stay.status, "In-house");
  assert.equal(arrived.body.key, true, "a mobile key is the point of checking in from the portal");
  const row = (await ctx.query(`SELECT * FROM reservations WHERE id = 'res_3'`)).rows[0];
  assert.equal(row.status, "In-house");
  assert.equal(row.eta, "18:30");
  assert.ok(row.key_issued_at, "the key is stamped with the moment it was issued");
  assert.equal((await ctx.query(`SELECT hk_status FROM rooms WHERE id = 'agm_101'`)).rows[0].hk_status, "Occupied");
  assert.equal((await ctx.query(`SELECT * FROM activity_log WHERE action = 'checked in'`)).rows[0].actor, "Kunle Adeyemi");
  assert.ok((await ctx.query(`SELECT * FROM notifications WHERE type = 'Guest checked in'`)).rows.length);

  const twice = await asGuest.post("/api/guest/check-in").send({});
  assert.equal(twice.status, 422);
  assert.match(twice.body.error, /already checked in/);
});

test("a request from the portal lands on the desk's board — this guest's own", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const asGuest = portal(ctx, token);
  await ctx.query(`INSERT INTO tasks (id,property_id,type,title,guest_id,source,status)
                   VALUES ('tsk_other','agm','Guest request','A towel order for another guest','gst_2','Guest app','Open')`);

  const out = await asGuest.post("/api/guest/requests").send({
    title: "Two extra towels", detail: "Room 101, before turndown", priority: "High", slaMins: 20,
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.type, "Guest request");
  assert.equal(out.body.source, "Guest app");
  assert.equal(out.body.guest_id, "gst_1");
  assert.equal(out.body.room_id, "agm_101");
  assert.equal(out.body.priority, "High");
  assert.equal(out.body.sla_mins, 20);
  assert.ok(out.body.due_at, "the desk is owed the minutes, not just the note");

  const board = (await ctx.query(`SELECT * FROM notifications WHERE type = 'Guest request'`)).rows;
  assert.equal(board.length, 1);
  assert.match(board[0].detail, /Room 101 · guest app · respond within 20 min/);

  const list = await asGuest.get("/api/guest/requests");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((t) => t.id), [out.body.id], "the thread is one guest's, not the building's");
  assert.equal((await portal(ctx, token).get("/api/guest/stay")).body.openRequests, 1);

  const blank = await asGuest.post("/api/guest/requests").send({ detail: "no title" });
  assert.equal(blank.status, 422);
  assert.match(blank.body.error, /Describe what you need/);
});

test("a preferences patch keeps what it was not asked about", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const asGuest = portal(ctx, token);

  const first = await asGuest.patch("/api/guest/preferences").send({
    pillow: "Firm", dietary: "No pork", allergies: "  ", marketing: true,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body.guest.preferences, { pillow: "Firm", dietary: "No pork" },
    "an empty answer is not an answer");
  assert.equal(first.body.guest.consent.marketing, true);

  const second = await asGuest.patch("/api/guest/preferences").send({ newspaper: "ThisDay" });
  assert.deepEqual(second.body.guest.preferences,
    { pillow: "Firm", dietary: "No pork", newspaper: "ThisDay" },
    "one field on the card cannot erase the rest of the profile");

  const row = (await ctx.query(`SELECT preferences, consent FROM guests WHERE id = 'gst_1'`)).rows[0];
  assert.equal(row.preferences.pillow, "Firm");
  assert.equal(row.consent.marketing, true, "consent the guest did not change stays as they left it");

  const smuggled = await asGuest.patch("/api/guest/preferences").send({ room: "High floor", tier: "Platinum", loyalty_pts: 9999 });
  assert.equal(smuggled.status, 200, JSON.stringify(smuggled.body));
  const after = (await ctx.query(`SELECT tier, loyalty_pts, preferences FROM guests WHERE id = 'gst_1'`)).rows[0];
  assert.equal(after.tier, "Platinum", "the tier the profile already carried, not one the request named");
  assert.equal(Number(after.loyalty_pts), 0, "a card cannot write the point balance");
  assert.equal(after.preferences.room, "High floor");
});

test("an order cannot be pointed at another guest's folio, whatever the page sends", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const out = await portal(ctx, token).post("/api/guest/orders").send({
    reservationId: "res_2", lines: [{ id: "spa_signature", qty: 1 }], listId: "pl_fest", currency: "USD",
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));

  // Every field that names money or another stay was dropped: the charge landed
  // on the guest's own folio at the standard rate the day sells at.
  assert.equal(out.body.charges.length, 1);
  assert.equal(out.body.total, 85000, "₦85,000 is the spa's own price, not a figure from the request");
  assert.equal(out.body.charges[0].description, "Signature massage — 60 min · Aurelia Spa");
  assert.equal(out.body.charges[0].department, "Spa & Wellness");
  assert.equal(out.body.task.sla_mins, 120, "the outlet's minutes, not the default");
  assert.equal((await ctx.as("Front Desk").get("/api/reservations/res_2/folio")).body.balance, 937500,
    "the other stay's folio is untouched");
});

/* ── booking a stay from the app (PRD 6.14) ─────────────────── */

// Two weeks out, so the nights fall on ordinary weekdays and nothing in the
// fixture overlaps them.
const ARRIVAL = (ctx) => addDays(ctx.day, 20);
const DEPARTURE = (ctx) => addDays(ctx.day, 22);
const TWO_NIGHTS = (ctx) => ({
  roomTypeId: "dk", ratePlanId: "flex", checkIn: ARRIVAL(ctx), checkOut: DEPARTURE(ctx), adults: 2,
});

test("a stay booked from the app is priced on the counter's own quote, night by night", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const out = await portal(ctx, token).post("/api/guest/bookings").send(TWO_NIGHTS(ctx));
  assert.equal(out.status, 201, JSON.stringify(out.body));

  const q = out.body.quote;
  assert.equal(q.roomType, "Deluxe King");
  assert.equal(q.ratePlan, "Flexible Rate");
  assert.equal(q.nights, 2);
  assert.equal(q.currency, "NGN");
  assert.deepEqual(q.nightly.map((n) => [n.date, n.rate, n.uplift, n.list]),
    [[ARRIVAL(ctx), 200000, 0, "Standard 2026"], [addDays(ctx.day, 21), 200000, 0, "Standard 2026"]],
    "two nights at the rate each of those nights sells at, not one averaged stay");
  assert.equal(q.roomTotal, 400000);
  assert.equal(q.extras, 0);
  assert.deepEqual(q.taxLines,
    [{ label: "Service charge (10%)", amount: 40000 }, { label: "VAT (7.5%)", amount: 33000 }],
    "the tax is taken once on the room total, so two nights cannot cost more than the same two nights booked singly");
  assert.equal(q.service, 40000);
  assert.equal(q.vat, 33000, "7.5% of ₦440,000 — VAT compounds on the service charge");
  assert.equal(q.taxes, 73000);
  assert.equal(q.total, 473000);
  assert.equal(q.deposit, 118250, "the flexible plan's 25% of the quoted total");

  // The number the guest was shown is the number the stay opens with.
  assert.equal(out.body.folio.total, q.total);
  assert.equal(out.body.folio.balance, q.total, "a new booking has paid nothing yet");
  assert.equal(out.body.folio.paid, 0);
  assert.equal(out.body.folio.currency, "NGN");
});

test("the stay the app books is the guest's own, in a real room, on the desk's board", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const out = await portal(ctx, token).post("/api/guest/bookings")
    .send(Object.assign(TWO_NIGHTS(ctx), { notes: "  High floor if possible  ", eta: "18:30" }));
  assert.equal(out.status, 201, JSON.stringify(out.body));

  const b = out.body.booking;
  assert.equal(b.reference, "AGM-4", "the next number in the hotel's own sequence");
  assert.equal(b.propertyId, "agm");
  assert.equal(b.status, "Confirmed", "a booking is a booking until somebody arrives");
  assert.equal(b.roomId, "agm_101", "a key is held, not a promise to allocate one later");
  assert.equal(b.roomNumber, "101");
  assert.equal(b.roomType, "Deluxe King");
  assert.equal(b.ratePlan, "Flexible Rate");
  assert.deepEqual([b.checkIn, b.checkOut], [ARRIVAL(ctx), DEPARTURE(ctx)]);
  assert.equal(b.adults, 2);
  assert.equal(b.eta, "18:30");
  assert.equal(b.notes, "High floor if possible", "the note is kept, the padding is not");

  const row = (await ctx.query(`SELECT * FROM reservations WHERE id = $1`, [b.id])).rows[0];
  assert.equal(row.guest_id, "gst_1", "the profile the token belongs to");
  assert.equal(row.channel, "Direct");
  assert.equal(row.source, "Guest app");
  assert.equal(row.vip, true, "a Platinum profile is flagged at the app's end exactly as at the counter's");
  assert.equal(Number(row.total), 473000);

  // The stay already in house is not the one being billed, and the app's own
  // thread now shows what it booked.
  assert.equal((await deskFolio(ctx)).body.balance, 118000, "a second booking does not move the live folio");
  const stay = await portal(ctx, token).get("/api/guest/stay");
  assert.deepEqual(stay.body.upcoming.map((u) => [u.reference, u.folio.balance]), [["AGM-4", 473000]]);
  assert.equal(stay.body.stay.reference, "AGM-0001", "the live stay is still the one the portal speaks for");

  const trail = (await ctx.query(`SELECT * FROM activity_log WHERE action = 'created a reservation'`)).rows;
  assert.equal(trail.length, 1);
  assert.equal(trail[0].actor, "Guest app");
  assert.equal(trail[0].entity, "reservation");
  assert.equal(trail[0].detail, "AGM-4 · Adaeze Nwankwo · 2 nights");

  const ntf = (await ctx.query(`SELECT * FROM notifications WHERE type = 'New reservation'`)).rows;
  assert.equal(ntf.length, 1, "the desk is told, once");
  assert.equal(ntf[0].title, "AGM-4 created for Adaeze Nwankwo");
  assert.equal(ntf[0].detail, "18 November 2026 → 20 November 2026 · Deluxe King");
  assert.equal(ntf[0].link, "#/booking/" + b.id);
});

test("every night of the booked stay is on the folio, dated the way the counter dates them", async () => {
  const ctx = await boot();
  const biz = require("../src/lib/business-date");
  const token = await guestToken(ctx, { email: ADAEZE });
  const out = await portal(ctx, token).post("/api/guest/bookings").send(TWO_NIGHTS(ctx));
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const id = out.body.booking.id;

  const charges = (await ctx.query(
    `SELECT * FROM charges WHERE reservation_id = $1 ORDER BY charge_date, description`, [id])).rows;
  assert.deepEqual(charges.map((c) => [biz.dstr(c.charge_date), c.department, c.description, Number(c.amount), c.posted_by]),
    [
      [ARRIVAL(ctx), "Rooms", "Room charge — Deluxe King (1/2)", 200000, "Guest app"],
      [addDays(ctx.day, 21), "Rooms", "Room charge — Deluxe King (2/2)", 200000, "Guest app"],
      [DEPARTURE(ctx), "Taxes & service", "Service charge (10%)", 40000, "System"],
      [DEPARTURE(ctx), "Taxes & service", "VAT (7.5%)", 33000, "System"],
    ], "the nights dated the nights, the tax dated the departure");

  // Each line carries the price it was written at, so re-pricing the book later
  // cannot rewrite a folio that has already been given to a guest.
  const night = charges[0];
  assert.deepEqual(
    [Number(night.unit_price), Number(night.base_price), night.price_id, night.list_name,
      night.service_id, night.currency, night.fx_rate, Number(night.base_amount), night.voided],
    [200000, 200000, "prc_dk_std", "Standard 2026", "svc_dk", "NGN", null, 200000, false]);
  assert.equal(charges[3].tax_rule_id, "tax_vat");
  assert.equal(charges.reduce((s, c) => s + Number(c.amount), 0), 473000);

  const row = (await ctx.query(`SELECT * FROM reservations WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(
    [Number(row.room_total), Number(row.base_room_total), Number(row.subtotal),
      Number(row.service_chg), Number(row.vat_amount), Number(row.total), row.currency, row.fx_rate],
    [400000, 400000, 400000, 40000, 33000, 473000, "NGN", null],
    "the stay carries the totals its own lines add up to");

  // And the counter reads the identical money from its own door.
  const deskView = await ctx.as("Front Desk").get(`/api/reservations/${id}/folio`);
  assert.equal(deskView.body.total, out.body.folio.total);
  assert.equal(deskView.body.balance, 473000, "the app's folio and the counter's are one account");
  assert.equal(deskView.body.charges.length, 4);
});

test("the app refuses the bookings the desk would refuse, in the desk's order, and files nothing", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const asGuest = portal(ctx, token);
  const count = async (table) => Number((await ctx.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const before = {
    reservations: await count("reservations"),
    charges: await count("charges"),
    payments: await count("payments"),
    trail: await count("activity_log"),
  };

  const cases = [
    [Object.assign(TWO_NIGHTS(ctx), { propertyId: "somewhere else" }),
      "Choose which hotel you are staying at."],
    [Object.assign(TWO_NIGHTS(ctx), { roomTypeId: "" }), "Choose a room type."],
    [Object.assign(TWO_NIGHTS(ctx), { roomTypeId: "not_a_type" }), "Choose a room type."],
    [Object.assign(TWO_NIGHTS(ctx), { ratePlanId: "" }), "Choose a rate plan."],
    [Object.assign(TWO_NIGHTS(ctx), { checkIn: addDays(ctx.day, -1) }),
      "Your arrival date is in the past."],
    [Object.assign(TWO_NIGHTS(ctx), { checkOut: ARRIVAL(ctx) }),
      "Departure has to be after arrival."],
    [Object.assign(TWO_NIGHTS(ctx), { checkOut: addDays(ctx.day, 19) }),
      "Departure has to be after arrival."],
    [Object.assign(TWO_NIGHTS(ctx), { adults: 3 }),
      "Deluxe King sleeps 2. Reduce the party or choose a suite."],
    [Object.assign(TWO_NIGHTS(ctx), { adults: 2, children: 1 }),
      "Deluxe King sleeps 2. Reduce the party or choose a suite."],
  ];
  for (const [body, error] of cases) {
    const out = await asGuest.post("/api/guest/bookings").send(body);
    assert.equal(out.status, 422, `${JSON.stringify(body)} → ${JSON.stringify(out.body)}`);
    assert.equal(out.body.error, error);
  }

  // A room type nobody is selling has no rate on sale — the app says so rather
  // than filing a stay that opens with an empty folio.
  await ctx.query(`UPDATE services SET active = false WHERE id = 'svc_dk'`);
  const unpriced = await asGuest.post("/api/guest/bookings").send(TWO_NIGHTS(ctx));
  assert.equal(unpriced.status, 422);
  assert.equal(unpriced.body.error,
    "Deluxe King has no rate on sale for those dates. Try another room type or different dates.");

  // The door still needs a guest to speak for: staff hands cannot book through it.
  const staff = await ctx.as("Front Desk").post("/api/guest/bookings").send(TWO_NIGHTS(ctx));
  assert.equal(staff.status, 422);
  assert.match(staff.body.error, /Sign in with your guest account/);
  assert.equal((await ctx.anon.post("/api/guest/bookings").send(TWO_NIGHTS(ctx))).status, 401);

  // Nothing refused left a trace anywhere.
  assert.equal(await count("reservations"), before.reservations);
  assert.equal(await count("charges"), before.charges, "not one line of a refused booking reaches the ledger");
  assert.equal(await count("payments"), before.payments, "a refused booking takes no deposit either");
  assert.equal(await count("activity_log"), before.trail);
  assert.equal(Number((await ctx.query(`SELECT res_seq FROM counters WHERE property_id = 'agm'`)).rows[0].res_seq), 3,
    "a refused booking does not burn a reference either");
  assert.equal((await asGuest.get("/api/guest/folio")).body.balance, 118000);
});

test("a room type with nothing free is sold out to the app, whole and at once", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const asGuest = portal(ctx, token);
  const billed = Number((await ctx.query(`SELECT count(*) AS n FROM charges`)).rows[0].n);
  const suite = {
    roomTypeId: "ps", ratePlanId: "flex",
    checkIn: addDays(ctx.day, 30), checkOut: addDays(ctx.day, 32), adults: 3,
  };

  const first = await asGuest.post("/api/guest/bookings").send(suite);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.booking.roomId, "agm_1200", "the hotel's one presidential suite");

  const second = await asGuest.post("/api/guest/bookings").send(suite);
  assert.equal(second.status, 422);
  assert.equal(second.body.error,
    "No Presidential Suite is free from 28 November 2026. Try different dates.");

  // The key held by the first booking is not offered twice, and the second
  // booking left no money behind.
  assert.equal((await ctx.as("Front Desk").get(
    `/api/rooms/types/ps/availability?checkIn=${suite.checkIn}&checkOut=${suite.checkOut}`)).body.free, 0);
  const rows = (await ctx.query(`SELECT id FROM reservations WHERE room_id = 'agm_1200' AND status = 'Confirmed'`)).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number((await ctx.query(`SELECT count(*) AS n FROM charges`)).rows[0].n), billed + 4,
    "two nights and their taxes, from the one booking that was accepted");
  assert.equal(Number((await ctx.query(`SELECT res_seq FROM counters WHERE property_id = 'agm'`)).rows[0].res_seq), 4,
    "the refused second booking never reached for a reference");
});

test("a guest cannot name the money, another profile or the channel it is booked on", async () => {
  const ctx = await boot();
  const token = await guestToken(ctx, { email: ADAEZE });
  const out = await portal(ctx, token).post("/api/guest/bookings").send(Object.assign(TWO_NIGHTS(ctx), {
    guestId: "gst_2", reservationId: "res_2", id: "res_hacked", reference: "AGM-9999",
    channel: "Booking.com", source: "Front desk", status: "In-house", currency: "USD",
    amount: 1, rate: 9999, deposit: 500000, roomId: "agm_1200", actor: "Manager",
    vip: false, points: 99999, paid: 473000, balance: 0,
  }));
  assert.equal(out.status, 201, JSON.stringify(out.body));

  const b = out.body.booking;
  assert.equal(b.id, out.body.folio.charges[0].reservation_id, "one stay was written, under the hotel's own id");
  assert.equal(b.reference, "AGM-4", "the hotel's own sequence, not a reference the request brought");
  assert.equal(b.propertyId, "agm", "the property the guest's own book is kept at");
  assert.equal(b.roomId, "agm_101", "the engine allocates the key, so a suite is not handed out by a form field");
  assert.equal(b.status, "Confirmed", "a booking is not an arrival because the request said so");

  const row = (await ctx.query(`SELECT * FROM reservations WHERE id = $1`, [b.id])).rows[0];
  assert.equal(row.id, b.id);
  assert.equal(row.guest_id, "gst_1", "the profile the token belongs to, never the one the request named");
  assert.equal(row.room_type_id, "dk", "the room type the guest asked for and the engine priced");
  assert.equal(row.channel, "Direct");
  assert.equal(row.source, "Guest app");
  assert.equal(row.vip, true, "the tier on the profile decides, not the flag in the request");
  assert.equal(row.currency, "NGN", "the money the stay is kept in is the money the books hold");
  assert.equal(row.fx_rate, null);
  assert.equal(Number(row.total), 473000, "₦473,000 is what those two nights cost, whatever the request offered");
  assert.equal(Number(row.deposit), 0, "nothing was prepaid, whatever the amount the page named");
  assert.equal(Number((await ctx.query(`SELECT count(*) AS n FROM payments WHERE reservation_id = $1`,
    [b.id])).rows[0].n), 0, "a deposit a stranger's form names is not taken");
  assert.equal((await ctx.as("Front Desk").get("/api/reservations/res_2/folio")).body.balance, 937500,
    "and the suite somebody tried to book themselves into is untouched");
});

test("the counter books the same stay for the same money, and can take a deposit with it", async () => {
  const ctx = await boot();
  const biz = require("../src/lib/business-date");
  const token = await guestToken(ctx, { email: ADAEZE });
  const viaApp = await portal(ctx, token).post("/api/guest/bookings").send(TWO_NIGHTS(ctx));
  assert.equal(viaApp.status, 201, JSON.stringify(viaApp.body));

  // The identical room type, plan and length at the counter, a fortnight later,
  // with a deposit the app's guest is never allowed to name.
  const viaDesk = await ctx.as("Front Desk").post("/api/reservations").send({
    propertyId: "agm", guestId: "gst_2", roomTypeId: "dk", ratePlanId: "flex",
    checkIn: addDays(ctx.day, 40), checkOut: addDays(ctx.day, 42), adults: 2, deposit: 100000,
  });
  assert.equal(viaDesk.status, 201, JSON.stringify(viaDesk.body));
  const desk = viaDesk.body;

  assert.equal(desk.reference, "AGM-5", "one sequence serves both ends of the desk");
  assert.equal(desk.source, "Front desk");
  assert.equal(Number(desk.room_total), viaApp.body.quote.roomTotal);
  assert.equal(Number(desk.service_chg), viaApp.body.quote.service);
  assert.equal(Number(desk.vat_amount), viaApp.body.quote.vat);
  assert.equal(Number(desk.total), viaApp.body.quote.total,
    "the guest in the app and the walk-in beside them are billed the same ₦473,000");
  assert.equal(desk.currency, "NGN");

  const folio = await ctx.as("Front Desk").get(`/api/reservations/${desk.id}/folio`);
  assert.equal(folio.body.total, 473000, "the counter's booking bills its nights too");
  assert.equal(folio.body.balance, 373000, "and the deposit is against them, not a separate pile");
  assert.deepEqual(folio.body.charges.filter((c) => c.department === "Rooms")
    .sort((a, b) => (a.charge_date < b.charge_date ? -1 : 1))
    .map((c) => [String(c.charge_date).slice(0, 10), Number(c.amount), c.posted_by]),
    [[addDays(ctx.day, 40), 200000, "Adamu Bello"], [addDays(ctx.day, 41), 200000, "Adamu Bello"]],
    "posted under the clerk's own name, not the app's");

  const paid = (await ctx.query(`SELECT * FROM payments WHERE reservation_id = $1`, [desk.id])).rows;
  assert.equal(paid.length, 1);
  assert.deepEqual([biz.dstr(paid[0].payment_date), Number(paid[0].amount), paid[0].method,
    paid[0].taken_by, paid[0].currency, Number(paid[0].base_amount)],
    [ctx.day, 100000, "Card", "Adamu Bello", "NGN", 100000],
    "the deposit is dated the day the books are open on");
});

test("a stay over a weekend is billed the uplifted night, not a flat rate", async () => {
  const ctx = await boot();
  const P = require("../src/lib/price");
  const token = await guestToken(ctx, { email: ADAEZE });
  const out = await portal(ctx, token).post("/api/guest/bookings").send({
    roomTypeId: "ps", ratePlanId: "flex", checkIn: addDays(ctx.day, 30),
    checkOut: addDays(ctx.day, 32), adults: 3,
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));

  const q = out.body.quote;
  assert.ok(P.isWeekend(addDays(ctx.day, 30)), "the arrival this booking opens on is a weekend night");
  assert.deepEqual(q.nightly.map((n) => [n.date, n.rate, n.base, n.uplift]),
    [[addDays(ctx.day, 30), 1437500, 1250000, 187500], [addDays(ctx.day, 31), 1250000, 1250000, 0]],
    "the weekend night carries the list's 15% uplift, the one after it does not");
  assert.equal(q.roomTotal, 2687500);
  assert.equal(q.service, 268750);
  assert.equal(q.vat, 221700);
  assert.equal(q.total, 3177950);
  assert.equal(out.body.folio.balance, q.total);
});
