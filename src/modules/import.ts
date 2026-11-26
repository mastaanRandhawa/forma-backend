import express, { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { badRequest } from "../lib/errors.js";
import { slugify, visibleTo } from "../lib/exercises.js";
import { createCompletedSession, recomputeUserHistory } from "../services/session.js";
import {
  matchExercise,
  normalizeName,
  parseHealthWeights,
  parseWorkoutCsv,
  type ParsedExercise,
  type ParsedWorkout,
} from "../services/import-parsers.js";

export const importRouter = Router();
importRouter.use(requireAuth);
// exports are plain text (CSV / XML), sent as text/csv, text/plain or text/xml — or as JSON { csv } / { xml } up to 1 MB
importRouter.use(express.text({ type: ["text/csv", "text/plain", "text/xml", "application/xml"], limit: "8mb" }));

const uid = (req: unknown) => (req as AuthedRequest).userId;
const MAX_WORKOUTS = 400; // a request rebuilds records for every imported day, so send big histories in chunks
const MAX_CUSTOM = 200;

function bodyText(req: express.Request, key: "csv" | "xml"): string {
  const b = req.body as unknown;
  const text = typeof b === "string" ? b : b && typeof b === "object" ? (b as Record<string, unknown>)[key] : undefined;
  if (typeof text !== "string" || !text.trim()) throw badRequest(`Send the export as text/${key === "csv" ? "csv" : "xml"}, or as JSON { "${key}": "…" }`);
  return text;
}

const workoutQuery = z.object({
  format: z.enum(["auto", "strong", "hevy", "fitnotes"]).default("auto"),
  units: z.enum(["kg", "lb"]).optional(),
  dryRun: z.enum(["true", "false"]).default("false"),
  createMissing: z.enum(["true", "false"]).default("true"),
});

const dupKey = (w: { name: string; startedAt: Date }) => `${w.startedAt.toISOString().slice(0, 16)}|${w.name.toLowerCase()}`;
const setCount = (w: ParsedWorkout) => w.exercises.reduce((n, e) => n + e.sets.length, 0);

function inferTracking(e: ParsedExercise): "reps" | "time" | "cardio" {
  if (e.sets.some((s) => s.distanceM)) return "cardio";
  const repsLogged = e.sets.some((s) => s.reps);
  return !repsLogged && e.sets.some((s) => s.durationSeconds) ? "time" : "reps";
}

/**
 * Bring in workout history from Strong, Hevy or FitNotes (CSV). Always run with
 * dryRun=true first: it returns what would be read, which names matched the
 * library, and how many workouts are already here — and changes nothing.
 * Importing merges: a workout already present (same start minute and name) is skipped.
 */
importRouter.post(
  "/workouts",
  validate({ query: workoutQuery }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const q = req.query as unknown as z.infer<typeof workoutQuery>;
    const dryRun = q.dryRun === "true";

    let parsed;
    try {
      parsed = parseWorkoutCsv(bodyText(req, "csv"), q.format, q.units ?? "kg");
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "Couldn't read that file");
    }
    if (!parsed.workouts.length) throw badRequest("No workouts found in that file");
    if (parsed.workouts.length > MAX_WORKOUTS) throw badRequest(`That file has ${parsed.workouts.length} workouts. Send up to ${MAX_WORKOUTS} at a time (split it by date).`);

    const warnings = [...parsed.warnings];
    const unitUsed = parsed.unitInFile ?? q.units ?? "kg";
    if (!parsed.unitInFile && !q.units) warnings.push("This export doesn't say its weight unit, so weights were read as kilograms. Add units=lb if yours are in pounds.");

    // names → library
    const catalog = (await prisma.exercise.findMany({ where: visibleTo(userId), select: { id: true, name: true, aliases: true } }));
    const byRaw = new Map<string, { id: string; name: string } | null>();
    const rawExercises = new Map<string, ParsedExercise>();
    for (const w of parsed.workouts) {
      for (const e of w.exercises) {
        const key = normalizeName(e.name);
        if (!byRaw.has(key)) byRaw.set(key, matchExercise(e.name, catalog));
        const seen = rawExercises.get(key);
        if (!seen) rawExercises.set(key, { name: e.name, sets: [...e.sets] });
        else seen.sets.push(...e.sets);
      }
    }

    // what is already here
    const from = parsed.workouts[0].startedAt;
    const to = parsed.workouts[parsed.workouts.length - 1].startedAt;
    const existing = await prisma.workoutSession.findMany({
      where: { userId, status: "completed", startedAt: { gte: new Date(from.getTime() - 86_400_000), lte: new Date(to.getTime() + 86_400_000) } },
      select: { name: true, startedAt: true },
    });
    const have = new Set(existing.map(dupKey));
    const fresh = parsed.workouts.filter((w) => !have.has(dupKey(w)));

    const unmatched = [...byRaw.entries()].filter(([, v]) => !v).map(([k]) => rawExercises.get(k)!.name);
    const createMissing = q.createMissing === "true";
    const summary = {
      format: parsed.format,
      unitUsed,
      dateRange: { from, to },
      workouts: { inFile: parsed.workouts.length, new: fresh.length, alreadyHere: parsed.workouts.length - fresh.length },
      sets: fresh.reduce((n, w) => n + setCount(w), 0),
      exercises: {
        matched: [...byRaw.values()].filter(Boolean).length,
        unmatched: unmatched.length,
        // what happens to the ones that didn't match
        willCreate: createMissing ? unmatched.length : 0,
        willSkip: createMissing ? 0 : unmatched.length,
      },
      matches: [...byRaw.entries()].map(([k, v]) => ({ name: rawExercises.get(k)!.name, matchedTo: v?.name ?? null })),
      warnings: warnings.slice(0, 20),
    };
    if (dryRun) return res.json({ dryRun: true, ...summary });

    // create the exercises that didn't match, as the person's own custom exercises
    const ids = new Map<string, string>();
    for (const [k, v] of byRaw) if (v) ids.set(k, v.id);
    let created = 0;
    if (createMissing && unmatched.length) {
      const have = await prisma.exercise.count({ where: { ownerUserId: userId } });
      if (have + unmatched.length > MAX_CUSTOM) throw badRequest(`${unmatched.length} exercises weren't recognised and you can keep up to ${MAX_CUSTOM} custom ones. Import with createMissing=false, or tidy your custom exercises first.`);
      for (const [k, v] of byRaw) {
        if (v) continue;
        const raw = rawExercises.get(k)!;
        const base = `u-${userId.slice(-6)}-${slugify(raw.name)}`;
        let slug = base;
        for (let n = 2; await prisma.exercise.findUnique({ where: { slug }, select: { id: true } }); n++) slug = `${base}-${n}`;
        const ex = await prisma.exercise.create({
          data: { slug, name: raw.name.slice(0, 80), category: "other", source: "custom", ownerUserId: userId, trackingType: inferTracking(raw) },
        });
        ids.set(k, ex.id);
        created++;
      }
    }

    let imported = 0;
    let skippedSets = 0;
    for (const w of fresh) {
      const performances = w.exercises
        .map((e) => ({ exerciseId: ids.get(normalizeName(e.name)), sets: e.sets }))
        .filter((p): p is { exerciseId: string; sets: ParsedExercise["sets"] } => {
          if (!p.exerciseId) skippedSets += p.sets.length;
          return !!p.exerciseId;
        });
      if (!performances.length) continue;
      await createCompletedSession(userId, { name: w.name.slice(0, 120), startedAt: w.startedAt, durationSeconds: w.durationSeconds, performances });
      imported++;
    }
    // records are judged in date order across the whole history, once, at the end
    if (imported) await recomputeUserHistory(userId, fresh[0].startedAt);

    res.status(201).json({ dryRun: false, ...summary, imported, createdExercises: created, skippedSets });
  }),
);

/**
 * Body weight from an Apple Health export. Send export.xml (unzipped) as text/xml; for a large
 * export send just the body-mass records. Readings already stored for the same moment are skipped.
 */
importRouter.post(
  "/body-weight",
  validate({ query: z.object({ dryRun: z.enum(["true", "false"]).default("false") }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const dryRun = (req.query as { dryRun: string }).dryRun === "true";
    const readings = parseHealthWeights(bodyText(req, "xml"));
    if (!readings.length) throw badRequest("No body weight readings found in that export");

    const existing = await prisma.bodyMeasurement.findMany({
      where: { userId, weightKg: { not: null }, recordedAt: { gte: readings[0].recordedAt, lte: readings[readings.length - 1].recordedAt } },
      select: { recordedAt: true, weightKg: true },
    });
    const have = new Set(existing.map((m) => `${m.recordedAt.getTime()}|${m.weightKg}`));
    const fresh = readings.filter((r) => !have.has(`${r.recordedAt.getTime()}|${r.weightKg}`));
    const summary = {
      readings: readings.length,
      new: fresh.length,
      alreadyHere: readings.length - fresh.length,
      dateRange: { from: readings[0].recordedAt, to: readings[readings.length - 1].recordedAt },
    };
    if (dryRun) return res.json({ dryRun: true, ...summary });
    if (fresh.length) await prisma.bodyMeasurement.createMany({ data: fresh.map((r) => ({ userId, weightKg: r.weightKg, recordedAt: r.recordedAt })) });
    res.status(201).json({ dryRun: false, ...summary, imported: fresh.length });
  }),
);
