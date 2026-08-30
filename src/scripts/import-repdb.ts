/**
 * import-repdb — fold the RepDB (repdb.co) free-tier exercise dataset into the
 * app's own `Exercise` / `ExerciseMuscle` tables.
 *
 *   npm run db:import-repdb            # fetch live from exercise-dataset.com
 *   npm run db:import-repdb -- ./repdb.json   # from a local copy
 *
 * Idempotent: keyed by `slug` (RepDB id) and `externalId`, safe to re-run.
 *
 * Reconciliation with the hand-curated seed (`src/data/library.ts`):
 *   • A native row with a curated `repdbId` is *enriched in place* — images,
 *     description, tips, MET, mechanic, force type, goals, bodyweight/unilateral
 *     flags, `externalId`. Its curated name / category / equipment / difficulty
 *     / instructions / muscle links are left untouched.
 *   • Every other RepDB record is inserted as a new `source: "repdb"` row.
 *   • Nothing is deleted. Existing workout / session / PR references are by
 *     `exerciseId` and are never affected.
 *
 * Licensing: RepDB free tier — commercial in-app use with visible attribution
 * ("Exercise data by RepDB — repdb.co", shown in Settings ▸ About and the
 * Exercise Library footer). No dataset redistribution: this imports into our
 * schema, it does not republish the source files.
 */
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { EXERCISES } from "../data/library.js";
import {
  REPDB_JSON_URL,
  REPDB_SOURCE,
  normalize,
  type RepDbExercise,
} from "../data/repdb.js";

const prisma = new PrismaClient();

async function loadDataset(): Promise<RepDbExercise[]> {
  const arg = process.argv[2];
  if (arg) {
    const raw = await readFile(arg, "utf8");
    return JSON.parse(raw).exercises;
  }
  const res = await fetch(REPDB_JSON_URL);
  if (!res.ok) throw new Error(`RepDB fetch failed: ${res.status} ${res.statusText}`);
  return ((await res.json()) as { exercises: RepDbExercise[] }).exercises;
}

async function main() {
  console.log("⇣ loading RepDB dataset…");
  const dataset = await loadDataset();
  const byId = new Map(dataset.map((e) => [e.id, e]));
  console.log(`   ${dataset.length} exercises`);

  const muscleByKey = new Map((await prisma.muscleGroup.findMany()).map((m) => [m.key, m.id]));
  const nativeSlugs = new Set(EXERCISES.map((e) => e.slug));

  // ── 1. enrich the curated native rows ────────────────────────────────────
  let enriched = 0;
  const claimed = new Set<string>();
  for (const native of EXERCISES) {
    if (!native.repdbId) continue;
    const src = byId.get(native.repdbId);
    if (!src) {
      console.warn(`   ! ${native.slug}: curated repdbId "${native.repdbId}" not in dataset`);
      continue;
    }
    claimed.add(native.repdbId);
    const n = normalize(src);
    await prisma.exercise.update({
      where: { slug: native.slug },
      data: {
        externalId: n.externalId,
        description: n.description,
        formTips: n.formTips,
        bodyPart: n.bodyPart,
        forceType: n.forceType,
        mechanic: n.mechanic,
        discipline: n.discipline,
        isUnilateral: n.isUnilateral,
        isBodyweight: n.isBodyweight,
        metValue: n.metValue,
        trainingGoals: n.trainingGoals,
        imageStartUrl: n.imageStartUrl,
        imageEndUrl: n.imageEndUrl,
      },
    });
    enriched++;
  }

  // ── 2. import the rest as source: "repdb" rows ───────────────────────────
  let created = 0;
  let updated = 0;
  let skippedMuscles = 0;
  for (const src of dataset) {
    if (claimed.has(src.id)) continue;
    const n = normalize(src);
    // Avoid clobbering a native slug that happens to collide without a match.
    const slug = nativeSlugs.has(n.slug) ? `repdb-${n.slug}` : n.slug;

    const existing = await prisma.exercise.findFirst({
      where: { OR: [{ slug }, { externalId: n.externalId }] },
    });

    const data = {
      slug,
      name: n.name,
      category: n.category,
      equipment: n.equipment,
      difficulty: n.difficulty,
      instructions: n.instructions,
      supportsCameraTracking: n.supportsCameraTracking,
      source: REPDB_SOURCE,
      externalId: n.externalId,
      description: n.description,
      formTips: n.formTips,
      bodyPart: n.bodyPart,
      forceType: n.forceType,
      mechanic: n.mechanic,
      discipline: n.discipline,
      isUnilateral: n.isUnilateral,
      isBodyweight: n.isBodyweight,
      metValue: n.metValue,
      trainingGoals: n.trainingGoals,
      imageStartUrl: n.imageStartUrl,
      imageEndUrl: n.imageEndUrl,
    };

    const row = existing
      ? ((updated++), await prisma.exercise.update({ where: { id: existing.id }, data }))
      : ((created++), await prisma.exercise.create({ data }));

    // Rebuild muscle links for repdb-owned rows only (never for native rows).
    if (row.source === REPDB_SOURCE) {
      await prisma.exerciseMuscle.deleteMany({ where: { exerciseId: row.id } });
      const links = [
        ...n.primary.map((k) => ({ k, role: "primary" as const, weight: 1 })),
        ...n.secondary.map((k) => ({ k, role: "secondary" as const, weight: 0.5 })),
      ];
      for (const l of links) {
        const muscleGroupId = muscleByKey.get(l.k);
        if (!muscleGroupId) {
          skippedMuscles++;
          continue;
        }
        await prisma.exerciseMuscle.create({
          data: { exerciseId: row.id, muscleGroupId, role: l.role, weight: l.weight },
        });
      }
    }
  }

  const total = await prisma.exercise.count();
  const repdb = await prisma.exercise.count({ where: { source: REPDB_SOURCE } });
  console.log(
    `✅ RepDB import complete\n` +
      `   ${enriched} native rows enriched\n` +
      `   ${created} imported · ${updated} refreshed · ${skippedMuscles} unmapped muscle links skipped\n` +
      `   library now: ${total} exercises (${repdb} from RepDB, ${total - repdb} native)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
