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

type CzRow = { owned: string[]; equipped: Record<string, string> };

/** Load (creating on first touch) and normalise a user's customization row. */
async function loadRow(userId: string): Promise<CzRow> {
  const row = await prisma.userCustomization.upsert({
    where: { userId },
    create: { userId, owned: DEFAULT_OWNED, equipped: DEFAULT_EQUIPPED },
    update: {},
  });
  const owned = Array.from(new Set([...(row.owned as string[]), ...DEFAULT_OWNED]));
  const equipped = { ...DEFAULT_EQUIPPED, ...(row.equipped as Record<string, string>) };
  return { owned, equipped };
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

    const [{ owned, equipped }, wallet] = await Promise.all([
      loadRow(userId),
      prisma.wallet.findUnique({ where: { userId } }),
    ]);
    if (owned.includes(itemId)) throw conflict("Already owned");
    if (!wallet) throw badRequest("No wallet");
    if (wallet.balance < entry.price) throw badRequest("Not enough coins");

    const nextOwned = [...owned, itemId];
    const nextEquipped = { ...equipped, [entry.slot]: itemId };

    await prisma.$transaction([
      prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: { decrement: entry.price } },
      }),
      prisma.walletTransaction.create({
        data: { walletId: wallet.id, type: "spend", amount: entry.price, label: `Unlocked ${itemId}` },
      }),
      prisma.userCustomization.update({
        where: { userId },
        data: { owned: nextOwned, equipped: nextEquipped },
      }),
    ]);

    res.status(201).json({
      owned: nextOwned,
      equipped: nextEquipped,
      balance: wallet.balance - entry.price,
    });
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
