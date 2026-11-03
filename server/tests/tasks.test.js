/**
 * Turning a room over — the port of the release rule the browser applies when a
 * task is signed off (LHMS.actions.completeTask), proven against the same tables.
 *
 * The rule is about sellable inventory, so every assertion reads the room row
 * rather than the response: a housekeeping job, a departure clean or an inspection
 * that is closed makes the room available again (an inspection only as far as
 * inspected), a room taken out of order is never lifted by a tick on a board, and
 * a request that is not a turn leaves the room exactly as it stood.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, USERS } = require("./helpers/api");

const HK = "Grace Mensah";      // Housekeeping
const DESK = "Adamu Bello";     // Front Desk

const roomOf = async (ctx, id) => (await ctx.query(`SELECT * FROM rooms WHERE id = $1`, [id])).rows[0];
const setRoom = (ctx, id, hk) => ctx.query(`UPDATE rooms SET hk_status = $2 WHERE id = $1`, [id, hk]);
const taskRows = (ctx, id) => ctx.query(`SELECT * FROM tasks WHERE id = $1`, [id]);
const complete = (ctx, id, role) => ctx.as(role).post(`/api/tasks/${id}/complete`).send({});
const newTask = (ctx, body) => ctx.as("Front Desk").post("/api/tasks").send(body);

/** The departure-clean task a check-out left behind for a room. */
async function departureTask(ctx, roomId) {
  const { rows } = await ctx.query(
    `SELECT * FROM tasks WHERE room_id = $1 AND type = 'Departure clean'`, [roomId]);
  assert.equal(rows.length, 1, 'the check-out put one turn on the board');
  return rows[0];
}

test("a departure is only over when housekeeping signs the turn off", async () => {
  const ctx = await boot();
  const out = await ctx.as("Front Desk").post("/api/reservations/res_1/check-out").send({ settle: true });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal((await roomOf(ctx, "agm_101")).hk_status, "Dirty", 'the room is left for turnover');

  const t = await departureTask(ctx, "agm_101");
  const done = await complete(ctx, t.id, "Housekeeping");
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.room.hk_status, "Available");
  assert.equal(done.body.already, false);

  const closed = (await taskRows(ctx, t.id)).rows[0];
  assert.equal(closed.status, "Done");
  assert.ok(closed.resolved_at, 'the board keeps when the turn was signed');
  assert.equal((await roomOf(ctx, "agm_101")).hk_status, "Available", 'the room is sellable again');

  const trail = (await ctx.query(`SELECT * FROM activity_log WHERE action = 'completed a task'`)).rows;
  assert.equal(trail.length, 1);
  assert.equal(trail[0].actor, HK);
  assert.match(trail[0].detail, /Room 101 released as Available/);
});

test("a patch that writes the status closes through the same door", async () => {
  const ctx = await boot();
  await ctx.as("Front Desk").post("/api/reservations/res_1/check-out").send({ settle: true });
  const t = await departureTask(ctx, "agm_101");

  const patched = await ctx.as("Housekeeping").patch(`/api/tasks/${t.id}`)
    .send({ status: "Done", priority: "Low" });
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  assert.equal(patched.body.status, "Done");
  assert.equal((await roomOf(ctx, "agm_101")).hk_status, "Available", 'a status write is not a way past the rule');

  // A status that is not a close is an ordinary edit and leaves the room alone.
  const request = await newTask(ctx, { propertyId: "agm", title: "Carry the luggage up", type: "Guest request", roomId: "agm_101" });
  assert.equal(request.status, 201, JSON.stringify(request.body));
  await setRoom(ctx, "agm_101", "Dirty");
  const moved = await ctx.as("Housekeeping").patch(`/api/tasks/${request.body.id}`).send({ status: "In progress" });
  assert.equal(moved.body.status, "In progress");
  assert.equal((await roomOf(ctx, "agm_101")).hk_status, "Dirty");
  assert.equal((await taskRows(ctx, request.body.id)).rows[0].resolved_at, null);
});

test("an inspection releases a room as inspected, not as sold", async () => {
  const ctx = await boot();
  await setRoom(ctx, "agm_101", "Dirty");
  const created = await newTask(ctx, { propertyId: "agm", title: "Room inspection — 101", type: "Inspection", roomId: "agm_101" });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const done = await complete(ctx, created.body.id, "Housekeeping");
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await roomOf(ctx, "agm_101")).hk_status, "Inspected");
});

test("a room that is grounded stays grounded when its turn is closed", async () => {
  const ctx = await boot();
  for (const grounded of ["Out of order", "Out of service"]) {
    await setRoom(ctx, "agm_101", grounded);
    const created = await newTask(ctx, { propertyId: "agm", title: `Turnover in ${grounded}`, type: "Housekeeping", roomId: "agm_101" });
    const done = await complete(ctx, created.body.id, "Housekeeping");
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.room, null, 'no room was released');
    assert.equal((await roomOf(ctx, "agm_101")).hk_status, grounded,
      'only the desk that grounded the room lifts it');
    assert.equal((await taskRows(ctx, created.body.id)).rows[0].status, "Done", 'the job is still closed');
  }
});

test("a request that is not a turn leaves the room as it stood", async () => {
  const ctx = await boot();
  await setRoom(ctx, "agm_101", "Dirty");
  const created = await newTask(ctx, { propertyId: "agm", title: "Extra towels", type: "Guest request", roomId: "agm_101" });

  const done = await complete(ctx, created.body.id, "Front Desk");
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.room, null);
  assert.equal((await roomOf(ctx, "agm_101")).hk_status, "Dirty");
});

test("a turn signed twice writes one trail and releases nothing more", async () => {
  const ctx = await boot();
  await ctx.as("Front Desk").post("/api/reservations/res_1/check-out").send({ settle: true });
  const t = await departureTask(ctx, "agm_101");
  await complete(ctx, t.id, "Housekeeping");

  await setRoom(ctx, "agm_101", "Dirty");
  const again = await complete(ctx, t.id, "Housekeeping");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.already, true);
  assert.equal((await roomOf(ctx, "agm_101")).hk_status, "Dirty", 'a re-sign does not silently re-release a room');
  assert.equal((await ctx.query(`SELECT * FROM activity_log WHERE action = 'completed a task'`)).rows.length, 1);
});

test("the hands that may sign a turn off, and the hands that may not", async () => {
  const ctx = await boot();
  await setRoom(ctx, "agm_101", "Dirty");
  const created = await newTask(ctx, { propertyId: "agm", title: "Turnover — 101", type: "Housekeeping", roomId: "agm_101" });
  const id = created.body.id;

  const auditor = await complete(ctx, id, "Auditor");
  assert.equal(auditor.status, 403);
  assert.match(auditor.body.error, /Permission 'housekeeping_board' is required/);
  const controller = await complete(ctx, id, "Finance Manager");
  assert.equal(controller.status, 403);
  const patched = await ctx.as("Auditor").patch(`/api/tasks/${id}`).send({ status: "Done" });
  assert.equal(patched.status, 403, 'the status door is not a weaker way in');

  assert.equal((await roomOf(ctx, "agm_101")).hk_status, "Dirty", 'a refused sign-off changes nothing');
  assert.equal((await taskRows(ctx, id)).rows[0].status, "Open");

  // The desk that raised it, the team that works it, and a manager's own map.
  assert.equal((await complete(ctx, id, "Front Desk")).status, 200);
  const second = await newTask(ctx, { propertyId: "agm", title: "Second turnover", type: "Housekeeping", roomId: "agm_101" });
  assert.equal((await complete(ctx, second.body.id, "Manager")).status, 200);
  assert.equal(USERS["Finance Manager"].name, "Emeka Balogun");
});
