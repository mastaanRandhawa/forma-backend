import { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import {
  CUSTOMIZATION_CATALOGUE,
  DEFAULT_EQUIPPED,
  DEFAULT_OWNED,
  type CustomizationSlot,
} from "../data/customization.js";

export const customizationRouter = Router();
customizationRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

type CzRow = { owned: string[]; equipped: Record<string, string>; updatedAt: Date };
type Db = Pick<typeof prisma, "userCustomization">;

/**
 * Create the row on first touch. Two first requests at once both try to insert;
 * the loser's unique-key error just means the row now exists.
 */
async function ensureRow(userId: string) {
  await prisma.userCustomization
    .upsert({
      where: { userId },
      create: { userId, owned: DEFAULT_OWNED, equipped: DEFAULT_EQUIPPED },
      update: {},
    })
    .catch((err: unknown) => {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    });
}

/** Load (creating on first touch) and normalise a user's customization row. */
async function loadRow(userId: string, db: Db = prisma): Promise<CzRow> {
  await ensureRow(userId);
  const row = await db.userCustomization.findUniqueOrThrow({ where: { userId } });
  const owned = Array.from(new Set([...(row.owned as string[]), ...DEFAULT_OWNED]));
  const equipped = { ...DEFAULT_EQUIPPED, ...(row.equipped as Record<string, string>) };
  return { owned, equipped, updatedAt: row.updatedAt };
}

async function walletBalance(userId: string) {
  const w = await prisma.wallet.findUnique({ where: { userId } });
  return w?.balance ?? 0;
}

customizationRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { owned, equipped } = await loadRow(userId);
    res.json({ owned, equipped, balance: await walletBalance(userId) });
  }),
);

customizationRouter.post(
  "/buy",
  validate({ body: z.object({ itemId: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { itemId } = req.body as { itemId: string };
    const entry = CUSTOMIZATION_CATALOGUE[itemId];
    if (!entry) throw notFound("Unknown customization item");

    // Two guarded writes in one transaction, so concurrent buys can't spend the
    // same coins twice: the decrement only applies while the balance covers the
    // price, and the ownership write only applies if the row hasn't changed since
    // it was read. Either guard failing rolls the whole purchase back.
    const result = await prisma.$transaction(async (tx) => {
      const row = await loadRow(userId, tx);
      if (row.owned.includes(itemId)) throw conflict("Already owned");
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw badRequest("No wallet");

      const spent = await tx.wallet.updateMany({
        where: { id: wallet.id, balance: { gte: entry.price } },
        data: { balance: { decrement: entry.price } },
      });
      if (spent.count === 0) throw badRequest("Not enough coins");

      const owned = [...row.owned, itemId];
      const equipped = { ...row.equipped, [entry.slot]: itemId };
      const saved = await tx.userCustomization.updateMany({
        where: { userId, updatedAt: row.updatedAt },
        data: { owned, equipped },
      });
      if (saved.count === 0) throw conflict("Customization changed during purchase, try again");

      await tx.walletTransaction.create({
        data: { walletId: wallet.id, type: "spend", amount: entry.price, label: `Unlocked ${itemId}` },
      });
      const after = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      return { owned, equipped, balance: after.balance };
    });

    res.status(201).json(result);
  }),
);

customizationRouter.post(
  "/equip",
  validate({ body: z.object({ itemId: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { itemId } = req.body as { itemId: string };
    const entry = CUSTOMIZATION_CATALOGUE[itemId];
    if (!entry) throw notFound("Unknown customization item");

    const { owned, equipped } = await loadRow(userId);
    if (!owned.includes(itemId)) throw badRequest("You do not own that item");

    const nextEquipped: Record<string, string> = { ...equipped, [entry.slot]: itemId };

    // mirror the Kai look onto the Trainer config so chat / orb stay in sync
    const data: { equipped: Record<string, string> } = { equipped: nextEquipped };
    await prisma.$transaction(async (tx) => {
      await tx.userCustomization.update({ where: { userId }, data });
      if (entry.slot === "avatar") {
        await tx.trainer.update({ where: { userId }, data: { avatarId: itemId } }).catch(() => {});
      }
    });

    res.json({ owned, equipped: nextEquipped, balance: await walletBalance(userId) });
  }),
);

/** direct slot set for the free "none" pseudo-items + theme picker */
customizationRouter.post(
  "/slot",
  validate({
    body: z.object({
      slot: z.enum(["theme", "accent", "effect", "avatar", "chatTheme", "frame", "title", "badge", "colorMode", "font"]),
      itemId: z.string().min(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { slot, itemId } = req.body as { slot: CustomizationSlot; itemId: string };
    const { owned, equipped } = await loadRow(userId);
    if (!owned.includes(itemId)) throw badRequest("You do not own that item");
    const nextEquipped = { ...equipped, [slot]: itemId };
    await prisma.userCustomization.update({ where: { userId }, data: { equipped: nextEquipped } });
    res.json({ owned, equipped: nextEquipped, balance: await walletBalance(userId) });
  }),
);
