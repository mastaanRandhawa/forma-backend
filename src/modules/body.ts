import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound } from "../lib/errors.js";

export const bodyRouter = Router();
bodyRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

/** Aggregated muscle activation over a window — feeds the 3D muscle map (B1/B2). */
bodyRouter.get(
  "/muscle-map",
  validate({ query: z.object({ range: z.enum(["today", "week", "month"]).default("week") }) }),
  asyncHandler(async (req, res) => {
    const range = (req.query as { range: "today" | "week" | "month" }).range;
    const since =
      range === "today"
        ? new Date(new Date().setHours(0, 0, 0, 0))
        : new Date(Date.now() - (range === "week" ? 7 : 30) * 86_400_000);

    const rows = await prisma.muscleActivation.findMany({
      where: { session: { userId: uid(req), startedAt: { gte: since }, status: "completed" } },
      include: { muscleGroup: true },
    });

    const map = new Map<string, { key: string; name: string; region: string; score: number; role: string }>();
    for (const r of rows) {
      const prev = map.get(r.muscleGroupId);
      const score = Math.min(1, (prev?.score ?? 0) + r.activationScore * (range === "today" ? 1 : 0.6));
      map.set(r.muscleGroupId, {
        key: r.muscleGroup.key,
        name: r.muscleGroup.plainName,
        region: r.muscleGroup.region,
        score: Math.round(score * 100) / 100,
        role: prev && prev.role === "primary" ? prev.role : r.role,
      });
    }
    res.json({ range, muscles: [...map.values()].sort((a, b) => b.score - a.score) });
  }),
);

/** Muscle balance / undertrained report (B4). */
bodyRouter.get(
  "/balance",
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - 28 * 86_400_000);
    const [groups, rows] = await Promise.all([
      prisma.muscleGroup.findMany(),
      prisma.muscleActivation.findMany({
        where: { session: { userId: uid(req), startedAt: { gte: since }, status: "completed" } },
        include: { muscleGroup: true },
      }),
    ]);
    const totals = new Map<string, number>();
    for (const r of rows) totals.set(r.muscleGroup.key, (totals.get(r.muscleGroup.key) ?? 0) + r.activationScore);
    const ranked = groups
      .map((g) => ({ key: g.key, name: g.plainName, region: g.region, load: Math.round((totals.get(g.key) ?? 0) * 10) / 10 }))
      .sort((a, b) => b.load - a.load);
    res.json({
      mostTrained: ranked.slice(0, 5),
      undertrained: ranked.filter((r) => r.load < 1).slice(0, 5),
    });
  }),
);

/** Muscle Detail Sheet (B3) — name, recent exercises, activity series, volume. */
bodyRouter.get(
  "/muscle/:key",
  validate({ query: z.object({ days: z.coerce.number().default(28) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const days = Number((req.query as unknown as { days: number }).days);
    const since = new Date(Date.now() - days * 86_400_000);
    const group = await prisma.muscleGroup.findUnique({ where: { key: req.params.key } });
    if (!group) throw notFound("Muscle group not found");

    const [activations, exercises] = await Promise.all([
      prisma.muscleActivation.findMany({
        where: { muscleGroupId: group.id, session: { userId, startedAt: { gte: since }, status: "completed" } },
        include: { session: true },
        orderBy: { session: { startedAt: "asc" } },
      }),
      prisma.exercise.findMany({
        where: { muscles: { some: { muscleGroupId: group.id } } },
        include: { muscles: { where: { muscleGroupId: group.id } } },
      }),
    ]);

    // recent exercises that actually hit this muscle, most recent first
    const recentPerf = await prisma.exercisePerformance.findMany({
      where: {
        exercise: { muscles: { some: { muscleGroupId: group.id } } },
        session: { userId, status: "completed", startedAt: { gte: since } },
      },
      include: { exercise: true, session: true, sets: true },
      orderBy: { session: { startedAt: "desc" } },
      take: 10,
    });

    const byDay = new Map<string, number>();
    for (const a of activations) {
      const d = a.session.startedAt.toISOString().slice(0, 10);
      byDay.set(d, Math.max(byDay.get(d) ?? 0, a.activationScore));
    }

    res.json({
      key: group.key,
      name: group.plainName,
      anatomicalName: group.name,
      region: group.region,
      sessionsHit: byDay.size,
      totalLoad: Math.round(activations.reduce((s, a) => s + a.activationScore, 0) * 10) / 10,
      activitySeries: [...byDay.entries()].map(([date, score]) => ({ date, score })),
      recentExercises: recentPerf.map((p) => ({
        name: p.exercise.name,
        slug: p.exercise.slug,
        date: p.session.startedAt,
        sets: p.sets.length,
        topSet: p.sets.reduce<{ weightKg: number | null; reps: number | null }>(
          (best, s) => ((s.weightKg ?? 0) > (best.weightKg ?? 0) ? { weightKg: s.weightKg, reps: s.reps } : best),
          { weightKg: null, reps: null },
        ),
      })),
      allExercises: exercises.map((e) => ({ name: e.name, slug: e.slug, role: e.muscles[0]?.role })),
    });
  }),
);
