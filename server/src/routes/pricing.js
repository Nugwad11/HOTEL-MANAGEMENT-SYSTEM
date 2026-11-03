/**
 * Pricing — services, price lists, prices, tax rules, price history.
 * This is the only place a number that a guest pays is decided.
 */
const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const P = require("../lib/price");
const PI = require("../lib/price-import");
const ledger = require("../lib/ledger");
const FX = require("../lib/fx");
const biz = require("../lib/business-date");
const { log } = require("../lib/log");

const router = Router();
router.use(authenticate);

// Whether this caller may move a price across the property's limit on their own
// word. Only the General Manager: the signing right is the second hand on
// somebody else's ask, and a role that holds it still owes one for its own.
const movesAlone = (req) => req.user.role === "Manager";

/**
 * The property's money, read once for the whole job. The approval limit is a
 * figure in the books' money, so a dollar row is judged on what its move is
 * worth here and not on the number of dollars it moves — and the same reading
 * refuses a price the books cannot value before it reaches the row.
 */
async function books(propertyId) {
  const day = await biz.businessDay();
  const fx = await FX.read({ propertyId, date: day });
  return {
    fx,
    fold: (amount, code) => {
      const f = FX.stampIn(fx, amount, code || fx.base);
      return f.error ? { error: f.error } : { base: f.baseAmount, currency: fx.base };
    },
  };
}

/* ── price lists ────────────────────────────────────────────── */

router.get("/lists", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM price_lists ORDER BY priority DESC`);
    res.json(rows);
  } catch (err) { next(err); }
});

router.patch("/lists/:id", can("configure_prices"), async (req, res, next) => {
  try {
    const allowed = ["name","active","from_date","to_date","priority","currency"];
    const fields = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!fields.length) return res.status(422).json({ error: "Nothing to update." });
    const sets  = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    const vals  = fields.map(([, v]) => v);
    const { rows } = await pool.query(
      `UPDATE price_lists SET ${sets} WHERE id=$1 RETURNING *`,
      [req.params.id, ...vals]
    );
    if (!rows[0]) return res.status(404).json({ error: "Price list not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── tax rules ──────────────────────────────────────────────── */

router.get("/taxes", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM tax_rules ORDER BY sort_order`);
    res.json(rows);
  } catch (err) { next(err); }
});

const TaxPatchSchema = z.object({
  pct:        z.number().min(0).max(50),
  name:       z.string().optional(),
  applies_to: z.array(z.string()).optional(),
  reason:     z.string().min(1, "A reason is required for the audit trail."),
});

router.patch("/taxes/:id", can("configure_prices"), validate(TaxPatchSchema), async (req, res, next) => {
  try {
    const d   = req.data;
    const sets = [`pct=$2`, `updated_at=now()`, `updated_by=$3`];
    const vals = [req.params.id, d.pct, req.user.name];
    if (d.name)       { vals.push(d.name);                   sets.push(`name=$${vals.length}`); }
    if (d.applies_to) { vals.push(JSON.stringify(d.applies_to)); sets.push(`applies_to=$${vals.length}`); }

    const { rows } = await pool.query(
      `UPDATE tax_rules SET ${sets.join(",")} WHERE id=$1 RETURNING *`, vals
    );
    if (!rows[0]) return res.status(404).json({ error: "Tax rule not found." });

    await pool.query(
      `INSERT INTO activity_log (id,property_id,actor,action,entity,detail)
       VALUES ($1,$2,$3,'changed a tax rule','pricing',$4)`,
      ["act_"+Math.random().toString(36).slice(2,8), req.user.propertyId, req.user.name,
       `${rows[0].name} → ${d.pct}% · ${d.reason}`]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── rate plans ─────────────────────────────────────────────── */

/** The plan as the price engine reads it — the shape both doors answer with. */
function planView(p) {
  return {
    id: p.id, code: p.code, name: p.name, modifier: Number(p.modifier),
    depositPct: Number(p.deposit_pct), cancelPolicy: p.cancel_policy, includes: p.includes,
  };
}

// The page shows a modifier as the percentage of the base rate it sells at, so
// the trail says the same thing the manager read on the screen.
const modifierPct = (m) => `${Math.round(Number(m) * 100)}%`;

/**
 * GET /api/pricing/plans?roomTypeId= — the commercial terms a stay is booked on.
 *
 * A modifier is only a number until it is applied to a rate, so a caller that
 * names a room type is also told what each plan sells the business day for, out
 * of the same `quoteNight` the night audit bills and a booking opens on. Without
 * a room type there is nothing honest to multiply, and the door answers with a
 * null rather than a figure taken off a rate nobody asked about.
 */
router.get("/plans", async (req, res, next) => {
  try {
    const day = await biz.businessDay();
    const [cat, fx] = await Promise.all([P.catalogue(), FX.sources(day)]);
    const typeId = req.query.roomTypeId ? String(req.query.roomTypeId) : "";
    const type = typeId ? cat.roomTypes.find((t) => t.id === typeId) || null : null;
    if (typeId && !type) return res.status(422).json({ error: "That room type is not on the books." });

    res.json(cat.ratePlans.map((p) => {
      // The room's own occupancy, so no extra-person line rides along on a figure
      // whose only job is to show what this plan sells the list rate at.
      const q = type
        ? P.quoteNight(cat, type.id, p.id, day, Number(type.occupancy), { propertyId: req.user.propertyId, fx })
        : null;
      return Object.assign({}, p, {
        // The night as the engine prices it: `base` is the list rate with this
        // plan's modifier on it, `uplift` whatever the date adds on top.
        tonight: q ? {
          date: q.date, base: q.base, uplift: q.uplift, rate: q.rate, extras: q.added,
          taxes: q.taxes, total: q.total, currency: q.currency, list: q.list,
        } : null,
      });
    }));
  } catch (err) { next(err); }
});

const PlanPatchSchema = z.object({
  // The ranges the manager's own form carries: a modifier outside half and double
  // is not a plan, and a deposit is a share of a stay, never more than it. All
  // four are optional — a page that sends only the term it edited leaves the rest
  // of the plan exactly as it stood, which is what the editor does.
  modifier:     z.number().min(0.5, "A modifier below 0.50 is not a rate plan.").max(2, "A plan cannot sell above twice the base rate.").optional(),
  depositPct:   z.number().int("A deposit is a whole percentage.").min(0, "A deposit cannot be negative.").max(100, "A deposit cannot be more than the stay.").optional(),
  includes:     z.string().min(1, "Name what the plan includes.").max(120).optional(),
  // The browser's field is `plan.cancel`; the column and the engine call it the
  // same thing the guest's booking terms are called.
  cancelPolicy: z.string().min(1, "Write the cancellation terms the guest is shown.").max(200).optional(),
  // A missing reason is refused in the editor's own words, not zod's "Required",
  // the same way the approvals note is.
  reason:       z.string({ required_error: "A reason is required for the audit trail." })
                  .min(1, "A reason is required for the audit trail."),
});

/**
 * PATCH /api/pricing/plans/:id — the port of `LHMS.actions.updatePlan`.
 *
 * The browser's page opens on two roles; the key those two roles hold is
 * `manage_rates`, and it is checked here rather than assumed from a screen,
 * because a plan's modifier moves every room sold on it and its deposit moves the
 * money taken before a guest arrives. The write lands on the plan row alone: a
 * folio already opened carries its own price snapshot, so re-pricing a plan
 * cannot rewrite a stay somebody has already been quoted. It does move the nights
 * nobody has billed yet — which is why this write is unheard of without a reason
 * and a line in the trail.
 */
router.patch("/plans/:id", can("manage_rates"), validate(PlanPatchSchema), async (req, res, next) => {
  try {
    const d = req.data;
    const cols = [];
    if (d.modifier !== undefined) cols.push(["modifier", d.modifier]);
    if (d.depositPct !== undefined) cols.push(["deposit_pct", d.depositPct]);
    if (d.includes !== undefined) cols.push(["includes", d.includes]);
    if (d.cancelPolicy !== undefined) cols.push(["cancel_policy", d.cancelPolicy]);
    if (!cols.length) return res.status(422).json({ error: "Nothing to update." });

    const { rows: was } = await pool.query(`SELECT * FROM rate_plans WHERE id = $1`, [req.params.id]);
    if (!was[0]) return res.status(404).json({ error: "Rate plan not found." });

    const vals = [req.params.id];
    const sets = cols.map(([col, v]) => { vals.push(v); return `${col}=$${vals.length}`; });
    const { rows } = await pool.query(
      `UPDATE rate_plans SET ${sets.join(", ")} WHERE id=$1 RETURNING *`, vals);
    const now = rows[0];

    // Only a term whose value actually differs is named: a page that posts the
    // whole form back cannot leave a trail claiming a change that never happened,
    // and a manager reading the line has to be able to trust what it counts.
    const text = (v) => String(v === null || v === undefined ? "" : v);
    const moved = [];
    if (d.modifier !== undefined && Number(was[0].modifier) !== Number(now.modifier)) {
      moved.push(`modifier ${modifierPct(was[0].modifier)} → ${modifierPct(now.modifier)}`);
    }
    if (d.depositPct !== undefined && Number(was[0].deposit_pct) !== Number(now.deposit_pct)) {
      moved.push(`deposit ${Number(was[0].deposit_pct)}% → ${Number(now.deposit_pct)}%`);
    }
    if (d.includes !== undefined && text(was[0].includes) !== text(now.includes)) {
      moved.push(`inclusions "${text(was[0].includes)}" → "${text(now.includes)}"`);
    }
    if (d.cancelPolicy !== undefined && text(was[0].cancel_policy) !== text(now.cancel_policy)) {
      moved.push(`cancellation "${text(was[0].cancel_policy)}" → "${text(now.cancel_policy)}"`);
    }
    await log({
      propertyId: req.user.propertyId, actor: req.user.name,
      action: "changed a rate plan", entity: "rate plan",
      detail: `${now.name} · ${moved.length ? moved.join(" · ") : "nothing moved"} · ${d.reason}`,
    });

    const read = planView(now);
    read.moved = moved;
    res.json(read);
  } catch (err) { next(err); }
});

/* ── services ───────────────────────────────────────────────── */

/* A service's price rows travel on their own select, the way a guest's notes do:
   pg-mem — the database these tests run against — carries neither a GROUP BY nor
   a subquery back to an aliased table, and two plain selects read the same
   against a live server. Oldest first, which is the order the price history on
   the page is written in. A service nobody has priced carries an empty list. */
async function attachPrices(services) {
  if (!services.length) return services;
  const params = services.map((s) => s.id);
  const { rows: prices } = await pool.query(
    `SELECT * FROM prices
     WHERE service_id IN (${params.map((_, i) => `$${i + 1}`).join(",")})
     ORDER BY created_at, id`,
    params
  );
  const by = {};
  for (const s of services) by[s.id] = [];
  for (const p of prices) by[p.service_id].push(p);
  return services.map((s) => Object.assign({}, s, { prices: by[s.id] }));
}

router.get("/services", async (req, res, next) => {
  try {
    const { category } = req.query;
    const params = [];
    let sql = `SELECT s.* FROM services s`;
    if (category) { params.push(category); sql += ` WHERE s.category = $1`; }
    sql += ` ORDER BY s.category, s.name`;
    const { rows } = await pool.query(sql, params);
    res.json(await attachPrices(rows));
  } catch (err) { next(err); }
});

router.get("/services/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT s.* FROM services s WHERE s.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Service not found." });
    const [service] = await attachPrices(rows);
    res.json(service);
  } catch (err) { next(err); }
});

const CreateServiceSchema = z.object({
  category:       z.enum(["room","hall","restaurant","laundry"]),
  name:           z.string().min(1, "Service name is required."),
  code:           z.string().optional(),
  unit:           z.string().default("piece"),
  occupancy:      z.number().int().optional(),
  capacity:       z.number().int().optional(),
  outletId:       z.string().optional(),
  // The menu row an item belongs to, carried the way the catalogue carries it:
  // the department a charge lands on and the minutes that team answers in are
  // the outlet's, not something a route can invent per order.
  outlet:         z.object({ id: z.string(), name: z.string(), dept: z.string(), sla: z.number().int() }).optional(),
  addon:          z.boolean().default(false),
  turnaroundMins: z.number().int().optional(),
  // First price (required)
  amount:         z.number().positive("Price must be greater than zero."),
  listId:         z.string().default("pl_std"),
  currency:       z.string().default("NGN"),
  surcharges:     z.record(z.number()).optional(),
  reason:         z.string().min(1, "A reason is required."),
});

router.post("/services", can("configure_prices"), validate(CreateServiceSchema), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const d   = req.data;
    const sid = "svc_" + Math.random().toString(36).slice(2, 8);
    const pid = "prc_" + Math.random().toString(36).slice(2, 8);
    const now = new Date().toISOString();

    await client.query(
      `INSERT INTO services (id,category,ref_id,code,name,unit,active,occupancy,capacity,outlet_id,outlet,addon,turnaround_mins)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11,$12,$13)`,
      [sid, d.category, sid, d.code||sid.toUpperCase(), d.name, d.unit,
       d.occupancy||null, d.capacity||null, d.outletId||null,
       d.outlet ? JSON.stringify(d.outlet) : null, d.addon, d.turnaroundMins||null]
    );

    const round50 = n => Math.round(n / 50) * 50;
    await client.query(
      `INSERT INTO prices (id,service_id,list_id,currency,amount,surcharges,active,created_at,updated_at,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$7,$8)`,
      [pid, sid, d.listId, d.currency, round50(d.amount), JSON.stringify(d.surcharges||{}), now, req.user.name]
    );

    await client.query(
      `INSERT INTO price_history (id,price_id,service_id,list_id,recorded_by,reason,from_data,to_data)
       VALUES ($1,$2,$3,$4,$5,$6,null,$7)`,
      ["ph_"+Math.random().toString(36).slice(2,8), pid, sid, d.listId, req.user.name, d.reason,
       JSON.stringify({ amount: round50(d.amount), active: true })]
    );

    await client.query(
      `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,'added a priced service','pricing',$4)`,
      ["act_"+Math.random().toString(36).slice(2,8), req.user.propertyId, req.user.name, d.name]
    );

    await client.query("COMMIT");
    const { rows } = await pool.query(`SELECT s.* FROM services s WHERE s.id = $1`, [sid]);
    const [service] = await attachPrices(rows);
    res.status(201).json(service);
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

/** PATCH /api/pricing/services/:id/active */
router.patch("/services/:id/active", can("configure_prices"), async (req, res, next) => {
  try {
    const { active, reason } = req.body;
    if (!reason) return res.status(422).json({ error: "A reason is required." });
    const { rows } = await pool.query(
      `UPDATE services SET active=$2 WHERE id=$1 RETURNING *`, [req.params.id, !!active]
    );
    if (!rows[0]) return res.status(404).json({ error: "Service not found." });
    await pool.query(
      `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,$4,'pricing',$5)`,
      ["act_"+Math.random().toString(36).slice(2,8), req.user.propertyId, req.user.name,
       active ? "re-opened a service" : "closed a service", `${rows[0].name} · ${reason}`]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/* ── prices ─────────────────────────────────────────────────── */

router.get("/prices", async (req, res, next) => {
  try {
    const { serviceId } = req.query;
    const params = [];
    let sql = `SELECT p.*, s.name AS service_name, s.category, l.name AS list_name
               FROM prices p
               JOIN services s ON s.id = p.service_id
               JOIN price_lists l ON l.id = p.list_id`;
    if (serviceId) { params.push(serviceId); sql += ` WHERE p.service_id=$1`; }
    sql += ` ORDER BY s.category, s.name, l.priority DESC`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

const PricePatchSchema = z.object({
  amount:     z.number().positive().optional(),
  active:     z.boolean().optional(),
  from_date:  z.string().nullable().optional(),
  to_date:    z.string().nullable().optional(),
  listId:     z.string().optional(),
  currency:   z.string().length(3, "Currency must be a three-letter code.").optional(),
  surcharges: z.record(z.number()).optional(),
  reason:     z.string().min(1, "A reason is required for the audit trail."),
});

// A price move wider than the property's limit is held as a request instead of
// written to the row. Approving it later runs this same patch, so the rate that
// finally lands is the one the approver read.
router.patch("/prices/:id", can("configure_prices"), validate(PricePatchSchema), async (req, res, next) => {
  try {
    const d = req.data;
    const row = await P.priceRow(req.params.id);
    if (!row) return res.status(404).json({ error: "Price not found." });

    const listId = d.listId === undefined ? row.listId : d.listId;
    const { rows: lists } = await pool.query(`SELECT id, name FROM price_lists WHERE id = $1`, [listId]);
    if (!lists[0]) return res.status(422).json({ error: "Choose a price list." });

    const money = await books(req.user.propertyId);
    const plan = P.planPricePatch(row, d, d.reason, money.fx);
    if (plan.error) return res.status(422).json({ error: plan.error });

    const settings = await ledger.financeSettings(req.user.propertyId);
    const gap = money.fold(plan.move, plan.next.currency);
    if (!movesAlone(req) && gap.base > settings.approvalAmount) {
      const queued = await ledger.queueApproval({
        propertyId: req.user.propertyId, kind: "price",
        subject: `${await serviceName(row.serviceId)} · ${lists[0].name}`, subjectId: row.id,
        change: { patch: d, reason: d.reason },
        // The gap the signer weighs is in the books' money; the two figures they
        // compare are the price row's own, so each carries its own currency.
        amount: gap.base, currency: gap.currency,
        from: plan.from, fromCurrency: row.currency,
        to: plan.to, toCurrency: plan.next.currency,
        reason: d.reason,
      }, req.user.name);
      await log({
        propertyId: req.user.propertyId, actor: req.user.name, action: "asked for approval of a price",
        entity: "approval",
        detail: `${queued.subject} · ${gap.base} ${gap.currency} · ${d.reason} · awaiting a second signature`,
      });
      return res.status(202).json({ ok: true, queued });
    }

    const applied = await P.applyPricePatch(row, d, d.reason, req.user.name);
    if (applied.error) return res.status(422).json({ error: applied.error });
    await log({
      propertyId: req.user.propertyId, actor: req.user.name,
      action: applied.active ? "changed a price" : "deactivated a price", entity: "pricing",
      detail: `${applied.service} · ${applied.list} → ${applied.amount}`,
    });
    res.json(applied.price);
  } catch (err) { next(err); }
});

async function serviceName(serviceId) {
  const { rows } = await pool.query(`SELECT name FROM services WHERE id = $1`, [serviceId]);
  return rows[0] ? rows[0].name : serviceId;
}

/* ── bulk update ────────────────────────────────────────────── */

const ImportSchema = z.object({
  text:   z.string().min(1, "Paste the price file you want applied."),
  reason: z.string().min(1, "A reason is required for the audit trail."),
});

/** POST /api/pricing/import/preview — what a file would do, with nothing written. */
router.post("/import/preview", can("configure_prices"), validate(ImportSchema), async (req, res, next) => {
  try {
    const settings = await ledger.financeSettings(req.user.propertyId);
    const plan = await PI.planImport(req.data.text, req.data.reason, {
      limit: settings.approvalAmount, movesAlone: movesAlone(req),
      money: await books(req.user.propertyId),
    });
    if (!plan.ok) return res.status(422).json({ error: plan.error });
    res.json(plan);
  } catch (err) { next(err); }
});

/**
 * POST /api/pricing/import — the file is planned again here rather than taken
 * from the caller, so what lands is what these rules say, never a plan edited
 * in transit. The rows a caller may sign are written in one transaction; the
 * wider moves go to the approvals queue for the second signature exactly as the
 * single-row route sends one.
 */
router.post("/import", can("configure_prices"), validate(ImportSchema), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const settings = await ledger.financeSettings(req.user.propertyId);
    const plan = await PI.planImport(req.data.text, req.data.reason, {
      limit: settings.approvalAmount, movesAlone: movesAlone(req),
      money: await books(req.user.propertyId),
    });
    if (!plan.ok) return res.status(422).json({ error: plan.error });

    let applied = 0;
    await client.query("BEGIN");
    for (const r of plan.rows) {
      if (r.state !== "change") continue;
      const { rows } = await client.query(`SELECT * FROM prices WHERE id = $1`, [r.priceId]);
      const row = P.mapPriceRow(rows[0]);
      if (!row) { r.state = "reject"; r.error = "That price record is gone."; continue; }
      const out = await P.applyPricePatch(row, r.patch, plan.reason, req.user.name, client);
      if (out.error) { r.state = "reject"; r.error = out.error; continue; }
      applied++;
    }
    await client.query("COMMIT");

    const approvals = [];
    for (const r of plan.rows) {
      if (r.state !== "queue") continue;
      approvals.push(await ledger.queueApproval({
        propertyId: req.user.propertyId, kind: "price",
        subject: `${r.service} · ${r.list}`, subjectId: r.priceId,
        change: { patch: r.patch, reason: plan.reason },
        // The gap is weighed in the books' money; the two figures the signer
        // compares are the row's own.
        amount: r.move, currency: r.currency,
        from: r.current.amount, fromCurrency: r.current.currency,
        to: r.next.amount, toCurrency: r.next.currency,
        reason: plan.reason,
      }, req.user.name));
    }
    const held = approvals.length;
    await log({
      propertyId: req.user.propertyId, actor: req.user.name,
      action: "imported prices from a file", entity: "pricing",
      detail: `${applied} price${applied === 1 ? "" : "s"} updated · ${held}` +
        (held === 1 ? " held for a second signature" : " held for second signatures") + ` · ${plan.reason}`,
    });
    res.json({
      ok: true, applied, queued: held, approvals,
      unchanged: plan.counts.unchanged,
      rejected: plan.rows.filter((r) => r.state === "reject").length,
      counts: plan.counts, rows: plan.rows,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/** GET /api/pricing/history?serviceId= */
router.get("/history", can("view_reports"), async (req, res, next) => {
  try {
    const { serviceId, limit = 100 } = req.query;
    const params = [];
    let sql = `SELECT ph.*, s.name AS service_name
               FROM price_history ph
               LEFT JOIN services s ON s.id = ph.service_id`;
    if (serviceId) { params.push(serviceId); sql += ` WHERE ph.service_id=$1`; }
    params.push(limit);
    sql += ` ORDER BY ph.recorded_at DESC LIMIT $${params.length}`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
