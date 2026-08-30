import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const subscriptionRouter = Router();
subscriptionRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

const PLANS = [
  { id: "free", name: "Free", price: 0, interval: null, features: ["Manual logging", "Exercise library", "Basic progress"] },
  { id: "pro_monthly", name: "Forma Pro", price: 12.99, interval: "month", features: ["AI camera coaching", "AI trainer chat", "3D muscle map", "Adaptive programs", "Full analytics"] },
  { id: "pro_annual", name: "Forma Pro (annual)", price: 99.99, interval: "year", features: ["Everything in Pro", "2 months free"] },
];

subscriptionRouter.get("/plans", (_req, res) => res.json(PLANS));

subscriptionRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const sub = await prisma.subscription.upsert({ where: { userId }, update: {}, create: { userId } });
    const entitled = sub.status === "active" || (sub.currentPeriodEnd ? sub.currentPeriodEnd > new Date() : false);
    res.json({ ...sub, entitled, plans: PLANS });
  }),
);

/**
 * Validate an App Store / Play Store receipt and set entitlement.
 * Stub: real impl verifies with Apple's verifyReceipt / Google Play Developer API,
 * then reconciles against one entitlement model (§22.7).
 */
subscriptionRouter.post(
  "/validate-receipt",
  validate({
    body: z.object({
      store: z.enum(["app_store", "play_store"]),
      receipt: z.string().min(1),
      plan: z.enum(["pro_monthly", "pro_annual"]),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { store, plan } = req.body as { store: string; receipt: string; plan: string };
    // TODO verify `receipt` with the store's API before trusting it
    const periodDays = plan === "pro_annual" ? 365 : 30;
    const sub = await prisma.subscription.upsert({
      where: { userId },
      update: { plan, status: "active", store, currentPeriodEnd: new Date(Date.now() + periodDays * 86_400_000) },
      create: { userId, plan, status: "active", store, currentPeriodEnd: new Date(Date.now() + periodDays * 86_400_000) },
    });
    res.json({ ...sub, entitled: true });
  }),
);

subscriptionRouter.post(
  "/cancel",
  asyncHandler(async (req, res) => {
    const sub = await prisma.subscription.update({
      where: { userId: uid(req) },
      data: { status: "cancelled" },
    });
    res.json(sub);
  }),
);
