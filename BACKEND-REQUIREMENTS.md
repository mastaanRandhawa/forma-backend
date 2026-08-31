# Forma — Backend Requirements

What has to exist on the server side to turn the current web app from a
local-only demo into a real product. Derived from the product audit (§F, §H, §I,
§J, §L, §N) and a read of the existing `backend/` source.

> **Status of `backend/`**: a substantial Express + Prisma API already exists on
> disk but is **not tracked in this repo** and **not deployed**. It covers auth,
> profile/onboarding, sessions with incremental set logging, session finalize
> (volume / muscle activation / PR detection / trainer comment), the feature-unlock
> progression engine, readiness scoring, a deterministic workout generator,
> AI chat/insights, goals, store, notifications. Most of this work does **not**
> need to be rebuilt. The gaps below are what's actually missing.

> **Implemented so far** (branch `feat/real-data-lifecycle`, migration
> `20260830120000_adaptation_engine`):
> §2.1 prescription engine (`services/prescription.ts` + wired into `POST /sessions`),
> §2.2 deload detection (`services/deload.ts`), §2.3 low-readiness adjustment
> (`services/readiness.ts` → `readinessAdjustment`), §2.4 program schedule
> endpoint + `rescheduleMissedWorkouts` worker job, §2.5 substitution scoring,
> §3.1 `POST /progress/checkin` + readiness wiring, §3.2 `POST /me/health/samples`
> batch ingest + device error state, §3.3 `GET /me/devices/:provider/connect`
> stub, §4 `RecommendationAudit` model + exposed on session reads, §5 readiness
> factor rename / dashboard provenance flags / per-day consistency / AI copy
> guards. Unit tests: `prescription.test.ts`, `deload.test.ts`.
>
> §1 (frontend auth) done: `frontend/src/api/auth.tsx` (AuthProvider +
> RequireAuth / RedirectIfAuthed, session restore behind a splash), pages
> `Login` / `Signup` / `ForgotPassword` / `ResetPassword`, `main.tsx` rewired,
> "sign out" in Settings, onboarding dual-writes to `api.me.onboarding`. Typed
> client + DTOs extended for every new endpoint; Settings recovery check-in
> write-throughs to `POST /progress/checkin`. `tsc -b` + `vite build` clean.
> When `VITE_API_URL` is unset the guard is a no-op, so the Pages build is
> unchanged.
>
> §6 workout lifecycle is wired and **verified end-to-end** against the hosted DB
> (migration `20260830120000` is applied there): `src/lib/lifecycle.ts` +
> `localStore` id fields; Workouts "Today"/"History"/"Templates" and ActiveWorkout
> (start → prescription-seeded targets + `RecommendationAudit`, per-set
> write-through with lb↔kg conversion, finish → server volume/PRs/trainer comment)
> now use `api.sessions.*` when `VITE_API_URL` is set, falling back to localStore
> otherwise. Hooks: `usePlannedWorkouts` / `useWorkoutTemplates` /
> `useSessionHistory` / `useConsistency`. E2E surfaced and fixed a real backend
> bug: `finalizeSession` violated `PersonalRecord.setId @unique` when one set was
> both the top-weight and top-e1RM set (finish 409'd) — now dedupes claimed setIds.
>
> **2026-08-30 pt.4** — the rest of the backlog, migration
> `20260830210000_nutrition_and_oauth` (applied to the hosted DB):
> - **§5 nutrition** — `NutritionEntry` model + `GET/POST /progress/nutrition`,
>   `/nutrition/summary`, `DELETE /nutrition/:id`; a logged entry bumps the
>   "protein today" goal. Web: `NutritionCard` on Progress. Verified E2E.
> - **§6 Progress / Home** — now derive from `api.sessions.list` (via the
>   `apiSessionToCompleted` adapter) + `api.dashboard`; Body already used
>   `api.body.*`. Verified: Progress shows real e1RM / PRs / volume, Home greets
>   "Alex" with readiness 77 from the check-in.
> - **§3.3 wearable OAuth** — `services/wearables.ts` (WHOOP + Oura OAuth2 with
>   refresh + daily fetchers; Garmin flagged unavailable), public
>   `GET /oauth/:provider/callback`, `GET /me/devices/:provider/connect`
>   (200 `{configured, authorizeUrl | message}`), `POST …/sync`, `DELETE`,
>   `syncWearables` worker job (every 4h). Web: Settings "connected devices" with
>   connect / sync / disconnect + callback query-param feedback. The
>   not-configured path is verified E2E; live flows need CLIENT_ID/SECRET env.
> - **openapi.yaml** — new paths + schemas added (99 paths / 66 schemas, parses).
> - **§3.2 mobile companion** — Expo scaffold in `mobile/` (login → HealthKit /
>   Health Connect read → `POST /me/health/samples`, plus a background-fetch
>   task). Not runnable here (needs an Expo dev build); code follows the library
>   contracts. See `mobile/README.md`.
> - Fixed the dev-only React `createRoot()`-twice / `removeChild` warning
>   (`frontend/src/main.tsx` reuses the root across Vite HMR).
>
> **Not yet done:** §0 (host the web build so it gets `VITE_API_URL`); register
> real WHOOP / Oura developer apps; build & ship the mobile app from the scaffold.

---

## 0. The one real blocker: deploy the API

The GitHub Pages build is static and has no `VITE_API_URL`, so every hook falls
through to `localStore`/demo data. Nothing else in this document matters until:

- [ ] The `backend/` package is committed (its own repo or a `backend/` path here).
- [ ] A Postgres instance is provisioned (`render.yaml` / `docker-compose.yml`
      already describe one).
- [ ] Prisma migrations run against it (`prisma migrate deploy`) and `prisma/seed.ts`
      populates the exercise library, muscle groups, store items, achievements.
- [ ] The API is hosted with a stable HTTPS origin and CORS allows the web origin.
- [ ] Secrets set: `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
      AI provider key, OAuth client secrets (Apple/Google) — see `backend/src/env.ts`.
- [ ] The web deploy sets `VITE_API_URL` to that origin (GitHub Actions secret +
      `vite.config.ts` already reads it). Consider moving the web host off Pages
      to somewhere that can inject env at build time cleanly (Netlify / Vercel /
      Cloudflare Pages) or keep Pages with the env baked at build.
- [ ] Decide the offline story: keep `frontend/src/lib/localStore.ts` as an
      offline cache/queue, or delete it once the API is the source of truth.
      Recommended: keep it as a write-through cache so the app still works offline.

---

## 1. Web authentication surface (frontend, small)

The API has full auth (`/auth/register`, `/login`, `/refresh`, `/logout`,
`/social`, password reset) and `frontend/src/api/client.ts` already wraps all of
it with token storage + silent refresh. **Missing: the screens and the guard.**

- [ ] `/signup`, `/login`, `/forgot-password`, `/reset-password` routes + pages.
- [ ] An auth boundary in `frontend/src/main.tsx`: unauthenticated users hitting
      an app route redirect to `/login`; `/onboarding` runs post-signup.
- [ ] Persist tokens (client.ts uses in-memory + a refresh cookie/localStorage —
      confirm the storage choice; refresh token in `localStorage` is the norm for
      an SPA, or use an HTTP-only cookie if the API is same-site).
- [ ] "Sign out" in Settings → `api.auth.logout()` + clear local cache.
- [ ] Session restoration on load: call `api.auth.me()` (or `refresh`) before
      first paint; show a splash, not the demo dashboard.
- [ ] Move onboarding submit from `saveProfile()` (localStore) to
      `api.me.onboarding(payload)` — the endpoint and `OnboardingPayload` type
      already exist.

---

## 2. Progressive-overload / adaptation engine (backend, largest gap)

The audit's central complaint: Forma *claims* adaptive programming but nothing
adjusts future sessions. `programs.ts` even has a comment — *"progressive overload
is applied at session time"* — for code that does not exist.

### 2.1 Session prescription

When a session is started from a program/template workout, each exercise should
carry a **prescribed target** derived from history, not a static template value.

- [ ] New service `backend/src/services/prescription.ts`:
  ```
  prescribeExercise(userId, exerciseId, template) → { targetWeightKg, targetReps, targetRpe, note }
  ```
  Rule (deterministic, unit-tested — no LLM):
  ```
  last = most recent completed working sets for this exercise
  if no history:            start at template target (or a % of bodyweight table)
  if all sets hit top of rep range AND avg RPE ≤ 8:
                            targetWeight = round_to_plate(last.weight * 1.025 … 1.05)
  if hit mid-range, RPE 8–9: repeat same weight, aim +1 rep
  if missed bottom of range OR RPE > 9 on 2+ sets:
                            targetWeight = last.weight * 0.9  (back-off)
  ```
  `round_to_plate` respects the user's unit preference (2.5 lb / 1.25 kg steps).
- [ ] `POST /sessions` populates each seeded `ExercisePerformance` with these
      targets; the active-workout UI shows "last time: 135×8 → today: 140×8".
- [ ] Store the prescription + the inputs that produced it on the performance row
      (see §4, audit metadata).

### 2.2 Deload

- [ ] `shouldDeload(userId)` — triggers on: 3+ consecutive sessions with declining
      volume for the main lifts, or 4 weeks since the last deload, or a run of
      low-readiness days. Returns a week-scoped flag.
- [ ] When set, prescription drops volume ~40% and caps intensity for that week;
      the program view labels it "deload week".

### 2.3 Low-readiness adjustment

- [ ] On session start, read `computeReadiness(userId)`. If < 55, apply a
      session-scoped modifier: −1 set on accessories, RPE cap 8, suggest swapping
      the heaviest compound for a machine variant. Surface *why* to the user.
- [ ] This only works once real readiness inputs exist (§3) — until then it's a
      no-op and the UI must not imply otherwise.

### 2.4 Missed-workout rescheduling

- [ ] `TrainingProgram` needs a schedule (preferred weekdays, from onboarding).
- [ ] A daily job: if a scheduled session's day passed with no session logged,
      mark it missed and shift the remaining week forward (don't silently drop it).
- [ ] `GET /programs/:id/schedule` returns the resolved upcoming sessions with
      `status: scheduled | completed | missed | rescheduled`.

### 2.5 Exercise substitution scoring

- [ ] `workouts.ts` already has `swapSuggestions` with a `reason`. Extend it into
      a scored ranking: same primary muscle + movement pattern + available
      equipment + difficulty ≤ user ceiling + not recently done. Return top 3 with
      a one-line rationale each.

---

## 3. Health-data ingestion (backend + mobile companion)

The audit is blunt: sleep / HRV / resting HR / steps shown in the current UI are
mock. `readiness.ts` is built to consume `ProgressMetric` rows of type
`sleep | hrv | resting_hr`, and `POST /progress/metrics` accepts them with
`source: health_sync` — but **nothing writes them**. `PUT /me/devices/:provider`
only flips a connection flag.

### 3.1 Now — manual check-in (already half-built on web)

- [ ] Add `metricType: "recovery_checkin"` (or reuse the sleep/quality metrics)
      and a `POST /progress/checkin` endpoint:
      `{ sleepH, sleepQuality 1–5, fatigue 1–5, soreness 1–5 }`.
- [ ] Feed the check-in into `readinessBreakdown()` as a first-class factor when
      no wearable data is present. **Never** synthesize an HRV or resting-HR
      number from a check-in — those factors stay absent.
- [ ] The web already has this UI (`Settings → recovery check-in`); point it at
      the real endpoint instead of `localStore.addCheckin`.

### 3.2 Then — first-party mobile health sync

HealthKit (iOS) and Health Connect (Android) are native APIs; the browser cannot
read them. This needs the mobile companion app to be the sync agent.

- [ ] Mobile reads normalized daily metrics and calls a **batch ingest** endpoint:
  ```
  POST /me/health/samples
  {
    provider: "apple_health" | "health_connect",
    samples: [
      { type: "sleep",       value: 7.3, unit: "h",   start, end, sourceBundleId },
      { type: "hrv",         value: 68,  unit: "ms",  recordedAt },
      { type: "resting_hr",  value: 52,  unit: "bpm", recordedAt },
      { type: "steps",       value: 8231, unit: "count", date }
    ]
  }
  ```
- [ ] Dedup on `(userId, type, recordedAt, provider)` — re-syncs must be idempotent.
- [ ] Map samples → `ProgressMetric` rows; update `DeviceConnection.lastSyncAt`
      only on a successful ingest with real rows.
- [ ] Add a sync-error state to `DeviceConnection` (`lastError`, `lastErrorAt`)
      and surface it in Settings ("last sync failed 2h ago").

### 3.3 Later — third-party wearables (OAuth)

- [ ] Real OAuth flows for WHOOP, Oura, Garmin: `GET /me/devices/:provider/connect`
      → provider consent → callback stores tokens → a webhook or poll job pulls
      sleep/HRV/RHR into the same `ProgressMetric` pipeline.
- [ ] Token refresh + revoke (`DELETE /me/devices/:provider` must revoke upstream).
- [ ] Only build these after 3.2 works end to end.

---

## 4. Recommendation provenance / audit metadata

Audit §L: keep deterministic recommendations separate from AI wording, and record
how each recommendation was reached.

- [ ] New model `RecommendationAudit`:
  ```
  id, userId, kind ("prescription" | "deload" | "readiness_adjustment" | "swap"),
  subjectId (exerciseId / sessionId / programId),
  inputs   Json   -- the counters/history the rule saw
  rule     String -- which branch fired, e.g. "top_of_range_rpe<=8 → +2.5%"
  output   Json   -- prescribed weight/reps/sets
  createdAt
  ```
- [ ] Every prescription / adjustment writes one row.
- [ ] `GET /sessions/:id` and the exercise-detail endpoint expose the audit row so
      the UI can answer "why this weight?" with the actual rule, not AI prose.
- [ ] `services/ai.ts` (`sessionComment`, insights) is only allowed to *explain*
      an existing deterministic output — never to choose weights/reps. Add a guard
      / prompt contract that passes the computed numbers in and asks only for
      wording.

---

## 5. Smaller backend fixes

- [ ] **Readiness factor naming** (`services/readiness.ts`): the query window is
      3 days but the factor is labelled `"prior-day strain"`. Either narrow the
      query to 1 day or rename the factor to `"recent training load (3d)"`.
- [ ] **Muscle activation ≠ recovery**: `MuscleActivation` is a training-exposure
      score. Nothing (chat, insights, dashboard) may phrase it as "chest is
      recovered". Audit `services/ai.ts` and `services/insights.ts` copy.
- [ ] **Dashboard provenance flags**: `GET /dashboard` should return, per metric,
      whether it's `live | unavailable | computed` so the web can render "—"
      instead of a stale/zero value. Add `readinessAvailable`, `formAvailable`,
      `volumeSource` to the `Dashboard` DTO.
- [ ] **Consistency / adherence**: `GET /progress/consistency` should return real
      per-day session counts for the last 13 weeks (the web now computes this
      locally from logged sessions — move it server-side once sessions persist).
- [ ] **Exercise detail + history**: confirm `GET /library/exercises/:slug/history`
      returns per-session sets, e1RM trend, PRs, and recent notes — the web
      exercise-detail route (audit §F) depends on it.
- [ ] **Nutrition**: `ProgressMetric` has `protein | calories` types. Either build
      a real daily-log surface or drop those types and the related goal presets —
      don't ship a half nutrition model (audit §M5).

---

## 6. Frontend wiring checklist (after §0)

Replace the local stand-ins with API calls. The client methods already exist.

| Screen / concern | Currently (this branch) | Wire to |
| --- | --- | --- |
| Onboarding submit | `saveProfile()` → localStore | `api.me.onboarding()` |
| Today's plan | `lib/program.ts` templates | `api.programs.week()` / active program |
| Start workout | `startSession()` → localStore | `api.sessions.start({ workoutId })` |
| Log set / RPE | `updateActive()` | `api.sessions.logSet()` (already the hot path) |
| Add / delete set, swap exercise | localStore | `api.sessions.addPerformance()` / `deleteSet()` |
| Finish | `finishSession()` | `api.sessions.finish()` → returns volume, PRs, comment |
| History | localStore `sessions` | `api.sessions.list({ status: "completed" })` |
| Progress (e1RM, PRs, volume, streak, consistency) | `lib/fitness.ts` over localStore | `api.progress.*`, `api.progress.strength`, `api.progress.consistency` |
| Dashboard | `api/localDashboard.ts` | `api.dashboard()` (+ provenance flags from §5) |
| Recovery check-in | `localStore.addCheckin()` | `api.progress.checkin()` (§3.1) |
| Quick log bodyweight | `addQuickLog()` | `api.progress.addMeasurement({ weightKg })` |
| Trainer chat | canned setTimeout reply | `api.chat.send()` |
| Settings devices | static "not available" note | `api.me.devices()` + real connect flow (§3) |
| Muscle balance (`/body`) | demo | `api.body.muscleMap()` / `api.body.balance()` |

Keep `lib/fitness.ts` — its formulas (Epley, PR detection, streak) should match
the server's and are useful for optimistic UI.

---

## 7. Suggested build order

1. **Deploy** the API + DB + seed; set `VITE_API_URL` (§0).
2. **Web auth** screens + guard; onboarding → `api.me.onboarding` (§1).
3. **Wire the workout lifecycle**: start → logSet → finish → history → progress
   read from the API (§6). This alone closes most of audit §J.
4. **Manual recovery check-in** endpoint + wire it (§3.1).
5. **Prescription engine** §2.1 + **audit metadata** §4 — the first real adaptation.
6. **Dashboard provenance flags** §5 so the web stops guessing.
7. **Deload / low-readiness / missed-workout** §2.2–2.4.
8. **Mobile health sync** §3.2, then **third-party wearables** §3.3.
9. Nutrition decision §5, exercise-detail polish, substitution scoring §2.5.

---

## 8. New endpoint contracts (summary)

| Method & path | Purpose | § |
| --- | --- | --- |
| `POST /progress/checkin` | manual recovery check-in → readiness input | 3.1 |
| `POST /me/health/samples` | batch health-metric ingest from mobile | 3.2 |
| `GET /me/devices/:provider/connect` | start wearable OAuth | 3.3 |
| `GET /programs/:id/schedule` | resolved upcoming sessions w/ status | 2.4 |
| `GET /progress/consistency` | real 13-week per-day session counts | 5 |
| `GET /sessions/:id` (extend) | include `RecommendationAudit` per performance | 4 |
| `GET /dashboard` (extend) | add per-metric availability/source flags | 5 |
| `POST /sessions` (extend) | seed performances with prescribed targets | 2.1 |

## 9. New / changed Prisma models

- `RecommendationAudit` — new (§4).
- `DeviceConnection` — add `lastError`, `lastErrorAt`, OAuth token fields (§3).
- `TrainingProgram` — add schedule (`preferredWeekdays Int[]`, `startDate`) (§2.4).
- `ProgramDay` / session — add `status` for missed/rescheduled tracking (§2.4).
- `ExercisePerformance` — add `prescribedWeightKg`, `prescribedReps`,
  `prescribedRpe`, `prescriptionAuditId` (§2.1).
- `ProgressMetric` — add `recovery_checkin` metric type, or a dedicated
  `RecoveryCheckin` model (§3.1).
- `UserProgression` already exists — unrelated to training progression; don't
  overload it.
