# Forma — Backend

Cloud backend for **Forma**, the AI personal-trainer product. This service is the
account system, the cross-device sync store, and the AI-orchestration layer that
sits behind both the React Native mobile app and the `frontend/` web companion.

Built from the companion specs: `forma-product-design-spec.md` (§21 data model,
§22 architecture), `forma-design-language.md`, `forma-screens-components.md`,
plus the mock data the web app ships (`frontend/src/lib/data.ts`).

---

## 1. Stack

| Concern | Choice |
|---|---|
| Language | TypeScript (strict, ESM, NodeNext) |
| Runtime | Node 22 |
| HTTP | Express 4 |
| ORM / DB | Prisma 6 + PostgreSQL 16 |
| Auth | JWT access + rotating opaque refresh tokens (SHA-256 hashed at rest); bcrypt; Sign in with Apple / Google; password reset |
| Validation | Zod on every body / query / params |
| Security | helmet, CORS locked to `WEB_ORIGIN`, 1 MB JSON cap, `x-request-id`, tiered rate limits (global / auth / AI) |
| AI | Anthropic Messages API (`claude-sonnet-5`) with a deterministic offline fallback |
| Background | `node-cron` worker (separate process) — token cleanup, account purge, daily nudges, weekly rollup |
| Tests | Vitest + supertest |

```
backend/
├── prisma/schema.prisma   # full data model
├── prisma/seed.ts         # reference data + demo user
├── src/
│   ├── index.ts  app.ts  env.ts  prisma.ts  routes.ts
│   ├── worker.ts          # cron worker entry (npm run worker)
│   ├── data/              # seed catalogues
│   ├── lib/               # auth, errors, http
│   ├── middleware/        # requireAuth, validate, error, rateLimit, requestId
│   ├── services/          # plan, session, readiness, ai, notify, achievements, insights, social-auth
│   ├── jobs/              # scheduled job implementations
│   └── modules/           # one router per domain
├── docker-compose.yml  Dockerfile  vitest.config.ts  .env.example
```

---

## 2. Data model (`prisma/schema.prisma`)

Implements §21 in full plus the web companion + system surfaces.

- **Identity:** `User` (+ soft-delete, camera-privacy fields), `RefreshToken`, `PasswordReset`, `InjuryNote`, `Equipment`/`UserEquipment`, `DeviceConnection`, `Subscription`, `NotificationPreference`
- **AI trainer:** `Trainer` (name/avatar/voice + 6 personality dials + equipped theme)
- **Reference:** `MuscleGroup` (hierarchical, mesh region), `Exercise` + `ExerciseMuscle` (role + weight)
- **Planned:** `TrainingProgram` → `ProgramDay` → `Workout` → `WorkoutExercise` (superset grouping)
- **Performed:** `WorkoutSession` → `ExercisePerformance` → `ExerciseSet` → `FormAnalysis` (per-rep, categorical faults + key joint angles only — **never raw pose frames**)
- **Derived:** `MuscleActivation` (materialized per session), `PersonalRecord`, `ProgressMetric` (generalized time-series), `BodyMeasurement`, `ProgressPhoto`
- **Trainer chat:** `ChatMessage` (role, rich content, `viaVoice`, `trainerSnapshot` for QA traceability, `appliedAt`), `CoachingInsight` (T4 log)
- **Gamification:** `Goal`/`GoalEntry`, `Achievement`/`UserAchievement`, `Wallet`/`WalletTransaction`, `StoreItem`/`UserStoreItem`
- **First-run experience:** `BackgroundPreset` (seed reference — curated background/glass looks, `isDefault` + `minTier` + `storeItemId` gating), `UserAppearance` (per-user override layer, clamps enforced), `UserDisclosure` (quiet-widget mode + per-widget overrides), `UserProgression` (monotonic `unlockedFeatures`, derived `tier`, `gatingEnabled`)
- **System:** `Notification` (incl. `feature_unlocked`)

---

## 3. API — every endpoint

**Contract:** [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1) is the source of truth.
Narrative reference + conventions + screen→endpoint map: [`API.md`](API.md).
Typed client for the web app: [`../frontend/src/api/`](../frontend/src/api).
When the server runs: `GET /api/v1/docs` (Redoc), `/api/v1/docs/openapi.json`.

Base `/api/v1`. All except `/health`, `/docs/*` and `/auth/*` require `Authorization: Bearer <accessToken>`.

### Auth — `/auth` (rate-limited)
`POST /register` · `POST /login` · `POST /refresh` · `POST /logout` · `GET /me`
`POST /social/:provider` (apple|google) · `POST /forgot-password` · `POST /reset-password`

### Profile & settings — `/me`
`GET /` (full bundle; lazily re-evals progression if stale) · `PATCH /`
`POST /onboarding` (profile+trainer+equipment+injuries+goals + optional `experience` block — also creates appearance/disclosure/progression rows)
`GET /settings` · `PUT /settings` — **the bundle**: `{ camera, units, appearance, disclosure, progression }`, deep-merge patch, per-block validation (hex regex, glass/dim clamps, image-host allowlist, widget-override key/enum → 422)
`PUT /progression` (`gatingEnabled` toggle) · `POST /progression/evaluate` (force re-eval)
`GET/POST /injuries` · `DELETE /injuries/:id` (O9/S11)
`GET/PUT /equipment` (O6/S10) · `GET /devices` · `PUT /devices/:provider` (S4/S5)
`GET /export` (GDPR JSON) · `DELETE /` (account deletion, soft + 30-day purge)

### Config — `/config` (auth optional, cacheable)
`GET /appearance-presets` — curated presets filtered by the caller's tier + owned themes

### First-run experience (appearance · disclosure · progression)
The appearance engine (themeable "liquid glass" surface), progressive disclosure
(quiet widgets until touched) and unlock progression (UI grows as the user earns
it) all live in the settings bundle. Rules table: `src/data/progression.ts`
(12 features, `starter→building→established→full`). Engine: `src/services/progression.ts`
(deterministic counter thresholds; fires `feature_unlocked` notifications; re-evaluated
after every `POST /sessions/:id/finish` and `POST /achievements/evaluate`).
`gatingEnabled:false` short-circuits to "everything unlocked". Presets: `src/data/appearance.ts`.
Full spec + delivery notes: [`docs-appearance-progression.md`](docs-appearance-progression.md).

### Trainer — `/trainer`
`GET /` · `PATCH /` · `POST /apply-personality/:storeItemId`
`GET /insights` · `POST /insights/generate` · `POST /insights/:id/dismiss` (T4)
`GET /check-in` · `POST /check-in/respond` (T5)
`GET /catalogue` (voices/avatars/themes/personalities — T2/O11)

### Exercise library — `/library`
`GET /muscle-groups` · `GET /muscle-groups/:key/exercises` (E3/B5)
`GET /exercises?q=&muscle=&equipment=&camera=&take=&skip=` (E1)
`GET /exercises/:slug` (+ alternatives, E2) · `GET /exercises/:slug/history` (personal history card, E2)

### Workouts — `/workouts`
`GET /?template=&from=&to=` · `GET /:id` · `POST /` · `PUT /:id` · `DELETE /:id`
`POST /:id/duplicate` (save-as-template / copy) · `POST /generate` (AI generator W2, deterministic)
`POST /swap-suggestions` (AI-ranked alternatives + why-swap reasons, W10)

### Programs — `/programs` (multi-week, W5/O15)
`GET /` · `GET /:id` · `GET /:id/week/:n` · `POST /generate` · `POST /:id/activate`
`POST /:id/schedule` (lay a week onto calendar dates) · `DELETE /:id`

### Sessions (active workout) — `/sessions`
`POST /` (start from workout or ad hoc) · `GET /` (W13) · `GET /:id` (W11/W14)
`POST /:id/performances` (swap mid-session, W10)
`PUT /:id/performances/:perfId/sets/:setNumber` (log a set — W7 hot path) · `DELETE …/sets/:setNumber`
`POST /:id/form-analysis` (per-rep camera ingest, W8)
`POST /:id/finish` → recompute volume + materialize `MuscleActivation` + detect PRs + trainer comment + fire achievements/insights/notifications (W11)
`POST /:id/abandon`

### Body / 3D map — `/body`
`GET /muscle-map?range=today|week|month` (B1/B2) · `GET /balance` (B4) · `GET /muscle/:key` (detail sheet B3)

### Progress — `/progress`
`GET/POST /metrics` · `GET/POST /measurements` (P4) · `GET /personal-records` (P7)
`GET /strength/:slug?days=` (P2) · `GET /overview` (P1) · `GET /readiness` (H3 breakdown)
`GET /consistency?weeks=` (P3) · `GET /form-trends?slug=&days=` (P6)
`GET /photos` · `POST /photos` (presigned-upload stub) · `DELETE /photos/:id` · `GET /photos/compare?a=&b=` (P5)
`GET /report?days=` (P8 export payload)

### Goals — `/goals`
`GET /` · `POST /` · `POST /:id/log` (set|increment) · `DELETE /:id`

### Store & wallet — `/store`
`GET /wallet` · `POST /wallet/earn` · `GET /items?category=` · `POST /items/:id/buy` · `POST /items/:id/equip`

### Chat — `/chat` (AI rate-limited)
`GET /?take=&before=` · `POST /` · `POST /voice` (T3) · `DELETE /`
`POST /messages/:id/apply` (ApplyAction card) · `GET /suggested-prompts`

### Notifications — `/notifications`
`GET /?unread=` · `POST /:id/read` · `POST /read-all` · `DELETE /:id` (H2)
`GET /preferences` · `PUT /preferences` (S6)

### Achievements — `/achievements`
`GET /` (with per-user progress) · `POST /evaluate`

### Subscription — `/subscription`
`GET /plans` · `GET /` (entitlement) · `POST /validate-receipt` (App/Play stub) · `POST /cancel` (S9/X1)

### Dashboard — `/dashboard`
`GET /` — Home aggregate (H1): greeting, trainer message, today/next workout, weekly ring,
volume, readiness, streak, recent PRs, active session, goals, unread count, insights

### `GET /health`

---

## 4. How it maps to spec §22

| Spec concept | Here |
|---|---|
| Platform-neutral sync store | Postgres + Prisma; mobile is local-first SQLite, reconciles against these REST resources |
| AI orchestration | `services/ai.ts` — prompt construction + personality parameterization + guardrails; offline fallback |
| Deterministic workout/program generation | `services/plan.ts` + `modules/programs.ts` — auditable set/rep/exercise selection; LLM only for phrasing |
| Analytics aggregation | `finalizeSession()`, `MuscleActivation` materialization, `jobs/weeklyRollup` |
| Insight rules engine (§15.3) | `services/insights.ts` — deterministic rules over the derived layer → `CoachingInsight` |
| Readiness | `services/readiness.ts` — from synced sleep/HRV/RHR + training load; raw health data never stored |
| Camera / pose | on-device only; backend receives categorical form scores + fault labels + key joint angles via `POST /sessions/:id/form-analysis`; verbosity is a user setting (`/me/settings`) |
| Proactive coaching / check-ins | `jobs/dailyNudges`, `services/insights.buildCheckIn`, `/trainer/check-in` |
| Subscription reconciliation | `modules/subscription.ts` — one entitlement model; receipt verification is stubbed (`TODO`) |
| Wearable HR streaming | out of scope (needs a realtime channel; `DeviceConnection` tracks pairing) |
| First-run cognitive load | appearance engine + progressive disclosure + unlock progression, all in `GET/PUT /me/settings`; brand re-themes propagate to every user still on a preset by editing `src/data/appearance.ts` and re-running the idempotent seed |

---

## 5. Local setup

```bash
cd backend
cp .env.example .env                 # fill JWT secrets
docker compose up -d                 # Postgres on :5432
npm install
npm run prisma:migrate               # first run: name it "init"
npm run db:seed                      # reference data + presets + demo user
npm run db:backfill                  # existing users: default appearance/disclosure rows + run progression once
npm run dev                          # API  → http://localhost:4000/api/v1
npm run worker                       # (separate terminal) cron jobs
npm test                             # contract + rule-table tests (no DB needed)
```

Demo login: `alex@forma.app` / `forma1234`.

Point the web companion at it with `VITE_API_URL=http://localhost:4000/api/v1`.

### Testing
`src/app.test.ts` covers routing / auth guard / validation / error shape with no
database. Full DB integration tests should run against a disposable Postgres
(`docker compose` + a `forma_test` database) — not yet written.

---

## 6. Remaining work

Everything in the screen inventory now has a read/write path. What's left is
depth and production hardening, not missing features:

- **Real integrations behind the stubs:** Apple/Google JWKS verification (`services/social-auth.ts`), App Store / Play Store receipt validation, S3/R2 presigned upload for progress photos, transactional email for password reset, APNs/FCM push transport for `Notification` rows.
- **Superset/circuit builder (W16):** schema supports it (`supersetGroup`/`supersetType`); no dedicated grouping endpoint yet.
- **PDF export (P8):** `/progress/report` returns the full payload; rendering to PDF is a client or separate service concern.
- **Realtime:** WebSocket channel for wearable heart-rate streaming during a session.
- **Ops:** OpenAPI/Swagger generation, structured logging, DB integration test suite, CI, migration for a fresh environment (`prisma migrate deploy`).
- **AI depth:** richer inline chat cards (charts, exercise cards), return-after-absence summary, program auto-progression logic.
