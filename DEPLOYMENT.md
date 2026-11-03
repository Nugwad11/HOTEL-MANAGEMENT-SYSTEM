# Deploying Aurelia Grand HMS

This repository contains two deployable pieces:

| Piece | What it is | Where its data lives |
|---|---|---|
| `server/` | Express + PostgreSQL REST API | The database |
| `index.html` + `assets/` | Staff SPA and guest portal | The browser's localStorage |
| `proposal/` | Solution proposal, published as a PDF download | — |

The SPA runs its own engine and is **not** wired to the API. That is a design
choice, not a missing switch: `assets/api.js` is a checked client, and no screen
calls it. A screen moves onto the network one at a time, with its figures proven
against the engine first (see `server/README.md`). Until then, a static host is
enough for the SPA and each browser keeps its own workspace.

The API is the multi-user backend: shared data, real credentials, Postgres.

---

## 1. Prerequisites

- Node.js 18 or later
- PostgreSQL 14 or later
- A TLS-terminating reverse proxy (nginx, Caddy, a cloud load balancer) for the
  public hostname

## 2. Configure

```bash
cd server
npm ci --omit=dev
cp .env.example .env
```

Edit `.env` and set at least:

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `postgresql://user:pass@host:5432/aurelia_hms` |
| `JWT_SECRET` | A random value of 32+ characters. Generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `CORS_ORIGIN` | The exact origin the SPA is served from, e.g. `https://hms.example.com` |
| `TRUST_PROXY` | `1` when one reverse proxy sits in front |

The process refuses to start in production with a missing `DATABASE_URL`,
a placeholder or short `JWT_SECRET`, a missing `CORS_ORIGIN`, or a wildcard
origin. `server/.env.example` documents the rest.

On Render the service's own URL is injected as `RENDER_EXTERNAL_URL`; when
`CORS_ORIGIN` is unset the config accepts it as the browser origin, so a
single-host deployment needs nothing set by hand. A wildcard gets no
exemption.

### Render (one-click)

The repository carries a `render.yaml` blueprint: one Node service and one
Postgres database. Push the repository to GitHub/GitLab, then in Render's
dashboard choose **New → Blueprint** and select the connected repository.
Render creates the database first, then the service; the start command runs
`db:migrate`, the demo seed (`ALLOW_DEMO_SEED=true`, which skips a board that
is already on file so restarts never re-seed), and `npm start`. Health lives
on `/health`. The blueprint's free-tier notes are in the file itself.

## 3. Build the database

```bash
npm run db:migrate
```

This creates the schema and nothing else. Then create the first property and
Manager account — without this there is no one to sign in as:

```bash
ADMIN_EMAIL=you@hotel.com \
ADMIN_PASSWORD='choose-a-long-password' \
PROPERTY_CODE=AGM \
PROPERTY_NAME='Aurelia Grand Marina' \
PROPERTY_CITY='Victoria Island, Lagos' \
npm run db:bootstrap
```

`db:bootstrap` is idempotent: re-running it resets that account's password.
Create every other property and staff account through the API (or a second
bootstrap run with a different `PROPERTY_CODE` and `ADMIN_EMAIL`).

**Optional demonstration data.** The seeded dataset is fictional. It is refused
when `NODE_ENV=production` unless you explicitly allow it:

```bash
ALLOW_DEMO_SEED=true npm run db:seed:demo
```

Never set `ALLOW_DEMO_SEED` on a real property. `npm run db:reset:demo` drops
every table first — demo installs only.

## 4. Start

```bash
npm start
```

- Listens on `PORT` (default `3001`).
- Serves `index.html` and `assets/` from the same process unless
  `SERVE_STATIC=false`, in which case host those two paths plus
  `proposal/Aurelia-Grand-HMS-Proposal.pdf` on your web server or CDN and point
  `CORS_ORIGIN` at it.
- Only `index.html`, `assets/` and the proposal PDF are published; the repository
  root, `server/` and `.env` are not reachable.
- The proposal downloads from `/proposal/Aurelia-Grand-HMS-Proposal.pdf` as an
  attachment. The rest of `proposal/` (the HTML source and its working files) is
  not served.

Under a process manager, keep it alive and restart on deploy (for example a
systemd unit or `pm2 start npm --name hms -- start`). The process drains
in-flight requests and closes the pool on `SIGTERM`.

## 5. Verify

```bash
curl -fsS https://hms.example.com/health
# {"status":"ok","db":"up","uptime":…,"time":"…"}
```

`/health` returns `503` with `"db":"down"` when the pool cannot answer, so a
load balancer can take the node out of rotation.

Then:

1. Open `https://hms.example.com/` and sign in to the staff workspace.
2. Sign in to the API with the bootstrapped account:
   ```bash
   curl -fsS -X POST https://hms.example.com/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"email":"you@hotel.com","password":"…"}'
   ```
3. Run a smoke transaction on a staging copy: create a guest, book a stay, post
   a charge, take a payment, run the night audit.

## 6. Operate

- **Backups.** `pg_dump --format=custom` on a schedule; restore into a fresh
  database and run `db:migrate` before switching traffic.
- **Secrets.** Rotate `JWT_SECRET` by restarting all nodes together; every
  session signs out. Keep `.env` out of version control (it is gitignored).
- **TLS.** Terminate at the proxy and redirect HTTP to HTTPS. The app does not
  set HSTS itself; add it at the proxy once HTTPS is permanent.
- **Rate limits.** Auth is capped at 10 attempts per 15 minutes and the API at
  200 requests per 15 minutes by default; tune `AUTH_RATE_LIMIT_MAX`,
  `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`.
- **Least privilege.** The database user needs DDL only during migration. Run
  `db:migrate` with an owner role and serve with a role limited to DML.
- **Updates.** Take a backup, deploy the new code, run `npm run db:migrate`
  (it is additive), restart. `--reset` is for demo installs only.

## 7. Boundaries of this build

These are deliberate and visible in the UI:

- The SPA stores its workspace in the browser. Clearing site data clears it;
  two browsers do not share it.
- Documents are a metadata register; file contents are not stored.
- Email, card capture and door-lock credentials are not connected. The screens
  say so where they would otherwise promise a send, a charge or a key.
- Product breadth still outstanding from the PRD: guest wallet/smartcard
  (6.10), gift cards (6.6) and mobile key provisioning (6.12).
