import { prisma } from "../prisma.js";
import { computeReadiness } from "./readiness.js";
import { notify } from "./notify.js";

/**
 * Insight rules engine (§15.3). Deterministic rules that read the derived layer
 * and emit CoachingInsight rows. De-duplicated per category per 3-day window.
 */
export async function generateInsights(userId: string) {
  const since3d = new Date(Date.now() - 3 * 86_400_000);
  const recent = await prisma.coachingInsight.findMany({
    where: { userId, createdAt: { gte: since3d } },
    select: { category: true },
  });
  const fresh = new Set(recent.map((r) => r.category));
  const out: { category: "recovery" | "volume" | "form" | "consistency"; title: string; body: string; actions: string[] }[] = [];

  // recovery
  if (!fresh.has("recovery")) {
    const readiness = await computeReadiness(userId);
    const sleep = await latestMetric(userId, "sleep");
    if (readiness < 60) {
      out.push({
        category: "recovery",
        title: "Recovery is running low",
        body: `Your readiness is ${readiness}/100. Consider capping today's top sets at RPE 8 and prioritising sleep tonight.`,
        actions: ["Adjust workout", "Why?"],
      });
    } else if (sleep != null && sleep >= 7.5) {
      out.push({
        category: "recovery",
        title: "Sleep is trending up",
        body: `You've averaged ${sleep.toFixed(1)}h of sleep. Readiness usually follows within a day or two.`,
        actions: ["Add to plan"],
      });
    }
  }

  // volume balance push vs pull
  if (!fresh.has("volume")) {
    const since = new Date(Date.now() - 14 * 86_400_000);
    const rows = await prisma.muscleActivation.findMany({
      where: { session: { userId, startedAt: { gte: since }, status: "completed" } },
      include: { muscleGroup: true },
    });
    const region = { push: 0, pull: 0, legs: 0 } as Record<string, number>;
    for (const r of rows) {
      const k = r.muscleGroup.key;
      if (["chest", "shoulders", "triceps"].includes(k)) region.push += r.activationScore;
      else if (["back", "lats", "biceps", "rear_delts", "traps"].includes(k)) region.pull += r.activationScore;
      else if (["quads", "hamstrings", "glutes", "calves"].includes(k)) region.legs += r.activationScore;
    }
    if (region.push > region.pull * 1.5 && region.push > 2) {
      out.push({
        category: "volume",
        title: "Push volume is ahead of pull",
        body: "Your last two weeks lean heavily toward pressing. Front-loading back and rear-delt work next week will even it out.",
        actions: ["Rebalance plan"],
      });
    }
  }

  // form drop
  if (!fresh.has("form")) {
    const sets = await prisma.exerciseSet.findMany({
      where: { formScore: { not: null }, performance: { session: { userId, status: "completed" } } },
      orderBy: { completedAt: "desc" },
      take: 40,
      include: { performance: { include: { exercise: true } } },
    });
    if (sets.length >= 10) {
      const recentAvg = avg(sets.slice(0, 10).map((s) => s.formScore!));
      const priorAvg = avg(sets.slice(10).map((s) => s.formScore!));
      if (recentAvg < priorAvg - 6) {
        out.push({
          category: "form",
          title: "Form score dipped recently",
          body: `Average clean-rep score is down ${Math.round(priorAvg - recentAvg)} points. Tempo on the eccentric is the usual culprit — try a 3-second lower on your first two sets.`,
          actions: ["See form trends"],
        });
      }
    }
  }

  // consistency
  if (!fresh.has("consistency")) {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const count = await prisma.workoutSession.count({ where: { userId, status: "completed", startedAt: { gte: weekAgo } } });
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const target = user.trainingFrequencyTarget ?? 4;
    if (count === 0) {
      out.push({
        category: "consistency",
        title: "No sessions logged this week",
        body: "A short 20-minute session still counts. Want me to generate a quick one?",
        actions: ["Generate workout"],
      });
    } else if (count >= target) {
      out.push({
        category: "consistency",
        title: "Weekly target hit",
        body: `${count} sessions this week — you're on plan. Anything beyond this is a bonus.`,
        actions: [],
      });
    }
  }

  const created = [];
  for (const i of out) {
    const row = await prisma.coachingInsight.create({ data: { userId, ...i } });
    created.push(row);
    if (i.category === "recovery" || i.category === "form") {
      await notify(userId, "trainer_message", i.title, i.body, "/trainer").catch(() => {});
    }
  }
  return created;
}

/** Trainer Check-In Prompt (T5) — a single proactive question card. */
export async function buildCheckIn(userId: string) {
  const lastSession = await prisma.workoutSession.findFirst({
    where: { userId, status: "completed" },
    orderBy: { startedAt: "desc" },
    include: { muscleActivations: { include: { muscleGroup: true } } },
  });
  const injuries = await prisma.injuryNote.findMany({ where: { userId, active: true } });

  if (injuries[0]) {
    return { prompt: `How's your ${injuries[0].tag} feeling today?`, options: ["Fine", "A little tight", "Painful"], topic: "injury" };
  }
  if (lastSession) {
    const top = [...lastSession.muscleActivations].sort((a, b) => b.activationScore - a.activationScore)[0];
    if (top) return { prompt: `How sore is your ${top.muscleGroup.plainName.toLowerCase()} after the last session?`, options: ["Not sore", "Mild", "Very sore"], topic: "soreness" };
  }
  return { prompt: "How are your energy levels today?", options: ["Great", "Okay", "Low"], topic: "energy" };
}

async function latestMetric(userId: string, metricType: string) {
  const row = await prisma.progressMetric.findFirst({
    where: { userId, metricType: metricType as never },
    orderBy: { recordedAt: "desc" },
  });
  return row?.value ?? null;
}
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
