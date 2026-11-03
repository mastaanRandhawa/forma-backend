import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { CUSTOMIZATION_CATALOGUE, type CustomizationSlot } from "../data/customization.js";
import { clockForUser, loadCustomization as loadRow, purchase } from "../services/economy.js";

export const customizationRouter = Router();
customizationRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

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
    if (!CUSTOMIZATION_CATALOGUE[itemId]) throw notFound("Unknown customization item");
    const result = await purchase(userId, itemId, await clockForUser(userId));

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

    if (!entry.slot) throw badRequest("That item can't be equipped");

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
      slot: z.enum([
        "theme", "accent", "effect", "avatar", "chatTheme", "frame", "title", "badge", "colorMode", "font",
        "persona", "restSound", "celebration",
      ]),
      itemId: z.string().min(1),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { slot, itemId } = req.body as { slot: CustomizationSlot; itemId: string };
    if (CUSTOMIZATION_CATALOGUE[itemId]?.slot !== slot) throw badRequest("That item doesn't go in that slot");
    const { owned, equipped } = await loadRow(userId);
    if (!owned.includes(itemId)) throw badRequest("You do not own that item");
    const nextEquipped = { ...equipped, [slot]: itemId };
    await prisma.userCustomization.update({ where: { userId }, data: { equipped: nextEquipped } });
    res.json({ owned, equipped: nextEquipped, balance: await walletBalance(userId) });
  }),
);
