import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound } from "../lib/errors.js";
import { generateWorkout } from "../services/plan.js";

export const programsRouter = Router();
programsRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

const SPLITS: Record<string, { label: string; focus: string[] }[]> = {
  full_body: [
    { label: "Full Body A", focus: ["quads", "chest", "back"] },
    { label: "Full Body B", focus: ["hamstrings", "shoulders", "lats"] },
    { label: "Full Body C", focus: ["glutes", "chest", "back"] },
  ],
  upper_lower: [
    { label: "Upper A", focus: ["chest", "back", "shoulders"] },
    { label: "Lower A", focus: ["quads", "hamstrings", "glutes"] },
    { label: "Upper B", focus: ["lats", "chest", "biceps"] },
    { label: "Lower B", focus: ["hamstrings", "glutes", "calves"] },
  ],
  ppl: [
    { label: "Push", focus: ["chest", "shoulders", "triceps"] },
    { label: "Pull", focus: ["back", "lats", "biceps"] },
    { label: "Legs", focus: ["quads", "hamstrings", "glutes"] },
  ],
};

programsRouter.get("/", asyncHandler(async (req, res) => {
  res.json(
    await prisma.trainingProgram.findMany({
      where: { userId: uid(req) },
      include: { days: { include: { workout: true }, orderBy: [{ weekIndex: "asc" }, { dayIndex: "asc" }] } },
      orderBy: { createdAt: "desc" },
    }),
  );
}));

programsRouter.get("/:id", asyncHandler(async (req, res) => {
  const program = await prisma.trainingProgram.findFirst({
    where: { id: req.params.id, userId: uid(req) },
    include: {
      days: {
        include: { workout: { include: { exercises: { include: { exercise: true }, orderBy: { order: "asc" } } } } },
        orderBy: [{ weekIndex: "asc" }, { dayIndex: "asc" }],
      },
    },
  });
  if (!program) throw notFound("Program not found");
  res.json(program);
}));

programsRouter.get(
  "/:id/week/:n",
  asyncHandler(async (req, res) => {
    const program = await prisma.trainingProgram.findFirst({ where: { id: req.params.id, userId: uid(req) } });
    if (!program) throw notFound("Program not found");
    res.json(
      await prisma.programDay.findMany({
        where: { programId: program.id, weekIndex: Number(req.params.n) },
        include: { workout: { include: { exercises: { include: { exercise: true }, orderBy: { order: "asc" } } } } },
        orderBy: { dayIndex: "asc" },
      }),
    );
  }),
);

/** AI program generator (O15) — builds week 1 in full, later weeks reference the
 *  same day templates (progressive overload is applied at session time). */
programsRouter.post(
  "/generate",
  validate({
    body: z.object({
      split: z.enum(["full_body", "upper_lower", "ppl"]).default("upper_lower"),
      daysPerWeek: z.number().int().min(2).max(6).default(4),
      durationWeeks: z.number().int().min(2).max(16).default(8),
      sessionLengthMin: z.number().int().min(20).max(120).default(45),
      equipmentKeys: z.array(z.string()).optional(),
      name: z.string().optional(),
      activate: z.boolean().default(true),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const b = req.body as {
      split: keyof typeof SPLITS; daysPerWeek: number; durationWeeks: number;
      sessionLengthMin: number; equipmentKeys?: string[]; name?: string; activate: boolean;
    };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const difficulty = user.experienceLevel ?? "intermediate";
    const templateDays = SPLITS[b.split]!.slice(0, b.daysPerWeek);

    // build one Workout per split day
    const dayWorkouts = await Promise.all(
      templateDays.map(async (d) => {
        const plan = await generateWorkout({
          focus: d.focus,
          durationMin: b.sessionLengthMin,
          equipmentKeys: b.equipmentKeys,
          difficulty,
        });
        return prisma.workout.create({
          data: {
            userId,
            name: d.label,
            source: "program",
            isTemplate: true,
            targetMuscleKeys: d.focus,
            estimatedDurationMin: b.sessionLengthMin,
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
        });
      }),
    );

    if (b.activate) await prisma.trainingProgram.updateMany({ where: { userId }, data: { active: false } });

    const program = await prisma.trainingProgram.create({
      data: {
        userId,
        name: b.name ?? `${b.split.replace(/_/g, " ")} · ${b.durationWeeks} weeks`,
        structureType: "split_defined",
        durationWeeks: b.durationWeeks,
        generatedBy: "ai_generated",
        active: b.activate,
        days: {
          create: Array.from({ length: b.durationWeeks }).flatMap((_, week) =>
            templateDays.map((_, di) => ({
              weekIndex: week,
              dayIndex: di,
              label: templateDays[di]!.label,
              workoutId: dayWorkouts[di]!.id,
            })),
          ),
        },
      },
      include: { days: { include: { workout: true } } },
    });
    res.status(201).json(program);
  }),
);

programsRouter.post("/:id/activate", asyncHandler(async (req, res) => {
  const userId = uid(req);
  const program = await prisma.trainingProgram.findFirst({ where: { id: req.params.id, userId } });
  if (!program) throw notFound("Program not found");
  await prisma.$transaction([
    prisma.trainingProgram.updateMany({ where: { userId }, data: { active: false } }),
    prisma.trainingProgram.update({ where: { id: program.id }, data: { active: true } }),
  ]);
  res.json({ ok: true });
}));

/** Schedule a program's week onto real calendar dates (W12). */
programsRouter.post(
  "/:id/schedule",
  validate({ body: z.object({ weekIndex: z.number().int().min(0), startDate: z.coerce.date() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const program = await prisma.trainingProgram.findFirst({ where: { id: req.params.id, userId } });
    if (!program) throw notFound("Program not found");
    const { weekIndex, startDate } = req.body as { weekIndex: number; startDate: Date };
    const days = await prisma.programDay.findMany({
      where: { programId: program.id, weekIndex },
      include: { workout: { include: { exercises: true } } },
      orderBy: { dayIndex: "asc" },
    });
    const spacing = Math.floor(7 / Math.max(1, days.length));
    const created = [];
    for (const [i, d] of days.entries()) {
      if (!d.workout) continue;
      const date = new Date(startDate.getTime() + i * spacing * 86_400_000);
      created.push(
        await prisma.workout.create({
          data: {
            userId,
            name: d.workout.name,
            source: "program",
            scheduledDate: date,
            targetMuscleKeys: d.workout.targetMuscleKeys,
            estimatedDurationMin: d.workout.estimatedDurationMin,
            exercises: {
              create: d.workout.exercises.map((e) => ({
                exerciseId: e.exerciseId,
                order: e.order,
                targetSets: e.targetSets,
                targetRepsMin: e.targetRepsMin,
                targetRepsMax: e.targetRepsMax,
                targetRestSec: e.targetRestSec,
              })),
            },
          },
        }),
      );
    }
    res.status(201).json({ scheduled: created.length, workouts: created });
  }),
);

programsRouter.delete("/:id", asyncHandler(async (req, res) => {
  await prisma.trainingProgram.deleteMany({ where: { id: req.params.id, userId: uid(req) } });
  res.status(204).end();
}));
