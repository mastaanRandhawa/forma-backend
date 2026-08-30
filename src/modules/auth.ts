import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import {
  hashPassword,
  verifyPassword,
} from "../lib/auth.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { badRequestCode, conflict, locked, unauthorized } from "../lib/errors.js";
import { isProd } from "../env.js";
import { STORE_ITEMS, GOAL_TEMPLATES } from "../data/store.js";
import { verifySocialToken } from "../services/social-auth.js";
import {
  issueSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  readRefreshToken,
} from "../services/authSession.js";
import { logAuthEvent } from "../services/audit.js";
import { issueVerificationToken, consumeVerificationToken } from "../services/verification.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendSecurityAlert,
} from "../services/mail.js";

export const authRouter = Router();

const LOCK_THRESHOLD = 8;
const LOCK_MINUTES = 15;

// ── validation ──────────────────────────────────────────────────────────────
const email = z.string().trim().toLowerCase().email();

/** Min 8 chars and a mix of at least three character classes. */
const password = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(200)
  .refine((v) => {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
    return classes >= 3;
  }, "Use a mix of upper- and lower-case letters, numbers, or symbols");

const registerSchema = z
  .object({
    email,
    password,
    name: z.string().trim().min(1).max(80).optional(),
    firstName: z.string().trim().min(1).max(40).optional(),
    lastName: z.string().trim().min(1).max(40).optional(),
    rememberMe: z.boolean().optional(),
  })
  .transform((v) => ({
    ...v,
    name: v.name ?? ([v.firstName, v.lastName].filter(Boolean).join(" ") || v.email.split("@")[0]!),
  }));

const loginSchema = z.object({
  email,
  password: z.string().min(1).max(200),
  rememberMe: z.boolean().optional(),
});

// ── new-account bootstrap (trainer / wallet / prefs / goals / default items) ──
export async function bootstrapUser(userId: string) {
  await prisma.trainer.create({ data: { userId } });
  await prisma.wallet.create({ data: { userId, balance: 100 } });
  await prisma.notificationPreference.create({ data: { userId } });
  await prisma.subscription.create({ data: { userId } });
  await prisma.userAppearance.create({ data: { userId } });
  await prisma.userDisclosure.create({ data: { userId } });
  await prisma.userProgression.create({
    data: { userId, unlockedFeatures: ["dashboard", "workouts", "trainer"] },
  });
  for (const item of STORE_ITEMS.filter((i) => i.isDefault)) {
    await prisma.userStoreItem.create({ data: { userId, storeItemId: item.id, equipped: true } });
  }
  for (const g of GOAL_TEMPLATES) {
    await prisma.goal.create({
      data: { userId, key: g.key, label: g.label, target: g.target, unit: g.unit, cadence: g.cadence, tone: g.tone },
    });
  }
}

const publicUser = (u: {
  id: string; email: string; name: string; authProvider: string;
  onboardingCompletedAt: Date | null; emailVerifiedAt: Date | null; role: string;
}) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  authProvider: u.authProvider,
  onboardingCompletedAt: u.onboardingCompletedAt,
  emailVerified: u.authProvider !== "email" || u.emailVerifiedAt != null,
  role: u.role,
});

// ── register ────────────────────────────────────────────────────────────────
authRouter.post(
  "/register",
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const { email: addr, password: pw, name } = req.body as z.infer<typeof registerSchema>;

    const existing = await prisma.user.findUnique({ where: { email: addr } });
    if (existing) throw conflict("An account with that email already exists");

    const user = await prisma.user.create({
      data: { email: addr, name, passwordHash: await hashPassword(pw) },
    });
    await bootstrapUser(user.id);

    const token = await issueVerificationToken(user.id, "email_verify");
    await sendVerificationEmail(user.email, token);
    await logAuthEvent(req, "register", { userId: user.id, email: user.email });
    await logAuthEvent(req, "email_verification_sent", { userId: user.id, email: user.email });

    const s = await issueSession(user, req, {
      rememberMe: (req.body as { rememberMe?: boolean }).rememberMe,
    });
    res.status(201).json({
      user: publicUser(user),
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      ...(isProd ? {} : { devVerificationToken: token }),
    });
  }),
);

// ── login ───────────────────────────────────────────────────────────────────
authRouter.post(
  "/login",
  loginLimiter,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const { email: addr, password: pw, rememberMe } = req.body as z.infer<typeof loginSchema>;
    const user = await prisma.user.findUnique({ where: { email: addr } });

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await logAuthEvent(req, "login_failed", { userId: user.id, email: addr, meta: { reason: "locked" } });
      throw locked(
        `Too many failed attempts. Try again in ${Math.ceil(
          (user.lockedUntil.getTime() - Date.now()) / 60_000,
        )} minutes, or reset your password.`,
      );
    }

    const ok = user?.passwordHash && (await verifyPassword(pw, user.passwordHash));
    if (!user || !ok) {
      if (user) {
        const next = user.failedLoginCount + 1;
        const hitLimit = next >= LOCK_THRESHOLD;
        await prisma.user.update({
          where: { id: user.id },
          data: hitLimit
            ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
            : { failedLoginCount: next },
        });
        await logAuthEvent(req, hitLimit ? "login_locked" : "login_failed", {
          userId: user.id,
          email: addr,
        });
        if (hitLimit) {
          await sendSecurityAlert(user.email, `Sign-in locked for ${LOCK_MINUTES} minutes after repeated failed attempts.`);
        }
      } else {
        await logAuthEvent(req, "login_failed", { email: addr });
      }
      // identical response whether the account exists or not
      throw unauthorized("Invalid email or password", "invalid_credentials");
    }

    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    }
    await logAuthEvent(req, "login_success", { userId: user.id, email: user.email });

    const s = await issueSession(user, req, { rememberMe });
    res.json({ user: publicUser(user), accessToken: s.accessToken, refreshToken: s.refreshToken });
  }),
);

// ── refresh — rotate the refresh token, mint a new access token ──────────────
authRouter.post(
  "/refresh",
  validate({ body: z.object({ refreshToken: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const raw = readRefreshToken(req);
    if (!raw) throw unauthorized("Missing refresh token", "session_expired");
    const s = await rotateSession(raw, req);
    if (!s) throw unauthorized("Refresh token invalid or expired", "session_expired");
    res.json({ accessToken: s.accessToken, refreshToken: s.refreshToken });
  }),
);

// ── logout (this device) ────────────────────────────────────────────────────
authRouter.post(
  "/logout",
  validate({ body: z.object({ refreshToken: z.string().min(10).optional() }) }),
  asyncHandler(async (req, res) => {
    const raw = readRefreshToken(req);
    if (raw) {
      const rec = await prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(raw) },
        select: { sessionId: true, userId: true },
      });
      if (rec?.sessionId) await revokeSession(rec.sessionId);
      if (rec) await logAuthEvent(req, "logout", { userId: rec.userId });
    }
    res.status(204).end();
  }),
);

// ── logout everywhere ───────────────────────────────────────────────────────
authRouter.post(
  "/logout-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId } = (req as AuthedRequest).auth;
    const count = await revokeAllSessions(userId);
    await logAuthEvent(req, "logout_all", { userId, meta: { sessions: count } });
    res.status(204).end();
  }),
);

// ── current user ────────────────────────────────────────────────────────────
authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: (req as AuthedRequest).auth.userId },
      include: { trainer: true, wallet: true },
    });
    const { passwordHash, appleSub, googleSub, ...safe } = user;
    res.json({ ...safe, emailVerified: user.authProvider !== "email" || user.emailVerifiedAt != null });
  }),
);

// ── email verification ──────────────────────────────────────────────────────
authRouter.post(
  "/verify-email",
  validate({ body: z.object({ token: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const { token } = req.body as { token: string };
    const result = await consumeVerificationToken(token, "email_verify");
    if (!result.ok) {
      throw result.reason === "expired"
        ? badRequestCode("token_expired", "This verification link has expired")
        : badRequestCode("token_invalid", "This verification link is invalid");
    }
    await prisma.user.update({
      where: { id: result.userId },
      data: { emailVerifiedAt: new Date() },
    });
    await logAuthEvent(req, "email_verified", { userId: result.userId });
    res.json({ ok: true });
  }),
);

authRouter.post(
  "/resend-verification",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { userId, email: addr } = (req as AuthedRequest).auth;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.authProvider !== "email" || user.emailVerifiedAt) {
      return res.json({ ok: true, alreadyVerified: true });
    }
    const recent = await prisma.verificationToken.findFirst({
      where: { userId, purpose: "email_verify" },
      orderBy: { createdAt: "desc" },
    });
    if (recent && Date.now() - recent.createdAt.getTime() < 60_000) {
      return res.json({ ok: true, throttled: true });
    }
    const token = await issueVerificationToken(userId, "email_verify");
    await sendVerificationEmail(addr, token);
    await logAuthEvent(req, "email_verification_sent", { userId, email: addr });
    res.json({ ok: true, ...(isProd ? {} : { devVerificationToken: token }) });
  }),
);

// ── password reset ──────────────────────────────────────────────────────────
authRouter.post(
  "/forgot-password",
  validate({ body: z.object({ email }) }),
  asyncHandler(async (req, res) => {
    const addr = (req.body as { email: string }).email;
    const user = await prisma.user.findUnique({ where: { email: addr } });
    await logAuthEvent(req, "password_reset_requested", { userId: user?.id ?? null, email: addr });

    let devToken: string | undefined;
    if (user?.passwordHash) {
      const raw = randomToken(32);
      await prisma.passwordReset.create({
        data: { userId: user.id, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 3_600_000) },
      });
      await sendPasswordResetEmail(user.email, raw);
      if (!isProd) devToken = raw;
    }
    // Always 200 — never reveal whether the address has an account.
    res.json({ ok: true, ...(devToken ? { devToken } : {}) });
  }),
);

authRouter.post(
  "/reset-password",
  validate({ body: z.object({ token: z.string().min(10), password }) }),
  asyncHandler(async (req, res) => {
    const { token, password: pw } = req.body as { token: string; password: string };
    const record = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt) throw badRequestCode("token_invalid", "This reset link is invalid");
    if (record.expiresAt < new Date()) throw badRequestCode("reset_link_expired", "This reset link has expired");

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await hashPassword(pw), passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null },
      }),
      prisma.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    await revokeAllSessions(record.userId);
    const u = await prisma.user.findUnique({ where: { id: record.userId }, select: { email: true } });
    if (u) await sendSecurityAlert(u.email, "Your password was reset. All sessions were signed out.");
    await logAuthEvent(req, "password_reset_completed", { userId: record.userId });
    res.json({ ok: true });
  }),
);

// ── Sign in with Apple / Google ─────────────────────────────────────────────
authRouter.post(
  "/social/:provider",
  validate({
    params: z.object({ provider: z.enum(["apple", "google"]) }),
    body: z.object({ identityToken: z.string().min(10), name: z.string().optional(), rememberMe: z.boolean().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const provider = req.params.provider as "apple" | "google";
    const { identityToken, name, rememberMe } = req.body as {
      identityToken: string; name?: string; rememberMe?: boolean;
    };
    const profile = await verifySocialToken(provider, identityToken);
    if (!profile) throw unauthorized("Could not verify identity token", "invalid_credentials");

    const subField = provider === "apple" ? "appleSub" : "googleSub";
    let user = await prisma.user.findFirst({
      where: { OR: [{ [subField]: profile.sub }, ...(profile.email ? [{ email: profile.email.toLowerCase() }] : [])] },
    });

    let created = false;
    if (!user) {
      user = await prisma.user.create({
        data: {
          email: profile.email?.toLowerCase() ?? `${provider}_${profile.sub}@forma.invalid`,
          name: name ?? profile.name ?? "Athlete",
          authProvider: provider,
          emailVerifiedAt: new Date(), // provider already verified the address
          [subField]: profile.sub,
        },
      });
      await bootstrapUser(user.id);
      created = true;
      await logAuthEvent(req, "register", { userId: user.id, email: user.email, meta: { provider } });
    } else if (!(user as Record<string, unknown>)[subField]) {
      user = await prisma.user.update({ where: { id: user.id }, data: { [subField]: profile.sub } });
    }

    await logAuthEvent(req, "login_success", { userId: user.id, email: user.email, meta: { provider } });
    const s = await issueSession(user, req, { rememberMe });
    res.status(created ? 201 : 200).json({
      user: publicUser(user),
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
    });
  }),
);
