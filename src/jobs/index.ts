import { prisma } from "../prisma.js";
import { notify } from "../services/notify.js";
import { generateInsights } from "../services/insights.js";
import { evaluateAchievements } from "../services/achievements.js";
import { currentStreak } from "../services/achievements.js";

/** Purge expired / revoked refresh + reset tokens. Runs hourly. */
export async function cleanupTokens() {
  const cutoff = new Date(Date.now() - 7 * 86_400_000);
  const [a, b] = await Promise.all([
    prisma.refreshToken.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { lt: cutoff } }] } }),
    prisma.passwordReset.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }] } }),
  ]);
  return { refreshTokens: a.count, passwordResets: b.count };
}

/** Hard-delete users soft-deleted more than 30 days ago (GDPR grace window). */
export async function purgeDeletedAccounts() {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const { count } = await prisma.user.deleteMany({ where: { deletedAt: { lt: cutoff } } });
  return { purged: count };
}

/** Daily: workout reminders + streak-break warnings + proactive check-ins. */
export async function dailyNudges() {
  const users = await prisma.user.findMany({
    where: { deletedAt: null, onboardingCompletedAt: { not: null } },
    include: { notificationPrefs: true },
  });
  const today = new Date().setHours(0, 0, 0, 0);

  for (const u of users) {
    const scheduled = await prisma.workout.findFirst({
      where: { userId: u.id, isTemplate: false, scheduledDate: { gte: new Date(today), lt: new Date(today + 86_400_000) } },
    });
    const doneToday = await prisma.workoutSession.findFirst({
      where: { userId: u.id, status: "completed", startedAt: { gte: new Date(today) } },
    });

    if (scheduled && !doneToday) {
      await notify(u.id, "reminder", "Today's workout is waiting", `${scheduled.name} · tap to start`, "/workouts").catch(() => {});
    }

    // streak-break warning
    const recent = await prisma.workoutSession.findMany({
      where: { userId: u.id, status: "completed" },
      orderBy: { startedAt: "desc" },
      take: 30,
      select: { startedAt: true },
    });
    const days = new Set(recent.map((s) => s.startedAt.toISOString().slice(0, 10)));
    const streak = currentStreak(days);
    const yesterday = new Date(today - 86_400_000).toISOString().slice(0, 10);
    if (streak >= 3 && days.has(yesterday) && !doneToday) {
      await notify(u.id, "reminder", `Keep your ${streak}-day streak`, "A quick session today keeps it alive.", "/workouts").catch(() => {});
    }
  }
}

/** Weekly (Mon): pre-compute a summary + fresh insights per active user. */
export async function weeklyRollup() {
  const users = await prisma.user.findMany({ where: { deletedAt: null, onboardingCompletedAt: { not: null } } });
  for (const u of users) {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const sessions = await prisma.workoutSession.findMany({ where: { userId: u.id, status: "completed", startedAt: { gte: weekAgo } } });
    const volume = Math.round(sessions.reduce((a, s) => a + s.totalVolumeKg, 0));
    await prisma.progressMetric.create({
      data: { userId: u.id, metricType: "volume_aggregate", value: volume, unit: "kg", source: "computed" },
    });
    await notify(
      u.id,
      "weekly_summary",
      "Your week in training",
      `${sessions.length} session${sessions.length === 1 ? "" : "s"}, ${volume.toLocaleString()} kg moved.`,
      "/progress",
    ).catch(() => {});
    await generateInsights(u.id).catch(() => {});
    await evaluateAchievements(u.id).catch(() => {});
  }
}
