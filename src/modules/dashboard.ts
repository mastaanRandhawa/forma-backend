import { Router } from "express";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { computeReadiness } from "../services/readiness.js";

export const dashboardRouter = Router();
dashboardRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

/** One call that fills the Home dashboard (H1). */
dashboardRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const startOfDay = new Date(now).setHours(0, 0, 0, 0);

    const [user, trainer, nextWorkout, weekSessions, activeSession, recentPRs, lastMessage, goals, unreadCount, insights] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      prisma.trainer.findUniqueOrThrow({ where: { userId } }),
      prisma.workout.findFirst({
        where: { userId, isTemplate: false, scheduledDate: { gte: new Date(startOfDay) } },
        include: { exercises: { include: { exercise: true } } },
        orderBy: { scheduledDate: "asc" },
      }),
      prisma.workoutSession.findMany({ where: { userId, status: "completed", startedAt: { gte: weekAgo } } }),
      prisma.workoutSession.findFirst({ where: { userId, status: "in_progress" }, orderBy: { startedAt: "desc" } }),
      prisma.personalRecord.findMany({ where: { userId }, include: { exercise: true }, orderBy: { achievedAt: "desc" }, take: 3 }),
      prisma.chatMessage.findFirst({ where: { userId, role: "trainer" }, orderBy: { createdAt: "desc" } }),
      prisma.goal.findMany({ where: { userId, active: true } }),
      prisma.notification.count({ where: { userId, readAt: null } }),
      prisma.coachingInsight.findMany({ where: { userId, dismissedAt: null }, orderBy: { createdAt: "desc" }, take: 2 }),
    ]);

    const weeklyVolume = weekSessions.reduce((a, s) => a + s.totalVolumeKg, 0);
    const readiness = await computeReadiness(userId);

    // streak: consecutive days ending today/yesterday with a completed session
    const recent = await prisma.workoutSession.findMany({
      where: { userId, status: "completed" },
      orderBy: { startedAt: "desc" },
      take: 60,
      select: { startedAt: true },
    });
    const days = new Set(recent.map((s) => s.startedAt.toISOString().slice(0, 10)));
    let streak = 0;
    for (let i = 0; i < 60; i++) {
      const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
      if (days.has(d)) streak++;
      else if (i > 0) break;
    }

    res.json({
      greeting: dayPart(now),
      user: { name: user.name },
      trainerMessage: lastMessage?.content ?? defaultTrainerMessage(nextWorkout?.name),
      trainerName: trainer.name,
      todayWorkout: nextWorkout && new Date(nextWorkout.scheduledDate!).toDateString() === now.toDateString()
        ? summarizeWorkout(nextWorkout)
        : null,
      upcomingWorkout: nextWorkout ? summarizeWorkout(nextWorkout) : null,
      activeSessionId: activeSession?.id ?? null,
      weeklyRing: { done: weekSessions.length, target: user.trainingFrequencyTarget ?? 5 },
      weeklyVolumeKg: Math.round(weeklyVolume),
      readiness,
      streakDays: streak,
      recentPRs: recentPRs.map((p) => ({
        lift: p.exercise.name,
        recordType: p.recordType,
        value: p.value,
        previousValue: p.previousValue,
      })),
      goals: goals.map((g) => ({ key: g.key, label: g.label, target: g.target, unit: g.unit, tone: g.tone })),
      notificationsUnread: unreadCount,
      insights: insights.map((i) => ({ id: i.id, category: i.category, title: i.title, body: i.body, actions: i.actions })),
    });
  }),
);

const dayPart = (d: Date) => {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

const defaultTrainerMessage = (name?: string) =>
  name
    ? `${name} is on the plan for today. Warm up properly and aim to beat your last top set.`
    : "No workout scheduled today. Want me to generate one?";

function summarizeWorkout(w: {
  name: string;
  estimatedDurationMin: number | null;
  targetMuscleKeys: string[];
  exercises: { exercise: { name: string } }[];
}) {
  return {
    name: w.name,
    durationMin: w.estimatedDurationMin,
    exercises: w.exercises.length,
    muscles: w.targetMuscleKeys,
  };
}
