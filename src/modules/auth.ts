import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import crypto from "node:crypto";
import {
  hashPassword,
  verifyPassword,
  signAccessToken,
  newRefreshToken,
  hashRefreshToken,
} from "../lib/auth.js";
import { badRequest, unauthorized } from "../lib/errors.js";
import { STORE_ITEMS, GOAL_TEMPLATES } from "../data/store.js";
import { verifySocialToken } from "../services/social-auth.js";

export const authRouter = Router();

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(80).optional(),
});

async function issueSession(user: { id: string; email: string }, req: { headers: Record<string, unknown> }) {
  const refresh = newRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
      userAgent: String(req.headers["user-agent"] ?? ""),
    },
  });
  return {
    accessToken: signAccessToken({ sub: user.id, email: user.email }),
    refreshToken: refresh.raw,
  };
}

/** Everything a brand-new account needs: trainer config, wallet, prefs, goals, default store items. */
async function bootstrapUser(userId: string) {
  await prisma.trainer.create({ data: { userId } });
  await prisma.wallet.create({ data: { userId, balance: 100 } });
  await prisma.notificationPreference.create({ data: { userId } });
  await prisma.subscription.create({ data: { userId } });
  await prisma.userAppearance.create({ data: { userId } });
  await prisma.userDisclosure.create({ data: { userId } });
  await prisma.userProgression.create({ data: { userId, unlockedFeatures: ["dashboard", "workouts", "trainer"] } });
  const defaults = STORE_ITEMS.filter((i) => i.isDefault);
  for (const item of defaults) {
    await prisma.userStoreItem.create({ data: { userId, storeItemId: item.id, equipped: true } });
  }
  for (const g of GOAL_TEMPLATES) {
    await prisma.goal.create({
      data: { userId, key: g.key, label: g.label, target: g.target, unit: g.unit, cadence: g.cadence, tone: g.tone },
    });
  }
}

authRouter.post(
  "/register",
  validate({ body: credentials }),
  asyncHandler(async (req, res) => {
    const { email, password, name } = req.body as z.infer<typeof credentials>;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw badRequest("Email already registered");

    const user = await prisma.user.create({
      data: { email, name: name ?? email.split("@")[0]!, passwordHash: await hashPassword(password) },
    });
    await bootstrapUser(user.id);

    const tokens = await issueSession(user, req);
    res.status(201).json({ user: { id: user.id, email: user.email, name: user.name }, ...tokens });
  }),
);

authRouter.post(
  "/login",
  validate({ body: credentials.pick({ email: true, password: true }) }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      throw unauthorized("Invalid email or password");
    }
    const tokens = await issueSession(user, req);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, onboardingCompletedAt: user.onboardingCompletedAt },
      ...tokens,
    });
  }),
);

authRouter.post(
  "/refresh",
  validate({ body: z.object({ refreshToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const raw = (req.body as { refreshToken: string }).refreshToken;
    const record = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(raw) },
      include: { user: true },
    });
    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw unauthorized("Refresh token invalid or expired");
    }
    // rotate
    await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    const tokens = await issueSession(record.user, req);
    res.json(tokens);
  }),
);

authRouter.post(
  "/logout",
  validate({ body: z.object({ refreshToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashRefreshToken((req.body as { refreshToken: string }).refreshToken) },
      data: { revokedAt: new Date() },
    });
    res.status(204).end();
  }),
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: (req as AuthedRequest).userId },
      include: { trainer: true, wallet: true },
    });
    const { passwordHash, appleSub, googleSub, ...safe } = user;
    res.json(safe);
  }),
);

// ── Sign in with Apple / Google (O2) ──────────────────────────────────────
authRouter.post(
  "/social/:provider",
  validate({
    params: z.object({ provider: z.enum(["apple", "google"]) }),
    body: z.object({ identityToken: z.string().min(10), name: z.string().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const provider = req.params.provider as "apple" | "google";
    const { identityToken, name } = req.body as { identityToken: string; name?: string };
    const profile = await verifySocialToken(provider, identityToken);
    if (!profile) throw unauthorized("Could not verify identity token");

    const subField = provider === "apple" ? "appleSub" : "googleSub";
    let user = await prisma.user.findFirst({
      where: { OR: [{ [subField]: profile.sub }, ...(profile.email ? [{ email: profile.email }] : [])] },
    });

    let created = false;
    if (!user) {
      user = await prisma.user.create({
        data: {
          email: profile.email ?? `${provider}_${profile.sub}@forma.invalid`,
          name: name ?? profile.name ?? "Athlete",
          authProvider: provider,
          [subField]: profile.sub,
        },
      });
      await bootstrapUser(user.id);
      created = true;
    } else if (!(user as Record<string, unknown>)[subField]) {
      user = await prisma.user.update({ where: { id: user.id }, data: { [subField]: profile.sub } });
    }

    const tokens = await issueSession(user, req);
    res.status(created ? 201 : 200).json({
      user: { id: user.id, email: user.email, name: user.name, onboardingCompletedAt: user.onboardingCompletedAt },
      ...tokens,
    });
  }),
);

// ── Password reset (O2) ──────────────────────────────────────────────────
authRouter.post(
  "/forgot-password",
  validate({ body: z.object({ email: z.string().email() }) }),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: (req.body as { email: string }).email } });
    // always 200 — do not leak whether the address exists
    if (user?.passwordHash) {
      const raw = crypto.randomBytes(32).toString("base64url");
      await prisma.passwordReset.create({
        data: {
          userId: user.id,
          tokenHash: crypto.createHash("sha256").update(raw).digest("hex"),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      // TODO send `raw` by email. Returned here only in non-production for testing.
      if (process.env.NODE_ENV !== "production") return res.json({ ok: true, devToken: raw });
    }
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/reset-password",
  validate({ body: z.object({ token: z.string().min(10), password: z.string().min(8).max(200) }) }),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body as { token: string; password: string };
    const record = await prisma.passwordReset.findUnique({
      where: { tokenHash: crypto.createHash("sha256").update(token).digest("hex") },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) throw badRequest("Reset token invalid or expired");
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash: await hashPassword(password) } }),
      prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: record.userId }, data: { revokedAt: new Date() } }),
    ]);
    res.json({ ok: true });
  }),
);
