/**
 * Finance API — the settings that gate money, the expense ledger with its two
 * hands, and the statement that counts revenue as earned rather than collected.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays, DAY, FINANCE_DEFAULTS } = require("./helpers/api");

test("financial settings fall back to the documented defaults", async () => {
  const { as } = await boot();
  const r = await as("Manager").get("/api/finance/settings?propertyId=agm");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, FINANCE_DEFAULTS);
});

test("only a holder of the settings right may move a limit", async () => {
  const { as } = await boot();
  for (const role of ["Front Desk", "Revenue", "Auditor", "Housekeeping"]) {
    const r = await as(role).patch("/api/finance/settings").send({ approvalAmount: 10 });
    assert.equal(r.status, 403, `${role} should not reach the settings`);
  }
});

test("a changed prefix numbers the next document, not the last one", async () => {
  const ctx = await boot();
  const first = await ctx.as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_1" });
  assert.equal(first.body.number, "AGM-INV-0001");

  const patch = await ctx.as("Manager").patch("/api/finance/settings")
    .send({ propertyId: "agm", invoicePrefix: "lag", approvalAmount: 5000000 });
  assert.equal(patch.status, 200);
  assert.deepEqual(patch.body.settings.invoicePrefix, "LAG");
  assert.deepEqual(patch.body.changed, ["prefix AGM to LAG", "approval limit 500000 to 5000000"]);

  const second = await ctx.as("Front Desk").post("/api/billing/invoices").send({
    propertyId: "agm", lines: [{ description: "Courtesy fruit", amount: 25000 }],
  });
  assert.equal(second.body.number, "LAG-INV-0002");
  // The document already raised keeps the number it was issued under.
  const doc = await ctx.as("Front Desk").get(`/api/billing/invoices/${first.body.id}`);
  assert.equal(doc.body.number, "AGM-INV-0001");
});

test("a setting outside its bounds or unchanged is refused", async () => {
  const { as } = await boot();
  const over = await as("Manager").patch("/api/finance/settings").send({ paymentDays: 91 });
  assert.equal(over.status, 422);
  assert.match(over.body.error, /Days to pay has to be between 0 and 90/);

  const blank = await as("Manager").patch("/api/finance/settings").send({ invoicePrefix: "  " });
  assert.equal(blank.status, 422);
  assert.match(blank.body.error, /at least one letter or figure/);

  const same = await as("Manager").patch("/api/finance/settings").send({ paymentDays: 7 });
  assert.equal(same.status, 422);
  assert.match(same.body.error, /Nothing in these settings has changed/);
});

test("a recorded expense waits for a second signature before it reaches the result", async () => {
  const ctx = await boot();
  const r = await ctx.as("Housekeeping").post("/api/finance/expenses").send({
    category: "Utilities", amount: 145000, description: "Diesel for the generator", payee: "Indastar",
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, "Pending");
  assert.equal(r.body.recordedBy, "Grace Mensah");

  // Housekeeping records costs but cannot let one in.
  const denied = await ctx.as("Housekeeping").post(`/api/finance/expenses/${r.body.id}/decide`).send({ approve: true });
  assert.equal(denied.status, 403);

  const approved = await ctx.as("Manager").post(`/api/finance/expenses/${r.body.id}/decide`)
    .send({ approve: true, note: "Matched to the fuel log" });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, "Approved");

  const twice = await ctx.as("Manager").post(`/api/finance/expenses/${r.body.id}/decide`)
    .send({ approve: false, note: "Second thoughts" });
  assert.equal(twice.status, 422);
  assert.match(twice.body.error, /already approved by Ifeoma Okafor/);
});

test("an expense is refused for shape, for the future, and for a sealed day", async () => {
  const ctx = await boot();
  const zero = await ctx.as("Housekeeping").post("/api/finance/expenses")
    .send({ category: "Utilities", amount: 0, description: "Nothing" });
  assert.equal(zero.status, 422);

  const unknown = await ctx.as("Housekeeping").post("/api/finance/expenses")
    .send({ category: "Yachts", amount: 50000, description: "A yacht" });
  assert.equal(unknown.status, 422);
  assert.match(unknown.body.error, /Choose an expense category/);

  const future = await ctx.as("Housekeeping").post("/api/finance/expenses")
    .send({ category: "Utilities", amount: 50000, description: "Next month", date: addDays(DAY, 3) });
  assert.equal(future.status, 422);
  assert.match(future.body.error, /cannot be dated in the future/);

  await ctx.query(`INSERT INTO closed_days (date,rolled_to,closed_at,closed_by,stats)
                   VALUES ($1,$2,now(),'Ifeoma Okafor','{}')`, [addDays(DAY, -1), DAY]);
  const sealed = await ctx.as("Housekeeping").post("/api/finance/expenses")
    .send({ category: "Utilities", amount: 50000, description: "Back-dated", date: addDays(DAY, -1) });
  assert.equal(sealed.status, 409);
  assert.match(sealed.body.error, /closed and sealed/);
});

test("the statement counts revenue as earned and only approved costs in the result", async () => {
  const { as, query } = await boot();
  const r = await as("Auditor").get("/api/finance/statement?propertyId=agm&days=30");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.now;
  // 200,000 + 18,000 + 1,250,000 of non-void charges, all inside the window.
  assert.equal(s.revenue, 1468000);
  assert.equal(s.taxBilled, 0);
  assert.equal(s.byDept.Rooms, 1450000);
  assert.equal(s.collected, 412500);
  assert.equal(s.expenses, 0, "a cost that has not been signed for is not a cost yet");

  await query(`INSERT INTO expenses (id,property_id,expense_date,category,description,amount,status)
               VALUES ('exp_1','agm',$1,'Utilities','Diesel',100000,'Pending'),
                      ('exp_2','agm',$1,'Payroll','Salaries',400000,'Approved')`, [addDays(DAY, -1)]);
  const again = await as("Auditor").get("/api/finance/statement?propertyId=agm&days=30");
  assert.equal(again.body.now.expenses, 400000);
  assert.equal(again.body.now.expensesPending, 100000);
  assert.equal(again.body.now.net, 1468000 - 400000);
});

test("guest debt is measured at the folio, never twice", async () => {
  const { as } = await boot();
  const r = await as("Revenue").get("/api/finance/statement?propertyId=agm&days=30");
  assert.equal(r.status, 200);
  const s = r.body.now;
  assert.equal(s.outstanding, s.guestOwed, "no standalone documents exist yet");
  // res_1 owes 118,000 and res_2 owes 937,500, both already net of payments.
  assert.equal(s.guestOwed, 118000 + 937500);

  // Copying a folio onto a document must not invent a second debt.
  await as("Front Desk").post("/api/billing/invoices").send({ reservationId: "res_1" });
  const after = await as("Revenue").get("/api/finance/statement?propertyId=agm&days=30");
  assert.equal(after.body.now.guestOwed, 118000 + 937500);
  assert.equal(after.body.now.docOwed, 0, "a folio invoice never adds its own balance");
  assert.equal(after.body.now.outstanding, 118000 + 937500);
});

test("a role that cannot see reports is turned away from the statement", async () => {
  const { as } = await boot();
  const r = await as("Housekeeping").get("/api/finance/statement?propertyId=agm");
  assert.equal(r.status, 403);
  const drill = await as("Housekeeping").get("/api/finance/statement/department?propertyId=agm&department=Rooms");
  assert.equal(drill.status, 403);
});

test("drill-down reaches the transactions behind a department figure", async () => {
  const { as } = await boot();
  const r = await as("Revenue").get("/api/finance/statement/department?propertyId=agm&days=30&department=Rooms");
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 2);
  assert.equal(r.body.reduce((s, x) => s + x.amount, 0), 1450000);
  assert.ok(r.body.every((x) => x.reference && x.guest));
});
