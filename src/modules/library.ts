import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { mediaKindOf, slugify, visibleTo } from "../lib/exercises.js";

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
      mine: z.enum(["true", "false"]).optional(),
      take: z.coerce.number().min(1).max(100).default(50),
      skip: z.coerce.number().min(0).default(0),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { q, muscle, equipment, camera, mine, take, skip } = req.query as unknown as {
      q?: string; muscle?: string; equipment?: string; camera?: string; mine?: string; take: number; skip: number;
    };
    const userId = (req as AuthedRequest).userId;
    const where = {
      ...(mine === "true" ? { ownerUserId: userId } : visibleTo(userId)),
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
      where: { muscles: { some: { muscleGroupId: group.id } }, ...visibleTo((req as AuthedRequest).userId) },
      include: { muscles: { include: { muscleGroup: true } } },
      orderBy: { name: "asc" },
    });
    res.json({ muscleGroup: group, exercises });
  }),
);

libraryRouter.get(
  "/exercises/:slug",
  asyncHandler(async (req, res) => {
    const exercise = await prisma.exercise.findFirst({
      where: { slug: req.params.slug, ...visibleTo((req as AuthedRequest).userId) },
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
    const exercise = await prisma.exercise.findFirst({ where: { slug: req.params.slug, ...visibleTo(userId) } });
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

// ── custom exercises ────────────────────────────────────────────────────────
// Private to their owner. Media is a link to the owner's own photo, GIF or short
// video (https only): files themselves are not stored by this API.

const MAX_CUSTOM = 200;
const httpsUrl = z
  .string()
  .max(500)
  .url()
  .refine((u) => u.startsWith("https://"), "Use an https link");

const customFields = {
  name: z.string().trim().min(2).max(80),
  category: z.enum(["push", "pull", "legs", "core", "cardio", "mobility", "other"]),
  equipment: z.array(z.string().min(1).max(40)).max(10),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  trackingType: z.enum(["reps", "time", "cardio"]),
  instructions: z.array(z.string().min(1).max(500)).max(20),
  primaryMuscleKeys: z.array(z.string()).max(6),
  secondaryMuscleKeys: z.array(z.string()).max(8),
  mediaUrl: httpsUrl.nullable(),
  mediaKind: z.enum(["image", "gif", "video"]),
  guideUrl: httpsUrl.nullable(),
};
const createCustom = z.object({ ...customFields }).partial().required({ name: true });
const updateCustom = z.object({ ...customFields }).partial().refine((b) => Object.keys(b).length > 0, "Nothing to change");

type CustomBody = z.infer<typeof createCustom>;

async function muscleRows(primary: string[] = [], secondary: string[] = []) {
  const keys = [...new Set([...primary, ...secondary])];
  if (!keys.length) return [];
  const groups = await prisma.muscleGroup.findMany({ where: { key: { in: keys } } });
  const byKey = new Map(groups.map((g) => [g.key, g.id]));
  const unknown = keys.filter((k) => !byKey.has(k));
  if (unknown.length) throw badRequest(`Unknown muscle: ${unknown.join(", ")}`);
  return [
    ...primary.map((k) => ({ muscleGroupId: byKey.get(k)!, role: "primary" as const, weight: 1 })),
    ...secondary.filter((k) => !primary.includes(k)).map((k) => ({ muscleGroupId: byKey.get(k)!, role: "secondary" as const, weight: 0.5 })),
  ];
}

const withMuscles = { muscles: { include: { muscleGroup: true } } };

libraryRouter.post(
  "/exercises",
  validate({ body: createCustom }),
  asyncHandler(async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const b = req.body as CustomBody;
    if ((await prisma.exercise.count({ where: { ownerUserId: userId } })) >= MAX_CUSTOM) throw badRequest(`You can keep up to ${MAX_CUSTOM} custom exercises`);
    const muscles = await muscleRows(b.primaryMuscleKeys, b.secondaryMuscleKeys);

    const base = `u-${userId.slice(-6)}-${slugify(b.name)}`;
    let slug = base;
    for (let n = 2; await prisma.exercise.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${base}-${n}`;

    const exercise = await prisma.exercise.create({
      data: {
        slug,
        name: b.name,
        category: b.category ?? "other",
        equipment: b.equipment ?? [],
        difficulty: b.difficulty ?? "intermediate",
        trackingType: b.trackingType ?? "reps",
        instructions: b.instructions ?? [],
        source: "custom",
        ownerUserId: userId,
        mediaUrl: b.mediaUrl ?? null,
        mediaKind: b.mediaUrl ? (b.mediaKind ?? mediaKindOf(b.mediaUrl)) : null,
        guideUrl: b.guideUrl ?? null,
        muscles: { create: muscles },
      },
      include: withMuscles,
    });
    res.status(201).json(exercise);
  }),
);

libraryRouter.patch(
  "/exercises/:id",
  validate({ body: updateCustom }),
  asyncHandler(async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const own = await prisma.exercise.findFirst({ where: { id: req.params.id, ownerUserId: userId } });
    if (!own) throw notFound("Custom exercise not found"); // shared exercises can't be edited
    const b = req.body as Partial<CustomBody>;
    const { primaryMuscleKeys, secondaryMuscleKeys, mediaUrl, mediaKind, ...rest } = b;
    const muscles = primaryMuscleKeys || secondaryMuscleKeys ? await muscleRows(primaryMuscleKeys, secondaryMuscleKeys) : null;
    const exercise = await prisma.$transaction(async (tx) => {
      if (muscles) {
        await tx.exerciseMuscle.deleteMany({ where: { exerciseId: own.id } });
        if (muscles.length) await tx.exerciseMuscle.createMany({ data: muscles.map((m) => ({ ...m, exerciseId: own.id })) });
      }
      return tx.exercise.update({
        where: { id: own.id },
        data: {
          ...rest,
          ...(mediaUrl !== undefined ? { mediaUrl, mediaKind: mediaUrl ? (mediaKind ?? mediaKindOf(mediaUrl)) : null } : mediaKind ? { mediaKind } : {}),
        },
        include: withMuscles,
      });
    });
    res.json(exercise);
  }),
);

libraryRouter.delete(
  "/exercises/:id",
  asyncHandler(async (req, res) => {
    const userId = (req as AuthedRequest).userId;
    const own = await prisma.exercise.findFirst({ where: { id: req.params.id, ownerUserId: userId } });
    if (!own) throw notFound("Custom exercise not found");
    const [used, planned] = await Promise.all([
      prisma.exercisePerformance.count({ where: { exerciseId: own.id } }),
      prisma.workoutExercise.count({ where: { exerciseId: own.id } }),
    ]);
    if (used || planned) throw conflict("This exercise is used in your workouts. Remove it from them first.");
    await prisma.exercise.delete({ where: { id: own.id } });
    res.status(204).end();
  }),
);
