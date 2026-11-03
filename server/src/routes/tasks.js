const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { log } = require("../lib/log");

const router = Router();
router.use(authenticate);

/**
 * Closing a turn is the room's release, not just a tick on a board.
 *
 * The same rule the browser applies (`LHMS.actions.completeTask`): a housekeeping
 * job, a departure clean or an inspection that is signed off makes the room
 * sellable again — an inspection releases it as inspected, everything else as
 * available — and a room taken out of order or out of service is never lifted by
 * closing a task, because that decision belongs to the desk that grounded it.
 */
async function closeTask(taskId, actor) {
  const { rows } = await pool.query(
    `SELECT t.*, r.hk_status, r.number AS room_number FROM tasks t
     LEFT JOIN rooms r ON r.id = t.room_id WHERE t.id = $1`,
    [taskId]
  );
  const t = rows[0];
  if (!t) return { missing: true, error: "Task not found." };
  // A second sign-off changes nothing and writes nothing: the room was released
  // the first time, and the trail must not read the same close twice.
  if (t.status === "Done") return { task: t, already: true };

  const { rows: closed } = await pool.query(
    `UPDATE tasks SET status = 'Done', resolved_at = now() WHERE id = $1 RETURNING *`, [taskId]
  );

  let room = null;
  const turns = ["Housekeeping", "Departure clean", "Inspection"];
  if (t.room_id && turns.includes(t.type)
      && !["Out of order", "Out of service"].includes(t.hk_status)) {
    const release = t.type === "Inspection" ? "Inspected" : "Available";
    const { rows: lifted } = await pool.query(
      `UPDATE rooms SET hk_status = $2 WHERE id = $1 RETURNING *`, [t.room_id, release]
    );
    room = lifted[0] || null;
  }
  await log({
    propertyId: t.property_id, actor: actor || "System", action: "completed a task",
    entity: "task",
    detail: t.title + (room ? ` · Room ${room.number} released as ${room.hk_status}` : ""),
  });
  return { task: closed[0], room };
}

/**
 * Either board may sign a turn off: housekeeping its own rooms, the desk the
 * requests and departures it raised. The browser gates the page; this gates the
 * door, and asks for the board permission rather than a role, so a manager's own
 * map stays authoritative.
 */
function mayClose(req) {
  if (req.user.role === "Manager") return true;
  const perms = req.user.permissions || {};
  return Boolean(perms.housekeeping_board || perms.manage_reservations);
}

const canClose = (req, res, next) =>
  mayClose(req) ? next() : res.status(403).json({ error: "Permission 'housekeeping_board' is required." });

/** GET /api/tasks?propertyId=&status=&source= */
router.get("/", async (req, res, next) => {
  try {
    const { propertyId, status, source, limit = 200 } = req.query;
    const pid = propertyId || req.user.propertyId;
    const params = [pid];
    const where = ["t.property_id = $1"];
    if (status)  { params.push(status);  where.push(`t.status = $${params.length}`); }
    if (source)  { params.push(source);  where.push(`t.source = $${params.length}`); }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT t.*, r.number AS room_number, g.name AS guest_name, s.name AS assignee_name
       FROM tasks t
       LEFT JOIN rooms r  ON r.id = t.room_id
       LEFT JOIN guests g ON g.id = t.guest_id
       LEFT JOIN staff s  ON s.id = t.assigned_to
       WHERE ${where.join(" AND ")}
       ORDER BY t.due_at ASC NULLS LAST, t.created_at DESC
       LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const CreateSchema = z.object({
  propertyId:  z.string(),
  type:        z.string().optional(),
  title:       z.string().min(1, "Title is required."),
  detail:      z.string().optional(),
  roomId:      z.string().optional(),
  guestId:     z.string().optional(),
  assignedTo:  z.string().optional(),
  priority:    z.enum(["High","Normal","Low"]).default("Normal"),
  source:      z.string().optional(),
  slaMins:     z.number().int().min(5).default(30),
});

/** POST /api/tasks */
router.post("/", validate(CreateSchema), async (req, res, next) => {
  try {
    const d = req.data;
    const id     = "tsk_" + Math.random().toString(36).slice(2, 8);
    const dueAt  = new Date(Date.now() + d.slaMins * 60000).toISOString();
    const { rows } = await pool.query(
      `INSERT INTO tasks (id,property_id,type,title,detail,room_id,guest_id,assigned_to,priority,status,source,sla_mins,due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Open',$10,$11,$12) RETURNING *`,
      [id, d.propertyId, d.type || "Guest request", d.title, d.detail || "", d.roomId || null, d.guestId || null,
       d.assignedTo || null, d.priority, d.source || "Front desk", d.slaMins, dueAt]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/** PATCH /api/tasks/:id */
router.patch("/:id", async (req, res, next) => {
  try {
    const { status, assignedTo, priority } = req.body;
    const closing = status === "Done";
    if (closing && !mayClose(req)) {
      return res.status(403).json({ error: "Permission 'housekeeping_board' is required." });
    }
    const sets = []; const params = [req.params.id];
    if (assignedTo !== undefined) { params.push(assignedTo || null); sets.push(`assigned_to = $${params.length}`); }
    if (priority)   { params.push(priority);   sets.push(`priority = $${params.length}`); }
    if (status && !closing) { params.push(status); sets.push(`status = $${params.length}`); }
    if (!sets.length && !closing) return res.status(422).json({ error: "Nothing to update." });

    let task = null;
    if (sets.length) {
      const { rows } = await pool.query(
        `UPDATE tasks SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params
      );
      if (!rows[0]) return res.status(404).json({ error: "Task not found." });
      task = rows[0];
    }
    // A patch that names the status closes the task through the same door as the
    // board's own button, so the release rule cannot be walked around by writing
    // the status straight onto the row.
    if (closing) {
      const out = await closeTask(req.params.id, req.user.name);
      if (out.error) return res.status(404).json({ error: out.error });
      return res.json({ ...task, ...out.task });
    }
    res.json(task);
  } catch (err) { next(err); }
});

/**
 * POST /api/tasks/:id/complete — the board's own sign-off.
 *
 * Answers with the room it released, because the hand closing a turn is the hand
 * that needs to know the room is sellable again.
 */
router.post("/:id/complete", canClose, async (req, res, next) => {
  try {
    const out = await closeTask(req.params.id, req.user.name);
    if (out.error) return res.status(404).json({ error: out.error });
    res.json({ task: out.task, room: out.room, already: Boolean(out.already) });
  } catch (err) { next(err); }
});

module.exports = router;
