import { prisma } from "../prisma.js";
import { notify } from "./notify.js";
import { grant, type Reward } from "./wallet.js";
import { clockFor, localHour, streakDays, streakLength, WORKED_SESSION } from "./streak.js";
import { ACHIEVEMENT_COINS } from "../data/economy.js";

/** Progress toward a key whose name ends in its target, e.g. "sessions-25". */
const LIFTS: Record<string, RegExp> = {
  "pr-bench": /bench/i,
  "pr-squat": /squat/i,
  "pr-deadlift": /deadlift/i,
  "pr-ohp": /overhead press|shoulder press|military press/i,
  "pr-row": /barbell row|bent.over.*row/i,
};

/**
 * Re-evaluate every achievement for a user, after a session or when a settle
 * paid something new. Only the unlock transition notifies and pays; an unlocked
 * achievement stays unlocked even if the streak behind it later breaks.
 * Returns the coins paid. Achievements with no evaluator stay locked.
 */
export async function evaluateAchievements(userId: string): Promise<Reward[]> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tzOffsetMin: true } });
  const clock = clockFor(user.tzOffsetMin);

  const [achievements, mine, sessions, prs, days, foodDays, checkins, chats, spent, supersets] = await Promise.all([
    prisma.achievement.findMany(),
    prisma.userAchievement.findMany({ where: { userId } }),
    prisma.workoutSession.findMany({
      where: { userId, ...WORKED_SESSION },
      select: { startedAt: true, totalVolumeKg: true, durationSeconds: true },
    }),
    prisma.personalRecord.findMany({
      where: { userId, previousValue: { not: null } },
      select: { exerciseId: true, sessionId: true, exercise: { select: { name: true } } },
    }),
    streakDays(userId, clock.tz),
    prisma.foodLog.findMany({ where: { userId }, distinct: ["date"], select: { date: true } }),
    prisma.recoveryCheckin.count({ where: { userId } }),
    prisma.chatMessage.count({ where: { userId, role: "user" } }),
    prisma.walletTransaction.aggregate({ where: { wallet: { userId }, type: "spend" }, _sum: { amount: true } }),
    prisma.exercisePerformance.count({ where: { supersetGroup: { not: null }, session: { userId, ...WORKED_SESSION } } }),
  ]);

  const streak = streakLength(days.trained, days.protectedDays, clock.day, days.plan);
  const totalKg = sessions.reduce((n, s) => n + s.totalVolumeKg, 0);
  const prLifts = new Set(prs.map((p) => `${p.sessionId}:${p.exerciseId}`)).size;

  // [current, target], or null for a key this evaluator can't measure
  const measure = (key: string, target: number | null): [number, number] | null => {
    const toward = (n: number): [number, number] => [n, target ?? 1];
    if (key in LIFTS) return [prs.some((p) => LIFTS[key].test(p.exercise.name)) ? 1 : 0, 1];
    if (key.startsWith("streak-")) return toward(streak);
    if (key.startsWith("sessions-")) return toward(sessions.length);
    if (key.startsWith("volume-")) return toward(totalKg);
    if (key.startsWith("prs-")) return toward(prLifts);
    if (key.startsWith("active-days-")) return toward(days.trained.size);
    if (key.startsWith("coins-")) return toward(spent._sum.amount ?? 0);
    switch (key) {
      case "first-session": return [sessions.length ? 1 : 0, 1];
      case "first-pr": return [prLifts ? 1 : 0, 1];
      case "first-superset": return [supersets ? 1 : 0, 1];
      case "food-log-30": return toward(foodDays.length);
      case "checkin-14": return toward(checkins);
      case "kai-chat-first": return [chats ? 1 : 0, 1];
      case "kai-chat-50": return toward(chats);
      case "session-60min": return [sessions.some((s) => s.durationSeconds >= 3600) ? 1 : 0, 1];
      case "session-90min": return [sessions.some((s) => s.durationSeconds >= 5400) ? 1 : 0, 1];
      case "session-early": return [sessions.some((s) => localHour(s.startedAt, clock.tz) < 7) ? 1 : 0, 1];
      default: return null;
    }
  };

  const byId = new Map(mine.map((m) => [m.achievementId, m]));
  const rewards: Reward[] = [];

  for (const a of achievements) {
    const m = measure(a.key, a.targetValue);
    if (!m) continue;
    const progress = Math.min(1, m[0] / m[1]);
    const existing = byId.get(a.id);
    const unlockedNow = !existing?.unlockedAt && m[0] >= m[1];
    if (existing && existing.progress === progress && !unlockedNow) continue;

    await prisma.userAchievement.upsert({
      where: { userId_achievementId: { userId, achievementId: a.id } },
      update: { progress, ...(unlockedNow ? { unlockedAt: new Date() } : {}) },
      create: { userId, achievementId: a.id, progress, unlockedAt: unlockedNow ? new Date() : null },
    });
    if (unlockedNow) {
      await notify(userId, "milestone", "Achievement unlocked", a.title, "/progress").catch(() => {});
      const coins = ACHIEVEMENT_COINS[a.key];
      if (coins) {
        const paid = await grant(
          userId,
          { kind: "achievement", key: `ach:${a.key}`, amount: coins, label: `Achievement · ${a.title}` },
          clock,
        ).catch(() => null);
        if (paid) rewards.push(paid);
      }
    }
  }
  return rewards;
}
