import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth.js";
import { EQUIPMENT, MUSCLE_GROUPS, EXERCISES } from "../src/data/library.js";
import { STORE_ITEMS, ACHIEVEMENTS, GOAL_TEMPLATES } from "../src/data/store.js";
import { BACKGROUND_PRESETS } from "../src/data/appearance.js";

const prisma = new PrismaClient();

async function main() {
  console.log("🌱 seeding reference data…");

  for (const e of EQUIPMENT) {
    await prisma.equipment.upsert({ where: { key: e.key }, update: e, create: e });
  }

  for (const m of MUSCLE_GROUPS) {
    await prisma.muscleGroup.upsert({
      where: { key: m.key },
      update: { name: m.name, plainName: m.plainName, region: m.region },
      create: { key: m.key, name: m.name, plainName: m.plainName, region: m.region, meshRegionId: m.key },
    });
  }
  const muscleByKey = new Map((await prisma.muscleGroup.findMany()).map((m) => [m.key, m.id]));

  for (const ex of EXERCISES) {
    const exercise = await prisma.exercise.upsert({
      where: { slug: ex.slug },
      update: {
        name: ex.name, category: ex.category, movementPattern: ex.movementPattern ?? null,
        equipment: ex.equipment, difficulty: ex.difficulty, supportsCameraTracking: ex.camera,
        alternativeSlugs: ex.alternatives ?? [],
      },
      create: {
        slug: ex.slug, name: ex.name, category: ex.category, movementPattern: ex.movementPattern ?? null,
        equipment: ex.equipment, difficulty: ex.difficulty, supportsCameraTracking: ex.camera,
        alternativeSlugs: ex.alternatives ?? [],
      },
    });
    await prisma.exerciseMuscle.deleteMany({ where: { exerciseId: exercise.id } });
    const links = [
      ...ex.primary.map((k) => ({ k, role: "primary" as const, weight: 1 })),
      ...(ex.secondary ?? []).map((k) => ({ k, role: "secondary" as const, weight: 0.5 })),
    ];
    for (const l of links) {
      const muscleGroupId = muscleByKey.get(l.k);
      if (!muscleGroupId) continue;
      await prisma.exerciseMuscle.create({
        data: { exerciseId: exercise.id, muscleGroupId, role: l.role, weight: l.weight },
      });
    }
  }

  for (const item of STORE_ITEMS) {
    await prisma.storeItem.upsert({ where: { id: item.id }, update: item, create: item });
  }

  for (const a of ACHIEVEMENTS) {
    await prisma.achievement.upsert({ where: { key: a.key }, update: a, create: a });
  }

  for (const p of BACKGROUND_PRESETS) {
    await prisma.backgroundPreset.upsert({ where: { id: p.id as string }, update: p, create: p });
  }

  console.log(`   ${EQUIPMENT.length} equipment · ${MUSCLE_GROUPS.length} muscles · ${EXERCISES.length} exercises · ${STORE_ITEMS.length} store items · ${BACKGROUND_PRESETS.length} presets`);

  // ── demo user matching the web companion's mock data ──────────────────────
  const email = "alex@forma.app";
  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    console.log("👤 creating demo user alex@forma.app / password: forma1234");
    const user = await prisma.user.create({
      data: {
        email,
        name: "Alex",
        passwordHash: await hashPassword("forma1234"),
        experienceLevel: "intermediate",
        fitnessGoal: "build_muscle",
        trainingLocation: "gym",
        trainingFrequencyTarget: 5,
        sessionLengthTargetMin: 45,
        heightCm: 180,
        weightKg: 82,
        onboardingCompletedAt: new Date(),
      },
    });
    await prisma.trainer.create({ data: { userId: user.id, name: "Kai" } });
    await prisma.notificationPreference.create({ data: { userId: user.id } });
    await prisma.subscription.create({ data: { userId: user.id, plan: "pro_monthly", status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
    await prisma.wallet.create({
      data: {
        userId: user.id,
        balance: 720,
        transactions: {
          create: [
            { type: "earn", amount: 60, label: "5-workout week" },
            { type: "earn", amount: 80, label: "14-day streak" },
            { type: "earn", amount: 40, label: "protein goal · 4 days" },
          ],
        },
      },
    });
    for (const item of STORE_ITEMS.filter((i) => i.isDefault)) {
      await prisma.userStoreItem.create({ data: { userId: user.id, storeItemId: item.id, equipped: true } });
    }
    for (const g of GOAL_TEMPLATES) {
      await prisma.goal.create({
        data: { userId: user.id, key: g.key, label: g.label, target: g.target, unit: g.unit, cadence: g.cadence, tone: g.tone },
      });
    }
    for (const [metricType, value, unit] of [
      ["sleep", 7.3, "h"], ["hrv", 68, "ms"], ["resting_hr", 52, "bpm"],
    ] as const) {
      await prisma.progressMetric.create({
        data: { userId: user.id, metricType, value, unit, source: "health_sync" },
      });
    }

    // appearance / disclosure / progression — mid-journey state so the app renders
    const defaultPreset = BACKGROUND_PRESETS.find((p) => p.isDefault)!;
    const dg = defaultPreset.glass as { opacity: number; blurPx: number; tint: string };
    await prisma.userAppearance.create({
      data: {
        userId: user.id,
        presetId: defaultPreset.id as string,
        backgroundMode: defaultPreset.mode as string,
        backgroundColor: (defaultPreset.backgroundColor as string) ?? "#170D17",
        backgroundGradient: defaultPreset.gradient ?? undefined,
        backgroundDim: (defaultPreset.backgroundDim as number) ?? 0,
        glassOpacity: dg.opacity,
        glassBlurPx: Math.round(dg.blurPx),
        glassTint: dg.tint,
      },
    });
    await prisma.userDisclosure.create({ data: { userId: user.id, mode: "always" } });
    await prisma.userProgression.create({
      data: {
        userId: user.id,
        tier: "building",
        unlockedFeatures: ["dashboard", "workouts", "trainer", "body_map", "progress_basic", "goals"],
        gatingEnabled: true,
        firstRunAt: new Date(Date.now() - 4 * 86_400_000),
      },
    });
  }

  console.log("✅ seed complete");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
