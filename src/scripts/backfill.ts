/**
 * One-off backfill for the appearance / disclosure / progression models.
 * Safe to re-run.  Usage:  npm run db:backfill
 *
 * For every non-deleted user:
 *   - create default UserAppearance / UserDisclosure rows if missing
 *     (UserAppearance is linked to the default BackgroundPreset)
 *   - create UserProgression if missing, then run evaluateProgression once so
 *     `unlockedFeatures` reflects their real history.
 */
import { prisma } from "../prisma.js";
import { BACKGROUND_PRESETS } from "../data/appearance.js";
import { evaluateProgression } from "../services/progression.js";

async function main() {
  const preset = BACKGROUND_PRESETS.find((p) => p.isDefault)!;
  const g = preset.glass as { opacity: number; blurPx: number; tint: string };

  const users = await prisma.user.findMany({ where: { deletedAt: null }, select: { id: true } });
  console.log(`backfilling ${users.length} users…`);

  let created = 0;
  for (const { id: userId } of users) {
    await prisma.userAppearance.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        presetId: preset.id as string,
        backgroundMode: preset.mode as string,
        backgroundColor: (preset.backgroundColor as string) ?? "#170D17",
        backgroundGradient: preset.gradient ?? undefined,
        backgroundDim: (preset.backgroundDim as number) ?? 0,
        glassOpacity: g.opacity,
        glassBlurPx: Math.round(g.blurPx),
        glassTint: g.tint,
      },
    });
    await prisma.userDisclosure.upsert({ where: { userId }, update: {}, create: { userId } });
    await evaluateProgression(userId);
    created++;
    if (created % 100 === 0) console.log(`  …${created}`);
  }

  console.log(`✅ backfill complete (${created} users)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
