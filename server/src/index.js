/**
 * Aurelia Grand HMS — Express API server
 * All routes are prefixed with /api. The SPA is served from the same process
 * unless a deployment hosts it separately (SERVE_STATIC=false).
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });

const path         = require("path");
const express      = require("express");
const helmet       = require("helmet");
const cors         = require("cors");
const rateLimit    = require("express-rate-limit");
const errorHandler = require("./middleware/errorHandler");
const pool         = require("./db/pool");
const config       = require("./config");

// A production process must not boot on a default secret or an open origin.
config.assertProduction();

const app  = express();
const PORT = process.env.PORT || 3001;
const ROOT = path.resolve(__dirname, "../..");

app.disable("x-powered-by");

/* Behind a load balancer the client address (and the rate limiter's key) is
   only right when Express is told how many proxies to trust. */
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : true);
}

/* ── security ──────────────────────────────────────────────── */
app.use(helmet({
  // The SPA is served from here, so the policy has to admit its assets: inline
  // style attributes are how the pages render, and the sign-in gallery and brand
  // images arrive from Google Fonts' hosts and data URLs. Scripts stay self-only
  // and eval-free. upgrade-insecure-requests is left to the TLS proxy, because
  // an http deployment (a laptop, a staging box) must not be upgraded to a port
  // that does not speak TLS.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:        ["https://fonts.gstatic.com"],
      imgSrc:         ["'self'", "data:"],
      connectSrc:     ["'self'"],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin:      config.origins(),
  credentials: true,
  methods:     ["GET","POST","PATCH","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));

/* Auth endpoints get a tighter rate limit (10 req / 15 min) */
app.use("/api/auth", rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX)  || 10,
  message:  { error: "Too many login attempts. Try again in 15 minutes." },
  standardHeaders: true, legacyHeaders: false,
}));

/* General API limit */
app.use("/api", rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)        || 200,
  message:  { error: "Rate limit exceeded. Slow down." },
  standardHeaders: true, legacyHeaders: false,
}));

// Brand images arrive as base64 inside the JSON body, and the uploader allows
// 3,600,000 characters of them. The parser must receive everything the browser
// would accept, so the cap here sits above that figure plus JSON overhead.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "8mb" }));
app.use(express.urlencoded({ extended: false, limit: process.env.JSON_BODY_LIMIT || "8mb" }));

/* ── the browser ───────────────────────────────────────────── */
/* Only `index.html` and `assets/` are published. Serving the repository root
   would hand out `server/.env` and the server sources with it, so the two
   published paths are mounted explicitly rather than as one static directory. */
if (config.staticEnabled()) {
  app.use("/assets", express.static(path.join(ROOT, "assets"), {
    index: false,
    dotfiles: "ignore",
    maxAge: process.env.STATIC_MAX_AGE || "1h",
  }));
  app.get(["/", "/index.html"], (req, res) => res.sendFile(path.join(ROOT, "index.html")));

  /* The proposal is published as one named document, downloaded rather than
     browsed: the rest of its folder (and the screenshot corpus) stays closed. */
  app.get("/proposal/Aurelia-Grand-HMS-Proposal.pdf", (req, res, next) => {
    res.download(
      path.join(ROOT, "proposal", "Aurelia-Grand-HMS-Proposal.pdf"),
      "Aurelia-Grand-HMS-Proposal.pdf",
      (err) => {
        if (!err) return;
        if (res.headersSent) return next(err);
        if (err.code === "ENOENT") return res.status(404).json({ error: "The proposal is not published in this build." });
        next(err);
      }
    );
  });
}

/* ── routes ────────────────────────────────────────────────── */
app.use("/api/auth",         require("./routes/auth"));
app.use("/api/properties",   require("./routes/properties"));
app.use("/api/guest",        require("./routes/guest"));
app.use("/api/guests",       require("./routes/guests"));
app.use("/api/reservations", require("./routes/reservations"));
app.use("/api/waitlist",     require("./routes/waitlist"));
app.use("/api/rooms",        require("./routes/rooms"));
app.use("/api/tasks",        require("./routes/tasks"));
app.use("/api/lost-found",   require("./routes/lost-found"));
app.use("/api/staff",        require("./routes/staff"));
app.use("/api/metrics",      require("./routes/metrics"));
app.use("/api/events",       require("./routes/events"));
app.use("/api/documents",    require("./routes/documents"));
app.use("/api/activity",     require("./routes/activity"));
app.use("/api/pricing",      require("./routes/pricing"));
app.use("/api/billing",      require("./routes/billing"));
app.use("/api/finance",      require("./routes/finance"));
app.use("/api/fx",           require("./routes/fx"));
app.use("/api/approvals",    require("./routes/approvals"));
app.use("/api/audit",        require("./routes/audit"));
app.use("/api/laundry",      require("./routes/laundry"));
app.use("/api/reviews",      require("./routes/reviews"));

/* ── health check ──────────────────────────────────────────── */
/* A load balancer needs a door that answers for the database as well as the
   process: a server holding a dead pool is not ready to take traffic. */
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      db: "up",
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({
      status: "degraded",
      db: "down",
      uptime: Math.round(process.uptime()),
      time: new Date().toISOString(),
    });
  }
});

/* ── 404 ────────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found.` });
});

/* ── error handler ─────────────────────────────────────────── */
app.use(errorHandler);

/* The app is exported for tests, which drive it through supertest instead of
   a socket — so only a direct `node src/index.js` binds a port. */
if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`🏨 Aurelia Grand HMS API running on http://localhost:${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  });

  /* Drain in-flight requests, then close the pool, so a deploy does not cut a
     payment in half. The timer is the backstop for a connection that will not
     finish. */
  const shutdown = (signal) => {
    console.log(`${signal} received — closing the server.`);
    server.close(async () => {
      try { await pool.end(); } catch (err) { console.error("Pool close failed:", err.message); }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  ["SIGTERM", "SIGINT"].forEach((signal) => process.on(signal, () => shutdown(signal)));
}

module.exports = app; // for testing
