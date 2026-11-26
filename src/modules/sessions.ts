import { Router } from "express";
import { onGoalCompleted, onWorkoutFinished, syncTimezone } from "../services/rewards.js";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound, badRequest } from "../lib/errors.js";
import { assertExercisesVisible } from "../lib/exercises.js";
import { createCompletedSession, deleteSession, finalizeSession, recomputeUserHistory } from "../services/session.js";
import { evaluateAchievements } from "../services/achievements.js";
import { generateInsights } from "../services/insights.js";
import { evaluateProgression } from "../services/progression.js";
import { sessionComment } from "../services/ai.js";
import { notify } from "../services/notify.js";
import { prescribeExercise } from "../services/prescription.js";
import { shouldDeload } from "../services/deload.js";
import { readinessAdjustment } from "../services/readiness.js";

export const sessionsRouter = Router();
sessionsRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

/** After any change to a finished workout, rebuild its numbers and every later record. */
async function rebuildIfFinished(session: { userId: string; status: string; startedAt: Date; endedAt: Date | null }) {
  if (session.status !== "completed") return;
  await recomputeUserHistory(session.userId, session.endedAt ?? session.startedAt);
}

const loggedSet = z.object({
  weightKg: z.number().min(0).max(2000).nullable().optional(),
  reps: z.number().int().min(0).max(1000).nullable().optional(),
  rpe: z.number().min(1).max(10).nullable().optional(),
  isWarmup: z.boolean().optional(),
  durationSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
  distanceM: z.number().min(0).max(1_000_000).nullable().optional(),
});
const FUTURE_SLACK_MS = 5 * 60_000;

async function ownSession(userId: string, id: string) {
  const s = await prisma.workoutSession.findFirst({ where: { id, userId } });
  if (!s) throw notFound("Session not found");
  return s;
}

sessionsRouter.get(
  "/",
  validate({ query: z.object({ status: z.enum(["in_progress", "completed", "abandoned"]).optional(), take: z.coerce.number().max(100).default(30) }) }),
  asyncHandler(async (req, res) => {
    const { status, take } = req.query as unknown as { status?: string; take: number };
    res.json(
      await prisma.workoutSession.findMany({
        where: { userId: uid(req), ...(status ? { status: status as never } : {}) },
        include: { performances: { include: { exercise: true, sets: true }, orderBy: { order: "asc" } } },
        orderBy: { startedAt: "desc" },
        take,
      }),
    );
  }),
);

sessionsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    await ownSession(uid(req), req.params.id);
    res.json(
      await prisma.workoutSession.findUnique({
        where: { id: req.params.id },
        include: {
          performances: {
            include: { exercise: true, sets: { orderBy: { setNumber: "asc" } }, prescriptionAudit: true },
            orderBy: { order: "asc" },
          },
          muscleActivations: { include: { muscleGroup: true } },
          personalRecords: { include: { exercise: true } },
        },
      }),
    );
  }),
);

/** Start a session from a planned workout (or ad hoc). Seeds empty performances. */
sessionsRouter.post(
  "/",
  validate({
    body: z.object({
      workoutId: z.string().optional(),
      name: z.string().optional(),
      trackingMode: z.enum(["camera", "manual"]).default("manual"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { workoutId, name, trackingMode } = req.body as { workoutId?: string; name?: string; trackingMode: "camera" | "manual" };

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const unit = user.unitPreference === "imperial" ? "imperial" : "metric";

    let workout = null;
    if (workoutId) {
      workout = await prisma.workout.findFirst({
        where: { id: workoutId, userId },
        include: { exercises: { orderBy: { order: "asc" } } },
      });
      if (!workout) throw notFound("Workout not found");
    }

    const session = await prisma.workoutSession.create({
      data: {
        userId,
        workoutId: workout?.id,
        name: name ?? workout?.name ?? "Quick Workout",
        trackingMode,
        performances: workout
          ? { create: workout.exercises.map((e) => ({ exerciseId: e.exerciseId, order: e.order })) }
          : undefined,
      },
      include: { performances: { include: { exercise: true, sets: true }, orderBy: { order: "asc" } } },
    });

    // ── adaptation engine (§2) — seed each performance with a prescribed target ──
    let readinessAdj: Awaited<ReturnType<typeof readinessAdjustment>> | null = null;
    if (workout && workout.exercises.length) {
      const [deloadSignal, adj] = await Promise.all([
        shouldDeload(userId).catch(() => null),
        readinessAdjustment(userId).catch(() => null),
      ]);
      readinessAdj = adj;
      const deload = !!deloadSignal?.deload;

      for (const perf of session.performances) {
        const templateEx = workout.exercises.find((e) => e.order === perf.order);
        if (!templateEx) continue;
        try {
          const { prescription, inputs } = await prescribeExercise(
            userId,
            perf.exerciseId,
            {
              targetRepsMin: templateEx.targetRepsMin,
              targetRepsMax: templateEx.targetRepsMax,
              targetWeightKg: templateEx.targetWeightKg,
            },
            { unit, deload },
          );
          const audit = await prisma.recommendationAudit.create({
            data: {
              userId,
              kind: "prescription",
              subjectId: perf.exerciseId,
              inputs: { ...inputs, deloadReason: deloadSignal?.reason ?? null } as never,
              rule: prescription.rule,
              output: {
                targetWeightKg: prescription.targetWeightKg,
                targetReps: prescription.targetReps,
                targetRpe: prescription.targetRpe,
                note: prescription.note,
              } as never,
            },
          });
          await prisma.exercisePerformance.update({
            where: { id: perf.id },
            data: {
              prescribedWeightKg: prescription.targetWeightKg,
              prescribedReps: prescription.targetReps,
              prescribedRpe: prescription.targetRpe,
              prescriptionAuditId: audit.id,
            },
          });
        } catch {
          /* prescription is best-effort — never block starting a workout */
        }
      }

      if (adj?.applied) {
        await prisma.recommendationAudit
          .create({
            data: {
              userId,
              kind: "readiness_adjustment",
              subjectId: session.id,
              inputs: { readiness: adj.score } as never,
              rule: adj.rule,
              output: {
                accessorySetDelta: adj.accessorySetDelta,
                rpeCap: adj.rpeCap,
                swapHeaviestCompound: adj.swapHeaviestCompound,
                reason: adj.reason,
              } as never,
            },
          })
          .catch(() => {});
      }
    }

    const full = await prisma.workoutSession.findUniqueOrThrow({
      where: { id: session.id },
      include: {
        performances: { include: { exercise: true, sets: true, prescriptionAudit: true }, orderBy: { order: "asc" } },
      },
    });
    res.status(201).json(Object.assign(full, { readinessAdjustment: readinessAdj }));
  }),
);

/** Log a workout that already happened (done on paper, or backfilled). Stored finished, with its real date. */
sessionsRouter.post(
  "/log",
  validate({
    body: z.object({
      name: z.string().min(1).max(120).default("Logged workout"),
      startedAt: z.coerce.date(),
      durationSeconds: z.number().int().min(0).max(86_400).default(3600),
      performances: z
        .array(z.object({ exerciseId: z.string(), sets: z.array(loggedSet).min(1).max(60) }))
        .min(1)
        .max(30),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const body = req.body as { name: string; startedAt: Date; durationSeconds: number; performances: { exerciseId: string; sets: z.infer<typeof loggedSet>[] }[] };
    if (body.startedAt.getTime() > Date.now() + FUTURE_SLACK_MS) throw badRequest("A logged workout can't be in the future");
    await assertExercisesVisible(userId, body.performances.map((p) => p.exerciseId));

    const created = await createCompletedSession(userId, body);
    await recomputeUserHistory(userId, body.startedAt);
    res.status(201).json(
      await prisma.workoutSession.findUniqueOrThrow({
        where: { id: created.id },
        include: {
          performances: { include: { exercise: true, sets: { orderBy: { setNumber: "asc" } } }, orderBy: { order: "asc" } },
          personalRecords: { include: { exercise: true } },
        },
      }),
    );
  }),
);

/** Edit a finished workout's name, date or duration. Records are re-read from the corrected history. */
sessionsRouter.patch(
  "/:id",
  validate({
    body: z
      .object({
        name: z.string().min(1).max(120),
        startedAt: z.coerce.date(),
        durationSeconds: z.number().int().min(0).max(86_400),
      })
      .partial()
      .refine((b) => Object.keys(b).length > 0, "Nothing to change"),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const session = await ownSession(userId, req.params.id);
    if (session.status !== "completed") throw badRequest("Only finished workouts can be edited");
    const b = req.body as { name?: string; startedAt?: Date; durationSeconds?: number };
    if (b.startedAt && b.startedAt.getTime() > Date.now() + FUTURE_SLACK_MS) throw badRequest("A workout can't be in the future");
    const startedAt = b.startedAt ?? session.startedAt;
    const durationSeconds = b.durationSeconds ?? session.durationSeconds;
    await prisma.workoutSession.update({
      where: { id: session.id },
      data: { name: b.name, startedAt, durationSeconds, endedAt: new Date(startedAt.getTime() + durationSeconds * 1000) },
    });
    const since = new Date(Math.min(startedAt.getTime(), (session.endedAt ?? session.startedAt).getTime(), session.startedAt.getTime()));
    await recomputeUserHistory(userId, since);
    res.json(
      await prisma.workoutSession.findUniqueOrThrow({
        where: { id: session.id },
        include: { performances: { include: { exercise: true, sets: { orderBy: { setNumber: "asc" } } }, orderBy: { order: "asc" } }, personalRecords: { include: { exercise: true } } },
      }),
    );
  }),
);

/** Remove an exercise from a finished workout. */
sessionsRouter.delete(
  "/:id/performances/:perfId",
  asyncHandler(async (req, res) => {
    const session = await ownSession(uid(req), req.params.id);
    const r = await prisma.exercisePerformance.deleteMany({ where: { id: req.params.perfId, sessionId: req.params.id } });
    if (!r.count) throw notFound("Performance not found");
    await rebuildIfFinished(session);
    res.status(204).end();
  }),
);

/** Delete a workout and its records; later records are re-read without it. */
sessionsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const session = await ownSession(userId, req.params.id);
    await deleteSession(session.id);
    if (session.status === "completed") await recomputeUserHistory(userId, session.endedAt ?? session.startedAt);
    res.status(204).end();
  }),
);

/** Add or replace an exercise performance mid-session (e.g. exercise swap W10). */
sessionsRouter.post(
  "/:id/performances",
  validate({ body: z.object({ exerciseId: z.string(), order: z.number().int().min(0) }) }),
  asyncHandler(async (req, res) => {
    const session = await ownSession(uid(req), req.params.id);
    const { exerciseId, order } = req.body as { exerciseId: string; order: number };
    await assertExercisesVisible(uid(req), [exerciseId]);
    const perf = await prisma.exercisePerformance.upsert({
      where: { sessionId_order: { sessionId: req.params.id, order } },
      update: { exerciseId },
      create: { sessionId: req.params.id, exerciseId, order },
      include: { exercise: true, sets: true },
    });
    await rebuildIfFinished(session);
    res.status(201).json(perf);
  }),
);

/** Log (upsert) a single set. This is the hot path during an active workout. */
sessionsRouter.put(
  "/:id/performances/:perfId/sets/:setNumber",
  validate({
    params: z.object({ id: z.string(), perfId: z.string(), setNumber: z.coerce.number().int().min(1) }),
    body: z.object({
      weightKg: z.number().nonnegative().nullable().optional(),
      reps: z.number().int().nonnegative().nullable().optional(),
      rpe: z.number().min(1).max(10).nullable().optional(),
      restSecondsTaken: z.number().int().nonnegative().optional(),
      isWarmup: z.boolean().optional(),
      durationSeconds: z.number().int().min(0).max(86_400).nullable().optional(),
      distanceM: z.number().min(0).max(1_000_000).nullable().optional(),
      formScore: z.number().min(0).max(100).nullable().optional(),
      romValue: z.number().nullable().optional(),
      completed: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const session = await ownSession(userId, req.params.id);
    const perf = await prisma.exercisePerformance.findFirst({
      where: { id: req.params.perfId, sessionId: req.params.id },
    });
    if (!perf) throw notFound("Performance not found");

    const setNumber = Number(req.params.setNumber);
    const { completed, ...data } = req.body as Record<string, unknown> & { completed?: boolean };

    const set = await prisma.exerciseSet.upsert({
      where: { performanceId_setNumber: { performanceId: perf.id, setNumber } },
      update: { ...data, completedAt: completed ? new Date() : undefined },
      create: { performanceId: perf.id, setNumber, ...data, completedAt: completed ? new Date() : null },
    });
    // fixing a finished workout: volume, muscle activation and records follow the change
    await rebuildIfFinished(session);
    res.json(set);
  }),
);

sessionsRouter.delete(
  "/:id/performances/:perfId/sets/:setNumber",
  asyncHandler(async (req, res) => {
    const session = await ownSession(uid(req), req.params.id);
    await prisma.exerciseSet.deleteMany({
      where: { setNumber: Number(req.params.setNumber), performance: { id: req.params.perfId, sessionId: req.params.id } },
    });
    await rebuildIfFinished(session);
    res.status(204).end();
  }),
);

/** Ingest camera form analysis for a set (per-rep). Categorical faults only. */
sessionsRouter.post(
  "/:id/form-analysis",
  validate({
    body: z.object({
      performanceId: z.string(),
      setNumber: z.number().int().min(1),
      reps: z.array(
        z.object({
          repIndex: z.number().int().min(0),
          jointAngleSnapshot: z.record(z.number()),
          romValue: z.number().optional(),
          tempoSeconds: z.number().optional(),
          detectedFaults: z.array(z.object({ type: z.string(), severity: z.number().min(0).max(1) })).default([]),
          overallRepScore: z.number().min(0).max(100).optional(),
        }),
      ),
    }),
  }),
  asyncHandler(async (req, res) => {
    await ownSession(uid(req), req.params.id);
    const body = req.body as {
      performanceId: string; setNumber: number;
      reps: { repIndex: number; jointAngleSnapshot: Record<string, number>; romValue?: number; tempoSeconds?: number; detectedFaults: unknown[]; overallRepScore?: number }[];
    };
    const set = await prisma.exerciseSet.findFirst({
      where: { setNumber: body.setNumber, performance: { id: body.performanceId, sessionId: req.params.id } },
    });
    if (!set) throw badRequest("Log the set before its form analysis");

    await prisma.$transaction([
      prisma.formAnalysis.deleteMany({ where: { setId: set.id } }),
      prisma.formAnalysis.createMany({
        data: body.reps.map((r) => ({
          setId: set.id,
          repIndex: r.repIndex,
          jointAngleSnapshot: r.jointAngleSnapshot,
          romValue: r.romValue,
          tempoSeconds: r.tempoSeconds,
          detectedFaults: r.detectedFaults as never,
          overallRepScore: r.overallRepScore,
        })),
      }),
    ]);

    const scores = body.reps.map((r) => r.overallRepScore).filter((n): n is number => n != null);
    if (scores.length) {
      await prisma.exerciseSet.update({
        where: { id: set.id },
        data: { formScore: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 },
      });
    }
    res.status(201).json({ ok: true, reps: body.reps.length });
  }),
);

/** Finish the workout → compute volume, activation, PRs, trainer comment (W11). */
sessionsRouter.post(
  "/:id/finish",
  validate({ body: z.object({ durationSeconds: z.number().int().optional(), caloriesEstimate: z.number().int().optional() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const session = await ownSession(userId, req.params.id);
    await syncTimezone(userId, req.header("x-timezone"));
    if (session.status === "completed") {
      // a retried finish still returns the rewards (grants are idempotent, so nothing pays twice)
      const done = await finalizeSession(session.id);
      return res.json(Object.assign(done, { rewards: await onWorkoutFinished(userId, session.id).catch(() => null) }));
    }
    const { durationSeconds, caloriesEstimate } = req.body as { durationSeconds?: number; caloriesEstimate?: number };
    if (durationSeconds || caloriesEstimate) {
      await prisma.workoutSession.update({ where: { id: session.id }, data: { durationSeconds, caloriesEstimate } });
    }

    const finalized = await finalizeSession(session.id);

    // post-workout trainer comment (§8.6) — richer context for better debrief
    const [trainer, readinessRow] = await Promise.all([
      prisma.trainer.findUniqueOrThrow({ where: { userId } }),
      prisma.recoveryCheckin.findFirst({ where: { userId }, orderBy: { recordedAt: "desc" } }),
    ]);

    // find the exercise with the highest average RPE across its sets (RPE >= 9)
    const highRpePerf = finalized.performances
      .map((p) => {
        const doneSets = p.sets.filter((s) => s.rpe != null && !s.isWarmup);
        const avgRpe = doneSets.length
          ? doneSets.reduce((sum, s) => sum + (s.rpe ?? 0), 0) / doneSets.length
          : 0;
        return { name: p.exercise?.name ?? "", avgRpe };
      })
      .filter((p) => p.avgRpe >= 9)
      .sort((a, b) => b.avgRpe - a.avgRpe)[0];

    // count sets above/below prescription targets
    let aboveTargetSets = 0;
    let belowTargetSets = 0;
    for (const perf of finalized.performances) {
      const done = perf.sets.filter((s) => s.reps != null && !s.isWarmup).length;
      const prescribed = perf.prescribedReps != null ? perf.sets.filter((s) => !s.isWarmup).length : 0;
      if (prescribed) {
        if (done > prescribed) aboveTargetSets++;
        else if (done < prescribed) belowTargetSets++;
      }
    }

    const comment = await sessionComment(trainer, {
      totalVolumeKg: finalized.totalVolumeKg,
      prCount: finalized.personalRecords.length,
      prDetails: finalized.personalRecords.map((pr) => `${pr.exercise?.name} ${pr.recordType}`).join(", "),
      exercises: finalized.performances.length,
      durationSeconds: finalized.durationSeconds,
      readiness: readinessRow
        ? Math.round(
            100 -
              ((readinessRow.fatigue ?? 3) + (readinessRow.soreness ?? 3) - (readinessRow.sleepQuality ?? 3)) * 10,
          )
        : null,
      aboveTargetSets: aboveTargetSets > 0,
      belowTargetSets: belowTargetSets > 0,
      highRpeExercise: highRpePerf?.name ?? null,
    }).catch(() => null);
    if (comment) {
      await prisma.workoutSession.update({ where: { id: session.id }, data: { trainerComment: comment } });
      finalized.trainerComment = comment;
    }

    // auto-connect: increment the user's workout-frequency goal by 1
    void autoIncrementGoal(userId, "workout_frequency").catch(() => {});

    // derived-layer follow-ups — best-effort, never block the response.
    // achievements first (they feed progression's prCount / achievementCount).
    await Promise.allSettled([
      generateInsights(userId),
      ...finalized.personalRecords.map((pr) =>
        notify(userId, "pr", "New personal record", `${pr.exercise.name} — ${pr.recordType.replace(/_/g, " ")}`, "/progress"),
      ),
    ]);
    await evaluateAchievements(userId).catch(() => {});
    const progression = await evaluateProgression(userId).catch(() => null);
    const rewards = await onWorkoutFinished(userId, session.id).catch(() => null);

    res.json(Object.assign(finalized, { progression, rewards }));
  }),
);

sessionsRouter.post("/:id/abandon", asyncHandler(async (req, res) => {
  await ownSession(uid(req), req.params.id);
  res.json(
    await prisma.workoutSession.update({
      where: { id: req.params.id },
      data: { status: "abandoned", endedAt: new Date() },
    }),
  );
}));

/** Increment a goal keyed by `key` by 1 for the current period. Best-effort. */
async function autoIncrementGoal(userId: string, key: string): Promise<void> {
  const goal = await prisma.goal.findFirst({ where: { userId, key, active: true } });
  if (!goal) return;
  const d = new Date();
  const periodKey =
    goal.cadence === "daily"
      ? d.toISOString().slice(0, 10)
      : (() => {
          const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
          const day = t.getUTCDay() || 7;
          t.setUTCDate(t.getUTCDate() + 4 - day);
          const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
          const wk = Math.ceil(((t.getTime() - ys.getTime()) / 86_400_000 + 1) / 7);
          return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
        })();
  const existing = await prisma.goalEntry.findUnique({
    where: { goalId_periodKey: { goalId: goal.id, periodKey } },
  });
  const next = (existing?.value ?? 0) + 1;
  await prisma.goalEntry.upsert({
    where: { goalId_periodKey: { goalId: goal.id, periodKey } },
    update: { value: next, completed: next >= goal.target },
    create: { goalId: goal.id, periodKey, value: next, completed: next >= goal.target },
  });
  if (next >= goal.target) await onGoalCompleted(userId, goal.id, periodKey, goal.label);
}
