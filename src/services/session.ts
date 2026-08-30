import { Prisma, type MuscleRole } from "@prisma/client";
import { prisma } from "../prisma.js";

/** Epley estimated 1RM. */
export const epley1RM = (weightKg: number, reps: number) =>
  reps <= 1 ? weightKg : Math.round(weightKg * (1 + reps / 30) * 10) / 10;

/**
 * Finalize a session: recompute total volume, materialize MuscleActivation rows,
 * detect PRs, and (best-effort) attach a trainer comment. Idempotent.
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

  let totalVolume = 0;
  const activation = new Map<string, { role: MuscleRole; score: number }>();
  const prWrites: Prisma.PersonalRecordCreateManyInput[] = [];
  const setPrIds: string[] = [];

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
      where: { userId: session.userId, exerciseId: perf.exerciseId },
      orderBy: { achievedAt: "desc" },
    });
    const priorBest = (t: string) => priorPRs.find((p) => p.recordType === t)?.value ?? 0;

    if (bestWeight > priorBest("max_weight") && bestWeightSetId) {
      prWrites.push({ userId: session.userId, exerciseId: perf.exerciseId, recordType: "max_weight",
        value: bestWeight, previousValue: priorBest("max_weight") || null, setId: bestWeightSetId, sessionId });
      setPrIds.push(bestWeightSetId);
    }
    if (best1RM > priorBest("max_1rm_estimate") && best1RMSetId) {
      prWrites.push({ userId: session.userId, exerciseId: perf.exerciseId, recordType: "max_1rm_estimate",
        value: best1RM, previousValue: priorBest("max_1rm_estimate") || null, setId: best1RMSetId, sessionId });
    }
    if (exVolume > priorBest("max_volume")) {
      prWrites.push({ userId: session.userId, exerciseId: perf.exerciseId, recordType: "max_volume",
        value: Math.round(exVolume), previousValue: priorBest("max_volume") || null, sessionId });
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
        endedAt: session.endedAt ?? new Date(),
        durationSeconds:
          session.durationSeconds ||
          Math.round(((session.endedAt ?? new Date()).getTime() - session.startedAt.getTime()) / 1000),
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
