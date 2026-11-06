import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { CUSTOMIZATION_CATALOGUE } from "../data/customization.js";
import {
  ACHIEVEMENT_COINS,
  BUNDLE_DISCOUNT,
  BUNDLES,
  CHALLENGES,
  CHECKIN_COINS,
  CONSUMABLES,
  DEALS,
  DEFAULT_PLANNED_DAYS,
  EARN_CAPS,
  FOOD_REWARD,
  FREEZE_MIN_STREAK,
  PR_REWARD,
  PROTEIN_COINS,
  REROLLS_PER_WEEK,
  REVIEW_ID,
  STREAK_MILESTONES,
  STREAK_REPAIR,
  VISIT_REWARD,
  WEEK_TARGET_REWARD,
  WELCOME_COINS,
  WORKOUT_REWARD,
} from "../data/economy.js";
import {
  clockForUser,
  economySnapshot,
  purchase,
  repairStreak,
  rerollChallenge,
  settle,
  useConsumable,
} from "../services/economy.js";
import { buildKaiReview, reviewAsText } from "../services/kaiReview.js";

export const economyRouter = Router();
economyRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

/** The browser's offset, minutes east of UTC. Real zones run from -12:00 to +14:00. */
const tzOffsetMin = z.number().int().min(-720).max(840);

/** Everything the store screen needs. */
economyRouter.get(
  "/",
  validate({ query: z.object({ tz: z.coerce.number().pipe(tzOffsetMin).optional() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const clock = await clockForUser(userId, (req.query as { tz?: number }).tz);
    res.json(await economySnapshot(userId, clock));
  }),
);

/**
 * The full rule table. The client's copy has to match it, and the E2E suite
 * checks that it does.
 */
economyRouter.get("/catalog", (_req, res) => {
  res.json({
    cosmetics: Object.fromEntries(
      Object.entries(CUSTOMIZATION_CATALOGUE).map(([id, e]) => [id, { slot: e.slot, price: e.price }]),
    ),
    consumables: CONSUMABLES,
    bundles: BUNDLES,
    bundleDiscount: BUNDLE_DISCOUNT,
    deals: DEALS,
    repair: STREAK_REPAIR,
    freezeMinStreak: FREEZE_MIN_STREAK,
    rerollsPerWeek: REROLLS_PER_WEEK,
    earnCaps: EARN_CAPS,
    workout: WORKOUT_REWARD,
    pr: PR_REWARD,
    visit: VISIT_REWARD,
    checkin: CHECKIN_COINS,
    food: FOOD_REWARD,
    protein: PROTEIN_COINS,
    weekTarget: WEEK_TARGET_REWARD,
    welcome: WELCOME_COINS,
    streakMilestones: STREAK_MILESTONES,
    defaultPlannedDays: DEFAULT_PLANNED_DAYS,
    achievements: ACHIEVEMENT_COINS,
    challenges: CHALLENGES.map(({ id, target, reward }) => ({ id, target, reward })),
  });
});

/**
 * Pay whatever is owed. The body carries no amounts: the server works it out from
 * sessions, check-ins and food logs, so repeating this or forging it earns nothing.
 */
economyRouter.post(
  "/settle",
  validate({ body: z.object({ tzOffsetMin: tzOffsetMin.optional() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const clock = await clockForUser(userId, (req.body as { tzOffsetMin?: number }).tzOffsetMin);
    const { rewards, events } = await settle(userId, clock);
    res.json({ rewards, events, economy: await economySnapshot(userId, clock) });
  }),
);

economyRouter.post(
  "/buy",
  validate({ body: z.object({ itemId: z.string().min(1), expectedPrice: z.number().int().nonnegative().optional() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { itemId, expectedPrice } = req.body as { itemId: string; expectedPrice?: number };
    const clock = await clockForUser(userId);
    const customization = await purchase(userId, itemId, clock, expectedPrice);
    // buying a freeze can rescue a streak that's already due one
    const { rewards, events } = await settle(userId, clock);
    res.status(201).json({ customization, rewards, events, economy: await economySnapshot(userId, clock) });
  }),
);

economyRouter.post(
  "/challenges/:id/reroll",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const clock = await clockForUser(userId);
    await rerollChallenge(userId, req.params.id, clock);
    res.json({ economy: await economySnapshot(userId, clock) });
  }),
);

economyRouter.post(
  "/streak-repair",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const clock = await clockForUser(userId);
    await repairStreak(userId, clock);
    const { rewards, events } = await settle(userId, clock);
    res.json({ rewards, events, economy: await economySnapshot(userId, clock) });
  }),
);

/**
 * Spend a Kai Deep Review. The report is built first, so a failure can't lose the
 * item, and it's saved as a message from Kai so it stays in the chat history.
 */
economyRouter.post(
  "/kai-review",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const clock = await clockForUser(userId);
    const held = await prisma.userInventory.findUnique({
      where: { userId_itemId: { userId, itemId: REVIEW_ID } },
      select: { quantity: true },
    });
    if (!held?.quantity) {
      return res.status(400).json({ error: { code: "bad_request", message: `You don't have a ${CONSUMABLES[REVIEW_ID].name}` } });
    }
    const review = await buildKaiReview(userId);
    await prisma.$transaction(async (tx) => {
      await useConsumable(tx, userId, REVIEW_ID);
      await tx.chatMessage.create({
        data: {
          userId,
          role: "trainer",
          content: reviewAsText(review),
          richContent: { kind: "kai_review", review } as never,
        },
      });
    });
    res.json({ review, economy: await economySnapshot(userId, clock) });
  }),
);
