import { Router } from "express";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { evaluateAchievements } from "../services/achievements.js";
import { evaluateProgression } from "../services/progression.js";

export const achievementsRouter = Router();
achievementsRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

/** All achievements with the user's progress (Progress `AchievementStrip`). */
achievementsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const [all, mine] = await Promise.all([
      prisma.achievement.findMany(),
      prisma.userAchievement.findMany({ where: { userId } }),
    ]);
    const byId = new Map(mine.map((m) => [m.achievementId, m]));
    res.json(
      all.map((a) => ({
        key: a.key,
        title: a.title,
        detail: a.detail,
        icon: a.icon,
        targetValue: a.targetValue,
        progress: byId.get(a.id)?.progress ?? 0,
        unlockedAt: byId.get(a.id)?.unlockedAt ?? null,
      })),
    );
  }),
);

/** Force a re-evaluation (also runs automatically after each session). */
achievementsRouter.post(
  "/evaluate",
  asyncHandler(async (req, res) => {
    await evaluateAchievements(uid(req));
    const progression = await evaluateProgression(uid(req)).catch(() => null);
    res.json({ ok: true, progression });
  }),
);
