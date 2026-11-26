/**
 * import-free-exercise-db — add the public-domain free-exercise-db dataset to the library.
 *
 *   npm run db:import-fed -- --dry-run          # report only, write nothing
 *   npm run db:import-fed                       # fetch live from GitHub and import
 *   npm run db:import-fed -- ./exercises.json   # from a local copy
 *
 * Additive and safe to re-run: exercises whose name or alias we already have are
 * skipped, rows already imported (externalId `fed:*`) are left alone, and existing
 * exercises are never changed.
 */
import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { FED_JSON_URL, FED_SOURCE, selectNew, takenKeys, type FedExercise } from "../data/free-exercise-db.js";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));

async function load(): Promise<FedExercise[]> {
  if (file) return JSON.parse(await readFile(file, "utf8"));
  const res = await fetch(FED_JSON_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as FedExercise[];
}

async function main() {
  const records = await load();
  console.log(`⇣ ${records.length} exercises in free-exercise-db`);
  const existing = await prisma.exercise.findMany({ where: { ownerUserId: null }, select: { name: true, aliases: true, slug: true, externalId: true } });
  const slugs = new Set(existing.map((e) => e.slug));
  const imported = new Set(existing.map((e) => e.externalId).filter(Boolean) as string[]);
  const fresh = records.filter((r) => !imported.has(`fed:${r.id}`));
  const { add, duplicates, noMuscle } = selectNew(fresh, takenKeys(existing));
  for (const n of add) if (slugs.has(n.slug)) n.slug = `${n.slug}-fed`;

  console.log(`   ${records.length - fresh.length} already imported · ${duplicates.length} already in the library by name · ${noMuscle.length} skipped (no usable muscle) · ${add.length} to add`);
  const byCat: Record<string, number> = {};
  for (const n of add) byCat[n.category] = (byCat[n.category] ?? 0) + 1;
  console.log("   by category:", JSON.stringify(byCat));
  if (dryRun) {
    console.log("   dry run, nothing written. sample:", add.slice(0, 8).map((n) => n.name).join(" · "));
    return;
  }

  const muscles = new Map((await prisma.muscleGroup.findMany()).map((m) => [m.key, m.id]));
  let created = 0;
  for (const n of add) {
    const row = await prisma.exercise.create({
      data: {
        slug: n.slug, name: n.name, category: n.category, equipment: n.equipment, difficulty: n.difficulty,
        instructions: n.instructions, source: FED_SOURCE, externalId: n.externalId,
        bodyPart: n.bodyPart, forceType: n.forceType, mechanic: n.mechanic, discipline: n.discipline,
        isBodyweight: n.isBodyweight, trackingType: n.trackingType,
        imageStartUrl: n.imageStartUrl, imageEndUrl: n.imageEndUrl,
      },
    });
    const links = [
      ...n.primary.map((k) => ({ k, role: "primary" as const, weight: 1 })),
      ...n.secondary.map((k) => ({ k, role: "secondary" as const, weight: 0.5 })),
    ];
    for (const l of links) {
      const muscleGroupId = muscles.get(l.k);
      if (muscleGroupId) await prisma.exerciseMuscle.create({ data: { exerciseId: row.id, muscleGroupId, role: l.role, weight: l.weight } });
    }
    created++;
  }
  console.log(`✅ added ${created} exercises · library now ${await prisma.exercise.count({ where: { ownerUserId: null } })}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
