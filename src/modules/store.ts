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

storeRouter.post(
  "/wallet/earn",
  validate({ body: z.object({ amount: z.number().int().positive().max(1000), label: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const { amount, label } = req.body as { amount: number; label: string };
    await awardCoins(uid(req), amount, label);
    res.json(await prisma.wallet.findUniqueOrThrow({ where: { userId: uid(req) } }));
  }),
);

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

    const [, , userItem] = await prisma.$transaction([
      prisma.wallet.update({ where: { id: wallet.id }, data: { balance: { decrement: item.price } } }),
      prisma.walletTransaction.create({ data: { walletId: wallet.id, type: "spend", amount: item.price, label: `Bought ${item.name}` } }),
      prisma.userStoreItem.create({ data: { userId, storeItemId: item.id } }),
    ]);
    res.status(201).json({ item: userItem, balance: wallet.balance - item.price });
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
