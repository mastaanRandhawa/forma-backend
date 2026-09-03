/**
 * Unlock-progression rule table. Tunable here without touching the engine
 * (`src/services/progression.ts`). Deterministic — every rule is a counter
 * threshold, no ML, no time-of-day magic.
 *
 * Note: "finished session" in the product spec == `WorkoutSession.status "completed"`.
 */

export type Tier = "starter" | "building" | "established" | "full";

export type FeatureKey =
  | "dashboard"
  | "workouts"
  | "trainer"
  | "body_map"
  | "progress_basic"
  | "goals"
  | "programs"
  | "progress_advanced"
  | "achievements"
  | "store"
  | "insights"
  | "voice_chat";

export type Counter =
  | "finishedSessions"
  | "activeDays"
  | "prCount"
  | "achievementCount"
  | "walletBalance"
  | "chatMessagesSent"
  | "daysSinceFirstRun";

export interface Condition {
  counter: Counter;
  gte: number;
}

export interface ProgressionRule {
  feature: FeatureKey;
  tier: Tier;
  /** What this unlocks in the client (docs only). */
  unlocks: string;
  /** Other features that must already be unlocked. */
  requires?: FeatureKey[];
  /** OR of AND-groups. An empty group `[]` means "always". */
  any: Condition[][];
  /** Human requirement string for `nextUnlock`. */
  requirementLabel: string;
  /** Deep link the "feature unlocked" notification points at. */
  deepLink: string;
  /** Title shown in the unlock toast / notification. */
  title: string;
}

export const TIER_ORDER: Tier[] = ["starter", "building", "established", "full"];

export const ALWAYS_FEATURES: FeatureKey[] = ["dashboard", "workouts", "trainer"];

/** Widgets kept visible even in "calm mode" (safety-critical). */
export const SAFETY_WIDGETS = ["readiness-ring", "next-workout"];

/** Known widget keys for docs/tests — the client owns the real registry. */
export const KNOWN_WIDGET_KEYS = [
  "readiness-ring",
  "weekly-volume",
  "avg-form",
  "weekly-goal",
  "protein-today",
  "workout-streak",
  "training-volume-chart",
  "session-card",
  "up-next",
  "kai-message",
  "goals-card",
  "insights",
];

export const PROGRESSION_RULES: ProgressionRule[] = [
  {
    feature: "dashboard", tier: "starter", unlocks: "Home essentials",
    any: [[]], requirementLabel: "Available from the start",
    title: "Home", deepLink: "/dashboard",
  },
  {
    feature: "workouts", tier: "starter", unlocks: "Today's workout + start a session",
    any: [[]], requirementLabel: "Available from the start",
    title: "Workouts", deepLink: "/workouts",
  },
  {
    feature: "trainer", tier: "starter", unlocks: "Chat with Kai",
    any: [[]], requirementLabel: "Available from the start",
    title: "Kai, your trainer", deepLink: "/trainer",
  },
  {
    feature: "body_map", tier: "building", unlocks: "Body / muscle map screen",
    any: [[]], requirementLabel: "Available from the start",
    title: "The muscle map", deepLink: "/body",
  },
  {
    feature: "progress_basic", tier: "building", unlocks: "Streak + weekly volume tiles",
    any: [[]], requirementLabel: "Available from the start",
    title: "Progress tracking", deepLink: "/progress",
  },
  {
    feature: "goals", tier: "building", unlocks: "Goals screen + goal widgets",
    any: [[]], requirementLabel: "Available from the start",
    title: "Goals", deepLink: "/goals",
  },
  {
    feature: "programs", tier: "established", unlocks: "Multi-week programs",
    any: [[]], requirementLabel: "Available from the start",
    title: "Multi-week programs", deepLink: "/workouts",
  },
  {
    feature: "progress_advanced", tier: "established",
    unlocks: "Strength curves, consistency grid, PR list",
    any: [[]], requirementLabel: "Available from the start",
    title: "Detailed progress", deepLink: "/progress",
  },
  {
    feature: "achievements", tier: "established",
    unlocks: "Achievements strip + celebrations",
    any: [[]], requirementLabel: "Available from the start",
    title: "Achievements", deepLink: "/progress",
  },
  {
    feature: "store", tier: "established", unlocks: "Kai store + coin economy",
    any: [[]], requirementLabel: "Available from the start",
    title: "The Kai store", deepLink: "/store",
  },
  {
    feature: "insights", tier: "full", unlocks: "Proactive coaching insights",
    any: [[]], requirementLabel: "Available from the start",
    title: "Coaching insights", deepLink: "/trainer",
  },
  {
    feature: "voice_chat", tier: "full", unlocks: "Voice messages to Kai",
    any: [[]], requirementLabel: "Available from the start",
    title: "Voice chat", deepLink: "/trainer",
  },
];

export const ALL_FEATURES: FeatureKey[] = PROGRESSION_RULES.map((r) => r.feature);

export const ruleFor = (f: FeatureKey) => PROGRESSION_RULES.find((r) => r.feature === f)!;
