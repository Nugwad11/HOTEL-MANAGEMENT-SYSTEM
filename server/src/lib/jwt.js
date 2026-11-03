const jwt = require("jsonwebtoken");

const SECRET  = process.env.JWT_SECRET;
const EXPIRES = process.env.JWT_EXPIRES_IN || "8h";

if (!SECRET) throw new Error("JWT_SECRET is not set in environment.");

/**
 * Sign a JWT for a user session.
 * Payload includes the minimum needed for every middleware check.
 */
function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
}

function verify(token) {
  return jwt.verify(token, SECRET); // throws on invalid/expired
}

module.exports = { sign, verify };
