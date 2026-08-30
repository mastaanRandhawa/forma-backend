# Backend spec — Appearance engine + Progressive disclosure + Unlock progression

> **Status: implemented (2026-08-29).** Delivery notes + deviations are in
> [§7](#7-implementation-status) at the end of this doc. Contract is in
> `openapi.yaml` / `API.md` ("The settings bundle"). The sections below are the
> original spec, kept for reference.

Implement three linked features in the Forma backend (`backend/`, Express 4 + Zod +
Prisma 6/PostgreSQL, ESM/NodeNext, base path `/api/v1`, JWT auth). Follow the
existing conventions: one router module per domain in `src/modules/`, Zod on every
body/query, deterministic rules in `src/services/`, reference data in
`prisma/seed.ts` and `src/data/`, contract tests in `src/app.test.ts`.

The product goal is **reducing first-run cognitive load**: a calm, themeable
surface; the option to keep widgets quiet until touched; and a UI that starts
small and grows as the user earns their way into it.

---

## 0. Client contract (how the web/mobile app consumes this)

Add everything to the existing settings bundle so the client fetches it in one
call. Extend `GET /me/settings` and `PUT /me/settings`:

```jsonc
// GET /api/v1/me/settings
{
  "camera":   { "formDataVerbosity": "categorical", "saveHighlightClips": false },
  "units":    { "unitPreference": "metric", "weekStartsMonday": true },
  "appearance": {
    "presetId": "aurora-plum",          // null when fully custom
    "backgroundMode": "solid",          // solid | gradient | image
    "backgroundColor": "#170D17",
    "backgroundGradient": null,         // { angle: 160, stops: [{ color, at }] }
    "backgroundImageUrl": null,
    "backgroundDim": 0.0,               // 0..1 scrim over image/gradient
    "glass": { "opacity": 0.72, "blurPx": 18, "tint": "#2A1623" },
    "accentColor": null,               // null = brand default (#D51A7A)
    "reduceMotion": false,
    "updatedAt": "2026-08-30T..."
  },
  "disclosure": {
    "mode": "always",                  // always | on_interaction
    "widgetOverrides": {               // per-widget exceptions to `mode`
      "readiness-ring": "always",
      "weekly-volume": "on_interaction"
    }
  },
  "progression": {
    "tier": "starter",                 // starter | building | established | full
    "unlockedFeatures": ["dashboard", "workouts", "trainer"],
    "gatingEnabled": true,             // false = user opted to "show everything"
    "nextUnlock": {
      "feature": "body_map",
      "requirement": "Finish your first workout",
      "progress": { "current": 0, "target": 1 }
    }
  }
}
```

`PUT /me/settings` accepts any subset of the same shape (deep-merge, validate each
block). Unknown `widgetOverrides` keys are stored as-is (the client owns the
widget registry); values are validated against the `on_interaction | always`
enum.

The client maps `appearance` → CSS custom properties (`--app-bg`,
`--glass-opacity`, `--glass-blur`, `--tint`, `--accent`) and layers every surface
as translucent "liquid glass" over the solid/gradient/image base.

---

## 1. Appearance engine

### 1a. Curated presets (backend-owned, changeable without an app release)

New reference model — seed a starter set, expose read-only:

```prisma
model BackgroundPreset {
  id              String   @id            // slug, e.g. "aurora-plum"
  name            String
  mode            String                  // "solid" | "gradient" | "image"
  backgroundColor String?
  gradient        Json?                   // { angle, stops:[{color,at}] }
  imageUrl        String?
  backgroundDim   Float    @default(0)
  glass           Json                    // { opacity, blurPx, tint }
  accentColor     String?
  sortOrder       Int      @default(0)
  isDefault       Boolean  @default(false) // the app-wide default for new users
  minTier         String?                 // null = always available; else gate by progression tier
  storeItemId     String?                 // if set, unlock requires owning this StoreItem (category "theme")
}
```

- `GET /api/v1/config/appearance-presets` — public-ish (auth optional), cacheable
  (`Cache-Control: public, max-age=300`). Returns presets the caller may use:
  filter out `minTier` above the user's tier and `storeItemId` they don't own; if
  unauthenticated, return only the unlocked/free ones.
- Seed ~6 presets covering the current dark plum look plus 2–3 calmer/lighter
  options and 1–2 premium ones tied to `StoreItem` `theme` rows (the store +
  wallet system already exists — reuse it, don't build a parallel one).
- Exactly one `isDefault: true`. New users get its values copied into their
  `appearance` at onboarding.

### 1b. Per-user appearance (override layer)

```prisma
model UserAppearance {
  userId             String  @id
  user               User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  presetId           String?                       // null once they hand-edit
  backgroundMode     String  @default("solid")
  backgroundColor    String  @default("#170D17")
  backgroundGradient Json?
  backgroundImageUrl String?
  backgroundDim      Float   @default(0)
  glassOpacity       Float   @default(0.72)        // clamp 0.35..0.95
  glassBlurPx        Int     @default(18)          // clamp 0..40
  glassTint          String  @default("#2A1623")
  accentColor        String?
  reduceMotion       Boolean @default(false)
  updatedAt          DateTime @updatedAt
}
```

- `PUT /me/settings { appearance }` upserts this row. Validation:
  - hex colours: `/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/`
  - `glassOpacity` clamp `0.35..0.95` (never let the app become unreadable),
    `glassBlurPx` clamp `0..40`, `backgroundDim` `0..1`
  - `backgroundImageUrl`: must be `https://` and on an allowlisted host
    (your CDN / R2 bucket). Reuse the progress-photo presigned-upload path for
    user-supplied images — do **not** proxy arbitrary URLs.
  - Setting `presetId` to a valid, permitted preset copies that preset's values
    and keeps `presetId` set. Editing any field afterwards nulls `presetId`.
- Merge order the client should see in the bundle: preset defaults → user
  overrides. Backend returns the already-merged object.

### 1c. Admin / brand control

- A preset flagged `isDefault` changing = the whole app re-themes on next
  `GET /me/settings` for every user still on a preset (i.e. `presetId != null`).
  Users who customised (`presetId == null`) are untouched.
- No new admin UI required — presets are seed/migration data. Document that
  changing `prisma/seed.ts` + re-running the idempotent seed is the update path.

---

## 2. Progressive disclosure (quiet widgets)

Pure settings storage — no computed behaviour server-side.

```prisma
model UserDisclosure {
  userId          String  @id
  user            User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  mode            String  @default("always")   // "always" | "on_interaction"
  widgetOverrides Json    @default("{}")        // { [widgetKey]: "always" | "on_interaction" }
  updatedAt       DateTime @updatedAt
}
```

- `PUT /me/settings { disclosure }`:
  - `mode` ∈ `always | on_interaction`
  - `widgetOverrides`: object, ≤ 60 keys, each key `^[a-z0-9-]{1,40}$`, each value
    in the enum. Reject anything else with 422.
- Effective visibility for a widget = `widgetOverrides[key] ?? mode`. The client
  computes this; backend only stores and validates.
- Onboarding: offer a "Calm mode" choice (see §4). If chosen, write
  `mode: "on_interaction"` and seed a few `always` exceptions for the safety-
  critical widgets (`readiness-ring`, `next-workout`).

Known widget keys (for docs/tests — the client is the source of truth):
`readiness-ring`, `weekly-volume`, `avg-form`, `weekly-goal`, `protein-today`,
`workout-streak`, `training-volume-chart`, `session-card`, `up-next`,
`kai-message`, `goals-card`, `insights`.

---

## 3. Unlock progression

Deterministic, server-evaluated, auditable — model it on `services/insights.ts`
and the achievements engine.

### 3a. Data

```prisma
model UserProgression {
  userId           String   @id
  user             User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  tier             String   @default("starter")   // starter | building | established | full
  unlockedFeatures String[] @default([])          // feature keys, additive, never removed
  gatingEnabled    Boolean  @default(true)        // false = user chose "show me everything"
  firstRunAt       DateTime @default(now())
  lastEvaluatedAt  DateTime @default(now())
}
```

### 3b. Feature keys & rules

Keep rules in `src/data/progression.ts` as a table so they're tunable without
code changes to the engine:

| feature key        | unlocks what (client)                    | requirement (deterministic)                     | tier when granted |
|--------------------|------------------------------------------|-------------------------------------------------|-------------------|
| `dashboard`        | home essentials                          | always (granted at onboarding)                  | starter           |
| `workouts`         | today's workout + start session          | always                                          | starter           |
| `trainer`          | chat with Kai                            | always                                          | starter           |
| `body_map`         | Body / muscle map screen                 | 1 finished session                              | building          |
| `progress_basic`   | streak + weekly volume tiles             | 1 finished session                              | building          |
| `goals`            | Goals screen + goal widgets              | 2 finished sessions OR 3 days active            | building          |
| `programs`         | multi-week programs                      | 3 finished sessions                             | established       |
| `progress_advanced`| strength curves, consistency grid, PRs   | 5 finished sessions OR 7 days since firstRun     | established       |
| `achievements`     | achievements strip + celebrations        | first PR OR first achievement earned            | established       |
| `store`            | Kai store + coin economy surfaced        | `achievements` unlocked AND wallet balance > 0  | established       |
| `insights`         | proactive coaching insights              | 4 finished sessions                             | full              |
| `voice_chat`       | voice messages to Kai                    | 10 chat messages sent                           | full              |

- `tier` is derived: `full` if all `full`-tier features unlocked, else
  `established` if any established feature unlocked, etc. Compute, don't store
  independently.
- `unlockedFeatures` is **additive and monotonic** — never revoke.
- If `gatingEnabled == false`, treat every feature as unlocked in responses
  (still record real unlock events for analytics, but `unlockedFeatures` in the
  response is the full set).

### 3c. Engine — `src/services/progression.ts`

```ts
evaluateProgression(userId): Promise<{
  tier, unlockedFeatures, newlyUnlocked: FeatureKey[], nextUnlock
}>
```

- Pulls the cheap counters it needs (`prisma.workoutSession.count({ where:{ userId, status:"finished" }})`,
  distinct active days, PR count, achievement count, wallet balance, chat count).
- Applies the rule table, unions results into `unlockedFeatures`, bumps
  `lastEvaluatedAt`.
- For each entry in `newlyUnlocked`, create a `Notification`
  (`type: "feature_unlocked"`, payload `{ feature, title }`) so the client can
  show a gentle "You've unlocked X" toast on next poll.
- `nextUnlock` = the locked feature with the smallest remaining distance to its
  requirement, with a human `requirement` string and `{ current, target }`.

Call sites:
- `POST /sessions/:id/finish` → after `finalizeSession()`, call
  `evaluateProgression` and include `progression.newlyUnlocked` in the response.
- `POST /achievements/evaluate` and PR detection → same.
- On login / `GET /me` → lazy re-evaluate if `lastEvaluatedAt` older than ~6h.
- `POST /me/onboarding` → create `UserProgression` with the three always-on
  features.

### 3d. Endpoints

- `GET /me/settings` → includes the `progression` block (already shown in §0).
- `POST /me/progression/evaluate` → force a re-eval, returns
  `{ tier, unlockedFeatures, newlyUnlocked, nextUnlock }`. Rate-limit lightly.
- `PUT /me/progression` `{ gatingEnabled: boolean }` → the "show me everything" /
  "ease me in again" toggle. Flipping to `true` does not reset `unlockedFeatures`.

The client hides/greys locked nav items and screens; deep-linking to a locked
route should still 200 from the API (gating is a UX layer, not authz) but the
client shows a "unlocks after N workouts" state.

---

## 4. Onboarding hook

Extend `POST /me/onboarding` to accept an optional `experience` block:

```jsonc
{ "experience": { "calmMode": true, "startTier": "starter" } }
```

- `calmMode: true` → `disclosure.mode = "on_interaction"` (+ the safety
  exceptions), `appearance.reduceMotion = true`, keep `progression.gatingEnabled
  = true`.
- `calmMode: false` → defaults, `progression.gatingEnabled = false` (power users
  see everything).
- Always create `UserAppearance` (from the default preset), `UserDisclosure`,
  `UserProgression` rows here so the rest of the app can assume they exist.

---

## 5. Migration, seed, tests, docs

- One Prisma migration adding the four models + relations on `User`.
- `prisma/seed.ts`: `BackgroundPreset` set (idempotent upsert), and backfill
  `UserAppearance` / `UserDisclosure` / `UserProgression` for the demo user
  (`alex@forma.app`) with a mid-progression state so the web app has something to
  render.
- Backfill migration/step for existing users: create default rows; set
  `unlockedFeatures` by running `evaluateProgression` once.
- `src/data/progression.ts` — the rule table (exported, unit-tested).
- Tests (`src/app.test.ts`, no DB): validation of `PUT /me/settings` for each
  block (clamps, hex regex, override key/enum rules, unknown keys), auth guard on
  the new routes, error-shape. Add a `services/progression.test.ts` with a fake
  counter source exercising every rule boundary and the `gatingEnabled=false`
  short-circuit.
- Update `BACKEND.md` §2 (data model), §3 (endpoint list: `/config/appearance-presets`,
  `/me/progression*`, expanded `/me/settings`), and the §4 spec-mapping table.

## 6. Out of scope / notes

- No realtime push — the client learns about unlocks and theme changes on its
  next `GET /me/settings` / notification poll.
- User-uploaded background images go through the existing presigned-upload
  mechanism; this prompt does not add a new upload endpoint.
- Keep all new reads out of the AI rate-limit tier; they're plain CRUD.

---

## 7. Implementation status

**Delivered** — `tsc` + `npm run build` clean, 26/26 tests pass, all routes boot.
Not run against a live database (none available in this environment).

### Files

| Area | Files |
|---|---|
| Schema | `prisma/schema.prisma` — `BackgroundPreset`, `UserAppearance`, `UserDisclosure`, `UserProgression` + `User` relations |
| Reference data | `src/data/progression.ts` (rule table, 12 features), `src/data/appearance.ts` (6 presets), `src/data/store.ts` (+`t-nebula`, `t-oceanic` theme items) |
| Engine | `src/services/progression.ts` (`applyRules` / `deriveTier` / `computeNextUnlock` pure + `evaluateProgression` / `readProgression` / `setGating`), `src/services/settings.ts` (bundle assembly + `applySettingsPatch` + exported validators) |
| Routes | `src/modules/config.ts` (new), `src/modules/me.ts` (bundle GET/PUT, `/progression`, `/progression/evaluate`, onboarding `experience`), wired into `src/modules/sessions.ts` + `src/modules/achievements.ts` |
| Middleware | `src/middleware/auth.ts` `optionalAuth`, `src/lib/errors.ts` `unprocessable` (422) |
| Notifications | `src/services/notify.ts` — `feature_unlocked` type → `milestones` pref |
| Seed / backfill | `prisma/seed.ts` (presets + demo user mid-tier), `src/scripts/backfill.ts` + `npm run db:backfill` |
| Tests | `src/services/progression.test.ts` (9), `src/services/settings.test.ts` (12), `src/app.test.ts` (+3) — all no-DB |
| Contract | `openapi.yaml` (+8 schemas, +4 paths), `API.md` ("The settings bundle" section), `frontend/src/api/{types,client}.ts` |
| Env | `APPEARANCE_IMAGE_HOSTS` (default `storage.local,cdn.forma.app`) |

### Deviations from the spec

1. **"finished session" == `WorkoutSession.status "completed"`** — that's the
   existing enum value; the rule table and engine use it.
2. **Migration** — `prisma migrate dev --name appearance-progression` is the step
   to run; no migration SQL was generated here because no database is reachable.
   `prisma validate` passes. Existing-user backfill is `npm run db:backfill`
   (a script, not a data migration — Prisma data migrations aren't idiomatic).
3. **`experience.startTier`** is accepted but ignored — tier is always derived
   from `unlockedFeatures`, which is monotonic. `calmMode` does all the real work.
4. **`PUT /me/settings` error codes** — structural/type errors (bad hex, unknown
   enum, malformed url) are caught by the Zod layer as `400 bad_request` with
   `details`. The spec's `422` is used specifically for `widgetOverrides`
   (key regex / value enum / >60) and the image-host allowlist check, matching
   the spec's intent ("reject anything else with 422").
5. **Premium presets** (`nebula`, `oceanic`) are gated on new `theme` StoreItems
   `t-nebula` / `t-oceanic` added to the catalogue; `oceanic` additionally has
   `minTier: "established"`.
6. **`GET /config/appearance-presets`** returns only presets the caller may use
   (filtered), each with `isDefault` + `premium` flags. There is no `locked: true`
   row — the client asks again after a purchase / tier bump.
7. **`GET /me`** gained a lazy progression re-eval (> 6h stale) as the spec's
   "on login" hook — there is no separate login-only endpoint that loads the user.
