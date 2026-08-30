import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound } from "../lib/errors.js";

export const libraryRouter = Router();
libraryRouter.use(requireAuth);

libraryRouter.get(
  "/muscle-groups",
  asyncHandler(async (_req, res) => {
    res.json(await prisma.muscleGroup.findMany({ orderBy: { region: "asc" } }));
  }),
);

libraryRouter.get(
  "/exercises",
  validate({
    query: z.object({
      q: z.string().optional(),
      muscle: z.string().optional(),
      equipment: z.string().optional(),
      camera: z.enum(["true", "false"]).optional(),
      take: z.coerce.number().min(1).max(100).default(50),
      skip: z.coerce.number().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { q, muscle, equipment, camera, take, skip } = req.query as unknown as {
      q?: string; muscle?: string; equipment?: string; camera?: string; take: number; skip: number;
    };
    const where = {
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      ...(equipment ? { equipment: { has: equipment } } : {}),
      ...(camera ? { supportsCameraTracking: camera === "true" } : {}),
      ...(muscle ? { muscles: { some: { muscleGroup: { key: muscle } } } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.exercise.findMany({
        where,
        include: { muscles: { include: { muscleGroup: true } } },
        orderBy: { name: "asc" },
        take,
        skip,
      }),
      prisma.exercise.count({ where }),
    ]);
    res.json({ items, total });
  }),
);

libraryRouter.get(
  "/muscle-groups/:key/exercises",
  asyncHandler(async (req, res) => {
    const group = await prisma.muscleGroup.findUnique({ where: { key: req.params.key } });
    if (!group) throw notFound("Muscle group not found");
    const exercises = await prisma.exercise.findMany({
      where: { muscles: { some: { muscleGroupId: group.id } } },
      include: { muscles: { include: { muscleGroup: true } } },
      orderBy: { name: "asc" },
    });
    res.json({ muscleGroup: group, exercises });
  }),
);

libraryRouter.get(
  "/exercises/:slug",
  asyncHandler(async (req, res) => {
    const exercise = await prisma.exercise.findUnique({
      where: { slug: req.params.slug },
      include: { muscles: { include: { muscleGroup: true } } },
    });
    if (!exercise) throw notFound("Exercise not found");
    const alternatives = exercise.alternativeSlugs.length
      ? await prisma.exercise.findMany({ where: { slug: { in: exercise.alternativeSlugs } }, select: { slug: true, name: true, equipment: true } })
      : [];
    res.json({ ...exercise, alternatives });
  }),
);

/** Personal History Card (E2) — the user's own logged history for one exercise. */
libraryRouter.get(
  "/exercises/:slug/history",
  validate({ query: z.object({ take: z.coerce.number().max(50).default(15) }) }),
  asyncHandler(async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const take = Number((req.query as unknown as { take: number }).take);
    const exercise = await prisma.exercise.findUnique({ where: { slug: req.params.slug } });
    if (!exercise) throw notFound("Exercise not found");

    const perfs = await prisma.exercisePerformance.findMany({
      where: { exerciseId: exercise.id, session: { userId, status: "completed" } },
      include: { session: true, sets: { orderBy: { setNumber: "asc" } } },
      orderBy: { session: { startedAt: "desc" } },
      take,
    });
    const prs = await prisma.personalRecord.findMany({
      where: { userId, exerciseId: exercise.id },
      orderBy: { achievedAt: "desc" },
    });

    res.json({
      exercise: { slug: exercise.slug, name: exercise.name },
      personalRecords: prs,
      history: perfs.map((p) => ({
        date: p.session.startedAt,
        sessionId: p.sessionId,
        formScoreAvg: p.formScoreAvg,
        sets: p.sets.map((s) => ({ weightKg: s.weightKg, reps: s.reps, rpe: s.rpe, isPersonalRecord: s.isPersonalRecord })),
      })),
    });
  }),
);
