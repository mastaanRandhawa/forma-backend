import { prisma } from "../prisma.js";
import { notify } from "./notify.js";
import {
  PROGRESSION_RULES,
  ALWAYS_FEATURES,
  ALL_FEATURES,
  ruleFor,
  type Counter,
  type FeatureKey,
  type Tier,
} from "../data/progression.js";

export type ProgressionCounters = Record<Counter, number>;

export interface NextUnlock {
  feature: FeatureKey;
  requirement: string;
  progress: { current: number; target: number };
}

export interface ProgressionResult {
  tier: Tier;
  unlockedFeatures: FeatureKey[];
  newlyUnlocked: FeatureKey[];
  gatingEnabled: boolean;
  nextUnlock: NextUnlock | null;
}

const RE_EVAL_MS = 6 * 60 * 60 * 1000;

// ── pure rule logic (unit-tested) ───────────────────────────────────────────

/** Union in every rule whose requirement is met, iterating until stable
 *  (features can depend on other features, e.g. `store` needs `achievements`). */
export function applyRules(
  counters: ProgressionCounters,
  alreadyUnlocked: Iterable<FeatureKey>,
): { unlocked: Set<FeatureKey>; newlyUnlocked: FeatureKey[] } {
  const before = new Set<FeatureKey>(alreadyUnlocked);
  for (const f of ALWAYS_FEATURES) before.add(f);
  const unlocked = new Set(before);

  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of PROGRESSION_RULES) {
      if (unlocked.has(rule.feature)) continue;
      if (rule.requires && !rule.requires.every((r) => unlocked.has(r))) continue;
      const met = rule.any.some((group) => group.every((c) => counters[c.counter] >= c.gte));
      if (met) {
        unlocked.add(rule.feature);
        changed = true;
      }
    }
  }
  return { unlocked, newlyUnlocked: [...unlocked].filter((f) => !before.has(f)) };
}

/** starter → building → established → full.  `full` only when every full-tier
 *  feature is unlocked; otherwise the highest tier that has any unlocked feature. */
export function deriveTier(unlocked: Set<FeatureKey>): Tier {
  const some = (t: Tier) => PROGRESSION_RULES.some((r) => r.tier === t && unlocked.has(r.feature));
  const every = (t: Tier) => PROGRESSION_RULES.filter((r) => r.tier === t).every((r) => unlocked.has(r.feature));
  if (every("full")) return "full";
  if (some("established")) return "established";
  if (some("building")) return "building";
  return "starter";
}

/** The locked feature closest to unlocking. Distance = fewest total counter units
 *  still needed across the easiest requirement group (missing prereqs push it far). */
export function computeNextUnlock(
  counters: ProgressionCounters,
  unlocked: Set<FeatureKey>,
): NextUnlock | null {
  let best: (NextUnlock & { distance: number }) | null = null;

  for (const rule of PROGRESSION_RULES) {
    if (unlocked.has(rule.feature)) continue;
    const prereqMissing = rule.requires?.filter((r) => !unlocked.has(r)).length ?? 0;

    let groupPick: { distance: number; binding: { counter: Counter; gte: number } } | null = null;
    for (const group of rule.any) {
      if (group.length === 0) continue;
      let sumGap = 0;
      let binding = group[0]!;
      let maxGap = -1;
      for (const c of group) {
        const gap = Math.max(0, c.gte - counters[c.counter]);
        sumGap += gap;
        if (gap > maxGap) {
          maxGap = gap;
          binding = c;
        }
      }
      const distance = sumGap + prereqMissing * 1000;
      if (!groupPick || distance < groupPick.distance) groupPick = { distance, binding };
    }
    if (!groupPick) continue;

    if (!best || groupPick.distance < best.distance) {
      best = {
        feature: rule.feature,
        requirement: rule.requirementLabel,
        progress: {
          current: Math.min(counters[groupPick.binding.counter], groupPick.binding.gte),
          target: groupPick.binding.gte,
        },
        distance: groupPick.distance,
      };
    }
  }
  if (!best) return null;
  const { distance: _d, ...rest } = best;
  return rest;
}

// ── data access + orchestration ─────────────────────────────────────────────

export async function gatherCounters(userId: string, firstRunAt: Date): Promise<ProgressionCounters> {
  const [finishedSessions, sessionDays, prCount, achievementCount, wallet, chatMessagesSent] = await Promise.all([
    prisma.workoutSession.count({ where: { userId, status: "completed" } }),
    prisma.workoutSession.findMany({ where: { userId, status: "completed" }, select: { startedAt: true } }),
    prisma.personalRecord.count({ where: { userId } }),
    prisma.userAchievement.count({ where: { userId, unlockedAt: { not: null } } }),
    prisma.wallet.findUnique({ where: { userId }, select: { balance: true } }),
    prisma.chatMessage.count({ where: { userId, role: "user" } }),
  ]);
  return {
    finishedSessions,
    activeDays: new Set(sessionDays.map((s) => s.startedAt.toISOString().slice(0, 10))).size,
    prCount,
    achievementCount,
    walletBalance: wallet?.balance ?? 0,
    chatMessagesSent,
    daysSinceFirstRun: Math.floor((Date.now() - firstRunAt.getTime()) / 86_400_000),
  };
}

export async function ensureProgression(userId: string) {
  return prisma.userProgression.upsert({
    where: { userId },
    update: {},
    create: { userId, unlockedFeatures: ALWAYS_FEATURES },
  });
}

/** Full re-evaluation. Persists, fires unlock notifications, returns the result. */
export async function evaluateProgression(userId: string): Promise<ProgressionResult> {
  const prog = await ensureProgression(userId);
  const counters = await gatherCounters(userId, prog.firstRunAt);
  const { unlocked, newlyUnlocked } = applyRules(counters, prog.unlockedFeatures as FeatureKey[]);
  const tier = deriveTier(unlocked);

  await prisma.userProgression.update({
    where: { userId },
    data: { unlockedFeatures: [...unlocked], tier, lastEvaluatedAt: new Date() },
  });

  for (const f of newlyUnlocked) {
    const rule = ruleFor(f);
    await notify(userId, "feature_unlocked", `You've unlocked ${rule.title}`, rule.unlocks, rule.deepLink).catch(() => {});
  }

  return shape({ tier, unlocked: [...unlocked], newlyUnlocked, counters, gatingEnabled: prog.gatingEnabled });
}

/** Cheap read for the settings bundle; re-evaluates only if stale (> 6h). */
export async function readProgression(userId: string): Promise<ProgressionResult> {
  const prog = await ensureProgression(userId);
  if (Date.now() - prog.lastEvaluatedAt.getTime() > RE_EVAL_MS) {
    return evaluateProgression(userId);
  }
  const counters = await gatherCounters(userId, prog.firstRunAt);
  const unlocked = new Set(prog.unlockedFeatures as FeatureKey[]);
  for (const f of ALWAYS_FEATURES) unlocked.add(f);
  return shape({
    tier: deriveTier(unlocked),
    unlocked: [...unlocked],
    newlyUnlocked: [],
    counters,
    gatingEnabled: prog.gatingEnabled,
  });
}

export async function setGating(userId: string, gatingEnabled: boolean): Promise<ProgressionResult> {
  await ensureProgression(userId);
  await prisma.userProgression.update({ where: { userId }, data: { gatingEnabled } });
  return evaluateProgression(userId);
}

function shape(input: {
  tier: Tier;
  unlocked: FeatureKey[];
  newlyUnlocked: FeatureKey[];
  counters: ProgressionCounters;
  gatingEnabled: boolean;
}): ProgressionResult {
  if (!input.gatingEnabled) {
    return {
      tier: "full",
      unlockedFeatures: [...ALL_FEATURES],
      newlyUnlocked: input.newlyUnlocked,
      gatingEnabled: false,
      nextUnlock: null,
    };
  }
  return {
    tier: input.tier,
    unlockedFeatures: input.unlocked,
    newlyUnlocked: input.newlyUnlocked,
    gatingEnabled: true,
    nextUnlock: computeNextUnlock(input.counters, new Set(input.unlocked)),
  };
}
