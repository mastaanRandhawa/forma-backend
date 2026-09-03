import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound } from "../lib/errors.js";
import { epley1RM } from "../services/session.js";
import { computeReadiness, readinessFactors } from "../services/readiness.js";
import { currentStreak } from "../services/achievements.js";
import { computeTrainingLoad } from "../services/training-load.js";
import { analyzePatterns } from "../services/patterns.js";

export const progressRouter = Router();
progressRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

// ── generic time-series metrics ─────────────────────────────────────────────
progressRouter.get(
  "/metrics",
  validate({ query: z.object({ type: z.string().optional(), key: z.string().optional(), days: z.coerce.number().default(90) }) }),
  asyncHandler(async (req, res) => {
    const { type, key, days } = req.query as unknown as { type?: string; key?: string; days: number };
    res.json(
      await prisma.progressMetric.findMany({
        where: {
          userId: uid(req),
          ...(type ? { metricType: type as never } : {}),
          ...(key ? { key } : {}),
          recordedAt: { gte: new Date(Date.now() - days * 86_400_000) },
        },
        orderBy: { recordedAt: "asc" },
      }),
    );
  }),
);

progressRouter.post(
  "/metrics",
  validate({
    body: z.object({
      metricType: z.enum([
        "bodyweight", "measurement", "form_score_aggregate", "volume_aggregate",
        "readiness", "sleep", "hrv", "resting_hr", "steps", "protein", "calories",
      ]),
      key: z.string().optional(),
      value: z.number(),
      unit: z.string(),
      recordedAt: z.coerce.date().optional(),
      source: z.enum(["manual_entry", "health_sync", "computed"]).default("manual_entry"),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.progressMetric.create({ data: { ...req.body, userId: uid(req) } }));
  }),
);

// ── manual recovery check-in (§3.1) → readiness input ──────────────────────
progressRouter.get("/checkin", asyncHandler(async (req, res) => {
  res.json(
    await prisma.recoveryCheckin.findMany({
      where: { userId: uid(req) },
      orderBy: { recordedAt: "desc" },
      take: 30,
    }),
  );
}));

progressRouter.post(
  "/checkin",
  validate({
    body: z.object({
      sleepH: z.number().min(0).max(24).optional(),
      sleepQuality: z.number().int().min(1).max(5).optional(),
      fatigue: z.number().int().min(1).max(5).optional(),
      soreness: z.number().int().min(1).max(5).optional(),
      note: z.string().max(500).optional(),
      recordedAt: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const body = req.body as {
      sleepH?: number; sleepQuality?: number; fatigue?: number; soreness?: number; note?: string; recordedAt?: Date;
    };
    const checkin = await prisma.recoveryCheckin.create({ data: { ...body, userId } });
    res.status(201).json({ checkin, readiness: await readinessFactors(userId) });
  }),
);

// ── nutrition daily log (§5) ───────────────────────────────────────────────
const todayLocal = () => new Date().toISOString().slice(0, 10);

interface NutritionTotals {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}

function nutritionTotals(
  entries: { calories: number | null; proteinG: number | null; carbsG: number | null; fatG: number | null }[],
): NutritionTotals {
  return entries.reduce<NutritionTotals>(
    (t, e) => ({
      calories: t.calories + (e.calories ?? 0),
      proteinG: Math.round((t.proteinG + (e.proteinG ?? 0)) * 10) / 10,
      carbsG: Math.round((t.carbsG + (e.carbsG ?? 0)) * 10) / 10,
      fatG: Math.round((t.fatG + (e.fatG ?? 0)) * 10) / 10,
    }),
    { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 },
  );
}

progressRouter.get(
  "/nutrition",
  validate({ query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) }),
  asyncHandler(async (req, res) => {
    const date = (req.query as { date?: string }).date ?? todayLocal();
    const entries = await prisma.nutritionEntry.findMany({
      where: { userId: uid(req), date },
      orderBy: { createdAt: "asc" },
    });
    res.json({ date, entries, totals: nutritionTotals(entries) });
  }),
);

/** Last `days` of daily totals — for the nutrition trend on Progress. */
progressRouter.get(
  "/nutrition/summary",
  validate({ query: z.object({ days: z.coerce.number().min(1).max(90).default(14) }) }),
  asyncHandler(async (req, res) => {
    const days = Number((req.query as unknown as { days: number }).days);
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const rows = await prisma.nutritionEntry.findMany({
      where: { userId: uid(req), date: { gte: since } },
      orderBy: { date: "asc" },
    });
    const byDay = new Map<string, typeof rows>();
    for (const r of rows) byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
    res.json({
      days: [...byDay.entries()].map(([date, es]) => ({ date, ...nutritionTotals(es) })),
    });
  }),
);

progressRouter.post(
  "/nutrition",
  validate({
    body: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      label: z.string().max(120).optional(),
      calories: z.number().int().min(0).max(20000).optional(),
      proteinG: z.number().min(0).max(2000).optional(),
      carbsG: z.number().min(0).max(2000).optional(),
      fatG: z.number().min(0).max(2000).optional(),
      note: z.string().max(500).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const body = req.body as Record<string, unknown>;
    const entry = await prisma.nutritionEntry.create({
      data: { ...body, date: (body.date as string) ?? todayLocal(), userId } as never,
    });
    // keep the "protein today" daily goal in step, if the user has one
    if (entry.proteinG) {
      const goal = await prisma.goal.findFirst({ where: { userId, key: "protein", active: true } });
      if (goal) {
        const periodKey = entry.date;
        const cur = await prisma.goalEntry.findUnique({ where: { goalId_periodKey: { goalId: goal.id, periodKey } } });
        const value = (cur?.value ?? 0) + entry.proteinG;
        await prisma.goalEntry.upsert({
          where: { goalId_periodKey: { goalId: goal.id, periodKey } },
          update: { value, completed: value >= goal.target },
          create: { goalId: goal.id, periodKey, value, completed: value >= goal.target },
        });
      }
    }
    const dayEntries = await prisma.nutritionEntry.findMany({ where: { userId, date: entry.date } });
    res.status(201).json({ entry, totals: nutritionTotals(dayEntries) });
  }),
);

progressRouter.delete("/nutrition/:id", asyncHandler(async (req, res) => {
  await prisma.nutritionEntry.deleteMany({ where: { id: req.params.id, userId: uid(req) } });
  res.status(204).end();
}));

// ── body measurements ──────────────────────────────────────────────────────
progressRouter.get("/measurements", asyncHandler(async (req, res) => {
  res.json(await prisma.bodyMeasurement.findMany({ where: { userId: uid(req) }, orderBy: { recordedAt: "asc" } }));
}));

progressRouter.post(
  "/measurements",
  validate({
    body: z.object({
      weightKg: z.number().positive().optional(),
      bodyFatPct: z.number().optional(),
      chestCm: z.number().optional(),
      waistCm: z.number().optional(),
      hipsCm: z.number().optional(),
      thighCm: z.number().optional(),
      armCm: z.number().optional(),
      recordedAt: z.coerce.date().optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const row = await prisma.bodyMeasurement.create({ data: { ...req.body, userId } });
    if (row.weightKg) await prisma.user.update({ where: { id: userId }, data: { weightKg: row.weightKg } });
    res.status(201).json(row);
  }),
);

// ── personal records (P7) ──────────────────────────────────────────────────
progressRouter.get("/personal-records", asyncHandler(async (req, res) => {
  res.json(
    await prisma.personalRecord.findMany({
      where: { userId: uid(req) },
      include: { exercise: true },
      orderBy: { achievedAt: "desc" },
    }),
  );
}));

// ── strength progression per lift (P2) ─────────────────────────────────────
progressRouter.get(
  "/strength/:slug",
  validate({ query: z.object({ days: z.coerce.number().default(180) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const since = new Date(Date.now() - Number((req.query as unknown as { days: number }).days) * 86_400_000);
    const sets = await prisma.exerciseSet.findMany({
      where: {
        isWarmup: false,
        weightKg: { not: null },
        reps: { not: null },
        performance: { exercise: { slug: req.params.slug }, session: { userId, startedAt: { gte: since }, status: "completed" } },
      },
      include: { performance: { include: { session: true } } },
      orderBy: { performance: { session: { startedAt: "asc" } } },
    });

    const byDay = new Map<string, number>();
    for (const s of sets) {
      const day = s.performance.session.startedAt.toISOString().slice(0, 10);
      const e1 = epley1RM(s.weightKg ?? 0, s.reps ?? 0);
      byDay.set(day, Math.max(byDay.get(day) ?? 0, e1));
    }
    res.json({ slug: req.params.slug, series: [...byDay.entries()].map(([date, e1rm]) => ({ date, e1rm })) });
  }),
);

// ── AI overview summary (P1) ───────────────────────────────────────────────
progressRouter.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const since = new Date(Date.now() - 56 * 86_400_000);
    const [sessions, prs] = await Promise.all([
      prisma.workoutSession.findMany({ where: { userId, status: "completed", startedAt: { gte: since } } }),
      prisma.personalRecord.count({ where: { userId, achievedAt: { gte: since } } }),
    ]);
    const volume = sessions.reduce((a, s) => a + s.totalVolumeKg, 0);
    const summary =
      sessions.length === 0
        ? "No completed sessions yet. Finish your first workout and I'll start tracking trends."
        : `Over the last 8 weeks you trained ${sessions.length} times, moved ${Math.round(volume).toLocaleString()} kg total, and set ${prs} personal record${prs === 1 ? "" : "s"}. Consistency is your strongest signal right now.`;
    res.json({ summary, sessions: sessions.length, totalVolumeKg: Math.round(volume), personalRecords: prs });
  }),
);

// ── readiness detail (H3) ──────────────────────────────────────────────────
progressRouter.get(
  "/readiness",
  asyncHandler(async (req, res) => {
    res.json(await readinessFactors(uid(req)));
  }),
);

// ── volume & consistency detail (P3) ───────────────────────────────────────
progressRouter.get(
  "/consistency",
  validate({ query: z.object({ weeks: z.coerce.number().min(1).max(52).default(13) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const weeks = Number((req.query as unknown as { weeks: number }).weeks);
    const since = new Date(Date.now() - weeks * 7 * 86_400_000);
    const [sessions, user] = await Promise.all([
      prisma.workoutSession.findMany({
        where: { userId, status: "completed", startedAt: { gte: since } },
        select: { startedAt: true, totalVolumeKg: true },
      }),
      prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    ]);

    const byWeek = new Map<string, { sessions: number; volumeKg: number }>();
    for (const s of sessions) {
      const wk = weekKey(s.startedAt);
      const cur = byWeek.get(wk) ?? { sessions: 0, volumeKg: 0 };
      cur.sessions += 1;
      cur.volumeKg += s.totalVolumeKg;
      byWeek.set(wk, cur);
    }
    const series = [...byWeek.entries()]
      .map(([week, v]) => ({ week, sessions: v.sessions, volumeKg: Math.round(v.volumeKg) }))
      .sort((a, b) => a.week.localeCompare(b.week));

    const dayCounts = new Map<string, number>();
    for (const s of sessions) {
      const d = s.startedAt.toISOString().slice(0, 10);
      dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
    }
    const days = new Set(dayCounts.keys());
    const target = user.trainingFrequencyTarget ?? 4;
    const adherence = series.length ? series.reduce((a, w) => a + Math.min(1, w.sessions / target), 0) / series.length : 0;

    // per-day grid for the last `weeks` weeks (P3 heatmap) — server-side now that
    // sessions persist (§5); the web previously derived this from localStore.
    const gridStart = new Date(Date.now() - weeks * 7 * 86_400_000);
    gridStart.setUTCHours(0, 0, 0, 0);
    const grid: { date: string; sessions: number }[] = [];
    for (let t = gridStart.getTime(); t <= Date.now(); t += 86_400_000) {
      const key = new Date(t).toISOString().slice(0, 10);
      grid.push({ date: key, sessions: dayCounts.get(key) ?? 0 });
    }

    res.json({
      target,
      currentStreak: currentStreak(days),
      adherence: Math.round(adherence * 100) / 100,
      weeks: series,
      days: grid,
    });
  }),
);

// ── form-score trends (P6) ─────────────────────────────────────────────────
progressRouter.get(
  "/form-trends",
  validate({ query: z.object({ slug: z.string().optional(), days: z.coerce.number().default(90) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { slug, days } = req.query as unknown as { slug?: string; days: number };
    const since = new Date(Date.now() - Number(days) * 86_400_000);
    const sets = await prisma.exerciseSet.findMany({
      where: {
        formScore: { not: null },
        performance: {
          ...(slug ? { exercise: { slug } } : {}),
          session: { userId, status: "completed", startedAt: { gte: since } },
        },
      },
      include: { performance: { include: { session: true, exercise: true } } },
      orderBy: { performance: { session: { startedAt: "asc" } } },
    });

    const byDay = new Map<string, number[]>();
    for (const s of sets) {
      const d = s.performance.session.startedAt.toISOString().slice(0, 10);
      const arr = byDay.get(d) ?? [];
      arr.push(s.formScore!);
      byDay.set(d, arr);
    }
    const series = [...byDay.entries()].map(([date, v]) => ({
      date,
      formScore: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10,
    }));
    res.json({ slug: slug ?? null, samples: sets.length, series });
  }),
);

// ── progress photos (P5) ───────────────────────────────────────────────────
progressRouter.get("/photos", asyncHandler(async (req, res) => {
  res.json(await prisma.progressPhoto.findMany({ where: { userId: uid(req) }, orderBy: { takenAt: "desc" } }));
}));

/**
 * Register a photo the client has encrypted and is about to upload. Returns the
 * object key + a (stubbed) presigned PUT URL. Real impl: S3/R2 presign here.
 */
progressRouter.post(
  "/photos",
  validate({ body: z.object({ poseTag: z.enum(["front", "side", "back"]).default("front"), takenAt: z.coerce.date().optional(), contentType: z.string().default("image/jpeg") }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { poseTag, takenAt } = req.body as { poseTag: "front" | "side" | "back"; takenAt?: Date };
    const assetRef = `progress-photos/${userId}/${Date.now()}-${poseTag}.enc`;
    const photo = await prisma.progressPhoto.create({ data: { userId, assetRef, poseTag, takenAt } });
    res.status(201).json({
      photo,
      upload: { method: "PUT", url: `https://storage.local/stub/${assetRef}`, headers: { "content-type": "application/octet-stream" } },
    });
  }),
);

progressRouter.delete("/photos/:id", asyncHandler(async (req, res) => {
  await prisma.progressPhoto.deleteMany({ where: { id: req.params.id, userId: uid(req) } });
  res.status(204).end();
}));

progressRouter.get(
  "/photos/compare",
  validate({ query: z.object({ a: z.string(), b: z.string() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { a, b } = req.query as unknown as { a: string; b: string };
    const photos = await prisma.progressPhoto.findMany({ where: { userId, id: { in: [a, b] } } });
    if (photos.length !== 2) throw notFound("Both photo ids must exist");
    res.json({ a: photos.find((p) => p.id === a), b: photos.find((p) => p.id === b) });
  }),
);

// ── full report export (P8) ────────────────────────────────────────────────
progressRouter.get(
  "/report",
  validate({ query: z.object({ days: z.coerce.number().default(90) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const days = Number((req.query as unknown as { days: number }).days);
    const since = new Date(Date.now() - days * 86_400_000);
    const [user, sessions, prs, measurements, activations] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, fitnessGoal: true, experienceLevel: true } }),
      prisma.workoutSession.findMany({ where: { userId, status: "completed", startedAt: { gte: since } }, include: { performances: { include: { exercise: true } } } }),
      prisma.personalRecord.findMany({ where: { userId, achievedAt: { gte: since } }, include: { exercise: true } }),
      prisma.bodyMeasurement.findMany({ where: { userId, recordedAt: { gte: since } }, orderBy: { recordedAt: "asc" } }),
      prisma.muscleActivation.findMany({ where: { session: { userId, startedAt: { gte: since }, status: "completed" } }, include: { muscleGroup: true } }),
    ]);
    const volume = sessions.reduce((a, s) => a + s.totalVolumeKg, 0);
    const muscleLoad = new Map<string, number>();
    for (const a of activations) muscleLoad.set(a.muscleGroup.plainName, (muscleLoad.get(a.muscleGroup.plainName) ?? 0) + a.activationScore);

    res.json({
      generatedAt: new Date().toISOString(),
      window: { days, from: since.toISOString() },
      user,
      totals: { sessions: sessions.length, totalVolumeKg: Math.round(volume), personalRecords: prs.length, avgDurationMin: sessions.length ? Math.round(sessions.reduce((a, s) => a + s.durationSeconds, 0) / sessions.length / 60) : 0 },
      personalRecords: prs.map((p) => ({ lift: p.exercise.name, type: p.recordType, value: p.value, previousValue: p.previousValue, achievedAt: p.achievedAt })),
      bodyMeasurements: measurements,
      muscleLoad: [...muscleLoad.entries()].map(([name, load]) => ({ name, load: Math.round(load * 10) / 10 })).sort((a, b) => b.load - a.load),
    });
  }),
);

// ── training load (CTL/ATL) ──────────────────────────────────────────────────
progressRouter.get(
  "/training-load",
  asyncHandler(async (req, res) => {
    res.json(await computeTrainingLoad(uid(req)));
  }),
);

// ── nutrition–training correlation ───────────────────────────────────────────
progressRouter.get(
  "/nutrition-correlation",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const since = new Date(Date.now() - 90 * 86400_000);

    const [sessions, foodLogs] = await Promise.all([
      prisma.workoutSession.findMany({
        where: { userId, status: "completed", startedAt: { gte: since } },
        select: { startedAt: true, totalVolumeKg: true },
        orderBy: { startedAt: "asc" },
      }),
      prisma.foodLog.findMany({
        where: { userId, loggedAt: { gte: since } },
        select: { date: true, protein: true, calories: true },
      }),
    ]);

    if (sessions.length < 10 || foodLogs.length < 10) {
      return res.json({ insufficient_data: true, sessionsNeeded: Math.max(0, 10 - sessions.length), logsNeeded: Math.max(0, 10 - foodLogs.length) });
    }

    // bucket by ISO week
    const proteinByWeek: Record<string, number[]> = {};
    for (const l of foodLogs) {
      const d = new Date(l.date);
      const k = weekKey(d);
      (proteinByWeek[k] ??= []).push(l.protein);
    }
    const volByWeek: Record<string, number> = {};
    for (const s of sessions) {
      const k = weekKey(s.startedAt);
      volByWeek[k] = (volByWeek[k] ?? 0) + s.totalVolumeKg;
    }

    const weeks = Object.keys(volByWeek).sort();
    const pairs = weeks
      .filter((w) => proteinByWeek[w])
      .map((w) => ({
        week: w,
        avgProteinG: Math.round(proteinByWeek[w].reduce((a, b) => a + b, 0) / proteinByWeek[w].length),
        totalVolumeKg: Math.round(volByWeek[w]),
      }));

    // Pearson correlation
    const n = pairs.length;
    if (n < 3) return res.json({ insufficient_data: true });
    const xArr = pairs.map((p) => p.avgProteinG);
    const yArr = pairs.map((p) => p.totalVolumeKg);
    const xMean = xArr.reduce((a, b) => a + b, 0) / n;
    const yMean = yArr.reduce((a, b) => a + b, 0) / n;
    const num = xArr.reduce((s, x, i) => s + (x - xMean) * (yArr[i] - yMean), 0);
    const den = Math.sqrt(
      xArr.reduce((s, x) => s + (x - xMean) ** 2, 0) *
      yArr.reduce((s, y) => s + (y - yMean) ** 2, 0),
    );
    const r = den === 0 ? 0 : num / den;

    res.json({
      correlation: Math.round(r * 100) / 100,
      interpretation: r > 0.4 ? "strong positive" : r > 0.1 ? "weak positive" : r < -0.1 ? "inverse" : "no clear correlation",
      weeks: pairs,
    });
  }),
);

// ── behavioral pattern insights ───────────────────────────────────────────────
progressRouter.get(
  "/patterns",
  asyncHandler(async (req, res) => {
    const result = await analyzePatterns(uid(req));
    if (!result) return res.json({ insufficient_data: true, message: "Needs 30+ sessions for pattern analysis." });
    res.json(result);
  }),
);

// ── peer cohort benchmarking ──────────────────────────────────────────────────
progressRouter.get(
  "/cohort",
  validate({ query: z.object({ exercise: z.string(), weightClass: z.coerce.number().optional() }) }),
  asyncHandler(async (req, res) => {
    const { exercise, weightClass } = req.query as unknown as { exercise: string; weightClass?: number };
    const userId = uid(req);

    const userPR = await prisma.personalRecord.findFirst({
      where: { userId, exercise: { name: exercise }, recordType: "max_1rm_estimate" },
      orderBy: { value: "desc" },
    });

    // count users with a PR for this exercise
    const cohortSize = await prisma.personalRecord.groupBy({
      by: ["userId"],
      where: { exercise: { name: exercise }, recordType: "max_1rm_estimate" },
    }).then((rows) => rows.length);

    if (cohortSize < 50) {
      return res.json({ insufficient_data: true, cohortSize, message: "Not enough users for this exercise yet." });
    }

    if (!userPR) return res.json({ no_pr: true });

    const below = await prisma.personalRecord.count({
      where: { exercise: { name: exercise }, recordType: "max_1rm_estimate", value: { lt: userPR.value }, userId: { not: userId } },
    });
    const percentile = Math.round((below / cohortSize) * 100);

    res.json({
      exercise,
      yourE1rm: userPR.value,
      cohortSize,
      percentile,
      weightClass: weightClass ?? null,
    });
  }),
);

const weekKey = (d: Date) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};
