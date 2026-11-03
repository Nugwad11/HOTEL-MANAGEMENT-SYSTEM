const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, requireRole } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const FX = require("../lib/fx");
const { jsonIn, jsonOut } = require("../lib/json");
const { log } = require("../lib/log");

const router = Router();
router.use(authenticate);

/** GET /api/properties — list all */
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM properties ORDER BY name`);
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/properties/:id */
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM properties WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Property not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/** GET /api/properties/:id/settings */
router.get("/:id/settings", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT data FROM settings WHERE property_id = $1`, [req.params.id]);
    res.json(rows[0]?.data || {});
  } catch (err) { next(err); }
});

const ProfileSchema = z.object({
  name:    z.string().min(1).optional(),
  short:   z.string().min(1).optional(),
  city:    z.string().optional(),
  country: z.string().optional(),
  address: z.string().optional(),
  phone:   z.string().optional(),
  email:   z.string().email().optional(),
  gm:      z.string().optional(),
  tagline: z.string().optional(),
  star:    z.number().int().min(1).max(5).optional(),
}).strict();

/** PATCH /api/properties/:id — manager only */
router.patch("/:id", requireRole("Manager"), validate(ProfileSchema), async (req, res, next) => {
  try {
    const fields = Object.entries(req.data);
    if (!fields.length) return res.status(422).json({ error: "No fields to update." });
    const sets  = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    const vals  = fields.map(([, v]) => v);
    const { rows } = await pool.query(
      `UPDATE properties SET ${sets} WHERE id = $1 RETURNING *`,
      [req.params.id, ...vals]
    );
    if (!rows[0]) return res.status(404).json({ error: "Property not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/**
 * The commercial policies the desk books a stay under — the port of
 * `LHMS.actions.saveSettings`. The bounds are the ones the form's own inputs
 * carry, the money of account is refused once the books hold money, and the
 * trail names each figure that moved rather than the page it came from, so a
 * form posted back whole cannot claim a change that never happened.
 */
// Two digits, a colon and two digits is a shape, not a clock: 25:00 would be
// written onto the confirmation a guest reads.
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const LANGUAGES = ["English (UK)", "English (US)", "French"];

const PolicySchema = z.object({
  depositPct:   z.number().int("A deposit is a whole percentage.")
                  .min(0, "A deposit cannot be negative.")
                  .max(100, "A deposit cannot be more than the stay.").optional(),
  checkInTime:  z.string().regex(TIME, "Arrival and departure times are written as HH:MM.").optional(),
  checkOutTime: z.string().regex(TIME, "Arrival and departure times are written as HH:MM.").optional(),
  currency:     z.string().refine((c) => FX.CODES.indexOf(c) !== -1,
                  (c) => ({ message: `This property holds money in ${FX.CODES.join(", ")}. ${c} is not among them.` }))
                  .optional(),
  language:     z.string().refine((l) => LANGUAGES.indexOf(l) !== -1,
                  { message: "The desk writes in English (UK), English (US) or French." }).optional(),
  overbooking:  z.number().int("An overbooking allowance is a whole room.")
                  .min(0, "An allowance cannot be negative.")
                  .max(10, "Ten rooms is the most an allowance may hold.").optional(),
  // Refused for being empty, but stored exactly as written: trimming here would
  // put a different string on the books than the same edit makes in the browser.
  cancellation: z.string()
                  .refine((v) => v.trim().length > 0, { message: "Write the cancellation terms the guest is shown." })
                  .refine((v) => v.length <= 400, { message: "The cancellation terms have to fit on the confirmation." })
                  .optional(),
}).strict();

const POLICY_FIELDS = Object.keys(PolicySchema.shape);

// A charge or a payment sits on a property through the stay it belongs to — or,
// for money taken against a document that never belonged to a stay, through that
// document; a cost names its own. Documents are not counted because their money
// is already on the folio as the charges they bill, exactly as in the browser's
// count, which reads a record's `amount` and finds none on an invoice. The
// server has no payment reversal, so every payment on file is live money.
async function moneyRecordsOnFile(propertyId) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM charges c
          JOIN reservations r ON r.id = c.reservation_id
         WHERE r.property_id = $1 AND NOT c.voided AND c.amount <> 0)
     + (SELECT COUNT(*) FROM payments p
          LEFT JOIN reservations r ON r.id = p.reservation_id
          LEFT JOIN invoices i ON i.id = p.invoice_id
         WHERE (r.property_id = $1 OR i.property_id = $1) AND p.amount <> 0)
     + (SELECT COUNT(*) FROM expenses e
         WHERE e.property_id = $1 AND e.amount <> 0) AS n`,
    [propertyId]
  );
  return Number(rows[0].n) || 0;
}

const moneyOfAccountLocked = (from, held, to) =>
  `This property keeps its books in ${from} and ${held} money records are already valued in it. ` +
  `Switching to ${to} would leave every one of them counting ${from} without saying so. ` +
  `Settle the folios and raise no more documents, or open the second currency as a rate on the ${from} books instead.`;

/** PATCH /api/properties/:id/settings — the commercial policies */
router.patch("/:id/settings", requireRole("Manager"), validate(PolicySchema), async (req, res, next) => {
  try {
    const wanted = POLICY_FIELDS.filter((k) => req.data[k] !== undefined);
    if (!wanted.length) return res.status(422).json({ error: "Nothing to update." });

    const { rows } = await pool.query(
      `SELECT s.data AS settings, p.name FROM settings s
         JOIN properties p ON p.id = s.property_id
        WHERE s.property_id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Property settings not found." });
    const was = jsonIn(rows[0].settings, {});

    if (req.data.currency && req.data.currency !== was.currency) {
      const held = await moneyRecordsOnFile(req.params.id);
      if (held) {
        return res.status(422).json({ error: moneyOfAccountLocked(was.currency, held, req.data.currency) });
      }
    }

    const text = (v) => String(v === null || v === undefined ? "" : v);
    const changed = [];
    const move = (key, label, fmt) => {
      if (!wanted.includes(key)) return;
      if (fmt(was[key]) === fmt(req.data[key])) return;
      changed.push(`${label} ${fmt(was[key]) || "unset"} → ${fmt(req.data[key])}`);
    };
    const num = (v) => (v === undefined || v === null || isNaN(Number(v)) ? "" : String(Number(v)));
    move("depositPct", "deposit", (v) => (num(v) === "" ? "" : num(v) + "%"));
    move("checkInTime", "check-in", text);
    move("checkOutTime", "check-out", text);
    move("currency", "money of account", text);
    move("language", "language", text);
    move("overbooking", "overbooking allowance", num);
    move("cancellation", "cancellation", (v) => (text(v) === "" ? "" : `"${text(v)}"`));

    const blob = Object.assign({}, was);
    wanted.forEach((k) => { blob[k] = req.data[k]; });
    await pool.query(`UPDATE settings SET data = $2 WHERE property_id = $1`,
      [req.params.id, jsonOut(blob)]);

    await log({
      propertyId: req.params.id, actor: req.user.name, action: "updated hotel settings",
      entity: "settings",
      detail: `${rows[0].name} · ${changed.length ? changed.join(" · ") : "nothing moved"}`,
    });
    res.json({ settings: blob, changed });
  } catch (err) { next(err); }
});

/* The six services the setup page offers a connection to. A key outside this
   list is not a service the hotel has, so the door refuses it rather than
   remembering whatever string a caller typed. */
const INTEGRATIONS = [
  "channelManager", "paymentGateway", "doorLocks", "accounting", "crm", "whatsapp",
];

/* The brand is the name, line, logo, gallery and palette the sign-in page and
   the app chrome wear. The limits are the uploader's own, because the ledger
   and the pictures share one browser budget; a gallery that quietly evicts the
   books is worse than a refused upload. */
const IMAGE_DATA = /^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const BRAND_LIMITS = {
  maxImages: 6, maxLogoChars: 700000, maxImageChars: 900000, maxTotalChars: 3600000,
};

const BrandSchema = z.object({
  brandName: z.string().min(1, "Give the hotel a name the sign-in page can show.")
                .max(60, "Keep the name under 60 characters.")
                .refine((v) => v.trim().length > 0, "Give the hotel a name the sign-in page can show.")
                .optional(),
  tagline:   z.string().max(90, "Keep the tagline under 90 characters.").optional(),
  logo:      z.string()
                .refine((v) => v === "" || IMAGE_DATA.test(v), "A logo is a PNG, JPEG, WebP or SVG image.")
                .refine((v) => v.length <= BRAND_LIMITS.maxLogoChars, "The logo is too large. Choose a smaller image.")
                .optional(),
  images:    z.array(z.object({
                src:  z.string()
                        .refine((v) => IMAGE_DATA.test(v), "Each gallery image is a PNG, JPEG, WebP or SVG file.")
                        .refine((v) => v.length <= BRAND_LIMITS.maxImageChars, "One of those images is too large. Choose a smaller one."),
                name: z.string().max(80, "An image name has to fit in 80 characters.").optional(),
              }).strict())
                .max(BRAND_LIMITS.maxImages, "Six images is the most the gallery holds.")
                .optional(),
  palette:   z.array(z.string().regex(HEX_COLOUR, "A palette colour is written as #rrggbb."))
                .min(1, "A palette carries between one and eight colours.")
                .max(8, "A palette carries between one and eight colours.")
                .nullable().optional(),
  useColors: z.boolean().optional(),
}).strict();

const brandDefaults = (property) => ({
  brandName: property.id === "agm" ? "Aurelia Grand" : property.name,
  tagline: property.id === "agm" ? "Hotels & Residences" : (property.tagline || ""),
  logo: "", images: [], palette: null, useColors: true,
  updatedAt: null, updatedBy: null,
});

/**
 * PATCH /api/properties/:id/branding — the port of `LHMS.actions.saveBranding`.
 * The trail names the parts that moved (a count of images, not their base64),
 * so re-saving the tab cannot claim a change that never happened.
 */
router.patch("/:id/branding", requireRole("Manager"), validate(BrandSchema), async (req, res, next) => {
  try {
    const wanted = Object.keys(req.data);
    if (!wanted.length) return res.status(422).json({ error: "Nothing to update." });

    const { rows } = await pool.query(
      `SELECT s.data AS settings, p.id, p.name, p.tagline FROM settings s
         JOIN properties p ON p.id = s.property_id
        WHERE s.property_id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Property settings not found." });

    const was = jsonIn(rows[0].settings, {});
    const before = Object.assign(brandDefaults(rows[0]), was.branding || {});
    const next = Object.assign({}, before, {
      images: (before.images || []).map((i) => ({ src: i.src, name: i.name })),
      palette: before.palette ? before.palette.slice() : null,
    });

    wanted.forEach((k) => {
      if (k === "brandName" || k === "tagline") next[k] = String(req.data[k] == null ? "" : req.data[k]).trim();
      else next[k] = req.data[k];
    });

    const total = (next.logo || "").length +
      next.images.reduce((n, i) => n + String(i.src || "").length, 0);
    if (total > BRAND_LIMITS.maxTotalChars) {
      return res.status(422).json({
        error: "That is more image than this browser can keep. Remove a picture or choose smaller files.",
      });
    }

    const changed = [];
    if (next.brandName !== before.brandName) changed.push(`name ${before.brandName} → ${next.brandName}`);
    if ((next.tagline || "") !== (before.tagline || "")) {
      changed.push(`tagline ${before.tagline ? `"${before.tagline}"` : "unset"} → ${next.tagline ? `"${next.tagline}"` : "unset"}`);
    }
    if (next.logo !== before.logo) changed.push(next.logo ? (before.logo ? "logo replaced" : "logo added") : "logo removed");
    if (next.images.length !== (before.images || []).length) {
      changed.push(`images ${(before.images || []).length} → ${next.images.length}`);
    }
    if (JSON.stringify(next.palette || null) !== JSON.stringify(before.palette || null)) {
      changed.push(next.palette ? "logo palette applied" : "logo palette cleared");
    }
    if (!!next.useColors !== !!before.useColors) {
      changed.push(next.useColors ? "system colours follow the logo" : "system colours returned to default");
    }

    if (changed.length) {
      next.updatedAt = new Date().toISOString();
      next.updatedBy = req.user.name;
    }

    const blob = Object.assign({}, was, { branding: next });
    await pool.query(`UPDATE settings SET data = $2 WHERE property_id = $1`,
      [req.params.id, jsonOut(blob)]);

    await log({
      propertyId: req.params.id, actor: req.user.name, action: "updated the hotel brand",
      entity: "hotel brand",
      detail: `${rows[0].name} · ${changed.length ? changed.join(" · ") : "nothing moved"}`,
    });
    res.json({ branding: next, changed });
  } catch (err) { next(err); }
});

/**
 * POST /api/properties/:id/integrations/:key/toggle — the port of
 * `LHMS.actions.toggleIntegration`. A connection is flipped, never set from the
 * outside: the page asks "Disconnect" for what is on and "Connect" for what is
 * not, and the trail says which of the two happened.
 */
router.post("/:id/integrations/:key/toggle", requireRole("Manager"), async (req, res, next) => {
  try {
    const key = req.params.key;
    if (INTEGRATIONS.indexOf(key) === -1) {
      return res.status(422).json({ error: "That service is not on the integration register." });
    }
    const { rows } = await pool.query(`SELECT data FROM settings WHERE property_id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Property settings not found." });

    const blob = jsonIn(rows[0].data, {});
    const on = !(blob.integrations && blob.integrations[key]);
    blob.integrations = Object.assign({}, blob.integrations, { [key]: on });
    await pool.query(`UPDATE settings SET data = $2 WHERE property_id = $1`,
      [req.params.id, jsonOut(blob)]);

    await log({
      propertyId: req.params.id, actor: req.user.name,
      action: on ? "connected an integration" : "disconnected an integration",
      entity: "integration", detail: key,
    });
    res.json({ key, connected: on, integrations: blob.integrations });
  } catch (err) { next(err); }
});

module.exports = router;
