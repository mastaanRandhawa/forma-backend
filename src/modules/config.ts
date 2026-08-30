import { Router } from "express";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { optionalAuth, type AuthedRequest } from "../middleware/auth.js";
import { TIER_ORDER } from "../data/progression.js";
import { readProgression } from "../services/progression.js";

export const configRouter = Router();

/**
 * Appearance presets available to the caller.
 *   - anonymous  → only free, always-available presets
 *   - authed     → + presets at/below the user's tier and themes they own
 * Cacheable for 5 minutes.
 */
configRouter.get(
  "/appearance-presets",
  optionalAuth,
  asyncHandler(async (req, res) => {
    const userId = (req as AuthedRequest).userId as string | undefined;
    const presets = await prisma.backgroundPreset.findMany({ orderBy: { sortOrder: "asc" } });

    let tierIndex = 0;
    let ownedThemeIds = new Set<string>();
    if (userId) {
      const [prog, owned] = await Promise.all([
        readProgression(userId),
        prisma.userStoreItem.findMany({ where: { userId, storeItem: { category: "theme" } }, select: { storeItemId: true } }),
      ]);
      tierIndex = TIER_ORDER.indexOf(prog.tier);
      ownedThemeIds = new Set(owned.map((o) => o.storeItemId));
    }

    const visible = presets.filter((p) => {
      if (p.minTier && TIER_ORDER.indexOf(p.minTier as never) > tierIndex) return false;
      if (p.storeItemId && !ownedThemeIds.has(p.storeItemId)) return false;
      return true;
    });

    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(
      visible.map((p) => ({
        id: p.id,
        name: p.name,
        mode: p.mode,
        backgroundColor: p.backgroundColor,
        gradient: p.gradient,
        imageUrl: p.imageUrl,
        backgroundDim: p.backgroundDim,
        glass: p.glass,
        accentColor: p.accentColor,
        isDefault: p.isDefault,
        locked: false,
        premium: !!p.storeItemId,
      })),
    );
  }),
);
