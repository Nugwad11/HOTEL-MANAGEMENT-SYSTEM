# Aurelia Grand HMS — API Server

Node.js / Express / PostgreSQL REST backend for the Hotel Management System.

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ running locally or on a remote host

## Setup

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Create the database

```sql
-- In psql or your Postgres client:
CREATE DATABASE aurelia_hms;
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set:

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | 64-byte random hex — generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `CORS_ORIGIN` | URL your frontend is served from (e.g. `http://localhost:5500`) |

### 4. Run migrations, then create the first account

```bash
npm run db:migrate   # creates all tables, no data
```

A production install then bootstraps one property and Manager account:

```bash
ADMIN_EMAIL=you@hotel.com ADMIN_PASSWORD='…' PROPERTY_CODE=AGM \
PROPERTY_NAME='Aurelia Grand Marina' npm run db:bootstrap
```

The demonstration dataset is fictional and is refused while
`NODE_ENV=production` unless you opt in:

```bash
npm run db:seed:demo                                  # demonstration data
ALLOW_DEMO_SEED=true npm run db:seed:demo             # on a demo install
npm run db:reset:demo                                 # drops everything first
```

See `../DEPLOYMENT.md` for the full production runbook.

### 5. Start the server

```bash
npm run dev    # development — auto-restarts on changes
npm start      # production — refuses to boot without secrets and an origin
```

The API runs on `http://localhost:3001` by default, and also serves the SPA from
the repository's `index.html` and `assets/` unless `SERVE_STATIC=false`.

---

## API routes

This file deliberately does not keep a copy of the route list, because a copy is how
documentation goes stale: the table here used to name about a tenth of the surface.

The two authoritative lists are the mount statements in `src/index.js` and the door table in
`../assets/api.js` — and `tests/api-client.test.js` compares them on every test run, refusing
a door with no route behind it and a route with no door. To read the current surface:

```bash
grep -E 'router\.(get|post|patch|put|delete)\("' src/routes/*.js   # every route, by file
sed -n '/var DOORS = {/,/^  };/p' ../assets/api.js                 # every door, by name
```

A few of the money doors, all on `window.LHMS.api`:

| Method | Path | Door |
|---|---|---|
| POST | `/api/reservations/:id/charges` | `postCharge(id, body)` |
| POST | `/api/reservations/:id/check-out` | `checkOut(id, body)` |
| PATCH | `/api/properties/:id/settings` | `saveHotelSettings(id, body)` |
| PATCH | `/api/pricing/plans/:id` | `updateRatePlan(id, body)` |
| POST | `/api/fx/rates` | `fileFxRate(body)` |
| POST | `/api/approvals/:id/decide` | `decideApproval(id, body)` |
| POST | `/api/audit/run` | `runNightAudit(body)` |
| POST | `/api/guest/bookings` | `bookStay(body)` |

---

## Connecting the frontend

The frontend is not wired to this server, and that is the current design rather than a switch
waiting to be thrown: every figure on screen comes from the engine in `assets/store.js`, which
is what this API is a port of. `assets/api.js` is a client — it only builds `window.LHMS.api`.
Setting an `api-base` meta changes no page's behaviour.

It used to do otherwise, and the change here is worth knowing before you make it again. When a
base was configured, `api.js` replaced `LHMS.signIn` with a function returning a Promise, while
the login form reads `result.ok` off it synchronously (`assets/app.js`) — so the documented
"enable API mode" step produced a form that failed with an empty error toast.

Moving a screen onto the network is that screen's own change:

1. call the door it needs (`LHMS.api.folio(resId)`);
2. prove its figures against the engine's first — `server/` ports `assets/store.js` and
   `assets/data.js`, and never re-implements them;
3. keep both suites green. `server/tests/api-client.test.js` checks the door table against the
   mounted routes, and `tests/api-adapter.test.js` checks the client against the pages.

While no base is set the app runs on localStorage, so the workspace needs no database and no server.

---

## Seeded accounts (demonstration data only)

`npm run db:seed:demo` creates these accounts with the password `aurelia2026`.
The API checks that password with bcrypt; the browser workspace accepts any
password of 4+ characters because it holds no credential store of its own.

| Role | Email | Password |
|---|---|---|
| Manager | `ifeoma.okafor@aureliagrand.com` | `aurelia2026` |
| Front Desk | `adamu.bello@aureliagrand.com` | `aurelia2026` |
| Housekeeping | `grace.mensah@aureliagrand.com` | `aurelia2026` |
| Revenue | `chiamaka.obi@aureliagrand.com` | `aurelia2026` |
| Guest | `guest@aureliagrand.com` | `aurelia2026` |
