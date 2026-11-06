/**
 * Coin economy rules: what pays, what it pays, what it costs, and how often.
 * The reasoning and the balance model are in docs/COIN_ECONOMY.md.
 *
 * Kept in sync with `frontend/src/lib/economyConfig.ts`, which runs the same
 * rules for the no-backend build. `GET /economy/catalog` serves this table so the
 * E2E suite can fail on any drift between the two.
 */
import { CUSTOMIZATION_CATALOGUE } from "./customization.js";

// ── earning ────────────────────────────────────────────────────────────────
export type EarnKind =
  | "workout" | "pr" | "visit" | "checkin" | "food" | "protein"
  | "week" | "challenge" | "streak" | "achievement" | "welcome";

/** Caps count payouts, not coins. `null` means no cap on that window. */
export const EARN_CAPS: Record<EarnKind, { daily: number | null; weekly: number | null }> = {
  workout: { daily: 2, weekly: 7 },
  pr: { daily: null, weekly: 4 },
  visit: { daily: 1, weekly: 7 },
  checkin: { daily: 1, weekly: 7 },
  food: { daily: 1, weekly: 7 },
  protein: { daily: 1, weekly: 7 },
  week: { daily: null, weekly: 1 },
  challenge: { daily: null, weekly: 3 },
  streak: { daily: null, weekly: null },
  achievement: { daily: null, weekly: null },
  welcome: { daily: null, weekly: null },
};

export const WORKOUT_REWARD = { minWorkingSets: 3, minSeconds: 300, base: 30, perSet: 2, maxSetBonus: 30 };
export const PR_REWARD = { coins: 25, perWorkout: 3 };
export const VISIT_REWARD = { coins: 5, minGapHours: 20 };
export const CHECKIN_COINS = 10;
export const FOOD_REWARD = { coins: 10, minItems: 2 };
export const PROTEIN_COINS = 10;
export const WEEK_TARGET_REWARD = { perSession: 25, minTarget: 2, maxTarget: 5 };
export const WELCOME_COINS = 100;
export const STREAK_MILESTONES: Record<number, number> = { 3: 10, 7: 25, 14: 50, 30: 100, 60: 175, 100: 300 };
/** The training days a week a user with no plan is held to. */
export const DEFAULT_PLANNED_DAYS = 3;

/** Coins for a finished workout, or null when it doesn't qualify. */
export function workoutCoins(workingSets: number, seconds: number): number | null {
  if (workingSets < WORKOUT_REWARD.minWorkingSets || seconds < WORKOUT_REWARD.minSeconds) return null;
  return WORKOUT_REWARD.base + Math.min(WORKOUT_REWARD.maxSetBonus, workingSets * WORKOUT_REWARD.perSet);
}

/** Lowering the target to game it pays less, and a target of 1 pays as 2. */
export function weekTargetCoins(target: number): number {
  const t = Math.max(WEEK_TARGET_REWARD.minTarget, Math.min(WEEK_TARGET_REWARD.maxTarget, target));
  return t * WEEK_TARGET_REWARD.perSession;
}

// ── achievements that pay. Streak achievements don't: milestones already do. ──
export const ACHIEVEMENT_COINS: Record<string, number> = {
  "first-session": 25,
  "first-pr": 25,
  "first-superset": 25,
  "session-60min": 25,
  "session-90min": 40,
  "session-early": 25,
  "sessions-10": 50,
  "sessions-25": 100,
  "sessions-50": 150,
  "sessions-100": 250,
  "sessions-250": 400,
  "volume-10k": 50,
  "volume-50k": 100,
  "volume-100k": 150,
  "volume-500k": 250,
  "volume-1m": 400,
  "pr-bench": 50,
  "pr-squat": 50,
  "pr-deadlift": 50,
  "pr-ohp": 50,
  "pr-row": 50,
  "prs-5": 50,
  "prs-10": 75,
  "prs-25": 150,
  "prs-50": 250,
  "active-days-30": 100,
  "active-days-100": 250,
  "food-log-30": 100,
  "checkin-14": 75,
  "kai-chat-first": 25,
  "kai-chat-50": 75,
  "coins-100": 25,
  "coins-1000": 75,
};

// ── consumables ────────────────────────────────────────────────────────────
export const CONSUMABLES: Record<string, { name: string; price: number; maxHold: number }> = {
  "cs-freeze": { name: "Streak Freeze", price: 100, maxHold: 2 },
  "cs-reroll": { name: "Challenge Reroll", price: 60, maxHold: 3 },
  "cs-review": { name: "Kai Deep Review", price: 300, maxHold: 3 },
};
export const FREEZE_ID = "cs-freeze";
export const REROLL_ID = "cs-reroll";
export const REVIEW_ID = "cs-review";

/** A freeze only fires on a streak at least this long. */
export const FREEZE_MIN_STREAK = 3;
export const REROLLS_PER_WEEK = 2;
export const STREAK_REPAIR = { price: 450, maxGapDays: 3, minPriorRun: 3, windowDays: 3, cooldownDays: 7 };

// ── bundles ────────────────────────────────────────────────────────────────
export const BUNDLE_DISCOUNT = 0.25;
export const BUNDLES: Record<string, { name: string; items: string[] }> = {
  "bn-neon": { name: "Neon Pack", items: ["fx-scanlines", "t-terminal", "fn-mono", "rs-arcade"] },
  "bn-zen": { name: "Zen Pack", items: ["fx-glow", "t-paper", "fn-serif", "rs-bowl", "ps-zen"] },
  "bn-champion": { name: "Champion's Set", items: ["fr-crown", "ti-legend", "bd-diamond", "cl-fireworks"] },
};

const roundTo5 = (n: number) => Math.round(n / 5) * 5;

/** 25% off whatever the buyer doesn't own yet, so a bundle never charges twice. */
export function bundlePrice(bundleId: string, owned: Iterable<string>): number {
  const have = new Set(owned);
  const sum = BUNDLES[bundleId].items
    .filter((id) => !have.has(id))
    .reduce((n, id) => n + CUSTOMIZATION_CATALOGUE[id].price, 0);
  return roundTo5(sum * (1 - BUNDLE_DISCOUNT));
}

// ── weekly rotation (challenges and deals) ─────────────────────────────────
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable per week, and needs no stored state: hash each id with the week. */
function weeklyOrder(ids: string[], week: string, salt: string): string[] {
  return [...ids].sort(
    (a, b) => fnv1a(`${week}:${salt}:${a}`) - fnv1a(`${week}:${salt}:${b}`) || a.localeCompare(b),
  );
}

// ── deals ──────────────────────────────────────────────────────────────────
export const DEALS = { count: 3, discount: 0.25, minPrice: 100 };

const dealPool = () =>
  Object.entries(CUSTOMIZATION_CATALOGUE)
    .filter(([, e]) => e.price >= DEALS.minPrice)
    .map(([id]) => id);

export function dealsFor(week: string): { itemId: string; price: number; was: number }[] {
  return weeklyOrder(dealPool(), week, "deal")
    .slice(0, DEALS.count)
    .map((itemId) => {
      const was = CUSTOMIZATION_CATALOGUE[itemId].price;
      return { itemId, was, price: roundTo5(was * (1 - DEALS.discount)) };
    });
}

/** What an item costs this week. */
export function currentPrice(itemId: string, week: string): number {
  const deal = dealsFor(week).find((d) => d.itemId === itemId);
  return deal ? deal.price : CUSTOMIZATION_CATALOGUE[itemId].price;
}

// ── challenges ─────────────────────────────────────────────────────────────
export interface WeekFacts {
  workouts: number;
  volumeLb: number;
  earlySessions: number;
  muscleGroups: number;
  workingSets: number;
  prs: number;
  foodDays: number;
  checkinDays: number;
  weekendSessions: number;
  longSessions: number;
}

export interface Challenge {
  id: string;
  title: string;
  detail: string;
  target: number;
  reward: number;
  unit: string;
  tone: "pink" | "cyan" | "lime" | "amber" | "violet";
  measure: (f: WeekFacts) => number;
}

export const CHALLENGES: Challenge[] = [
  { id: "ch-consistency", title: "Show up", detail: "Complete 4 workouts this week", target: 4, reward: 60, unit: "workouts", tone: "pink", measure: (f) => f.workouts },
  { id: "ch-volume", title: "Move weight", detail: "Log 50,000 lb of total volume", target: 50000, reward: 70, unit: "lb", tone: "cyan", measure: (f) => f.volumeLb },
  { id: "ch-early", title: "Early sets", detail: "Train before 9am twice", target: 2, reward: 50, unit: "sessions", tone: "amber", measure: (f) => f.earlySessions },
  { id: "ch-explorer", title: "Mix it up", detail: "Train 5 different muscle groups", target: 5, reward: 60, unit: "groups", tone: "violet", measure: (f) => f.muscleGroups },
  { id: "ch-sets", title: "Stack the sets", detail: "Log 60 working sets", target: 60, reward: 60, unit: "sets", tone: "lime", measure: (f) => f.workingSets },
  { id: "ch-pr", title: "Beat yourself", detail: "Set a personal record on any lift", target: 1, reward: 50, unit: "PR", tone: "amber", measure: (f) => f.prs },
  { id: "ch-fuel", title: "Fuel up", detail: "Log your food on 4 days", target: 4, reward: 50, unit: "days", tone: "lime", measure: (f) => f.foodDays },
  { id: "ch-recovery", title: "Listen to your body", detail: "Do 4 recovery check-ins", target: 4, reward: 40, unit: "check-ins", tone: "cyan", measure: (f) => f.checkinDays },
  { id: "ch-weekend", title: "Weekend work", detail: "Train on Saturday or Sunday", target: 1, reward: 40, unit: "session", tone: "pink", measure: (f) => f.weekendSessions },
  { id: "ch-long", title: "Long haul", detail: "Do 2 sessions of 45 minutes or more", target: 2, reward: 50, unit: "sessions", tone: "violet", measure: (f) => f.longSessions },
];

export const challengeById = (id: string) => CHALLENGES.find((c) => c.id === id);
export const ACTIVE_CHALLENGES = 3;

export const challengeOrder = (week: string): string[] =>
  weeklyOrder(CHALLENGES.map((c) => c.id), week, "challenge");

export const defaultChallengeSlots = (week: string): string[] =>
  challengeOrder(week).slice(0, ACTIVE_CHALLENGES);
