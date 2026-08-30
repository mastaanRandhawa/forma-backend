import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound, badRequest } from "../lib/errors.js";
import { generateWorkout } from "../services/plan.js";

export const workoutsRouter = Router();
workoutsRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

const exerciseInput = z.object({
  exerciseId: z.string(),
  order: z.number().int().min(0),
  targetSets: z.number().int().min(1).max(20),
  targetRepsMin: z.number().int().optional(),
  targetRepsMax: z.number().int().optional(),
  targetWeightKg: z.number().optional(),
  targetRestSec: z.number().int().optional(),
  notes: z.string().optional(),
});

const workoutInput = z.object({
  name: z.string().min(1).max(120),
  source: z.enum(["ai_generated", "manual", "template", "program"]).default("manual"),
  isTemplate: z.boolean().default(false),
  scheduledDate: z.coerce.date().optional(),
  estimatedDurationMin: z.number().int().optional(),
  targetMuscleKeys: z.array(z.string()).default([]),
  notes: z.string().optional(),
  exercises: z.array(exerciseInput).default([]),
});

workoutsRouter.get(
  "/",
  validate({ query: z.object({ template: z.enum(["true", "false"]).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const { template, from, to } = req.query as unknown as { template?: string; from?: Date; to?: Date };
    res.json(
      await prisma.workout.findMany({
        where: {
          userId: uid(req),
          ...(template ? { isTemplate: template === "true" } : {}),
          ...(from || to ? { scheduledDate: { gte: from, lte: to } } : {}),
        },
        include: { exercises: { include: { exercise: true }, orderBy: { order: "asc" } } },
        orderBy: [{ scheduledDate: "asc" }, { createdAt: "desc" }],
      }),
    );
  }),
);

workoutsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const w = await prisma.workout.findFirst({
      where: { id: req.params.id, userId: uid(req) },
      include: { exercises: { include: { exercise: true }, orderBy: { order: "asc" } } },
    });
    if (!w) throw notFound("Workout not found");
    res.json(w);
  }),
);

workoutsRouter.post(
  "/",
  validate({ body: workoutInput }),
  asyncHandler(async (req, res) => {
    const { exercises, ...data } = req.body as z.infer<typeof workoutInput>;
    const workout = await prisma.workout.create({
      data: { ...data, userId: uid(req), exercises: { create: exercises } },
      include: { exercises: { include: { exercise: true }, orderBy: { order: "asc" } } },
    });
    res.status(201).json(workout);
  }),
);

workoutsRouter.put(
  "/:id",
  validate({ body: workoutInput.partial() }),
  asyncHandler(async (req, res) => {
    const existing = await prisma.workout.findFirst({ where: { id: req.params.id, userId: uid(req) } });
    if (!existing) throw notFound("Workout not found");
    const { exercises, ...data } = req.body as Partial<z.infer<typeof workoutInput>>;
    const workout = await prisma.$transaction(async (tx) => {
      if (exercises) {
        await tx.workoutExercise.deleteMany({ where: { workoutId: existing.id } });
        await tx.workoutExercise.createMany({ data: exercises.map((e) => ({ ...e, workoutId: existing.id })) });
      }
      return tx.workout.update({
        where: { id: existing.id },
        data,
        include: { exercises: { include: { exercise: true }, orderBy: { order: "asc" } } },
      });
    });
    res.json(workout);
  }),
);

workoutsRouter.delete("/:id", asyncHandler(async (req, res) => {
  await prisma.workout.deleteMany({ where: { id: req.params.id, userId: uid(req) } });
  res.status(204).end();
}));

/** AI Workout Generator (W2). Deterministic rules engine + optional LLM phrasing. */
workoutsRouter.post(
  "/generate",
  validate({
    body: z.object({
      focus: z.array(z.string()).min(1),          // muscle keys
      durationMin: z.number().int().min(15).max(120).default(45),
      equipmentKeys: z.array(z.string()).optional(),
      difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
      scheduledDate: z.coerce.date().optional(),
      save: z.boolean().default(false),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const body = req.body as {
      focus: string[]; durationMin: number; equipmentKeys?: string[];
      difficulty?: "beginner" | "intermediate" | "advanced"; scheduledDate?: Date; save: boolean;
    };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const plan = await generateWorkout({
      focus: body.focus,
      durationMin: body.durationMin,
      equipmentKeys: body.equipmentKeys,
      difficulty: body.difficulty ?? user.experienceLevel ?? "intermediate",
    });
    if (plan.exercises.length === 0) throw badRequest("No exercises match those constraints");

    if (!body.save) return res.json(plan);

    const workout = await prisma.workout.create({
      data: {
        userId,
        name: plan.name,
        source: "ai_generated",
        scheduledDate: body.scheduledDate,
        estimatedDurationMin: body.durationMin,
        targetMuscleKeys: body.focus,
        exercises: {
          create: plan.exercises.map((e, i) => ({
            exerciseId: e.exerciseId,
            order: i,
            targetSets: e.sets,
            targetRepsMin: e.repsMin,
            targetRepsMax: e.repsMax,
            targetRestSec: e.restSec,
          })),
        },
      },
      include: { exercises: { include: { exercise: true }, orderBy: { order: "asc" } } },
    });
    res.status(201).json(workout);
  }),
);

/** Duplicate a workout (save-as-template / copy to a new date). */
workoutsRouter.post(
  "/:id/duplicate",
  validate({ body: z.object({ name: z.string().optional(), asTemplate: z.boolean().optional(), scheduledDate: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const src = await prisma.workout.findFirst({
      where: { id: req.params.id, userId },
      include: { exercises: { orderBy: { order: "asc" } } },
    });
    if (!src) throw notFound("Workout not found");
    const { name, asTemplate, scheduledDate } = req.body as { name?: string; asTemplate?: boolean; scheduledDate?: Date };
    const copy = await prisma.workout.create({
      data: {
        userId,
        name: name ?? `${src.name} (copy)`,
        source: src.source,
        isTemplate: asTemplate ?? src.isTemplate,
        scheduledDate: asTemplate ? null : scheduledDate ?? null,
        estimatedDurationMin: src.estimatedDurationMin,
        targetMuscleKeys: src.targetMuscleKeys,
        notes: src.notes,
        exercises: {
          create: src.exercises.map((e) => ({
            exerciseId: e.exerciseId, order: e.order, targetSets: e.targetSets,
            targetRepsMin: e.targetRepsMin, targetRepsMax: e.targetRepsMax,
            targetWeightKg: e.targetWeightKg, targetRestSec: e.targetRestSec,
            notes: e.notes, supersetGroup: e.supersetGroup, supersetType: e.supersetType,
          })),
        },
      },
      include: { exercises: { include: { exercise: true }, orderBy: { order: "asc" } } },
    });
    res.status(201).json(copy);
  }),
);

/** Exercise Swap Sheet (W10) — AI-ranked alternatives + "why swap" reasons. */
workoutsRouter.post(
  "/swap-suggestions",
  validate({
    body: z.object({
      exerciseSlug: z.string(),
      reason: z.enum(["equipment_unavailable", "pain", "preference", "too_easy", "too_hard"]).optional(),
      equipmentKeys: z.array(z.string()).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { exerciseSlug, reason, equipmentKeys } = req.body as {
      exerciseSlug: string; reason?: string; equipmentKeys?: string[];
    };
    const original = await prisma.exercise.findUnique({
      where: { slug: exerciseSlug },
      include: { muscles: { include: { muscleGroup: true } } },
    });
    if (!original) throw notFound("Exercise not found");

    const primaryKeys = original.muscles.filter((m) => m.role === "primary").map((m) => m.muscleGroup.key);
    let equip = equipmentKeys;
    if (!equip?.length) {
      const owned = await prisma.userEquipment.findMany({ where: { userId }, include: { equipment: true } });
      equip = owned.map((e) => e.equipment.key);
    }

    const candidates = await prisma.exercise.findMany({
      where: {
        slug: { not: exerciseSlug },
        muscles: { some: { role: "primary", muscleGroup: { key: { in: primaryKeys } } } },
        ...(equip?.length ? { equipment: { hasSome: equip } } : {}),
      },
      include: { muscles: { include: { muscleGroup: true } } },
    });

    const ranked = candidates
      .map((c) => {
        const overlap = c.muscles.filter((m) => m.role === "primary" && primaryKeys.includes(m.muscleGroup.key)).length;
        const reasons: string[] = [`Same primary muscle${overlap > 1 ? "s" : ""}`];
        if (reason === "pain") reasons.push("Lower joint-strain option");
        if (reason === "equipment_unavailable") reasons.push("Uses your available equipment");
        if (reason === "too_hard" && c.difficulty === "beginner") reasons.push("Easier progression");
        if (reason === "too_easy" && c.difficulty === "advanced") reasons.push("Harder variation");
        if (original.alternativeSlugs.includes(c.slug)) reasons.push("Recommended alternative");
        let score = overlap * 2;
        if (original.alternativeSlugs.includes(c.slug)) score += 3;
        if (reason === "too_hard" && c.difficulty === "beginner") score += 2;
        if (reason === "too_easy" && c.difficulty === "advanced") score += 2;
        return { slug: c.slug, name: c.name, equipment: c.equipment, difficulty: c.difficulty, reasons, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 6);

    res.json({ original: { slug: original.slug, name: original.name }, recommended: ranked.slice(0, 3), all: ranked });
  }),
);
