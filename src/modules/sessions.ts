import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound, badRequest } from "../lib/errors.js";
import { finalizeSession } from "../services/session.js";
import { evaluateAchievements } from "../services/achievements.js";
import { generateInsights } from "../services/insights.js";
import { evaluateProgression } from "../services/progression.js";
import { sessionComment } from "../services/ai.js";
import { notify } from "../services/notify.js";

export const sessionsRouter = Router();
sessionsRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

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
          performances: { include: { exercise: true, sets: { orderBy: { setNumber: "asc" } } }, orderBy: { order: "asc" } },
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
    res.status(201).json(session);
  }),
);

/** Add or replace an exercise performance mid-session (e.g. exercise swap W10). */
sessionsRouter.post(
  "/:id/performances",
  validate({ body: z.object({ exerciseId: z.string(), order: z.number().int().min(0) }) }),
  asyncHandler(async (req, res) => {
    await ownSession(uid(req), req.params.id);
    const { exerciseId, order } = req.body as { exerciseId: string; order: number };
    const perf = await prisma.exercisePerformance.upsert({
      where: { sessionId_order: { sessionId: req.params.id, order } },
      update: { exerciseId },
      create: { sessionId: req.params.id, exerciseId, order },
      include: { exercise: true, sets: true },
    });
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
      formScore: z.number().min(0).max(100).nullable().optional(),
      romValue: z.number().nullable().optional(),
      completed: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    await ownSession(userId, req.params.id);
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
    res.json(set);
  }),
);

sessionsRouter.delete(
  "/:id/performances/:perfId/sets/:setNumber",
  asyncHandler(async (req, res) => {
    await ownSession(uid(req), req.params.id);
    await prisma.exerciseSet.deleteMany({
      where: { setNumber: Number(req.params.setNumber), performance: { id: req.params.perfId, sessionId: req.params.id } },
    });
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
    if (session.status === "completed") return res.json(await finalizeSession(session.id));
    const { durationSeconds, caloriesEstimate } = req.body as { durationSeconds?: number; caloriesEstimate?: number };
    if (durationSeconds || caloriesEstimate) {
      await prisma.workoutSession.update({ where: { id: session.id }, data: { durationSeconds, caloriesEstimate } });
    }

    const finalized = await finalizeSession(session.id);

    // post-workout trainer comment (§8.6)
    const trainer = await prisma.trainer.findUniqueOrThrow({ where: { userId } });
    const comment = await sessionComment(trainer, {
      totalVolumeKg: finalized.totalVolumeKg,
      prCount: finalized.personalRecords.length,
      exercises: finalized.performances.length,
      durationSeconds: finalized.durationSeconds,
    }).catch(() => null);
    if (comment) {
      await prisma.workoutSession.update({ where: { id: session.id }, data: { trainerComment: comment } });
      finalized.trainerComment = comment;
    }

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

    res.json(Object.assign(finalized, { progression }));
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
