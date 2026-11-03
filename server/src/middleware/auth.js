const { verify } = require("../lib/jwt");
const pool = require("../db/pool");

/**
 * authenticate — requires a valid JWT in the Authorization header.
 * Attaches req.user = { id, email, name, role, propertyId, guestId, permissions }.
 */
async function authenticate(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token provided." });

  let s;
  try {
    s = verify(token);
  } catch {
    return res.status(401).json({ error: "Token invalid or expired." });
  }

  if (s.role === "Guest") {
    // A guest is not a staff member with a shorter list: every staff door is
    // written around the permission map, and the map gives a guest nothing, so a
    // guest token is sent to the guest's own half of the house and nowhere else.
    // The browser's portal is the same page and nothing else — here the door is
    // the one that says so.
    if (!GUEST_ROUTES.test((req.baseUrl || "") + req.path)) {
      return res.status(403).json({ error: "Only the guest in house can use this action." });
    }
    req.user = {
      ...s,
      permissions: {},
      propertyId: s.propertyId || (s.guestId ? await stayProperty(s.guestId) : null),
    };
    return next();
  }

  req.user = s;
  next();
}

// The portal speaks for the stay a guest is living, so the property is a fact
// about that stay rather than a field somebody types. An in-house arrival wins
// over a booking still ahead of it: the guest standing in a room is not waiting
// for a future one.
async function stayProperty(guestId) {
  const { rows } = await pool.query(
    `SELECT property_id FROM reservations
     WHERE guest_id = $1 AND status IN ('Confirmed','In-house')
     ORDER BY CASE WHEN status = 'In-house' THEN 0 ELSE 1 END, check_in ASC
     LIMIT 1`,
    [guestId]
  );
  return rows[0] ? rows[0].property_id : null;
}

// The portal is the guest's own half of the house. The document register is the
// one staff router that carries guest rules of its own — it decides record by
// record whether a guest may see it, and a consent form has to be signable from
// the guest side — so it is reached with a guest token and still gates itself.
// Every other door is written around the permission map, which gives a guest
// nothing, and is closed before the door itself is asked.
const GUEST_ROUTES = /^\/api\/(guest|documents)(\/|$)/;

/**
 * requireRole — restricts a route to one or more roles.
 * Always used after authenticate.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) {
      return res.status(403).json({ error: "Your role cannot perform this action." });
    }
    next();
  };
}

/**
 * requireProperty — ensures the authenticated user belongs to the
 * property they are trying to access (read from req.params.propertyId
 * or req.query.propertyId). Managers can see all properties.
 */
function requireProperty(req, res, next) {
  const pid = req.params.propertyId || req.query.propertyId;
  if (!pid) return next(); // route doesn't scope by property
  if (req.user.role === "Manager") return next();
  if (req.user.propertyId !== pid) {
    return res.status(403).json({ error: "Access to this property is not permitted." });
  }
  next();
}

/**
 * can — checks a named capability against the in-request permissions
 * snapshot. The permissions are loaded once at sign-in time and
 * embedded in the JWT so every request is self-contained.
 */
function can(perm) {
  return (req, res, next) => {
    if (req.user.role === "Manager") return next();
    const perms = req.user.permissions || {};
    if (!perms[perm]) {
      return res.status(403).json({ error: `Permission '${perm}' is required.` });
    }
    next();
  };
}

module.exports = { authenticate, requireRole, requireProperty, can, stayProperty };
