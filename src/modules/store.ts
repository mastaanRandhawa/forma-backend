import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { badRequest, notFound, conflict } from "../lib/errors.js";

export const storeRouter = Router();
storeRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

// ── wallet ─────────────────────────────────────────────────────────────────
storeRouter.get(
  "/wallet",
  asyncHandler(async (req, res) => {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: uid(req) },
      include: { transactions: { orderBy: { createdAt: "desc" }, take: 20 } },
    });
    const earnedThisWeek = wallet.transactions
      .filter((t) => t.type === "earn" && t.createdAt > new Date(Date.now() - 7 * 86_400_000))
      .reduce((a, t) => a + t.amount, 0);
    res.json({ balance: wallet.balance, earnedThisWeek, recent: wallet.transactions });
  }),
);

/** Award coins (called by achievement / goal completion hooks; exposed for tests). */
export async function awardCoins(userId: string, amount: number, label: string) {
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId } });
  await prisma.$transaction([
    prisma.wallet.update({ where: { id: wallet.id }, data: { balance: { increment: amount } } }),
    prisma.walletTransaction.create({ data: { walletId: wallet.id, type: "earn", amount, label } }),
  ]);
}

/**
 * Retired: clients used to post their own coin amounts here, which let anyone
 * with a token mint coins. Coins are now granted server-side from what the user
 * actually did (see services/rewards.ts). Old app builds get a 410 and carry on.
 */
storeRouter.post("/wallet/earn", (_req, res) => {
  res.status(410).json({ error: { code: "gone", message: "Coins are granted by the server now — see /rewards." } });
});

// ── catalogue ──────────────────────────────────────────────────────────────
storeRouter.get(
  "/items",
  validate({ query: z.object({ category: z.enum(["voice", "personality", "look", "theme"]).optional() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const category = (req.query as { category?: string }).category;
    const [items, owned] = await Promise.all([
      prisma.storeItem.findMany({ where: category ? { category: category as never } : {}, orderBy: { price: "asc" } }),
      prisma.userStoreItem.findMany({ where: { userId } }),
    ]);
    const ownedMap = new Map(owned.map((o) => [o.storeItemId, o]));
    res.json(
      items.map((i) => ({
        ...i,
        owned: ownedMap.has(i.id),
        equipped: ownedMap.get(i.id)?.equipped ?? false,
      })),
    );
  }),
);

storeRouter.post(
  "/items/:id/buy",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const item = await prisma.storeItem.findUnique({ where: { id: req.params.id } });
    if (!item) throw notFound("Store item not found");

    const [wallet, existing] = await Promise.all([
      prisma.wallet.findUniqueOrThrow({ where: { userId } }),
      prisma.userStoreItem.findUnique({ where: { userId_storeItemId: { userId, storeItemId: item.id } } }),
    ]);
    if (existing) throw conflict("Already owned");
    if (wallet.balance < item.price) throw badRequest("Not enough coins");

    // the check above is only a fast path: the decrement itself must refuse to overdraw,
    // or two purchases at once could both pass it
    const { userItem, balance } = await prisma.$transaction(async (tx) => {
      const debited = await tx.wallet.updateMany({ where: { id: wallet.id, balance: { gte: item.price } }, data: { balance: { decrement: item.price } } });
      if (debited.count === 0) throw badRequest("Not enough coins");
      await tx.walletTransaction.create({ data: { walletId: wallet.id, type: "spend", amount: item.price, label: `Bought ${item.name}` } });
      const userItem = await tx.userStoreItem.create({ data: { userId, storeItemId: item.id } });
      const { balance } = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      return { userItem, balance };
    });
    res.status(201).json({ item: userItem, balance });
  }),
);

storeRouter.post(
  "/items/:id/equip",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const owned = await prisma.userStoreItem.findUnique({
      where: { userId_storeItemId: { userId, storeItemId: req.params.id } },
      include: { storeItem: true },
    });
    if (!owned) throw badRequest("You do not own that item");

    await prisma.$transaction(async (tx) => {
      // one equipped item per category
      const sameCategory = await tx.userStoreItem.findMany({
        where: { userId, storeItem: { category: owned.storeItem.category } },
      });
      await tx.userStoreItem.updateMany({
        where: { id: { in: sameCategory.map((s) => s.id) } },
        data: { equipped: false },
      });
      await tx.userStoreItem.update({ where: { id: owned.id }, data: { equipped: true } });

      // reflect on the trainer config
      const t = owned.storeItem;
      if (t.category === "voice") await tx.trainer.update({ where: { userId }, data: { voiceId: t.id } });
      if (t.category === "look") await tx.trainer.update({ where: { userId }, data: { avatarId: t.id } });
      if (t.category === "theme") await tx.trainer.update({ where: { userId }, data: { equippedThemeId: t.id } });
      if (t.category === "personality" && t.style) {
        const s = t.style as { directness: number; warmth: number; detail: number; intensity: number; humor: number };
        await tx.trainer.update({
          where: { userId },
          data: {
            coachingDirectness: s.directness,
            motivationLevel: s.warmth,
            coachingDetail: s.detail,
            formStrictness: s.intensity,
            humor: s.humor,
          },
        });
      }
    });
    res.json({ ok: true });
  }),
);
