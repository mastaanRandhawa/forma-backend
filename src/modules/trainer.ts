import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { generateInsights, buildCheckIn } from "../services/insights.js";

export const trainerRouter = Router();
trainerRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

trainerRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await prisma.trainer.findUniqueOrThrow({ where: { userId: uid(req) } }));
  }),
);

const patchSchema = z.object({
  name: z.string().min(1).max(40).optional(),
  avatarId: z.string().optional(),
  voiceId: z.string().optional(),
  equippedThemeId: z.string().optional(),
  motivationLevel: z.number().min(0).max(1).optional(),
  coachingDirectness: z.number().min(0).max(1).optional(),
  formStrictness: z.number().min(0).max(1).optional(),
  speakingFrequency: z.number().min(0).max(1).optional(),
  coachingDetail: z.number().min(0).max(1).optional(),
  humor: z.number().min(0).max(1).optional(),
});

trainerRouter.patch(
  "/",
  validate({ body: patchSchema }),
  asyncHandler(async (req, res) => {
    res.json(await prisma.trainer.update({ where: { userId: uid(req) }, data: req.body }));
  }),
);

/** Apply a personality preset ("p-drill" etc.) that the user owns. */
trainerRouter.post(
  "/apply-personality/:storeItemId",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const owned = await prisma.userStoreItem.findFirst({
      where: { userId, storeItemId: req.params.storeItemId, storeItem: { category: "personality" } },
      include: { storeItem: true },
    });
    if (!owned) return res.status(403).json({ error: { code: "forbidden", message: "Personality not owned" } });

    const s = owned.storeItem.style as
      | { directness: number; warmth: number; detail: number; intensity: number; humor: number }
      | null;
    if (!s) return res.status(400).json({ error: { code: "bad_request", message: "Preset has no style" } });

    const trainer = await prisma.trainer.update({
      where: { userId },
      data: {
        coachingDirectness: s.directness,
        motivationLevel: s.warmth,
        coachingDetail: s.detail,
        formStrictness: s.intensity,
        humor: s.humor,
      },
    });
    res.json(trainer);
  }),
);

// ── Coaching Insights Log (T4) ─────────────────────────────────────────────
trainerRouter.get(
  "/insights",
  asyncHandler(async (req, res) => {
    res.json(
      await prisma.coachingInsight.findMany({
        where: { userId: uid(req), dismissedAt: null },
        orderBy: { createdAt: "desc" },
        take: 30,
      }),
    );
  }),
);

trainerRouter.post(
  "/insights/generate",
  asyncHandler(async (req, res) => {
    res.json(await generateInsights(uid(req)));
  }),
);

trainerRouter.post("/insights/:id/dismiss", asyncHandler(async (req, res) => {
  await prisma.coachingInsight.updateMany({
    where: { id: req.params.id, userId: uid(req) },
    data: { dismissedAt: new Date() },
  });
  res.json({ ok: true });
}));

// ── Trainer Check-In Prompt (T5) ──────────────────────────────────────────
trainerRouter.get(
  "/check-in",
  asyncHandler(async (req, res) => {
    res.json(await buildCheckIn(uid(req)));
  }),
);

trainerRouter.post(
  "/check-in/respond",
  validate({ body: z.object({ topic: z.string(), answer: z.string() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { topic, answer } = req.body as { topic: string; answer: string };
    // record the answer as a trainer-visible chat note + (for injuries) update state
    await prisma.chatMessage.create({
      data: { userId, role: "user", content: `[check-in · ${topic}] ${answer}` },
    });
    if (topic === "injury" && /pain|hurt/i.test(answer)) {
      const injury = await prisma.injuryNote.findFirst({ where: { userId, active: true }, orderBy: { createdAt: "desc" } });
      if (injury) await prisma.injuryNote.update({ where: { id: injury.id }, data: { note: `${injury.note ?? ""} · flared ${new Date().toISOString().slice(0, 10)}`.trim() } });
    }
    res.json({ ok: true });
  }),
);

// ── voice / avatar catalogue (T2, O11) ────────────────────────────────────
trainerRouter.get(
  "/catalogue",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const [items, owned] = await Promise.all([
      prisma.storeItem.findMany({ where: { category: { in: ["voice", "look", "theme", "personality"] } }, orderBy: { price: "asc" } }),
      prisma.userStoreItem.findMany({ where: { userId } }),
    ]);
    const ownedIds = new Set(owned.map((o) => o.storeItemId));
    const group = (cat: string) =>
      items.filter((i) => i.category === cat).map((i) => ({ ...i, owned: ownedIds.has(i.id) }));
    res.json({ voices: group("voice"), avatars: group("look"), themes: group("theme"), personalities: group("personality") });
  }),
);
