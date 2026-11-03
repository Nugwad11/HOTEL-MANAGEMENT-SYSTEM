/**
 * Bulk price files and rate plans against the API — the port of the desk's Bulk
 * update modal and the manager's plan editor. The point being proven is the one
 * the whole pricing module rests on: a file is only another way to feed the
 * single-row applier, so it cannot move a number the edit form could not, and it
 * cannot sign for itself. A plan is the other half of the same rule — it is the
 * multiplier every quote runs through, so its write is read back off the nights
 * the audit still owes and the stay the counter opens next.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays, DAY } = require("./helpers/api");
const { dstr } = require("../src/lib/business-date");

const NL = String.fromCharCode(10);
const file = (...lines) => lines.join(NL);
const HEAD = "Price ID,Service,Code,Price list,Amount,Currency,Effective from,Effective to,Status";
const REASON = "December diary review ahead of the festive bookings";

const rowOf = async (query, id) =>
  (await query(`SELECT amount, currency, from_date, to_date, active FROM prices WHERE id = $1`, [id])).rows[0];
const historyOf = async (query, id) =>
  (await query(`SELECT reason, recorded_by, from_data, to_data FROM price_history WHERE price_id = $1 ORDER BY recorded_at`, [id])).rows;
const pending = async (query) =>
  (await query(`SELECT id, kind, subject, subject_id, amount, from_value, to_value, change FROM approvals WHERE status = 'Pending'`)).rows;
const auditLines = async (query) =>
  (await query(`SELECT action, actor, detail FROM activity_log WHERE entity = 'pricing' ORDER BY created_at`)).rows;

/** One small change, one move over the property's limit, one row that is not there. */
const threeRowFile = file(
  HEAD,
  "prc_dk_std,Deluxe King,DLK,Standard 2026,240000,NGN,,,on sale",
  "prc_ps_std,Presidential Suite,PRS,Standard 2026,3100000,NGN,,,on sale",
  "prc_ghost_std,Unicorn Suite,UC1,Standard 2026,150000,NGN,,,on sale"
);

test("a preview says what a file would do and writes nothing at all", async () => {
  const { as, query } = await boot();
  const r = await as("Revenue").post("/api/pricing/import/preview").send({ text: threeRowFile, reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  assert.equal(r.body.limit, 500000);
  assert.deepEqual(r.body.counts, { change: 1, queue: 1, unchanged: 0, reject: 1 });
  assert.equal(r.body.rows[0].state, "change");
  assert.deepEqual(r.body.rows[0].diff, [["amount", 200000, 240000]]);
  assert.equal(r.body.rows[1].state, "queue");
  assert.equal(r.body.rows[1].move, 1850000);
  assert.equal(r.body.rows[2].state, "reject");
  assert.match(r.body.rows[2].error, /No price record matches id prc_ghost_std/);

  assert.equal((await rowOf(query, "prc_dk_std")).amount, 200000);
  assert.equal((await pending(query)).length, 0);
  assert.equal((await historyOf(query, "prc_dk_std")).length, 0);
});

test("applying a file writes the rows this caller may sign and holds the rest", async () => {
  const { as, query } = await boot();
  const r = await as("Revenue").post("/api/pricing/import").send({ text: threeRowFile, reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applied, 1);
  assert.equal(r.body.queued, 1);
  assert.equal(r.body.rejected, 1);

  assert.equal((await rowOf(query, "prc_dk_std")).amount, 240000);
  assert.equal((await rowOf(query, "prc_ps_std")).amount, 1250000, "the suite rate waits for a second signature");

  const held = await pending(query);
  assert.equal(held.length, 1);
  assert.equal(held[0].kind, "price");
  assert.equal(held[0].subject, "Presidential Suite · Standard 2026");
  assert.equal(Number(held[0].amount), 1850000);
  assert.equal(Number(held[0].from_value), 1250000);
  assert.equal(Number(held[0].to_value), 3100000);

  const hist = await historyOf(query, "prc_dk_std");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].reason, REASON);
  assert.equal(hist[0].recorded_by, "Chiamaka Obi");

  const lines = await auditLines(query);
  const line = lines.filter((l) => l.action === "imported prices from a file")[0];
  assert.ok(line, "the file is recorded in the trail");
  assert.match(line.detail, /1 price updated · 1 held for a second signature/);
  assert.match(line.detail, new RegExp(REASON.split(" ")[0]));
});

test("the held row lands through the approvals queue with the same history", async () => {
  const { as, query } = await boot();
  const r = await as("Revenue").post("/api/pricing/import").send({ text: threeRowFile, reason: REASON });
  const held = r.body.approvals[0];
  assert.equal(held.status, "Pending");

  const decided = await as("Manager").post(`/api/approvals/${held.id}/decide`)
    .send({ approve: true, note: "Checked against the compset before signing" });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((await rowOf(query, "prc_ps_std")).amount, 3100000);

  const hist = await historyOf(query, "prc_ps_std");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].reason, REASON, "the reason the file carried is the reason that landed");
});

test("a Manager's file signs its own wide move", async () => {
  const { as, query } = await boot();
  const r = await as("Manager").post("/api/pricing/import").send({ text: threeRowFile, reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applied, 2);
  assert.equal(r.body.queued, 0);
  assert.equal((await pending(query)).length, 0);
  assert.equal((await rowOf(query, "prc_dk_std")).amount, 240000);
  assert.equal((await rowOf(query, "prc_ps_std")).amount, 3100000);
});

test("a role that cannot price is refused the file at the door", async () => {
  const { as, query } = await boot();
  const preview = await as("Front Desk").post("/api/pricing/import/preview").send({ text: threeRowFile, reason: REASON });
  const apply = await as("Front Desk").post("/api/pricing/import").send({ text: threeRowFile, reason: REASON });
  assert.equal(preview.status, 403, JSON.stringify(preview.body));
  assert.equal(apply.status, 403, JSON.stringify(apply.body));
  assert.equal((await rowOf(query, "prc_dk_std")).amount, 200000);
});

test("a row that cannot be read is reported by line number and the good rows still land", async () => {
  const { as, query } = await boot();
  const text = file(
    HEAD,
    "prc_dk_std,Deluxe King,DLK,Standard 2026,two fifty,NGN,,,on sale",
    "prc_dk_fest,Deluxe King,DLK,Festive season,260000,NGN,,,on sale",
    "prc_dk_std,Deluxe King,DLK,Standard 2026,210000,NGN,,,on sale"
  );
  const preview = await as("Revenue").post("/api/pricing/import/preview").send({ text, reason: REASON });
  assert.equal(preview.body.rows[0].error, "Amount “two fifty” is not a number.");
  assert.equal(preview.body.rows[0].line, 2);
  assert.match(preview.body.rows[2].error, /line 2 already carries it/);

  const r = await as("Revenue").post("/api/pricing/import").send({ text, reason: REASON });
  assert.equal(r.body.applied, 1);
  assert.equal(r.body.rejected, 2);
  assert.equal((await rowOf(query, "prc_dk_fest")).amount, 260000);
  assert.equal((await rowOf(query, "prc_dk_std")).amount, 200000, "the duplicate never reaches the row");
});

test("a file that names no price id finds the row by code and list", async () => {
  const { as, query } = await boot();
  const text = file("Code,Price list,Amount", "DLK,Festive season,275000", "dlk,Standard 2026,205000");
  const r = await as("Revenue").post("/api/pricing/import").send({ text, reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.applied, 2);
  assert.deepEqual(r.body.rows.map((x) => x.priceId), ["prc_dk_fest", "prc_dk_std"]);
  assert.equal((await rowOf(query, "prc_dk_fest")).amount, 275000);
  assert.equal((await rowOf(query, "prc_dk_std")).amount, 205000, "the code is matched without its case");
});

test("a paste out of Excel separated by tabs reads the same file", async () => {
  const { as, query } = await boot();
  const text = threeRowFile.split(NL).map((line) => line.split(",").join("\t")).join(NL);
  const r = await as("Revenue").post("/api/pricing/import").send({ text, reason: REASON });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.counts, { change: 1, queue: 1, unchanged: 0, reject: 1 });
  assert.equal((await rowOf(query, "prc_dk_std")).amount, 240000);
});

test("a column the file leaves out is left alone; a named blank clears the window", async () => {
  const { as, query } = await boot();
  const set = file("Price ID,Effective from,Effective to", "prc_dk_std,2026-12-20,2027-01-05");
  const first = await as("Revenue").post("/api/pricing/import").send({ text: set, reason: REASON });
  assert.equal(first.body.applied, 1);
  const window = await rowOf(query, "prc_dk_std");
  assert.equal(dstr(window.from_date), "2026-12-20");
  assert.equal(dstr(window.to_date), "2027-01-05");
  assert.equal(Number(window.amount), 200000, "the amount column was never named, so it did not move");

  const cleared = await as("Revenue").post("/api/pricing/import")
    .send({ text: file("Price ID,Effective from,Effective to", "prc_dk_std,,"), reason: REASON });
  assert.equal(cleared.body.applied, 1);
  const after = await rowOf(query, "prc_dk_std");
  assert.equal(after.from_date, null);
  assert.equal(after.to_date, null);
});

test("a status column takes a price out of sale without touching the number", async () => {
  const { as, query } = await boot();
  const text = file("Price ID,Amount,Status", "prc_dk_std,200000,off");
  const r = await as("Revenue").post("/api/pricing/import").send({ text, reason: REASON });
  assert.equal(r.body.applied, 1);
  const row = await rowOf(query, "prc_dk_std");
  assert.equal(row.active, false);
  assert.equal(Number(row.amount), 200000);
});

test("a cell holding an unquoted comma is refused rather than read sideways", async () => {
  const { as, query } = await boot();
  const text = file("Price ID,Service,Amount", 'prc_dk_std,Deluxe King, Annex,240000');
  const preview = await as("Revenue").post("/api/pricing/import/preview").send({ text, reason: REASON });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.counts.reject, 1);
  assert.match(preview.body.rows[0].error, /quote any cell that contains a comma/);
  assert.equal((await rowOf(query, "prc_dk_std")).amount, 200000);
});

test("the currency column writes through the same applier as the amount", async () => {
  const { as, query } = await boot();
  // A row only moves into a money the books can value, so the fixing is filed
  // first — the same order the browser puts it in. The gap that opens is then
  // wider than the limit, so the hand writing it has to be one that can sign.
  const rate = await as("Manager").post("/api/fx/rates")
    .send({ code: "USD", perBase: 1550, note: "Treasury fixing" });
  assert.equal(rate.status, 201, JSON.stringify(rate.body));

  const text = file("Price ID,Amount,Currency", "prc_dk_std,250,usd");
  const r = await as("Manager").post("/api/pricing/import").send({ text, reason: REASON });
  assert.equal(r.body.applied, 1, JSON.stringify(r.body));
  const row = await rowOf(query, "prc_dk_std");
  assert.equal(row.currency, "USD", "a three-letter code is taken upper case");
  assert.equal(Number(row.amount), 250);
});

test("a file with no reason, no rows or no header is refused before it is planned", async () => {
  const { as } = await boot();
  const noReason = await as("Revenue").post("/api/pricing/import").send({ text: threeRowFile, reason: "" });
  assert.equal(noReason.status, 422, JSON.stringify(noReason.body));

  const headerOnly = await as("Revenue").post("/api/pricing/import").send({ text: HEAD, reason: REASON });
  assert.equal(headerOnly.status, 422);
  assert.match(headerOnly.body.error, /header line and at least one price/);

  const unnamed = await as("Revenue").post("/api/pricing/import")
    .send({ text: file("Service,Amount", "Deluxe King,240000"), reason: REASON });
  assert.equal(unnamed.status, 200, JSON.stringify(unnamed.body));
  assert.equal(unnamed.body.applied, 0);
  assert.equal(unnamed.body.rejected, 1);
  assert.match(unnamed.body.rows[0].error, /No price record matches/);
});

/* ── rate plans ─────────────────────────────────────────────── */

const PLAN_REASON = "Shoulder-season push agreed on the Tuesday revenue call";
const planRow = async (query, id) =>
  (await query(`SELECT code, name, modifier, deposit_pct, cancel_policy, includes FROM rate_plans WHERE id = $1`, [id])).rows[0];
const planLines = async (query) =>
  (await query(`SELECT action, actor, detail FROM activity_log WHERE entity = 'rate plan' ORDER BY created_at`)).rows;
const bookedMoney = async (query, id) => {
  const { rows } = await query(`SELECT room_total, service_chg, vat_amount, total, deposit FROM reservations WHERE id = $1`, [id]);
  const r = rows[0];
  return [r.room_total, r.service_chg, r.vat_amount, r.total, r.deposit].map(Number);
};

test("the plan read says what each plan sells tonight's night for", async () => {
  const { as } = await boot();
  const r = await as("Revenue").get("/api/pricing/plans?roomTypeId=dk");
  assert.equal(r.status, 200, JSON.stringify(r.body));

  // The five plans the desk books on, and the ₦200,000 the Deluxe King is on the
  // standard list for. The business day is a Thursday, so no weekend uplift rides
  // on any of these: each figure is the list rate with nothing but its own
  // modifier applied, then the 10% service and 7.5% VAT compounded on it.
  assert.deepEqual(r.body.map((p) => [p.code, p.modifier, p.tonight.base, p.tonight.rate, p.tonight.total]),
    [["ADV", 0.85, 170000, 170000, 201050],
     ["CLUB", 0.92, 184000, 184000, 217600],
     ["CORP", 0.88, 176000, 176000, 208100],
     ["FLEX", 1, 200000, 200000, 236500],
     ["OTA", 1.06, 212000, 212000, 250700]]);

  const flex = r.body[3];
  assert.equal(flex.name, "Flexible Rate");
  assert.equal(flex.depositPct, 25);
  assert.equal(flex.cancelPolicy, "Free cancellation until 48 hours before arrival");
  assert.equal(flex.includes, "Breakfast for two");
  assert.equal(flex.tonight.date, DAY);
  assert.equal(flex.tonight.list, "Standard 2026");
  assert.equal(flex.tonight.currency, "NGN");
  assert.equal(flex.tonight.uplift, 0);
  assert.deepEqual(flex.tonight.extras, []);
  assert.equal(flex.tonight.taxes, 36500);
});

test("a plan read that names no room has no rate to multiply and says so", async () => {
  const { as } = await boot();
  const plain = await as("Revenue").get("/api/pricing/plans");
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.length, 5);
  assert.deepEqual(plain.body.map((p) => p.tonight), [null, null, null, null, null]);

  const ghost = await as("Revenue").get("/api/pricing/plans?roomTypeId=unicorn");
  assert.equal(ghost.status, 422, JSON.stringify(ghost.body));
  assert.equal(ghost.body.error, "That room type is not on the books.");
});

test("only the two roles that hold the rate key may move a plan", async () => {
  const { as, anon, query } = await boot();
  const patch = { modifier: 0.9, reason: PLAN_REASON };
  for (const role of ["Front Desk", "Housekeeping", "Auditor", "Finance Manager"]) {
    const r = await as(role).patch("/api/pricing/plans/flex").send(patch);
    assert.equal(r.status, 403, `${role} — ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /manage_rates/);
  }
  assert.equal(Number((await planRow(query, "flex")).modifier), 1);

  const desk = await as("Front Desk").get("/api/pricing/plans?roomTypeId=dk");
  assert.equal(desk.status, 200, "the rate card a booking screen reads stays open to the desk");

  const unsigned = await anon.get("/api/pricing/plans");
  assert.equal(unsigned.status, 401);
});

test("a modifier write moves the nights nobody billed, never the folio somebody has", async () => {
  const ctx = await boot();
  const opened = await ctx.as("Front Desk").get("/api/reservations/res_1/folio");
  assert.equal(opened.body.total, 218000);

  const r = await ctx.as("Revenue").patch("/api/pricing/plans/flex")
    .send({ modifier: 0.9, reason: PLAN_REASON });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.modifier, 0.9);
  assert.deepEqual(r.body.moved, ["modifier 100% → 90%"]);

  // The in-house stay's first night was billed while the plan sold at 100%, and
  // its line keeps that figure; the two nights the audit still owes are priced off
  // the plan as it now stands. 90% of ₦200,000 is ₦180,000, its service ₦18,000
  // and the VAT on the pair ₦14,850.
  const pack = await ctx.as("Manager").get("/api/audit/pack?propertyId=agm");
  assert.deepEqual(pack.body.unbilled.map((n) => [n.date, n.quote.rate, n.quote.taxes]),
    [[addDays(DAY, -1), 180000, 32850], [DAY, 180000, 32850]]);
  assert.equal(pack.body.unbilledTotal, (180000 + 32850) * 2);

  const still = await ctx.as("Front Desk").get("/api/reservations/res_1/folio");
  assert.equal(still.body.total, 218000, "a re-priced plan cannot rewrite an opened folio");

  // The stay booked after the write is booked at the new multiplier, and the
  // reservation carries the money its own lines say.
  const next = await ctx.as("Front Desk").post("/api/reservations").send({
    propertyId: "agm", guestId: "gst_2", roomTypeId: "dk", ratePlanId: "flex",
    checkIn: addDays(DAY, 20), checkOut: addDays(DAY, 22), adults: 2,
  });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.deepEqual(await bookedMoney(ctx.query, next.body.id), [360000, 36000, 29700, 425700, 0]);
});

test("a deposit percentage moves the deposit the portal asks the guest for", async () => {
  const ctx = await boot();
  const token = await ctx.anon.post("/api/auth/guest").send({ email: "adaeze@meridian.ng" });
  assert.equal(token.status, 200, JSON.stringify(token.body));

  // The Flexible Rate at 30% of a ₦473,000 stay — the figures the quote panel is
  // showing, since a guest's own payment is never taken by the portal.
  const written = await ctx.as("Revenue").patch("/api/pricing/plans/flex")
    .send({ depositPct: 30, reason: PLAN_REASON });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(written.body.moved, ["deposit 25% → 30%"]);

  const booked = await ctx.bearer(token.body.token).post("/api/guest/bookings").send({
    roomTypeId: "dk", ratePlanId: "flex",
    checkIn: addDays(DAY, 20), checkOut: addDays(DAY, 22), adults: 2,
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal(booked.body.quote.total, 473000);
  assert.equal(booked.body.quote.deposit, 141900);
  assert.equal(Number((await bookedMoney(ctx.query, booked.body.booking.id))[4]), 0,
    "the portal tells the guest the deposit the plan asks for and takes nothing");
});

test("a plan write is a line in the trail that names both figures", async () => {
  const { as, query } = await boot();
  const r = await as("Revenue").patch("/api/pricing/plans/club").send({
    modifier: 0.88, depositPct: 10, includes: "Breakfast · 14:00 checkout · late checkout on request",
    cancelPolicy: "Free cancellation until 48 hours before arrival", reason: PLAN_REASON,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.moved, [
    "modifier 92% → 88%", "deposit 0% → 10%",
    'inclusions "Breakfast · 14:00 checkout" → "Breakfast · 14:00 checkout · late checkout on request"',
    'cancellation "Free cancellation until 24 hours before arrival" → "Free cancellation until 48 hours before arrival"',
  ]);

  const lines = await planLines(query);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].action, "changed a rate plan");
  assert.equal(lines[0].actor, "Chiamaka Obi");
  assert.match(lines[0].detail, /^Aurelia Club Rate · modifier 92% → 88% · deposit 0% → 10%/);
  assert.match(lines[0].detail, new RegExp(PLAN_REASON));

  const row = await planRow(query, "club");
  assert.equal(Number(row.modifier), 0.88);
  assert.equal(Number(row.deposit_pct), 10);
  assert.equal(row.cancel_policy, "Free cancellation until 48 hours before arrival",
    "the terms the caller wrote are the terms the guest is shown");

  // Posting the read-back of that plan straight again is a write that moves
  // nothing, and the trail says so rather than naming figures that never changed.
  const again = await as("Revenue").patch("/api/pricing/plans/club").send({
    modifier: r.body.modifier, depositPct: r.body.depositPct, includes: r.body.includes,
    cancelPolicy: r.body.cancelPolicy, reason: PLAN_REASON,
  });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body.moved, []);
  const after = await planLines(query);
  assert.equal(after.length, 2);
  assert.equal(after.filter((l) => /^Aurelia Club Rate · nothing moved · /.test(l.detail)).length, 1);
});

test("a plan write asks nobody for a second signature and rewrites no price row", async () => {
  const { as, query } = await boot();
  // Half the base rate is the widest move the form allows, and it is still signed
  // by one hand: the approval gate the spec raises is for the figures a guest
  // pays off a price row, and a plan is the multiplier the page's own editor sets.
  const r = await as("Revenue").patch("/api/pricing/plans/flex").send({ modifier: 0.5, reason: PLAN_REASON });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await pending(query)).length, 0);
  assert.equal((await historyOf(query, "prc_dk_std")).length, 0);
  assert.equal((await rowOf(query, "prc_dk_std")).amount, 200000, "the list rate the plan multiplies is untouched");
});

test("a plan outside the form's own bounds is refused before it reaches the row", async () => {
  const { as, query } = await boot();
  const cases = [
    [{ modifier: 0.4, reason: PLAN_REASON }, "A modifier below 0.50 is not a rate plan."],
    [{ modifier: 2.5, reason: PLAN_REASON }, "A plan cannot sell above twice the base rate."],
    [{ depositPct: 25.5, reason: PLAN_REASON }, "A deposit is a whole percentage."],
    [{ depositPct: -5, reason: PLAN_REASON }, "A deposit cannot be negative."],
    [{ depositPct: 101, reason: PLAN_REASON }, "A deposit cannot be more than the stay."],
    [{ includes: "", reason: PLAN_REASON }, "Name what the plan includes."],
    [{ cancelPolicy: "", reason: PLAN_REASON }, "Write the cancellation terms the guest is shown."],
    [{ modifier: 0.9 }, "A reason is required for the audit trail."],
    [{ reason: PLAN_REASON }, "Nothing to update."],
  ];
  for (const [body, error] of cases) {
    const r = await as("Revenue").patch("/api/pricing/plans/flex").send(body);
    assert.equal(r.status, 422, `${JSON.stringify(body)} — ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, error);
  }
  const row = await planRow(query, "flex");
  assert.equal(Number(row.modifier), 1);
  assert.equal(Number(row.deposit_pct), 25);

  const gone = await as("Revenue").patch("/api/pricing/plans/pl_ghost").send({ modifier: 0.9, reason: PLAN_REASON });
  assert.equal(gone.status, 404, JSON.stringify(gone.body));
  assert.equal(gone.body.error, "Rate plan not found.");

  // Only the four columns the editor owns can be written: a body that names the
  // plan's own identity, or the column by its database name, moves nothing but the
  // percentage it was asked for.
  const smuggled = await as("Revenue").patch("/api/pricing/plans/flex").send({
    depositPct: 40, id: "adv", code: "HIJACK", cancel_policy: "written straight to the column",
    propertyId: "ari", reason: PLAN_REASON,
  });
  assert.equal(smuggled.status, 200, JSON.stringify(smuggled.body));
  const after = await planRow(query, "flex");
  assert.equal(Number(after.deposit_pct), 40);
  assert.equal(after.code, "FLEX");
  assert.equal(after.cancel_policy, "Free cancellation until 48 hours before arrival");
});
