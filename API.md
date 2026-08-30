# Forma API — Reference

The machine-readable contract is **[`openapi.yaml`](openapi.yaml)** (OpenAPI 3.1).
When the server is running it is also served at:

| URL | What |
|---|---|
| `GET /api/v1/docs` | Rendered reference (Redoc) |
| `GET /api/v1/docs/openapi.json` | Spec as JSON |
| `GET /api/v1/docs/openapi.yaml` | Spec as YAML |

A typed TypeScript client + DTOs for the web app lives in
[`../frontend/src/api/`](../frontend/src/api).

---

## Conventions

**Base URL** — every path is under `/api/v1`. Local: `http://localhost:4000/api/v1`.

**Auth** — all endpoints except `/health`, `/docs/*`, `/config/*` and `/auth/*` require:

```
Authorization: Bearer <accessToken>
```

Access tokens are JWTs, valid ~15 minutes. Refresh tokens are opaque, valid 30
days, **single-use** (rotated on every `/auth/refresh`). Store the refresh token
in secure storage (Keychain / Keystore on mobile; the web app keeps it in memory +
`localStorage` — see the client). On `401 unauthorized`, call `/auth/refresh`
once and retry; if that also fails, send the user to sign-in.

**Error envelope** — every non-2xx response is:

```json
{ "error": { "code": "bad_request", "message": "Validation failed", "details": { "fieldErrors": { "email": ["Invalid email"] } } } }
```

`code` values: `bad_request` (400), `unauthorized` (401), `forbidden` (403),
`not_found` (404), `conflict` (409), `rate_limited` (429), `internal` (500).
`details` is present only on validation errors (zod `flatten()` output).

**IDs** are opaque CUID strings. Don't parse them.

**Timestamps** are ISO-8601 UTC strings (`2026-08-30T04:00:00.000Z`).

**Units** — the API is metric everywhere (`kg`, `cm`). The client converts for
display based on `user.unitPreference`. RPE is 1–10 in 0.5 steps. Form scores and
readiness are 0–100. Muscle activation is 0–1.

**Pagination** — list endpoints that can grow take `take` (max noted per endpoint)
and either `skip` (offset, library search) or `before` (cursor by `createdAt`,
chat). Others return the full working set (goals, today's workouts, etc).

**Rate limits** — `429` with `Retry-After`. Tiers: auth `20 / 15 min`,
chat `20 / min`, everything else `240 / min` (per IP; production only).

**Request ids** — send `X-Request-Id` to correlate logs; the response echoes it.

---

## Auth flow

```
register / login / social         → { user, accessToken, refreshToken }
   │
   ├─ authed requests with  Authorization: Bearer <accessToken>
   │
   └─ on 401 →  POST /auth/refresh { refreshToken }  → { accessToken, refreshToken }
                    │ (old refresh token is now dead — replace it)
                    └─ on failure → sign in again

logout   → POST /auth/logout { refreshToken }   (revokes it)
```

New accounts are fully bootstrapped server-side (trainer config, wallet with 100
coins, default store items equipped, notification prefs, the four starter goals,
a free subscription). After sign-up, walk the client through `POST /me/onboarding`
which accepts profile + trainer + equipment + injuries in one call and flips
`onboardingCompletedAt`.

Social sign-in (`POST /auth/social/apple` | `/auth/social/google`): send the
provider identity token as `identityToken`. In non-production the server accepts a
base64url-encoded `{ sub, email, name }` JSON payload so the flow is testable
before real JWKS verification is wired.

---

## Screen → endpoint map

| Screen | Primary calls |
|---|---|
| Onboarding (O1–O16) | `POST /auth/register` → `POST /me/onboarding` → `POST /programs/generate` |
| Home Dashboard (H1) | `GET /dashboard` |
| Notifications Center (H2) | `GET /notifications`, `POST /notifications/:id/read` |
| Readiness Detail (H3) | `GET /progress/readiness` |
| Workouts Home / Templates (W1/W4) | `GET /workouts?template=`, `GET /programs` |
| AI Generator (W2) | `POST /workouts/generate` |
| Manual Builder (W3) | `GET /library/exercises`, `POST /workouts` |
| Pre-Workout Summary (W6) | `GET /workouts/:id` |
| Active Workout — manual (W7) | `POST /sessions` → `PUT /sessions/:id/performances/:perfId/sets/:n` → `POST /sessions/:id/finish` |
| AI Camera Workout (W8) | as W7 + `POST /sessions/:id/form-analysis` |
| Exercise Swap (W10) | `POST /workouts/swap-suggestions`, `POST /sessions/:id/performances` |
| Workout Summary (W11) | response of `POST /sessions/:id/finish` |
| Calendar / History (W12/W13/W14) | `GET /workouts?from=&to=`, `GET /sessions`, `GET /sessions/:id` |
| Trainer Chat (T1) | `GET /chat`, `POST /chat`, `GET /chat/suggested-prompts` |
| Trainer Customization (T2) | `GET /trainer`, `PATCH /trainer`, `GET /trainer/catalogue` |
| Voice Mode (T3) | `POST /chat/voice` |
| Coaching Insights (T4) | `GET /trainer/insights` |
| Check-In (T5) | `GET /trainer/check-in`, `POST /trainer/check-in/respond` |
| Body — Today / Overview (B1/B2) | `GET /body/muscle-map?range=` |
| Muscle Detail (B3) | `GET /body/muscle/:key` |
| Muscle Balance (B4) | `GET /body/balance` |
| Progress Overview (P1) | `GET /progress/overview` |
| Strength (P2) | `GET /progress/strength/:slug` |
| Volume & Consistency (P3) | `GET /progress/consistency` |
| Measurements (P4) | `GET /progress/measurements`, `POST /progress/measurements` |
| Progress Photos (P5) | `GET/POST /progress/photos`, `GET /progress/photos/compare` |
| Form Trends (P6) | `GET /progress/form-trends` |
| PR List (P7) | `GET /progress/personal-records` |
| Report Export (P8) | `GET /progress/report` |
| Exercise Library (E1–E4) | `GET /library/exercises`, `GET /library/exercises/:slug`, `GET /library/muscle-groups/:key/exercises` |
| Exercise Detail (E2) | `GET /library/exercises/:slug`, `GET /library/exercises/:slug/history` |
| Settings (S1–S13) | `GET /me`, `PATCH /me`, `GET/PUT /me/settings` (the bundle), `GET/PUT /me/equipment`, `GET/PUT /me/devices/:provider`, `GET/PUT /notifications/preferences`, `GET /subscription` |
| Appearance / theming | `GET /config/appearance-presets`, `PUT /me/settings { appearance }` |
| Calm mode / quiet widgets | `PUT /me/settings { disclosure }` |
| Unlock progression / "show everything" | `GET /me/settings` (`progression` block), `PUT /me/progression { gatingEnabled }`, `POST /me/progression/evaluate` |
| Paywall (X1) | `GET /subscription/plans`, `POST /subscription/validate-receipt` |
| Store | `GET /store/items`, `POST /store/items/:id/buy`, `POST /store/items/:id/equip`, `GET /store/wallet` |
| Goals | `GET /goals`, `POST /goals/:id/log` |
| Achievements strip | `GET /achievements` |

---

## The settings bundle (`GET` / `PUT /me/settings`)

One call returns everything the shell needs to render itself:

```jsonc
{
  "camera":   { "formDataVerbosity": "categorical", "saveHighlightClips": false },
  "units":    { "unitPreference": "metric", "weekStartsMonday": true },
  "appearance": {
    "presetId": "aurora-plum",        // null once the user hand-edits
    "backgroundMode": "gradient",     // solid | gradient | image
    "backgroundColor": "#170D17",
    "backgroundGradient": { "angle": 160, "stops": [{ "color": "#241021", "at": 0 }, ...] },
    "backgroundImageUrl": null,
    "backgroundDim": 0,               // 0..1 scrim
    "glass": { "opacity": 0.72, "blurPx": 18, "tint": "#2A1623" },
    "accentColor": "#D51A7A",         // resolved (brand default when unset)
    "reduceMotion": false,
    "updatedAt": "..."
  },
  "disclosure": {
    "mode": "always",                 // always | on_interaction
    "widgetOverrides": { "readiness-ring": "always" }   // effective = overrides[key] ?? mode
  },
  "progression": {
    "tier": "building",               // starter | building | established | full
    "unlockedFeatures": ["dashboard", "workouts", "trainer", "body_map", "progress_basic"],
    "gatingEnabled": true,            // false → unlockedFeatures is the full set
    "nextUnlock": { "feature": "goals", "requirement": "Finish 2 workouts or train on 3 different days", "progress": { "current": 1, "target": 2 } }
  }
}
```

`PUT /me/settings` accepts **any subset** of those blocks (deep-merge). Per-block rules:

- **appearance** — hex colours `#RRGGBB` or `#RRGGBBAA`; `glass.opacity` clamped `0.35–0.95`,
  `glass.blurPx` `0–40`, `backgroundDim` `0–1`; `backgroundImageUrl` must be `https://` on
  an allowlisted host (upload user images through the progress-photo presigned flow).
  Setting `presetId` copies that preset's values; editing any theme field afterwards nulls
  `presetId`. `403` if the preset is above your tier or a premium theme you don't own.
- **disclosure** — `widgetOverrides`: ≤ 60 keys, each key `^[a-z0-9-]{1,40}$`, each value
  `always | on_interaction`. Invalid key/value → `422`. Unknown *widget names* are fine
  (the client owns the registry).
- **camera / units** → the corresponding `User` columns.

Client maps `appearance` → CSS custom properties (`--app-bg`, `--glass-opacity`,
`--glass-blur`, `--tint`, `--accent`) and layers translucent surfaces over the base.

**Progression** is server-evaluated and monotonic — features never re-lock. It re-runs
after every `POST /sessions/:id/finish` (response carries `progression.newlyUnlocked`)
and `POST /achievements/evaluate`, and lazily on `GET /me` if stale > 6h.
`PUT /me/progression { gatingEnabled: false }` is the "show me everything" switch;
flipping it back on never discards earned unlocks. Deep-linking to a locked route still
`200`s from the API — gating is a UX layer, not authorization.

`GET /config/appearance-presets` (auth optional, `Cache-Control: 300s`) lists the presets
the caller may pick — filtered by tier and owned premium themes.

---

## The active-workout write path (most important flow)

```
POST /sessions { workoutId }
  → session with empty `performances` (one per planned exercise)

for each set the user completes:
  PUT /sessions/:id/performances/:perfId/sets/:setNumber
    { weightKg, reps, rpe, completed: true }
  → ExerciseSet   (upsert — safe to retry, safe to send partial then complete)

camera mode, after each tracked set:
  POST /sessions/:id/form-analysis { performanceId, setNumber, reps: [...] }

swap an exercise mid-session:
  POST /sessions/:id/performances { exerciseId, order }   (upsert by order)

finish:
  POST /sessions/:id/finish { durationSeconds }
  → fully computed session: totalVolumeKg, muscleActivations[], personalRecords[],
    trainerComment.  Also fires achievements, insights and PR notifications.
```

Everything is upsert-by-natural-key, so an offline client can replay its queue
without duplicating rows. `POST /sessions/:id/finish` is idempotent.
