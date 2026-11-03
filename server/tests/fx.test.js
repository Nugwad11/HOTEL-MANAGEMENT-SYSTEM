/**
 * Multi-currency over the API — the port of the rules the browser app enforces,
 * proven against the same SQL and the same gates.
 *
 * Every assertion asks the ledger what it kept rather than what a page prints:
 * a rate is read as of the day the money moved, a folio and a document each hold
 * one money and one rate, an aggregate folds foreign money onto the books before
 * it adds, and a money the books cannot value is refused in the sentence that
 * says why.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays, defaultPermissions, USERS, DAY } = require("./helpers/api");
const { sign } = require("../src/lib/jwt");

const USD = 1550;   // the treasury fixing, on the air on the seeded day
const GBP = 1965;   // nine days old, so the books no longer trust it
const round50 = (n) => Math.round(n / 50) * 50;

const ATTEST = {
  arrivals: "Reviewed with the duty manager", folios: "Two balances chased with the guest",
  roomtax: "Posted by this run", payments: "Card settlement matched to the terminal",
  currency: "Both rates read against the treasury screen", housekeeping: "Handed to the morning shift",
  revenue: "Pack read against the dashboard", audit: "Trail exported",
};

/** File the fixings the desk works against: the dollar live, sterling off the air. */
async function fileRates(ctx) {
  const usd = await ctx.as("Manager").post("/api/fx/rates")
    .send({ code: "USD", perBase: USD, note: "Treasury fixing" });
  assert.equal(usd.status, 201, JSON.stringify(usd.body));
  const gbp = await ctx.as("Manager").post("/api/fx/rates")
    .send({ code: "GBP", perBase: GBP, effective: addDays(DAY, -9), note: "A nine-day-old memo" });
  assert.equal(gbp.status, 201, JSON.stringify(gbp.body));
  return ctx;
}

/** An account with nothing on it, so the first line picks its money. */
async function cleanFolio(ctx, id) {
  await ctx.query(`DELETE FROM charges  WHERE reservation_id = $1`, [id]);
  await ctx.query(`DELETE FROM payments WHERE reservation_id = $1`, [id]);
  return id;
}

const charge = (ctx, id, body) => ctx.as("Front Desk").post(`/api/reservations/${id}/charges`).send(body);
const pay = (ctx, id, body) => ctx.as("Front Desk").post(`/api/reservations/${id}/payments`).send(body);
const folioOf = async (ctx, id) => (await ctx.as("Front Desk").get(`/api/reservations/${id}/folio`)).body;
const rowsOf = async (ctx, sql) => (await ctx.query(sql)).rows;

test("a rate is read as of the day the money moved, and a later fixing cannot rewrite it", async () => {
  const ctx = await boot();
  await ctx.query(
    `INSERT INTO fx_rates (id,code,per_base,effective,set_by,note)
     VALUES ('fx_mid','USD',1512,$1,'Treasury','Mid-week fixing'),
            ('fx_day','USD',$2,$3,'Treasury','The fixing the books open on')`,
    [addDays(DAY, -4), USD, DAY]);
  await cleanFolio(ctx, "res_1");
  await cleanFolio(ctx, "res_3");

  const early = await charge(ctx, "res_1", { description: "Mid-week dollar line", amount: 100, currency: "USD", date: addDays(DAY, -4) });
  assert.equal(early.status, 201, JSON.stringify(early.body));
  assert.equal(Number(early.body.fx_rate), 1512, "the line is valued at what a dollar bought that day");
  assert.equal(Number(early.body.base_amount), 151200);

  const today = await charge(ctx, "res_3", { description: "Today's dollar line", amount: 100, currency: "USD" });
  assert.equal(Number(today.body.fx_rate), USD, "the same money on the open day reads the newer fixing");
  assert.equal(Number(today.body.base_amount), 155000);

  // A correction filed now says nothing about a night already billed.
  await ctx.as("Manager").post("/api/fx/rates").send({ code: "USD", perBase: 2000, note: "A wide move" });
  const kept = (await rowsOf(ctx, `SELECT * FROM charges WHERE id = '${early.body.id}'`))[0];
  assert.equal(Number(kept.base_amount), 151200, "a later fixing cannot rewrite yesterday");
  const f = await folioOf(ctx, "res_1");
  assert.equal(f.currency, "USD", "the balance the guest settles is in the money they were billed in");
  assert.equal(f.total, 100);
  assert.equal(f.fxRate, 1512, "and the folio keeps the rate its first line was posted at");
  assert.equal(f.baseTotal, 151200, "the balance the books hold is in the money of account");
});

test("fresh, stale and missing are three different answers with three different sentences", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");
  await cleanFolio(ctx, "res_3");

  const traded = await charge(ctx, "res_1", { description: "Dollar line", amount: 100, currency: "USD" });
  assert.equal(traded.status, 201, JSON.stringify(traded.body));

  const stale = await charge(ctx, "res_3", { description: "Sterling line", amount: 10, currency: "GBP" });
  assert.equal(stale.status, 422);
  assert.match(stale.body.error, /GBP rate was set on/, "the refusal says how old the figure is");
  assert.match(stale.body.error, /3 days/);

  const missing = await charge(ctx, "res_3", { description: "Euro line", amount: 10, currency: "EUR" });
  assert.equal(missing.status, 422);
  assert.match(missing.body.error, /EUR rate on file/, "a money with no row at all is refused in the same breath");

  assert.equal((await rowsOf(ctx, `SELECT id FROM charges WHERE reservation_id = 'res_3'`)).length, 0,
    "both refusals wrote nothing");
  const states = await ctx.as("Manager").get("/api/fx/states?propertyId=agm");
  assert.equal(states.status, 200);
  assert.deepEqual(states.body, [], "nothing on the shelf is priced in an unusable money yet");
});

test("the window a rate is trusted for is a rule on the property, not a constant", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");
  const refused = await charge(ctx, "res_1", { description: "Sterling line", amount: 10, currency: "GBP" });
  assert.equal(refused.status, 422, "nine days is outside a three-day window");

  const widened = await ctx.as("Manager").patch("/api/finance/settings").send({ rateMaxAgeDays: 30 });
  assert.equal(widened.status, 200, JSON.stringify(widened.body));
  const accepted = await charge(ctx, "res_1", { description: "Sterling line", amount: 10, currency: "GBP" });
  assert.equal(accepted.status, 201, "the same rate is usable again once the property stands behind it longer");
  assert.equal(Number(accepted.body.fx_rate), GBP, "widening the window never changes the figure, only the trust in it");
  assert.equal(Number(accepted.body.base_amount), round50(10 * GBP));

  const narrowed = await ctx.as("Manager").patch("/api/finance/settings").send({ rateMaxAgeDays: 1 });
  assert.equal(narrowed.status, 200);
  // On the sterling folio the rate is already pinned, so the window no longer
  // applies — the refusal has to come from an account that has not picked a money.
  await cleanFolio(ctx, "res_3");
  const closed = await charge(ctx, "res_3", { description: "Sterling again", amount: 10, currency: "GBP" });
  assert.equal(closed.status, 422, "and it closes when the property stops trusting its own history");
  assert.match(closed.body.error, /GBP rate was set on/);
});

test("a folio is billed in one money and the first line pins its rate", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");

  const opened = await charge(ctx, "res_1", { description: "Dollar line", amount: 100, currency: "USD" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));

  const clash = await charge(ctx, "res_1", { description: "Naira line", amount: 5000, currency: "NGN" });
  assert.equal(clash.status, 422);
  assert.match(clash.body.error, /billed in USD, not NGN/);
  assert.match(clash.body.error, /one currency/, "the sentence says what to do about it");

  // Money handed in is held to the same rule: a naira note settles a naira bill.
  const paidIn = await pay(ctx, "res_1", { amount: 50, currency: "NGN" });
  assert.equal(paidIn.status, 422);
  assert.match(paidIn.body.error, /billed in USD, not NGN/);
  assert.equal((await rowsOf(ctx, `SELECT id FROM charges WHERE reservation_id = 'res_1'`)).length, 1,
    "the refused line wrote nothing");

  // The account is a dollar account: every line after it converts at the rate the
  // folio opened at, whatever the treasury files afterwards.
  await ctx.as("Manager").post("/api/fx/rates").send({ code: "USD", perBase: 2000, note: "Treasury jump" });
  const again = await charge(ctx, "res_1", { description: "Second dollar line", amount: 50, currency: "USD" });
  assert.equal(again.status, 201);
  assert.equal(Number(again.body.fx_rate), USD, "the stay was agreed at one rate and is kept at it");
  assert.equal(Number(again.body.base_amount), 77500);
  const f = await folioOf(ctx, "res_1");
  assert.equal(f.total, 150);
  assert.equal(f.baseTotal, 232500, "both lines fold onto the books at the pinned figure");
});

test("a payment onto a folio is taken in the folio's money at the folio's rate", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");
  await charge(ctx, "res_1", { description: "Dollar room", amount: 100, currency: "USD", department: "Rooms" });

  const first = await pay(ctx, "res_1", { amount: 40, method: "Card" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.currency, "USD", "a guest paying into a dollar account pays dollars");
  assert.equal(Number(first.body.fx_rate), USD);
  assert.equal(Number(first.body.base_amount), 62000);

  await ctx.as("Manager").post("/api/fx/rates").send({ code: "USD", perBase: 2000, note: "A later fixing" });
  const second = await pay(ctx, "res_1", { amount: 10, method: "Cash" });
  assert.equal(Number(second.body.fx_rate), USD, "the till does not re-value the account on its own");
  assert.equal(Number(second.body.base_amount), 15500);

  const f = await folioOf(ctx, "res_1");
  assert.equal(f.balance, 50, "what the guest still owes is in their money");
  assert.equal(f.baseBalance, 77500, "and what the property carries is the same debt in its own");
});

test("a document pins the rate it was raised at and settles at it", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");
  await charge(ctx, "res_1", { description: "Board hire — dollars", amount: 2000, currency: "USD", department: "Rooms" });

  const raised = await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_1" });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  const inv = raised.body;
  assert.equal(inv.currency, "USD", "the invoice is written in the money the account is kept in");
  assert.equal(inv.fxRate, USD, "and carries the rate it was raised at");
  assert.equal(inv.lines[0].fxRate, USD, "every line converts at the document rate");
  assert.equal(inv.totals.total, 2000, "the guest owes two thousand dollars");
  assert.equal(inv.totals.base.total, 3100000, "the books hold three million one hundred thousand naira");

  await ctx.as("Manager").post("/api/fx/rates").send({ code: "USD", perBase: 1900, note: "A later fixing" });
  const paid = await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`)
    .send({ amount: 1000, method: "Transfer" });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  assert.equal(paid.body.payment.currency, "USD", "cash against a dollar document is dollars");
  assert.equal(paid.body.payment.fxRate, USD, "at the document rate, not the figure filed this morning");
  assert.equal(paid.body.payment.baseAmount, 1550000);
  assert.equal(paid.body.totals.balance, 1000);
  assert.equal(paid.body.totals.base.balance, 1550000, "the debt left on the books is the same debt in naira");

  const lines = await rowsOf(ctx, `SELECT currency, fx_rate, base_amount FROM payments WHERE invoice_id = '${inv.id}'`);
  assert.equal(lines[0].currency, "USD", "the money row itself carries the stamp, so a report cannot read it as naira");
  assert.equal(Number(lines[0].base_amount), 1550000);
});

test("a document that mixes monies is refused before a line is written", async () => {
  const ctx = await fileRates(await boot());
  const mixed = await ctx.as("Front Desk").post("/api/billing/invoices").send({
    propertyId: "agm",
    notes: "One bill, two monies",
    lines: [
      { description: "In dollars", amount: 100, currency: "USD" },
      { description: "In naira", amount: 5000, currency: "NGN" },
    ],
  });
  assert.equal(mixed.status, 422, JSON.stringify(mixed.body));
  assert.match(mixed.body.error, /mix USD and NGN/, "the two monies are named in the refusal");
  assert.equal((await rowsOf(ctx, `SELECT id FROM invoices`)).length, 0,
    "a refused document writes no half-valued header");

  const single = await ctx.as("Front Desk").post("/api/billing/invoices").send({
    propertyId: "agm",
    lines: [{ description: "In dollars", amount: 100, currency: "USD" }],
  });
  assert.equal(single.status, 201, JSON.stringify(single.body));
  assert.equal(single.body.currency, "USD");
  assert.equal(single.body.fxRate, USD, "a document in one money takes that money and its rate");
});

test("a foreign document cannot be raised once its money has gone off the air", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");
  await charge(ctx, "res_1", { description: "Dollars while the dollar trades", amount: 100, currency: "USD" });

  // The day runs on without anyone refreshing the fixing; the money stops existing.
  await ctx.query(`UPDATE business_date SET day = $1 WHERE id = 1`, [addDays(DAY, 4)]);
  const late = await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_1" });
  assert.equal(late.status, 422);
  assert.match(late.body.error, /USD/, "the refusal names the money that has gone off the air");
  assert.equal((await rowsOf(ctx, `SELECT id FROM invoices WHERE reservation_id = 'res_1'`)).length, 0,
    "no half-valued document was written");
});

test("a refund on a foreign document is judged on the money it hands back", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");
  await charge(ctx, "res_1", { description: "Dollar board", amount: 2000, currency: "USD", department: "Rooms" });
  const inv = (await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_1" })).body;
  await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/payments`).send({ amount: 1000, method: "Transfer" });

  const asked = await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/refunds`)
    .send({ amount: 400, reason: "Over-billed on the board" });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const queued = asked.body.queued;
  assert.equal(queued.kind, "refund");
  assert.equal(queued.to, 400, "the figure handed back is the document money");
  assert.equal(queued.toCurrency, "USD", "and it keeps its own name on the request");
  assert.equal(queued.amount, 620000, "the limit is judged on the naira it hands back");
  assert.equal(queued.currency, "NGN", "stated in the money the limit is written in");
  assert.match(queued.subject, /USD/, "and the heading says which money the guest holds");
  assert.equal((await rowsOf(ctx, `SELECT id FROM refunds`)).length, 0, "nothing left the till while it waited");

  const cleared = await ctx.as("Manager").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: true, note: "Signed against the bank screen" });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const rows = await rowsOf(ctx, `SELECT currency, fx_rate, base_amount, amount FROM refunds`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].currency, "USD", "the refund leaves in the money the guest paid in");
  assert.equal(Number(rows[0].fx_rate), USD, "at the rate the document was raised at");
  assert.equal(Number(rows[0].base_amount), 620000, "and the books lose what the books once gained");
});

test("a cost in a money the books cannot value is not a cost the property can record", async () => {
  const ctx = await fileRates(await boot());
  const sterling = await ctx.as("Housekeeping").post("/api/finance/expenses")
    .send({ amount: 10, currency: "GBP", category: "Repairs & maintenance", description: "Supplier in sterling" });
  assert.equal(sterling.status, 422, JSON.stringify(sterling.body));
  assert.match(sterling.body.error, /GBP/);

  const dollar = await ctx.as("Housekeeping").post("/api/finance/expenses")
    .send({ amount: 100, currency: "USD", category: "Repairs & maintenance", description: "Supplier in dollars" });
  assert.equal(dollar.status, 201, JSON.stringify(dollar.body));
  assert.equal(dollar.body.currency, "USD");
  assert.equal(dollar.body.fxRate, USD);
  assert.equal(dollar.body.baseAmount, 155000, "the books hold what the invoice cost on the day it was dated");

  // A foreign line is measured by what it costs here, not by the figure on it.
  const wide = await ctx.as("Housekeeping").post("/api/finance/expenses")
    .send({ amount: 400000, currency: "USD", category: "Other operating", description: "A very large dollar invoice" });
  assert.equal(wide.status, 422, JSON.stringify(wide.body));
  assert.match(wide.body.error, /500,000,000/, "the ceiling is written in the money of account");
});

test("a rate is filed by the General Manager alone; every other hand waits and replays", async () => {
  const perms = defaultPermissions();
  perms.Revenue.manage_financial_settings = true;
  const ctx = await boot({ permissions: perms });
  await fileRates(ctx);

  const door = await ctx.as("Front Desk").post("/api/fx/rates").send({ code: "USD", perBase: 1600, note: "A screen reading" });
  assert.equal(door.status, 403, "a desk that holds no settings cannot move the money the books are kept in");

  const asked = await ctx.as("Revenue").post("/api/fx/rates").send({ code: "USD", perBase: 1700, note: "Bank screen" });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.queued.kind, "fx");
  assert.equal(asked.body.queued.amount, 1700 - USD, "the request is judged on the gap it moves");
  assert.equal(asked.body.queued.currency, "NGN", "a rate is quoted in the money the books keep");
  assert.equal(asked.body.queued.from, USD);
  assert.equal(asked.body.queued.to, 1700);
  assert.equal((await rowsOf(ctx, `SELECT id FROM fx_rates WHERE per_base = 1700`)).length, 0, "nothing landed while it waited");

  const self = await ctx.as("Revenue").post(`/api/approvals/${asked.body.queued.id}/decide`)
    .send({ approve: true, note: "I filed this myself" });
  assert.equal(self.status, 403, "a right to file a rate is not a right to sign one");

  // A wider grant handed to the same human still puts the same hands on both sides.
  const signedTwice = sign(Object.assign({}, USERS.Revenue, {
    role: "Revenue", propertyId: "agm", guestId: null,
    permissions: { manage_financial_settings: true, approve_financial_changes: true },
  }));
  const own = await ctx.bearer(signedTwice).post(`/api/approvals/${asked.body.queued.id}/decide`)
    .send({ approve: true, note: "I hold the right now" });
  assert.equal(own.status, 422, JSON.stringify(own.body));
  assert.match(own.body.error, /second pair of hands/);
  assert.equal((await rowsOf(ctx, `SELECT id FROM fx_rates WHERE per_base = 1700`)).length, 0,
    "the widened ask landed nothing");

  const cleared = await ctx.as("Manager").post(`/api/approvals/${asked.body.queued.id}/decide`)
    .send({ approve: true, note: "Signed against the bank screen" });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  await cleanFolio(ctx, "res_1");
  const line = await charge(ctx, "res_1", { description: "Line after the clearing", amount: 100, currency: "USD" });
  assert.equal(Number(line.body.fx_rate), 1700, "clearing it files the rate the approver read");

  // A rate somebody else moved while the request waited goes back rather than
  // silently overwriting the newer figure.
  const sterling = await ctx.as("Revenue").post("/api/fx/rates").send({ code: "GBP", perBase: 2000, note: "Sterling memo" });
  assert.equal(sterling.status, 202);
  await ctx.as("Manager").post("/api/fx/rates").send({ code: "GBP", perBase: 1990, note: "A later bank screen" });
  const stale = await ctx.as("Manager").post(`/api/approvals/${sterling.body.queued.id}/decide`)
    .send({ approve: true, note: "Clearing the older ask" });
  assert.equal(stale.status, 422);
  assert.match(stale.body.error, /moved since this was asked/);
  const rows = await rowsOf(ctx, `SELECT per_base FROM fx_rates WHERE code = 'GBP' AND effective = '${DAY}'`);
  assert.equal(Number(rows[0].per_base), 1990, "the newer figure stands");

  // The controller holds the settings right and the signing right both, and still
  // waits: a rate revalues every foreign figure on these books, so it is filed on
  // another hand's word rather than their own.
  const controller = await ctx.as("Finance Manager").post("/api/fx/rates")
    .send({ code: "USD", perBase: 1750, note: "Controller's fixing" });
  assert.equal(controller.status, 202, JSON.stringify(controller.body));
  assert.equal(controller.body.queued.requestedBy, "Emeka Balogun");

  const bothHands = await ctx.as("Finance Manager").post(`/api/approvals/${controller.body.queued.id}/decide`)
    .send({ approve: true, note: "I hold both rights" });
  assert.equal(bothHands.status, 422, JSON.stringify(bothHands.body));
  assert.match(bothHands.body.error, /second pair of hands/);

  const theirs = await ctx.as("Manager").post(`/api/approvals/${controller.body.queued.id}/decide`)
    .send({ approve: true, note: "Signed against the treasury screen" });
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  assert.equal((await rowsOf(ctx, `SELECT id FROM fx_rates WHERE per_base = 1750`)).length, 1,
    "and it lands through the same replay as any other ask");
});

test("the plan refuses a rate that is not a rate before it reaches the register", async () => {
  const ctx = await boot();
  const refusals = [
    [{ code: "USD", perBase: 0, note: "x" }, /above zero/],
    [{ code: "NGN", perBase: 1, note: "x" }, /always stands at 1/],
    [{ code: "ZAR", perBase: 1, note: "x" }, /not among them/],
    [{ code: "usd", perBase: "abc", note: "x" }, /greater than zero|number/],
    [{ code: "EUR", perBase: 1700, effective: addDays(DAY, 5), note: "x" }, /take effect in the future/],
    [{ code: "EUR", perBase: 1700, effective: "30 Oct 2026", note: "x" }, /2026-10-30 shape/],
    [{ code: "EUR", perBase: 1700, effective: DAY }, /where the rate came from/],
  ];
  for (const [body, pattern] of refusals) {
    const r = await ctx.as("Manager").post("/api/fx/rates").send(body);
    assert.equal(r.status, 422, JSON.stringify(r.body) + " for " + JSON.stringify(body));
    assert.match(r.body.error, pattern);
  }
  assert.equal((await rowsOf(ctx, `SELECT id FROM fx_rates`)).length, 0, "every refusal above filed nothing");

  const euro = await ctx.as("Manager").post("/api/fx/rates")
    .send({ code: "EUR", perBase: 1700, effective: DAY, note: "ECB fixing" });
  assert.equal(euro.status, 201, JSON.stringify(euro.body));
  assert.equal(euro.body.previous, null, "there was no earlier euro rate to hand over from");
  await cleanFolio(ctx, "res_1");
  const line = await charge(ctx, "res_1", { description: "Euro line", amount: 100, currency: "EUR" });
  assert.equal(line.status, 201, "the money is on the books from the moment the row exists");
});

test("an aggregate folds foreign money onto the books before it adds", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");
  await cleanFolio(ctx, "res_3");
  await charge(ctx, "res_3", { description: "Naira room", amount: 100000, currency: "NGN", department: "Rooms" });
  await charge(ctx, "res_1", { description: "Dollar room", amount: 100, currency: "USD", department: "Rooms" });

  const pack = await ctx.as("Manager").get("/api/audit/pack?propertyId=agm");
  assert.equal(pack.status, 200, JSON.stringify(pack.body));
  assert.equal(pack.body.chargesTotal, 255000, "a dollar line and a naira line add as naira, never as 100,100,000");
  assert.ok(pack.body.charges.every((c) => typeof c.baseAmount === "number"), "every line says what the books kept");
  const dollar = pack.body.charges.find((c) => c.currency === "USD");
  assert.equal(dollar.amount, 100, "and still shows the figure the guest holds beside it");
  assert.equal(dollar.baseAmount, 155000);
});

test("the close names the money it cannot value and stops rather than half-billing the day", async () => {
  const ctx = await boot();
  await cleanFolio(ctx, "res_1");
  // Nights for the seeded room type are owed in dollars with no fixing on file.
  // No desk could have put them there — the currency gate refuses a price the
  // books cannot value, exactly as the browser does — so the catalogue is moved
  // by writing the row the way the browser test writes its database.
  await ctx.query(`UPDATE prices SET currency = 'USD', amount = 150 WHERE id = 'prc_dk_std'`);

  const pack = await ctx.as("Manager").get("/api/audit/pack?propertyId=agm");
  assert.equal(pack.body.unbilled.length, 0, "a night the price read refuses is not a night it can promise");
  assert.equal(pack.body.unbillable.length, 3, "but the close knows the nights are owed in it");
  assert.deepEqual(pack.body.rates.map((r) => r.code + ":" + r.state), ["USD:missing"]);
  const checks = (await ctx.as("Manager").get("/api/audit/checks?propertyId=agm")).body.checks;
  assert.match(checks.find((c) => c.key === "currency").detail, /USD \(missing\) cannot be valued today/);
  assert.match(checks.find((c) => c.key === "roomtax").detail, /priced in USD cannot be valued/);
  assert.match(checks.find((c) => c.key === "roomtax").detail, /this run stops/);

  const before = (await rowsOf(ctx, `SELECT id FROM charges`)).length;
  const refused = await ctx.as("Manager").post("/api/audit/run").send({ propertyId: "agm", checks: ATTEST });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(refused.body.error, /cannot post every open night/);
  assert.match(refused.body.error, /USD/, "the refusal names the money that has no rate");
  assert.equal((await rowsOf(ctx, `SELECT id FROM charges`)).length, before, "nothing was posted, so nothing has to be unpicked");
  assert.equal((await rowsOf(ctx, `SELECT date FROM closed_days`)).length, 0, "the day is still open");

  // The fixing has to be dated the first night the books owe: a rate is read as
  // of the day it is asked about, so a figure filed today says nothing about a
  // night three days gone.
  const filed = await ctx.as("Manager").post("/api/fx/rates")
    .send({ code: "USD", perBase: USD, effective: addDays(DAY, -2), note: "The fixing was never filed" });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  const owed = (await ctx.as("Manager").get("/api/audit/pack?propertyId=agm")).body.unbilled;
  assert.equal(owed.length, 3, "the nights are billable again the moment the money is worth something");
  assert.deepEqual(owed.map((n) => n.date), [addDays(DAY, -2), addDays(DAY, -1), DAY]);

  const sealed = await ctx.as("Manager").post("/api/audit/run").send({ propertyId: "agm", checks: ATTEST });
  assert.equal(sealed.status, 201, JSON.stringify(sealed.body));
  assert.equal(sealed.body.posted.length, 3);
  assert.ok(sealed.body.posted.every((p) => p.currency === "USD"), "each night keeps the money it was agreed in");
  const rooms = (await rowsOf(ctx, `SELECT * FROM charges WHERE currency = 'USD' AND department = 'Rooms'`))
    .sort((a, b) => String(a.charge_date).localeCompare(String(b.charge_date)));
  assert.equal(rooms.length, 3);
  assert.equal(Number(rooms[0].fx_rate), USD, "and the rate the close found on the day it billed");
  assert.equal(Number(rooms[0].base_amount), round50(150 * USD), "the books hold the conversion, frozen");

  const seal = (await rowsOf(ctx, `SELECT * FROM closed_days ORDER BY date DESC LIMIT 1`))[0];
  const posted = typeof seal.posted === "string" ? JSON.parse(seal.posted) : seal.posted;
  assert.equal(Number(seal.posted_total), posted.reduce((s, p) => s + p.baseAmount, 0),
    "the seal totals the close in the money of account, not in the monies it billed in");
});

/* ── the approval gate reads every figure in its own money ─────── */

const priceRow = async (ctx, id) =>
  (await rowsOf(ctx, `SELECT amount, currency FROM prices WHERE id = '${id}'`))[0];

test("a dollar price move is weighed on the books and the request names every figure", async () => {
  const ctx = await fileRates(await boot());
  assert.equal((await priceRow(ctx, "prc_dk_corp")).currency, "USD");
  assert.equal(Number((await priceRow(ctx, "prc_dk_corp")).amount), 150);

  const asked = await ctx.as("Revenue").patch("/api/pricing/prices/prc_dk_corp")
    .send({ amount: 900, reason: "Corporate re-pricing in dollars" });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const queued = asked.body.queued;
  assert.equal(queued.kind, "price");
  assert.equal(queued.amount, 1162500, "the limit is tested on what the move is worth on the books");
  assert.equal(queued.currency, "NGN", "and the gap is stated in the money of account");
  assert.equal(queued.from, 150);
  assert.equal(queued.to, 900);
  assert.equal(queued.fromCurrency, "USD", "the two figures a signer compares are the row's own money");
  assert.equal(queued.toCurrency, "USD");
  assert.equal(Number((await priceRow(ctx, "prc_dk_corp")).amount), 150,
    "a seven-hundred-and-fifty-dollar move waited instead of landing");
  assert.match((await rowsOf(ctx, `SELECT detail FROM activity_log WHERE entity = 'approval'`))[0].detail,
    /1162500 NGN/, "and the trail says which money was weighed, not a bare number");

  const cleared = await ctx.as("Manager").post(`/api/approvals/${queued.id}/decide`)
    .send({ approve: true, note: "Signed against the treasury sheet" });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(Number((await priceRow(ctx, "prc_dk_corp")).amount), 900,
    "the signature lands the patch that was asked for, in the money the row holds");
  assert.equal((await priceRow(ctx, "prc_dk_corp")).currency, "USD", "and does not quietly re-base it");
});

test("a file is judged on what its foreign rows are worth here, not on the figures on them", async () => {
  const ctx = await fileRates(await boot());
  const text = ["Price ID,Amount", "prc_dk_corp,500", "prc_dk_std,400000"].join("\n");

  const preview = await ctx.as("Revenue").post("/api/pricing/import/preview").send({ text, reason: "Contract renewal" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body.counts, { change: 1, queue: 1, unchanged: 0, reject: 0 },
    "three hundred and fifty dollars is a wider move here than two hundred and fifteen thousand naira");
  const dollar = preview.body.rows.find((r) => r.priceId === "prc_dk_corp");
  assert.equal(dollar.state, "queue");
  assert.equal(dollar.move, 542500, "the row is weighed in the money of account");
  assert.equal(dollar.currency, "NGN", "and the plan says so");
  assert.equal(dollar.current.currency, "USD", "while the figures it shows stay the row's own");

  const out = await ctx.as("Revenue").post("/api/pricing/import").send({ text, reason: "Contract renewal" });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.applied, 1);
  assert.equal(out.body.queued, 1);
  const held = out.body.approvals[0];
  assert.equal(held.subjectId, "prc_dk_corp");
  assert.equal(held.amount, 542500);
  assert.equal(held.currency, "NGN");
  assert.equal(held.fromCurrency, "USD");
  assert.equal(held.toCurrency, "USD");
  assert.equal(Number((await priceRow(ctx, "prc_dk_corp")).amount), 150, "the dollar row waited");
  assert.equal(Number((await priceRow(ctx, "prc_dk_std")).amount), 400000, "the naira row landed");
});

test("a hand that owes a signature is refused when the books cannot value the money", async () => {
  const ctx = await boot();   // nothing filed: neither dollar nor sterling has a rate
  const before = await priceRow(ctx, "prc_dk_std");
  const refused = await ctx.as("Revenue").patch("/api/pricing/prices/prc_dk_std")
    .send({ currency: "USD", amount: 500, reason: "Nights sold in dollars" });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.match(refused.body.error, /USD.*cannot be valued|no USD rate/,
    "the sentence says what is missing rather than pretending the move was small");
  assert.equal((await rowsOf(ctx, `SELECT id FROM approvals`)).length, 0, "an ask nobody can weigh is not filed as an ask");
  assert.equal(Number((await priceRow(ctx, "prc_dk_std")).amount), Number(before.amount), "and the row did not move");

  // A file is held to the same rule: the row is refused while it is being
  // planned, so it never reaches the queue as a gap nobody can price.
  const text = ["Price ID,Amount,Currency", "prc_dk_std,250,usd"].join("\n");
  const preview = await ctx.as("Revenue").post("/api/pricing/import/preview")
    .send({ text, reason: "Dollar re-booking" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.counts.reject, 1, "the file rejects the row rather than weighing it");
  assert.match(preview.body.rows[0].error, /USD/);

  // The same hand, once the money is worth something, is queued on the figure.
  await ctx.as("Manager").post("/api/fx/rates").send({ code: "USD", perBase: USD, note: "Treasury fixing" });
  const asked = await ctx.as("Revenue").patch("/api/pricing/prices/prc_dk_std")
    .send({ currency: "USD", amount: 500, reason: "Nights sold in dollars" });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.queued.amount, round50(Math.abs(500 - Number(before.amount)) * USD),
    "the gap is the row's own figure folded, so a naira row turned into dollars is weighed in dollars");
  assert.equal(asked.body.queued.fromCurrency, "NGN");
  assert.equal(asked.body.queued.toCurrency, "USD");
});

test("a queued discount stays in the money the document is billed in", async () => {
  const ctx = await fileRates(await boot());
  await cleanFolio(ctx, "res_1");
  await charge(ctx, "res_1", { description: "Dollar board", amount: 200, currency: "USD", department: "Rooms" });
  const inv = (await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_1" })).body;
  assert.equal((await rowsOf(ctx, `SELECT currency FROM invoices WHERE id = '${inv.id}'`))[0].currency, "USD",
    "the folio opened in dollars, so its discount is a dollar figure");

  const asked = await ctx.as("Front Desk").post(`/api/billing/invoices/${inv.id}/discounts`)
    .send({ amount: 30, reason: "Contract courtesy on the dollar board" });
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  assert.equal(asked.body.queued.kind, "discount");
  assert.equal(asked.body.queued.amount, 30, "a discount is a share of the document, so its figure stays the document's");
  assert.equal(asked.body.queued.currency, "USD", "and is not read as thirty naira by whoever signs it");
  assert.match((await rowsOf(ctx, `SELECT detail FROM activity_log WHERE action = 'asked for approval of a discount'`))[0].detail,
    /30 USD/);
});
