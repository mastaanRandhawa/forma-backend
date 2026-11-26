import { Prisma, type MuscleRole } from "@prisma/client";
import { prisma } from "../prisma.js";

/** Epley estimated 1RM. */
export const epley1RM = (weightKg: number, reps: number) =>
  reps <= 1 ? weightKg : Math.round(weightKg * (1 + reps / 30) * 10) / 10;

/**
 * Finalize a session: recompute total volume, materialize MuscleActivation rows,
 * detect PRs, and (best-effort) attach a trainer comment. Idempotent.
 *
 * Records are judged against history up to the moment the session ended, so a
 * back-dated or edited session is compared with what came before it, not with
 * lifts done after it.
 */
export async function finalizeSession(sessionId: string) {
  const session = await prisma.workoutSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      performances: {
        include: {
          sets: true,
          exercise: { include: { muscles: { include: { muscleGroup: true } } } },
        },
      },
    },
  });

  const cutoff = session.endedAt ?? new Date();
  let totalVolume = 0;
  const activation = new Map<string, { role: MuscleRole; score: number }>();
  const prWrites: Prisma.PersonalRecordCreateManyInput[] = [];
  const setPrIds: string[] = [];
  // PersonalRecord.setId is @unique — a set can back at most one PR row. Guard
  // against the same set being both the top-weight and top-e1RM set, and against
  // a set already linked by a prior PR (idempotent re-finalize).
  const claimedSetIds = new Set(
    (await prisma.personalRecord.findMany({
      where: { userId: session.userId, setId: { not: null } },
      select: { setId: true },
    })).map((p) => p.setId as string),
  );
  const claimSetId = (id: string | null): string | undefined => {
    if (!id || claimedSetIds.has(id)) return undefined;
    claimedSetIds.add(id);
    return id;
  };

  for (const perf of session.performances) {
    const working = perf.sets.filter((s) => !s.isWarmup && s.weightKg != null && s.reps != null);
    let exVolume = 0;
    let bestWeight = 0;
    let best1RM = 0;
    let bestReps = 0;
    let best1RMSetId: string | null = null;
    let bestWeightSetId: string | null = null;

    for (const s of working) {
      const v = (s.weightKg ?? 0) * (s.reps ?? 0);
      exVolume += v;
      const e1 = epley1RM(s.weightKg ?? 0, s.reps ?? 0);
      if ((s.weightKg ?? 0) > bestWeight) { bestWeight = s.weightKg ?? 0; bestWeightSetId = s.id; }
      if (e1 > best1RM) { best1RM = e1; best1RMSetId = s.id; }
      if ((s.reps ?? 0) > bestReps) bestReps = s.reps ?? 0;
    }
    totalVolume += exVolume;

    // form-score aggregate
    const scored = perf.sets.filter((s) => s.formScore != null);
    const formScoreAvg = scored.length
      ? Math.round((scored.reduce((a, s) => a + (s.formScore ?? 0), 0) / scored.length) * 10) / 10
      : null;
    await prisma.exercisePerformance.update({ where: { id: perf.id }, data: { formScoreAvg } });

    // muscle activation — weighted by role and set count
    const setFactor = Math.min(1, working.length / 4);
    for (const m of perf.exercise.muscles) {
      const roleWeight = m.role === "primary" ? 1 : m.role === "secondary" ? 0.5 : 0.25;
      const contribution = roleWeight * m.weight * setFactor;
      const prev = activation.get(m.muscleGroupId);
      const score = Math.min(1, (prev?.score ?? 0) + contribution);
      const role = prev && prev.role === "primary" ? prev.role : m.role;
      activation.set(m.muscleGroupId, { role, score });
    }

    // PR detection against historical bests for this exercise
    const priorPRs = await prisma.personalRecord.findMany({
      where: { userId: session.userId, exerciseId: perf.exerciseId, achievedAt: { lte: cutoff } },
      orderBy: { achievedAt: "desc" },
    });
    const priorBest = (t: string) => priorPRs.find((p) => p.recordType === t)?.value ?? 0;

    if (bestWeight > priorBest("max_weight") && bestWeightSetId) {
      const linkedSetId = claimSetId(bestWeightSetId);
      prWrites.push({ userId: session.userId, exerciseId: perf.exerciseId, recordType: "max_weight",
        value: bestWeight, previousValue: priorBest("max_weight") || null, setId: linkedSetId, sessionId, achievedAt: cutoff });
      if (linkedSetId) setPrIds.push(linkedSetId);
    }
    if (best1RM > priorBest("max_1rm_estimate") && best1RMSetId) {
      const linkedSetId = claimSetId(best1RMSetId);
      prWrites.push({ userId: session.userId, exerciseId: perf.exerciseId, recordType: "max_1rm_estimate",
        value: best1RM, previousValue: priorBest("max_1rm_estimate") || null, setId: linkedSetId, sessionId, achievedAt: cutoff });
      if (linkedSetId) setPrIds.push(linkedSetId);
    }
    if (exVolume > priorBest("max_volume")) {
      prWrites.push({ userId: session.userId, exerciseId: perf.exerciseId, recordType: "max_volume",
        value: Math.round(exVolume), previousValue: priorBest("max_volume") || null, sessionId, achievedAt: cutoff });
    }

    // timed sets (planks, carries) and cardio: longest effort and furthest distance.
    // They carry no reps, so they never touch volume or the 1RM estimate above.
    const timed = perf.sets.filter((s) => !s.isWarmup && (s.durationSeconds ?? 0) > 0);
    if (timed.length) {
      const longest = timed.reduce((a, b) => ((b.durationSeconds ?? 0) > (a.durationSeconds ?? 0) ? b : a));
      if ((longest.durationSeconds ?? 0) > priorBest("max_duration")) {
        const linkedSetId = claimSetId(longest.id);
        prWrites.push({ userId: session.userId, exerciseId: perf.exerciseId, recordType: "max_duration",
          value: longest.durationSeconds!, previousValue: priorBest("max_duration") || null, setId: linkedSetId, sessionId, achievedAt: cutoff });
        if (linkedSetId) setPrIds.push(linkedSetId);
      }
      const far = timed.filter((s) => (s.distanceM ?? 0) > 0);
      if (far.length) {
        const furthest = far.reduce((a, b) => ((b.distanceM ?? 0) > (a.distanceM ?? 0) ? b : a));
        if ((furthest.distanceM ?? 0) > priorBest("max_distance")) {
          const linkedSetId = claimSetId(furthest.id);
          prWrites.push({ userId: session.userId, exerciseId: perf.exerciseId, recordType: "max_distance",
            value: Math.round(furthest.distanceM!), previousValue: priorBest("max_distance") || null, setId: linkedSetId, sessionId, achievedAt: cutoff });
          if (linkedSetId) setPrIds.push(linkedSetId);
        }
      }
    }
  }

  await prisma.$transaction([
    prisma.muscleActivation.deleteMany({ where: { sessionId } }),
    prisma.muscleActivation.createMany({
      data: [...activation.entries()].map(([muscleGroupId, v]) => ({
        sessionId, muscleGroupId, role: v.role, activationScore: Math.round(v.score * 100) / 100,
      })),
    }),
    ...(prWrites.length ? [prisma.personalRecord.createMany({ data: prWrites })] : []),
    ...(setPrIds.length
      ? [prisma.exerciseSet.updateMany({ where: { id: { in: setPrIds } }, data: { isPersonalRecord: true } })]
      : []),
    prisma.workoutSession.update({
      where: { id: sessionId },
      data: {
        totalVolumeKg: Math.round(totalVolume * 10) / 10,
        status: "completed",
        endedAt: cutoff,
        durationSeconds:
          session.durationSeconds ||
          Math.round((cutoff.getTime() - session.startedAt.getTime()) / 1000),
      },
    }),
  ]);

  return prisma.workoutSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      performances: { include: { sets: true, exercise: true }, orderBy: { order: "asc" } },
      muscleActivations: { include: { muscleGroup: true } },
      personalRecords: { include: { exercise: true } },
    },
  });
}

/**
 * Rebuild a session's records, volume and muscle activation from its current sets.
 * Its own records are dropped first, then re-detected against earlier history.
 */
export async function recomputeSession(sessionId: string) {
  await prisma.$transaction([
    prisma.exerciseSet.updateMany({ where: { performance: { sessionId }, isPersonalRecord: true }, data: { isPersonalRecord: false } }),
    prisma.personalRecord.deleteMany({ where: { sessionId } }),
  ]);
  return finalizeSession(sessionId);
}

/**
 * Re-read a user's history from `since` onwards, oldest first, so a correction (an
 * edited weight, a deleted session, imported older workouts) flows through to every
 * later record instead of leaving stale "previous best" values behind.
 */
export async function recomputeUserHistory(userId: string, since: Date) {
  const sessions = await prisma.workoutSession.findMany({
    where: { userId, status: "completed", OR: [{ endedAt: { gte: since } }, { endedAt: null, startedAt: { gte: since } }] },
    orderBy: [{ endedAt: "asc" }, { startedAt: "asc" }],
    select: { id: true },
  });
  for (const s of sessions) await recomputeSession(s.id);
  return sessions.length;
}

export interface LoggedSetInput {
  weightKg?: number | null;
  reps?: number | null;
  rpe?: number | null;
  isWarmup?: boolean;
  durationSeconds?: number | null;
  distanceM?: number | null;
}
export interface LoggedPerformanceInput {
  exerciseId: string;
  sets: LoggedSetInput[];
}

/**
 * Create a finished workout from data (a session done on paper, or imported). The
 * session is stored completed with its real date; call recomputeUserHistory once
 * afterwards so records are judged in date order.
 */
export async function createCompletedSession(
  userId: string,
  input: { name: string; startedAt: Date; durationSeconds: number; performances: LoggedPerformanceInput[] },
) {
  const endedAt = new Date(input.startedAt.getTime() + Math.max(0, input.durationSeconds) * 1000);
  return prisma.workoutSession.create({
    data: {
      userId,
      name: input.name,
      startedAt: input.startedAt,
      endedAt,
      durationSeconds: Math.max(0, Math.round(input.durationSeconds)),
      status: "completed",
      performances: {
        create: input.performances.map((p, order) => ({
          exerciseId: p.exerciseId,
          order,
          sets: {
            create: p.sets.map((s, i) => ({
              setNumber: i + 1,
              weightKg: s.weightKg ?? null,
              reps: s.reps ?? null,
              rpe: s.rpe ?? null,
              isWarmup: s.isWarmup ?? false,
              durationSeconds: s.durationSeconds ?? null,
              distanceM: s.distanceM ?? null,
              completedAt: endedAt,
            })),
          },
        })),
      },
    },
  });
}

/** Delete a session and everything it produced (records are not cascaded by the schema). */
export async function deleteSession(sessionId: string) {
  await prisma.$transaction([
    prisma.personalRecord.deleteMany({ where: { sessionId } }),
    prisma.muscleActivation.deleteMany({ where: { sessionId } }),
    prisma.workoutSession.delete({ where: { id: sessionId } }),
  ]);
}
