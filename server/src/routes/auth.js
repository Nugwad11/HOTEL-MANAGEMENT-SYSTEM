const { Router } = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const pool = require("../db/pool");
const biz = require("../lib/business-date");
const { sign } = require("../lib/jwt");
const { validate } = require("../middleware/validate");
const { authenticate } = require("../middleware/auth");

const router = Router();

const LoginSchema = z.object({
  email:    z.string().email("Enter a valid email address."),
  password: z.string().min(4, "Password must be at least 4 characters."),
});

/**
 * POST /api/auth/login
 * Returns a JWT and the user's session shape.
 */
router.post("/login", validate(LoginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.data;

    const { rows } = await pool.query(
      `SELECT u.*, sp.data AS permissions
       FROM users u
       LEFT JOIN staff_permissions sp ON sp.id = 1
       WHERE u.email = $1`,
      [email.toLowerCase()]
    );
    const user = rows[0];

    if (!user || !user.is_active) {
      return res.status(401).json({ error: "Email not found or account is inactive." });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Incorrect password." });
    }

    // Embed only the permissions for this user's role in the token so every
    // middleware can check capabilities without a DB round-trip.
    const rolePerm = (user.permissions || {})[user.role] || {};

    const payload = {
      id:          user.id,
      email:       user.email,
      name:        user.name,
      role:        user.role,
      propertyId:  user.property_id,
      guestId:     user.guest_id || null,
      permissions: rolePerm,
    };
    const token = sign(payload);

    await pool.query(`UPDATE users SET last_login = now() WHERE id = $1`, [user.id]);

    res.json({
      token,
      user: {
        id:         user.id,
        name:       user.name,
        email:      user.email,
        role:       user.role,
        propertyId: user.property_id,
        guestId:    user.guest_id || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

/* ── the guest portal's own door ─────────────────────────────── */

// One sentence for both failures. A name that is not on the book and a detail
// that does not match the name on it are the same answer here, because a door
// that says which half was wrong is a directory of who stays at the property.
const NO_MATCH = "We could not match those details to a booking with us.";

/** The number as it was typed, without the punctuation people type numbers with. */
const digits = (v) => String(v || "").replace(/\D+/g, "");

const GuestSignInSchema = z.object({
  email:     z.string().trim().default(""),
  phone:     z.string().trim().default(""),
  reference: z.string().trim().default(""),
}).refine((d) => !!d.email || !!digits(d.phone), {
  message: "Give us the email or the phone number the booking was made with.",
});

/**
 * Which profile is this person? An email is looked up as it is keyed. A phone is
 * stored the way the desk heard it — spaces, brackets, a leading plus — so the
 * digits are compared rather than the string, and the comparison is made in one
 * place rather than in a SQL function that would have to strip the punctuation
 * the same way every time.
 *
 * Two profiles on one contact answer nothing: a duplicated book cannot quietly
 * choose which stranger the token is issued to, so it goes to the front desk.
 */
async function matchGuest(email, phone) {
  if (email) {
    const { rows } = await pool.query(`SELECT * FROM guests WHERE lower(email) = $1 LIMIT 2`, [email]);
    return rows.length === 1 ? rows[0] : null;
  }
  const { rows } = await pool.query(`SELECT * FROM guests WHERE phone IS NOT NULL`);
  const hit = rows.filter((g) => digits(g.phone) === phone);
  return hit.length === 1 ? hit[0] : null;
}

/** The browser's `stayWindowHit`: in house, or a confirmed arrival whose day has begun. */
const liveNow = (r, day) =>
  r.status === "In-house" ||
  (r.status === "Confirmed" && biz.dstr(r.check_in) <= day && biz.dstr(r.check_out) > day);

/**
 * POST /api/auth/guest
 *
 * The guest half of the door, and the only way into `/api/guest`. A guest is not
 * a staff account and does not have a password here: they prove who they are with
 * the contact the booking was made on — the same way the desk finds a name when
 * somebody walks in and asks for their key. What comes back is that one guest's
 * own identity and their own stay, never a list of who else is in the building.
 */
router.post("/guest", validate(GuestSignInSchema), async (req, res, next) => {
  try {
    const d = req.data;
    const guest = await matchGuest(d.email.toLowerCase(), digits(d.phone));
    if (!guest) return res.status(401).json({ error: NO_MATCH });

    const day = await biz.businessDay();
    const { rows: booked } = await pool.query(
      `SELECT r.*, rm.number AS room_number FROM reservations r
       LEFT JOIN rooms rm ON rm.id = r.room_id
       WHERE r.guest_id = $1 AND r.status IN ('In-house','Confirmed')
       ORDER BY CASE WHEN r.status = 'In-house' THEN 0 ELSE 1 END, r.check_in ASC`,
      [guest.id]
    );
    let stay = booked.find((r) => liveNow(r, day)) || null;

    // A reference narrows the answer to one booking. It has to be that guest's
    // own: the door checks the match rather than trusting the caller, so a token
    // cannot be pointed at a stranger's reservation.
    if (d.reference) {
      const { rows } = await pool.query(
        `SELECT r.*, rm.number AS room_number FROM reservations r
         LEFT JOIN rooms rm ON rm.id = r.room_id
         WHERE upper(r.reference) = $1 LIMIT 1`,
        [d.reference.toUpperCase()]
      );
      const named = rows[0];
      if (!named || named.guest_id !== guest.id) return res.status(401).json({ error: NO_MATCH });
      stay = liveNow(named, day) ? named : null;
    }
    const propertyId = (stay || booked[0] || {}).property_id || null;

    const payload = {
      id: guest.id, email: guest.email, name: guest.name, role: "Guest",
      propertyId, guestId: guest.id, permissions: {},
    };
    res.json({
      token: sign(payload),
      user: { id: guest.id, name: guest.name, email: guest.email, role: "Guest",
        propertyId, guestId: guest.id },
      guest: { id: guest.id, name: guest.name, email: guest.email, phone: guest.phone,
        tier: guest.tier, loyaltyPoints: Number(guest.loyalty_pts) || 0 },
      stay: stay ? {
        id: stay.id, reference: stay.reference, propertyId: stay.property_id, status: stay.status,
        roomNumber: stay.room_number || null, checkIn: biz.dstr(stay.check_in),
        checkOut: biz.dstr(stay.check_out),
      } : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Returns the current user's profile from the DB (token refresh-free check).
 */
router.get("/me", authenticate, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, role, property_id, guest_id FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "User not found." });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/logout  (client just discards the token; this logs it)
 */
router.post("/logout", authenticate, (req, res) => {
  res.json({ ok: true });
});

module.exports = router;
