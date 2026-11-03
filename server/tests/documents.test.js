/**
 * The document register over the API — the port of the role map, the capture
 * rules and the trail the browser app keeps.
 *
 * The assertions ask the trail what it recorded as often as they ask the register
 * what it holds: a record that moved without a line in the audit is a record
 * nobody can account for, and a refusal that left no trace is the one the screen
 * promises was logged.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, dstr } = require("./helpers/api");
const { sign } = require("../src/lib/jwt");

const GST = "00000000-0000-4000-8000-000000000199";

/** A guest's own token: their portal identity, not a staff role. */
function guestToken(ctx, guestId) {
  return ctx.bearer(sign({
    id: GST, email: "adaeze@meridian.ng", name: "Adaeze Nwankwo", role: "Guest",
    propertyId: "agm", guestId, permissions: {},
  }));
}

/** File a record the way the desk would, then hand back the row. */
async function capture(ctx, role, over) {
  const out = await ctx.as(role).post("/api/documents").send(Object.assign({
    name: "Registration card", category: "Registration", guestId: "gst_1", reservationId: "res_1",
  }, over || {}));
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body;
}

const trail = async (ctx) => (await ctx.query(`SELECT * FROM activity_log WHERE entity = 'document'`)).rows;
const actions = async (ctx) => (await trail(ctx)).map((r) => r.action);

test("every document the register files, signs, sends, archives or purges is in the trail", async () => {
  const ctx = await boot();
  const doc = await capture(ctx, "Front Desk", { guestVisible: true });
  assert.match(doc.id, /^doc_/);
  assert.equal(doc.status, "Draft");
  assert.equal(dstr(doc.retention_until).slice(0, 4), String(new Date().getFullYear() + 7),
    "the retention window is the years the record was filed under");

  const opened = await ctx.as("Front Desk").get(`/api/documents/${doc.id}`);
  assert.equal(opened.status, 200);

  const signed = await ctx.as("Front Desk").post(`/api/documents/${doc.id}/sign`).send({ signer: "Adaeze Nwankwo" });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.status, "Signed");
  assert.equal(signed.body.signed_by, "Adaeze Nwankwo");

  const sent = await ctx.as("Front Desk").post(`/api/documents/${doc.id}/send`).send({});
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.status, "Signed", "a signature already on the record is not downgraded by a delivery");
  assert.ok(sent.body.sent_at);

  const archived = await ctx.as("Manager").post(`/api/documents/${doc.id}/archive`).send({});
  assert.equal(archived.status, 200, JSON.stringify(archived.body));
  const purged = await ctx.as("Manager").del(`/api/documents/${doc.id}`);
  assert.equal(purged.status, 204);

  assert.deepEqual(await actions(ctx), [
    "captured a document", "viewed a document", "signed a document",
    "simulated document delivery", "archived a document", "purged a document record",
  ]);
  const rows = await trail(ctx);
  assert.equal(rows.filter((r) => r.action === "signed a document")[0].detail,
    "Registration card · Adaeze Nwankwo", "the trail names who signed, not just that somebody did");
  assert.equal(rows.filter((r) => r.action === "simulated document delivery")[0].detail,
    "Registration card · no message was sent", "and says honestly that nothing left the building");
  assert.equal(rows.filter((r) => r.action === "purged a document record")[0].detail,
    "Registration card · Registration · metadata removed", "the row is gone but the fact that it went is not");
  assert.equal((await ctx.query(`SELECT count(*) AS n FROM documents WHERE id = '${doc.id}'`)).rows[0].n, 0);
});

test("a role the category map does not reach is refused, and the refusal is logged", async () => {
  const ctx = await boot();
  const billing = await capture(ctx, "Revenue", { name: "Folio statement", category: "Billing" });

  const hk = ctx.as("Housekeeping");
  const list = await hk.get("/api/documents?propertyId=agm");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((d) => d.name), [], "housekeeping sees no billing record in the register");

  const peek = await hk.get(`/api/documents/${billing.id}`);
  assert.equal(peek.status, 403);
  assert.equal(peek.body.error, "Access denied.");

  const sign = await hk.post(`/api/documents/${billing.id}/sign`).send({ signer: "Grace Mensah" });
  assert.equal(sign.status, 403);
  assert.match(sign.body.error, /cannot sign/);

  const send = await hk.post(`/api/documents/${billing.id}/send`).send({});
  assert.equal(send.status, 403);

  const archive = await hk.post(`/api/documents/${billing.id}/archive`).send({});
  assert.equal(archive.status, 403);

  const purge = await hk.del(`/api/documents/${billing.id}`);
  assert.equal(purge.status, 403);

  const kept = await ctx.as("Revenue").get(`/api/documents/${billing.id}`);
  assert.equal(kept.status, 200, "the record is exactly where it was, unsigned and un-archived");
  assert.equal(kept.body.status, "Draft");

  const rows = await trail(ctx);
  assert.equal(rows.filter((r) => r.action.startsWith("refused to")).length, 5,
    "every denial is in the trail, because the screen promises it is");
  assert.deepEqual(rows.filter((r) => r.action.startsWith("refused to")).map((r) => r.action), [
    "refused to view a document", "refused to sign a document", "refused to send a document",
    "refused to archive a document", "refused to purge a document",
  ]);
  assert.ok(rows.filter((r) => r.action.startsWith("refused to")).every((r) => r.actor === "Grace Mensah"),
    "the refusals are all in her name, and hers alone");
});

test("a guest sees the records the desk showed them and signs only their own consents", async () => {
  const ctx = await boot();
  const consent = await capture(ctx, "Front Desk", { name: "Spa consent", category: "Spa & consent", guestVisible: true });
  const kept = await capture(ctx, "Front Desk", { name: "Kept back", category: "Registration", guestVisible: false });
  const folio = await capture(ctx, "Revenue", { name: "Folio statement", category: "Billing", guestVisible: true });

  const guest = guestToken(ctx, "gst_1");
  const list = await guest.get("/api/documents?propertyId=agm");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((d) => d.name).sort(), ["Folio statement", "Spa consent"],
    "Billing is a category a guest may read — but only the statement the desk chose to show them");

  const signed = await guest.post(`/api/documents/${consent.id}/sign`).send({ signer: "Adaeze Nwankwo" });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.signed_by, "Adaeze Nwankwo");

  const shown = await guest.get(`/api/documents/${folio.id}`);
  assert.equal(shown.status, 200);
  const signBill = await guest.post(`/api/documents/${folio.id}/sign`).send({ signer: "Adaeze Nwankwo" });
  assert.equal(signBill.status, 403, "a statement is read, not signed into agreement");

  const hidden = await guest.get(`/api/documents/${kept.id}`);
  assert.equal(hidden.status, 403, "a record nobody chose to show is not theirs, even in their own category");

  // A guest pointed at somebody else's record can neither read it nor sign it into being theirs.
  const stranger = guestToken(ctx, "gst_2");
  const wrong = await stranger.get(`/api/documents/${consent.id}`);
  assert.equal(wrong.status, 403);
  const forged = await stranger.post(`/api/documents/${consent.id}/sign`).send({ signer: "Someone else" });
  assert.equal(forged.status, 403, "and the refusal comes before the fact that it was already signed");
  assert.deepEqual((await stranger.get("/api/documents?propertyId=agm")).body, [],
    "the register shows a guest nothing that belongs to another");
});

test("a record is filed with a name, a category the register knows and a retention window", async () => {
  const ctx = await boot();
  const desk = ctx.as("Front Desk");

  const noName = await desk.post("/api/documents").send({ name: "   ", category: "Registration" });
  assert.equal(noName.status, 422);
  const oddCategory = await desk.post("/api/documents").send({ name: "Payroll run", category: "Payroll" });
  assert.equal(oddCategory.status, 422);
  assert.match(oddCategory.body.error, /Choose a category/,
    "a mis-filed category is a record only a Manager could ever find");
  const tooSoon = await desk.post("/api/documents").send({ name: "Card", category: "Billing", retentionYears: 0 });
  assert.equal(tooSoon.status, 422);

  assert.equal((await ctx.query(`SELECT count(*) AS n FROM documents`)).rows[0].n, 0, "nothing half-filed");
  assert.deepEqual(await actions(ctx), [], "and nothing in the trail either");

  const filed = await capture(ctx, "Front Desk", { name: " Indemnity form ", category: "Spa & consent", retentionYears: 3 });
  assert.equal(filed.name, "Indemnity form", "the name is filed as it was meant");
  assert.equal(Number(filed.retention_years), 3);
  assert.equal(filed.source, "Front Desk", "the register records which desk filed it");

  const noSigner = await desk.post(`/api/documents/${filed.id}/sign`).send({ signer: " " });
  assert.equal(noSigner.status, 422);
  assert.match(noSigner.body.error, /signer's full name/);
  assert.equal((await ctx.as("Manager").get(`/api/documents/${filed.id}`)).body.signed_at, null);

  const again = await desk.post(`/api/documents/${filed.id}/sign`).send({ signer: "Adamu Bello" });
  assert.equal(again.status, 200);
  const twice = await desk.post(`/api/documents/${filed.id}/sign`).send({ signer: "Someone else" });
  assert.equal(twice.status, 422);
  assert.match(twice.body.error, /already been signed/);
  assert.equal((await ctx.as("Manager").get(`/api/documents/${filed.id}`)).body.signed_by, "Adamu Bello",
    "a second name never overwrites the first signature");

  const missing = await desk.get("/api/documents/doc_nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, "Record not found.");
});

test("only a manager archives, and only an archived record is purged", async () => {
  const ctx = await boot();
  const doc = await capture(ctx, "Manager", { name: "Incident report", category: "Housekeeping" });

  const tooEarly = await ctx.as("Manager").del(`/api/documents/${doc.id}`);
  assert.equal(tooEarly.status, 422);
  assert.match(tooEarly.body.error, /Only archived records can be purged/);

  const byDesk = await ctx.as("Front Desk").post(`/api/documents/${doc.id}/archive`).send({});
  assert.equal(byDesk.status, 403);

  const once = await ctx.as("Manager").post(`/api/documents/${doc.id}/archive`).send({});
  assert.equal(once.status, 200);
  const twice = await ctx.as("Manager").post(`/api/documents/${doc.id}/archive`).send({});
  assert.equal(twice.status, 422);
  assert.match(twice.body.error, /already archived/);

  const gone = await ctx.as("Manager").del(`/api/documents/${doc.id}`);
  assert.equal(gone.status, 204);
  assert.equal((await ctx.query(`SELECT count(*) AS n FROM documents`)).rows[0].n, 0);
  const filed = await actions(ctx);
  assert.ok(filed.includes("purged a document record"));
  assert.equal(filed.filter((a) => a === "refused to archive a document").length, 1);
});

test("a role that cannot file a record leaves no half-written register", async () => {
  const ctx = await boot();
  const hk = ctx.as("Housekeeping");
  const out = await hk.post("/api/documents").send({ name: "Minibar count", category: "Housekeeping" });
  assert.equal(out.status, 403);
  assert.match(out.body.error, /cannot create documents/);
  assert.equal((await ctx.query(`SELECT count(*) AS n FROM documents`)).rows[0].n, 0);
  assert.deepEqual(await actions(ctx), []);

  const auditor = ctx.as("Auditor");
  const peek = await auditor.get("/api/documents?propertyId=agm");
  assert.equal(peek.status, 200);
  assert.deepEqual(peek.body, [], "a role the category map names nothing is shown an honest empty register");
});

/** The browser's register quotes every cell and ends its lines with CRLF; the
    file the API hands back has to be readable by whoever opens it, so the test
    reads it the same way. */
function cells(line) {
  return line.replace(/^"|"$/g, "").split('","');
}

test("the register file carries the columns the browser's register writes", async () => {
  const ctx = await boot();
  const card = await capture(ctx, "Front Desk", { name: "Registration card", category: "Registration", guestVisible: true });
  const signed = await ctx.as("Front Desk").post(`/api/documents/${card.id}/sign`).send({ signer: "Adaeze Nwankwo" });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));

  const out = await ctx.as("Manager").get("/api/documents/export?propertyId=agm");
  assert.equal(out.status, 200, out.text);
  assert.match(out.headers["content-disposition"],
    /filename="aurelia-document-register-AGM-\d{4}-\d{2}-\d{2}\.csv"/,
    "the file is named for the property and the day it was pulled, not a generic download");
  const lines = out.text.replace(/\uFEFF/, "").split("\r\n").filter((l) => l.length);
  assert.equal(lines.length, 2, "one record in, one line out");
  assert.deepEqual(cells(lines[0]), [
    "Name", "Category", "Source", "Guest", "Reservation", "Status",
    "Created by", "Created", "Retention review", "Signed by", "Signed at", "Sent at", "Archived at",
  ]);
  const row = cells(lines[1]);
  assert.deepEqual(row.slice(0, 6), ["Registration card", "Registration", "Front Desk", "Adaeze Nwankwo", "AGM-0001", "Signed"],
    "the names beside the record are the ones the register shows, not bare ids");
  assert.equal(row[6], "Adamu Bello", "and it says which desk filed it");
  assert.equal(row[8], dstr(card.retention_until), "the retention review is the window on the row");
  assert.deepEqual(row.slice(9), ["Adaeze Nwankwo", dstr(signed.body.signed_at), "", ""],
    "a signature that is not there is an empty cell, not a guess");

  const filed = await actions(ctx);
  assert.ok(filed.includes("exported document register"), "the file leaving the building is itself a record");
  assert.equal((await trail(ctx)).filter((r) => r.action === "exported document register")[0].detail,
    "1 metadata records");

  // One record on its own, without the desk-only columns.
  const one = await ctx.as("Manager").get(`/api/documents/${card.id}/metadata`);
  assert.equal(one.status, 200, one.text);
  const oneLines = one.text.replace(/\uFEFF/, "").split("\r\n").filter((l) => l.length);
  assert.deepEqual(cells(oneLines[0]),
    ["Name", "Category", "Source", "Guest", "Reservation", "Status", "Created", "Retention review"],
    "who filed it and who signed it stay inside the building");
  assert.deepEqual(cells(oneLines[1]).slice(0, 6), row.slice(0, 6), "the same record, the same values");

  const byRevenue = await ctx.as("Revenue").get(`/api/documents/${card.id}/metadata`);
  assert.equal(byRevenue.status, 403, "Registration is not a Revenue category, even for a file");
  assert.match(byRevenue.body.error, /cannot export/);
  assert.equal((await trail(ctx)).filter((r) => r.action === "refused to export a document").length, 1);
});

test("a register with nothing a role may export is refused, not handed over empty", async () => {
  const ctx = await boot();
  const empty = await ctx.as("Manager").get("/api/documents/export?propertyId=agm");
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /No records available for export/,
    "a file of headers alone reads like a register that was emptied, and it was not");
  assert.deepEqual(await actions(ctx), [], "a refusal to write a file writes no trail either");

  await capture(ctx, "Revenue", { name: "Folio statement", category: "Billing" });
  const hk = await ctx.as("Housekeeping").get("/api/documents/export?propertyId=agm");
  assert.equal(hk.status, 422, "housekeeping may export a register — just not one holding only billing records");

  const guest = guestToken(ctx, "gst_1");
  const shown = await capture(ctx, "Front Desk", { name: "Spa consent", category: "Spa & consent", guestVisible: true });
  const guestFile = await guest.get("/api/documents/export?propertyId=agm");
  assert.equal(guestFile.status, 422, "a guest is never given the register, not even their own part of it");
  const oneRecord = await guest.get(`/api/documents/${shown.id}/metadata`);
  assert.equal(oneRecord.status, 403);
  assert.ok((await actions(ctx)).includes("refused to export a document"),
    "and the attempt is in the trail, because the screen promised it would be");
});
