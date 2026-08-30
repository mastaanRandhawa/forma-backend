import { prisma } from "../prisma.js";
import { notify } from "./notify.js";
import { awardCoins } from "../modules/store.js";

const COIN_REWARD: Record<string, number> = {
  "pr-bench": 50,
  "streak-14": 80,
  consistency: 100,
  "volume-1m": 200,
};

/**
 * Re-evaluate every achievement for a user. Called after a session finishes.
 * Idempotent — only fires the notification/coin award on the unlock transition.
 */
export async function evaluateAchievements(userId: string) {
  const [achievements, sessions, prs, allTimeVolume] = await Promise.all([
    prisma.achievement.findMany(),
    prisma.workoutSession.findMany({ where: { userId, status: "completed" }, select: { startedAt: true, totalVolumeKg: true } }),
    prisma.personalRecord.findMany({ where: { userId }, include: { exercise: true } }),
    prisma.workoutSession.aggregate({ where: { userId, status: "completed" }, _sum: { totalVolumeKg: true } }),
  ]);

  const days = new Set(sessions.map((s) => s.startedAt.toISOString().slice(0, 10)));
  const streak = currentStreak(days);
  const activeDaysThisMonth = [...days].filter((d) => d.startsWith(new Date().toISOString().slice(0, 7))).length;
  const totalVolume = allTimeVolume._sum.totalVolumeKg ?? 0;

  const progressFor = (key: string): { progress: number; unlocked: boolean } => {
    switch (key) {
      case "pr-bench": {
        const hit = prs.some((p) => /bench/i.test(p.exercise.name));
        return { progress: hit ? 1 : 0, unlocked: hit };
      }
      case "streak-14":
        return { progress: Math.min(1, streak / 14), unlocked: streak >= 14 };
      case "consistency":
        return { progress: Math.min(1, activeDaysThisMonth / 30), unlocked: activeDaysThisMonth >= 30 };
      case "volume-1m": {
        const lb = totalVolume * 2.2046;
        return { progress: Math.min(1, lb / 1_000_000), unlocked: lb >= 1_000_000 };
      }
      default:
        return { progress: 0, unlocked: false };
    }
  };

  for (const a of achievements) {
    const { progress, unlocked } = progressFor(a.key);
    const existing = await prisma.userAchievement.findUnique({
      where: { userId_achievementId: { userId, achievementId: a.id } },
    });
    const wasUnlocked = !!existing?.unlockedAt;
    const row = await prisma.userAchievement.upsert({
      where: { userId_achievementId: { userId, achievementId: a.id } },
      update: { progress, unlockedAt: unlocked ? existing?.unlockedAt ?? new Date() : null },
      create: { userId, achievementId: a.id, progress, unlockedAt: unlocked ? new Date() : null },
    });
    if (!wasUnlocked && row.unlockedAt) {
      await notify(userId, "milestone", "Achievement unlocked", a.title, "/progress");
      const reward = COIN_REWARD[a.key];
      if (reward) await awardCoins(userId, reward, a.title).catch(() => {});
    }
  }
}

export function currentStreak(days: Set<string>): number {
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    if (days.has(d)) streak++;
    else if (i > 0) break;
  }
  return streak;
}
