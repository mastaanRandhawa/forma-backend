import { prisma } from "../prisma.js";
import { notify } from "../services/notify.js";
import { generateInsights } from "../services/insights.js";
import { evaluateAchievements } from "../services/achievements.js";
import { currentStreak } from "../services/achievements.js";
import { syncConnection, WEARABLE_PROVIDERS } from "../services/wearables.js";

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

/**
 * Daily (§2.4): a scheduled program workout whose day has passed with no logged
 * session is marked missed and shifted forward to the next preferred weekday —
 * never silently dropped.
 */
export async function rescheduleMissedWorkouts() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const overdue = await prisma.workout.findMany({
    where: {
      isTemplate: false,
      source: "program",
      scheduledDate: { lt: startOfToday },
      sessions: { none: { status: "completed" } },
    },
    orderBy: [{ userId: "asc" }, { scheduledDate: "asc" }],
    select: { id: true, userId: true, scheduledDate: true },
  });

  const cursorByUser = new Map<string, number>();
  let shifted = 0;

  for (const w of overdue) {
    const program = await prisma.trainingProgram.findFirst({
      where: { userId: w.userId, active: true },
      select: { id: true, preferredWeekdays: true },
    });
    const weekdays = program?.preferredWeekdays.length ? [...program.preferredWeekdays].sort((a, b) => a - b) : [1, 3, 5];

    const slot = cursorByUser.get(w.userId) ?? 0;
    cursorByUser.set(w.userId, slot + 1);
    const wd = weekdays[slot % weekdays.length]!;
    const base = new Date(startOfToday.getTime() + Math.floor(slot / weekdays.length) * 7 * 86_400_000);
    const shiftDays = ((wd - base.getDay() + 7) % 7) || 7; // strictly in the future
    const next = new Date(base.getTime() + shiftDays * 86_400_000);

    await prisma.workout.update({ where: { id: w.id }, data: { scheduledDate: next } });
    await prisma.programDay.updateMany({
      where: { programId: program?.id ?? "", workoutId: w.id, status: { in: ["scheduled", "missed"] } },
      data: { status: "rescheduled" },
    });
    shifted++;
  }
  return { overdue: overdue.length, shifted };
}

/**
 * Every few hours (§3.3): pull the latest sleep / HRV / resting-HR from every
 * connected third-party wearable into the ProgressMetric pipeline. Providers with
 * no client credentials configured have no connections, so this is a no-op then.
 */
export async function syncWearables() {
  const conns = await prisma.deviceConnection.findMany({
    where: { provider: { in: WEARABLE_PROVIDERS }, accessToken: { not: null } },
    select: { id: true },
  });
  let ingested = 0;
  let failed = 0;
  for (const c of conns) {
    try {
      ingested += (await syncConnection(c.id)).ingested;
    } catch {
      failed += 1;
    }
  }
  return { connections: conns.length, ingested, failed };
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
