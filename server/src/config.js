/**
 * Deployment configuration.
 *
 * Nothing here is needed in development or under test: both run on defaults.
 * A production process is the one place a missing secret must stop the boot
 * rather than surface as a 500 on the first sign-in.
 */

const PLACEHOLDER_JWT = /^replace[_-]?with/i;

/** The origin the browser may call from. Render injects RENDER_EXTERNAL_URL
    (the service's own https URL) automatically; it is an honest answer to the
    production check below, and the SPA is same-origin so CORS is not exercised
    by the app itself. */
function originSetting(env = process.env) {
  return env.CORS_ORIGIN || env.RENDER_EXTERNAL_URL || "";
}

function productionIssues(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const problems = [];

  if (!env.DATABASE_URL) problems.push("DATABASE_URL");

  const secret = env.JWT_SECRET || "";
  if (!secret) problems.push("JWT_SECRET");
  else if (secret.length < 32 || PLACEHOLDER_JWT.test(secret)) {
    problems.push("JWT_SECRET (a random value of at least 32 characters)");
  }

  const origin = originSetting(env);
  if (!origin) problems.push("CORS_ORIGIN");
  else if (String(origin).split(",").some((o) => o.trim() === "*")) {
    problems.push("CORS_ORIGIN (a wildcard origin cannot be used in production)");
  }

  return problems;
}

function assertProduction(env = process.env) {
  const problems = productionIssues(env);
  if (problems.length) {
    throw new Error("Refusing to start in production — set: " + problems.join(", "));
  }
}

/** The origins the browser may call from, comma-separated for more than one. */
function origins(env = process.env) {
  const raw = originSetting(env) || "http://localhost:5500";
  return String(raw).split(",").map((o) => o.trim()).filter(Boolean);
}

/**
 * The seeded dataset is fictional. It is allowed everywhere except a production
 * install unless that install has explicitly asked for demonstration data.
 */
function demoSeedAllowed(env = process.env) {
  return env.NODE_ENV !== "production" || env.ALLOW_DEMO_SEED === "true";
}

/** The SPA is served from the same process unless a separate host is used. */
function staticEnabled(env = process.env) {
  return env.SERVE_STATIC !== "false";
}

module.exports = { productionIssues, assertProduction, origins, demoSeedAllowed, staticEnabled };
