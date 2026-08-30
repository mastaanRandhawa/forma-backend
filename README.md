# Forma — Backend

Cloud API for **Forma**, the AI personal-trainer product. TypeScript · Express 4 ·
Prisma 6 · PostgreSQL. Backs the React Native app and the web companion.

- **[`BACKEND.md`](BACKEND.md)** — architecture, data model, every endpoint, how it maps to the product spec
- **[`API.md`](API.md)** — API conventions, auth flow, the settings bundle, the active-workout write path
- **[`openapi.yaml`](openapi.yaml)** — the machine-readable contract (also served at `GET /api/v1/docs`)
- **[`docs-appearance-progression.md`](docs-appearance-progression.md)** — the appearance / disclosure / progression feature spec

> This repo is a read-only mirror of the `backend/` folder of the Forma monorepo.

---

## Run it

**Prerequisites:** Node 22, and a PostgreSQL 16 database.

```bash
cp .env.example .env          # then edit: set JWT secrets, point DATABASE_URL at your DB
npm install
```

### Database — pick one

**a) Hosted Postgres (Render / Neon / Supabase / RDS)** — paste the connection
string into `DATABASE_URL` in `.env`. Hosted Postgres requires SSL, so append
`?sslmode=require`.

On Render: open the database, *Connect*, copy the **External Database URL** (the
internal one only works from inside Render):

```
DATABASE_URL="postgresql://USER:PASSWORD@dpg-xxxxxxxx-a.oregon-postgres.render.com/DBNAME?sslmode=require"
```

**b) An existing local Postgres** — create the database and user, then point
`DATABASE_URL` at it:

```sql
CREATE ROLE forma WITH LOGIN PASSWORD 'forma';
CREATE DATABASE forma OWNER forma;
```
```
DATABASE_URL="postgresql://forma:forma@localhost:5432/forma?schema=public"
```

**c) Docker** — `docker-compose.yml` provisions Postgres at the `.env.example` URL: `docker compose up -d`

### Migrate, seed, start

```bash
npx prisma migrate dev --name init   # creates prisma/migrations/ and applies the schema
npm run db:seed                      # reference data (exercises, muscles, presets) + demo user
npm run dev                          # API → http://localhost:4000/api/v1
```

After the first `migrate dev`, deployments use `npm run prisma:deploy`
(`prisma migrate deploy`) to apply committed migrations.

Open **http://localhost:4000/api/v1/docs** for the interactive API reference.

Demo login: `alex@forma.app` / `forma1234`

```bash
curl -s localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"alex@forma.app","password":"forma1234"}'
```

### Other processes / commands

```bash
npm run worker        # background cron jobs (token cleanup, reminders, weekly rollup) — separate terminal
npm test              # contract + rule-table tests (no database needed)
npm run db:backfill   # one-off: default appearance/disclosure rows + progression eval for existing users
npm run build && npm start          # production build
npm run prisma:studio               # browse the DB
```

### Connecting the web app

In the frontend's `.env`:

```
VITE_API_URL=http://localhost:4000/api/v1
```

### Deploy to Render

**Blueprint (easiest):** Render dashboard → *New* → *Blueprint* → select this repo.
`render.yaml` provisions a Postgres + a web service, generates the JWT secrets, and
wires `DATABASE_URL`. After the first deploy succeeds, open the service *Shell* and
run `npm run db:seed` once. Edit `WEB_ORIGIN` in `render.yaml` to your frontend's
origin.

**Manual web service** — *New* → *Web Service* → this repo:

| Field | Value |
|---|---|
| Runtime | Node |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm run prisma:deploy && npm start` |
| Health check path | `/api/v1/health` |

Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | link the Render Postgres (use its **Internal** URL — same region, no `sslmode` needed) |
| `JWT_ACCESS_SECRET` | *Generate* |
| `JWT_REFRESH_SECRET` | *Generate* |
| `WEB_ORIGIN` | your frontend origin, e.g. `https://mastaanrandhawa.github.io` (comma-separated for several, no trailing slash) |
| `ANTHROPIC_API_KEY` | optional — omit for the deterministic offline trainer |
| `AI_MODEL` | optional — defaults to `claude-sonnet-5` |

`PORT` is injected by Render automatically. `prisma generate` runs on `npm ci` via
the `postinstall` hook; `prisma migrate deploy` runs on every deploy via the start
command. Seed once from the Shell: `npm run db:seed`.

Notes: free Postgres expires after 30 days; free web services sleep after 15 min
idle (cold start ~30s). The background `worker` (reminders / cleanup) is optional
and needs a paid plan — see the commented block in `render.yaml`.

### Deploy with Docker

`Dockerfile` builds a production image that runs `prisma migrate deploy` then the
server. Provide `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`WEB_ORIGIN` (and optionally `ANTHROPIC_API_KEY`).

```bash
docker build -t forma-backend .
docker run -p 4000:4000 --env-file .env forma-backend
```
