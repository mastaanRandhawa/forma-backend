import { prisma } from "../prisma.js";
import { epley1RM } from "./session.js";
import { reviewTake } from "./ai.js";
import { personaFor } from "./economy.js";
import { WORKED_SESSION } from "./streak.js";

export interface KaiReview {
  title: string;
  generatedAt: string;
  sections: { heading: string; body: string }[];
}

const DAY_MS = 86_400_000;
const WINDOW_DAYS = 28;

const pctChange = (now: number, was: number) => (was > 0 ? Math.round(((now - was) / was) * 100) : null);

/**
 * A 28-day review built from logged numbers only. When the AI service is
 * configured Kai adds a written take; everything else is computed, so the review
 * says the same thing with or without it.
 */
export async function buildKaiReview(userId: string): Promise<KaiReview> {
  const now = Date.now();
  const from = new Date(now - WINDOW_DAYS * DAY_MS);
  const priorFrom = new Date(now - 2 * WINDOW_DAYS * DAY_MS);

  const [user, trainer, sessions, prs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { trainingFrequencyTarget: true } }),
    prisma.trainer.findUniqueOrThrow({ where: { userId } }),
    prisma.workoutSession.findMany({
      where: { userId, ...WORKED_SESSION, startedAt: { gte: priorFrom } },
      select: {
        startedAt: true,
        totalVolumeKg: true,
        performances: {
          select: {
            exercise: { select: { name: true } },
            sets: { where: { isWarmup: false, weightKg: { not: null }, reps: { gt: 0 } }, select: { weightKg: true, reps: true } },
          },
        },
        muscleActivations: {
          where: { role: "primary" },
          select: { activationScore: true, muscleGroup: { select: { plainName: true } } },
        },
      },
    }),
    prisma.personalRecord.findMany({
      where: { userId, achievedAt: { gte: from }, previousValue: { not: null } },
      select: { sessionId: true, exerciseId: true, exercise: { select: { name: true } } },
    }),
  ]);

  const recent = sessions.filter((s) => s.startedAt >= from);
  const prior = sessions.filter((s) => s.startedAt < from);
  const sections: KaiReview["sections"] = [];

  // frequency
  const target = user.trainingFrequencyTarget;
  const perWeek = Math.round((recent.length / (WINDOW_DAYS / 7)) * 10) / 10;
  sections.push({
    heading: "consistency",
    body: recent.length
      ? `${recent.length} session${recent.length === 1 ? "" : "s"} in 28 days, about ${perWeek} a week${
          target ? ` against your target of ${target}` : ""
        }. ${target && perWeek >= target ? "You're hitting your target." : target ? "That's the first thing to lift." : ""}`.trim()
      : "No completed sessions in the last 28 days. Starting again is the whole job right now.",
  });

  // volume
  const volume = (list: typeof sessions) => list.reduce((n, s) => n + s.totalVolumeKg, 0);
  const change = pctChange(volume(recent), volume(prior));
  sections.push({
    heading: "volume",
    body: `${Math.round(volume(recent)).toLocaleString("en-US")} kg moved${
      change == null ? "." : `, ${change >= 0 ? "up" : "down"} ${Math.abs(change)}% on the 28 days before.`
    }`,
  });

  // lifts: compare the best estimated 1RM in each window
  const bestLifts = (list: typeof sessions) => {
    const best = new Map<string, number>();
    for (const s of list) {
      for (const p of s.performances) {
        for (const set of p.sets) {
          const e1 = epley1RM(set.weightKg ?? 0, set.reps ?? 0);
          if (e1 > (best.get(p.exercise.name) ?? 0)) best.set(p.exercise.name, e1);
        }
      }
    }
    return best;
  };
  const before = bestLifts(prior);
  const moved = [...bestLifts(recent).entries()]
    .flatMap(([name, e1]) => {
      const was = before.get(name);
      return was ? [{ name, delta: Math.round((e1 - was) * 10) / 10 }] : [];
    })
    .sort((a, b) => b.delta - a.delta);
  const up = moved.filter((m) => m.delta > 0).slice(0, 3);
  const down = moved.filter((m) => m.delta < 0).slice(-1)[0];
  sections.push({
    heading: "lifts",
    body: moved.length
      ? [
          up.length ? `Moving up: ${up.map((m) => `${m.name} +${m.delta} kg e1RM`).join(", ")}.` : "No lift has moved up yet.",
          down ? `Watch ${down.name}, down ${Math.abs(down.delta)} kg e1RM.` : "",
        ].filter(Boolean).join(" ")
      : "Not enough repeat lifts across both windows to compare yet.",
  });

  // records
  const prLifts = [...new Set(prs.map((p) => p.exercise.name))];
  sections.push({
    heading: "records",
    body: prLifts.length
      ? `Personal records on ${prLifts.slice(0, 5).join(", ")}${prLifts.length > 5 ? ` and ${prLifts.length - 5} more` : ""}.`
      : "No new records in this window.",
  });

  // muscle balance
  const load = new Map<string, number>();
  for (const s of recent) {
    for (const m of s.muscleActivations) {
      load.set(m.muscleGroup.plainName, (load.get(m.muscleGroup.plainName) ?? 0) + m.activationScore);
    }
  }
  const ranked = [...load.entries()].sort((a, b) => b[1] - a[1]);
  const most = ranked[0]?.[0];
  const least = ranked.length > 1 ? ranked[ranked.length - 1][0] : null;
  sections.push({
    heading: "balance",
    body: most ? `Most work went to ${most}${least ? `, least to ${least}` : ""}.` : "No muscle data in this window yet.",
  });

  // the next step, picked from the weakest signal above
  sections.push({
    heading: "next step",
    body: !recent.length
      ? "Book two short sessions this week. Don't worry about load until the habit is back."
      : target && perWeek < target
        ? `Add one session a week until you're at ${target}. Consistency will do more than any program change.`
        : down
          ? `Keep ${down.name} at the current weight for a week and aim to beat your reps before adding load.`
          : least
            ? `Add 2–3 sets for ${least} this week to even things out.`
            : "Keep going as you are, and add the smallest weight step when you reach the top of a rep range.",
  });

  const take = await reviewTake(
    { ...trainer, persona: await personaFor(userId) },
    {
      sessions: recent.length,
      perWeek,
      target,
      volumeKg: Math.round(volume(recent)),
      volumeChangePct: change,
      liftsUp: up,
      liftDown: down ?? null,
      prs: prLifts,
      mostWorked: most ?? null,
      leastWorked: least,
    },
  );
  if (take) sections.unshift({ heading: "kai's take", body: take });

  return { title: "28-day review", generatedAt: new Date(now).toISOString(), sections };
}

export const reviewAsText = (r: KaiReview) =>
  [r.title, ...r.sections.map((s) => `${s.heading}: ${s.body}`)].join("\n\n");
