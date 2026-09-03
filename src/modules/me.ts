import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { GOAL_TEMPLATES } from "../data/store.js";
import { SAFETY_WIDGETS } from "../data/progression.js";
import { getSettingsBundle, applySettingsPatch, settingsPatchSchema } from "../services/settings.js";
import { ensureProgression, evaluateProgression, setGating } from "../services/progression.js";
import { authorizeUrl, isConfigured, providerConfig, revokeConnection, syncConnection, type WearableProvider } from "../services/wearables.js";
import { badRequest, badRequestCode, conflict, notFound, unauthorized } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "../lib/auth.js";
import { isProd } from "../env.js";
import { listSessions, revokeSession, revokeAllSessions } from "../services/authSession.js";
import { logAuthEvent } from "../services/audit.js";
import { issueVerificationToken, consumeVerificationToken } from "../services/verification.js";
import { sendEmailChangeEmail, sendSecurityAlert } from "../services/mail.js";

export const meRouter = Router();
meRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;
const authCtx = (req: unknown) => (req as AuthedRequest).auth;
const RE_EVAL_MS = 6 * 60 * 60 * 1000;

const profileSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  dateOfBirth: z.coerce.date().optional(),
  biologicalSex: z.enum(["male", "female", "other", "prefer_not_to_say"]).optional(),
  heightCm: z.number().positive().optional(),
  weightKg: z.number().positive().optional(),
  unitPreference: z.enum(["metric", "imperial"]).optional(),
  weekStartsMonday: z.boolean().optional(),
  fitnessGoal: z
    .enum(["build_muscle", "lose_fat", "get_stronger", "general_fitness", "athletic_performance", "maintain"])
    .optional(),
  experienceLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  trainingLocation: z.enum(["gym", "home", "both"]).optional(),
  trainingFrequencyTarget: z.number().int().min(1).max(7).optional(),
  sessionLengthTargetMin: z.number().int().min(10).max(240).optional(),
});

/** Full profile bundle (S1/S2). Lazily re-evaluates progression if stale. */
meRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const prog = await ensureProgression(userId);
    if (Date.now() - prog.lastEvaluatedAt.getTime() > RE_EVAL_MS) {
      await evaluateProgression(userId).catch(() => {});
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        trainer: true,
        wallet: true,
        subscription: true,
        notificationPrefs: true,
        injuries: { where: { active: true } },
        equipment: { include: { equipment: true } },
        deviceConnections: true,
        progression: true,
      },
    });
    const { passwordHash, appleSub, googleSub, ...safe } = user;
    res.json(safe);
  }),
);

meRouter.patch(
  "/",
  validate({ body: profileSchema }),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.update({ where: { id: uid(req) }, data: req.body });
    const { passwordHash, appleSub, googleSub, ...safe } = user;
    res.json(safe);
  }),
);

// ── Settings bundle (camera S8 · units S7 · appearance · disclosure · progression) ──
meRouter.get(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json(await getSettingsBundle(uid(req)));
  }),
);

meRouter.put(
  "/settings",
  validate({ body: settingsPatchSchema }),
  asyncHandler(async (req, res) => {
    res.json(await applySettingsPatch(uid(req), req.body));
  }),
);

// ── Unlock progression ───────────────────────────────────────────────────
meRouter.post(
  "/progression/evaluate",
  asyncHandler(async (req, res) => {
    res.json(await evaluateProgression(uid(req)));
  }),
);

meRouter.put(
  "/progression",
  validate({ body: z.object({ gatingEnabled: z.boolean() }) }),
  asyncHandler(async (req, res) => {
    res.json(await setGating(uid(req), (req.body as { gatingEnabled: boolean }).gatingEnabled));
  }),
);

// ── GDPR: export + account deletion ──────────────────────────────────────
meRouter.get("/export", asyncHandler(async (req, res) => {
  const userId = uid(req);
  const [user, workouts, sessions, metrics, measurements, chat, goals, prs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { trainer: true } }),
    prisma.workout.findMany({ where: { userId }, include: { exercises: true } }),
    prisma.workoutSession.findMany({ where: { userId }, include: { performances: { include: { sets: true } } } }),
    prisma.progressMetric.findMany({ where: { userId } }),
    prisma.bodyMeasurement.findMany({ where: { userId } }),
    prisma.chatMessage.findMany({ where: { userId } }),
    prisma.goal.findMany({ where: { userId }, include: { entries: true } }),
    prisma.personalRecord.findMany({ where: { userId } }),
  ]);
  const { passwordHash, ...safeUser } = user;
  res.setHeader("content-disposition", 'attachment; filename="forma-export.json"');
  res.json({ exportedAt: new Date().toISOString(), user: safeUser, workouts, sessions, metrics, measurements, chat, goals, personalRecords: prs });
}));

meRouter.delete(
  "/",
  validate({ body: z.object({ confirm: z.literal(true), password: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { password } = req.body as { password?: string };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.passwordHash) {
      if (!password || !(await verifyPassword(password, user.passwordHash))) {
        throw unauthorized("Password is incorrect", "invalid_credentials");
      }
    }
    // soft-delete + anonymize, then cascade-hard-delete via a worker/grace window
    await prisma.$transaction([
      prisma.session.updateMany({ where: { userId }, data: { revokedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date() } }),
      prisma.user.update({
        where: { id: userId },
        data: { deletedAt: new Date(), email: `deleted+${userId}@forma.invalid`, name: "Deleted user", passwordHash: null, appleSub: null, googleSub: null },
      }),
    ]);
    await logAuthEvent(req, "account_deleted", { userId });
    res.status(204).end();
  }),
);

// ── Account & Security ──────────────────────────────────────────────────────

/** Change password (authenticated). Revokes every other session. */
meRouter.put(
  "/password",
  validate({
    body: z.object({
      currentPassword: z.string().min(1),
      newPassword: z
        .string()
        .min(8)
        .max(200)
        .refine(
          (v) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length >= 3,
          "Use a mix of upper- and lower-case letters, numbers, or symbols",
        ),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { currentPassword, newPassword } = req.body as { currentPassword: string; newPassword: string };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash) {
      throw badRequestCode("no_password", "This account signs in with Apple or Google — use “forgot password” to set one");
    }
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw unauthorized("Current password is incorrect", "invalid_credentials");
    }
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() },
    });
    await revokeAllSessions(userId, authCtx(req).sessionId);
    await sendSecurityAlert(user.email, "Your password was changed. Other devices were signed out.");
    await logAuthEvent(req, "password_changed", { userId });
    res.json({ ok: true });
  }),
);

/** Request an email change — sends a confirm link to the NEW address. */
meRouter.post(
  "/email/change",
  validate({ body: z.object({ newEmail: z.string().trim().toLowerCase().email(), currentPassword: z.string().min(1) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { newEmail, currentPassword } = req.body as { newEmail: string; currentPassword: string };
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw unauthorized("Password is incorrect", "invalid_credentials");
    }
    if (newEmail === user.email) throw badRequest("That's already your email address");
    if (await prisma.user.findUnique({ where: { email: newEmail } })) {
      throw conflict("That email address is already in use");
    }
    const token = await issueVerificationToken(userId, "email_change", newEmail);
    await sendEmailChangeEmail(newEmail, token);
    await sendSecurityAlert(user.email, `An email change to ${newEmail} was requested. It is not active until confirmed from the new address.`);
    await logAuthEvent(req, "email_change_requested", { userId, meta: { to: newEmail } });
    res.json({ ok: true, ...(isProd ? {} : { devToken: token }) });
  }),
);

/** Confirm an email change from the link sent to the new address. */
meRouter.post(
  "/email/change/confirm",
  validate({ body: z.object({ token: z.string().min(10) }) }),
  asyncHandler(async (req, res) => {
    const result = await consumeVerificationToken((req.body as { token: string }).token, "email_change");
    if (!result.ok) {
      throw result.reason === "expired"
        ? badRequestCode("token_expired", "This confirmation link has expired")
        : badRequestCode("token_invalid", "This confirmation link is invalid");
    }
    if (result.userId !== uid(req)) throw unauthorized("This link belongs to a different account");
    if (!result.newEmail) throw badRequest("Malformed token");
    if (await prisma.user.findUnique({ where: { email: result.newEmail } })) {
      throw conflict("That email address is now in use");
    }
    await prisma.user.update({
      where: { id: result.userId },
      data: { email: result.newEmail, emailVerifiedAt: new Date() },
    });
    await revokeAllSessions(result.userId, authCtx(req).sessionId);
    await logAuthEvent(req, "email_changed", { userId: result.userId, email: result.newEmail });
    res.json({ ok: true, email: result.newEmail });
  }),
);

// ── active sessions / devices ───────────────────────────────────────────────
meRouter.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    res.json(await listSessions(uid(req), authCtx(req).sessionId));
  }),
);

meRouter.delete(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    const revoked = await revokeSession(req.params.id, uid(req));
    if (!revoked) throw notFound("Session not found");
    await logAuthEvent(req, "session_revoked", { userId: uid(req), meta: { sessionId: req.params.id } });
    res.status(204).end();
  }),
);

meRouter.delete(
  "/sessions",
  asyncHandler(async (req, res) => {
    const count = await revokeAllSessions(uid(req), authCtx(req).sessionId);
    await logAuthEvent(req, "logout_all", { userId: uid(req), meta: { sessions: count, keptCurrent: true } });
    res.json({ ok: true, revoked: count });
  }),
);

// ── connected login providers ──────────────────────────────────────────────
meRouter.get(
  "/connected-accounts",
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid(req) } });
    res.json({
      password: !!user.passwordHash,
      google: !!user.googleSub,
      apple: !!user.appleSub,
    });
  }),
);

meRouter.delete(
  "/connected-accounts/:provider",
  validate({ params: z.object({ provider: z.enum(["google", "apple"]) }) }),
  asyncHandler(async (req, res) => {
    const provider = req.params.provider as "google" | "apple";
    const user = await prisma.user.findUniqueOrThrow({ where: { id: uid(req) } });
    const subField = provider === "google" ? "googleSub" : "appleSub";
    const other = provider === "google" ? user.appleSub : user.googleSub;
    if (!user[subField]) throw badRequest(`No ${provider} account is linked`);
    if (!user.passwordHash && !other) {
      throw badRequestCode("last_credential", "Set a password before unlinking your only sign-in method");
    }
    await prisma.user.update({ where: { id: user.id }, data: { [subField]: null } });
    await sendSecurityAlert(user.email, `Your ${provider} account was unlinked from Forma.`);
    await logAuthEvent(req, "connected_account_unlinked", { userId: user.id, meta: { provider } });
    res.status(204).end();
  }),
);

/** Onboarding — accepts the full profile plus trainer + equipment in one call. */
const onboardingSchema = profileSchema.extend({
  trainer: z
    .object({
      name: z.string().min(1).max(40).optional(),
      avatarId: z.string().optional(),
      voiceId: z.string().optional(),
      motivationLevel: z.number().min(0).max(1).optional(),
      coachingDirectness: z.number().min(0).max(1).optional(),
      formStrictness: z.number().min(0).max(1).optional(),
      speakingFrequency: z.number().min(0).max(1).optional(),
      coachingDetail: z.number().min(0).max(1).optional(),
      humor: z.number().min(0).max(1).optional(),
    })
    .optional(),
  equipmentKeys: z.array(z.string()).optional(),
  injuries: z.array(z.object({ tag: z.string(), note: z.string().optional() })).optional(),
  experience: z
    .object({
      calmMode: z.boolean().optional(),
      startTier: z.enum(["starter", "building", "established", "full"]).optional(),
    })
    .optional(),
});

meRouter.post(
  "/onboarding",
  validate({ body: onboardingSchema }),
  asyncHandler(async (req, res) => {
    const { trainer, equipmentKeys, injuries, experience, ...profile } = req.body as z.infer<typeof onboardingSchema>;
    const userId = uid(req);
    const calmMode = experience?.calmMode ?? false;

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { ...profile, onboardingCompletedAt: new Date() } });

      if (trainer) await tx.trainer.update({ where: { userId }, data: trainer });

      if (equipmentKeys?.length) {
        const equipment = await tx.equipment.findMany({ where: { key: { in: equipmentKeys } } });
        await tx.userEquipment.deleteMany({ where: { userId } });
        await tx.userEquipment.createMany({
          data: equipment.map((e) => ({ userId, equipmentId: e.id })),
          skipDuplicates: true,
        });
      }

      if (injuries?.length) {
        await tx.injuryNote.createMany({ data: injuries.map((i) => ({ ...i, userId })) });
      }

      for (const g of GOAL_TEMPLATES) {
        await tx.goal.upsert({
          where: { userId_key: { userId, key: g.key } },
          update: {},
          create: { userId, key: g.key, label: g.label, target: g.target, unit: g.unit, cadence: g.cadence, tone: g.tone },
        });
      }

      // appearance — copy the default preset's values
      const preset = await tx.backgroundPreset.findFirst({ where: { isDefault: true } });
      const g = (preset?.glass ?? { opacity: 0.72, blurPx: 18, tint: "#2A1623" }) as { opacity: number; blurPx: number; tint: string };
      await tx.userAppearance.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          presetId: preset?.id ?? null,
          backgroundMode: preset?.mode ?? "solid",
          backgroundColor: preset?.backgroundColor ?? "#170D17",
          backgroundGradient: preset?.gradient ?? undefined,
          backgroundImageUrl: preset?.imageUrl ?? null,
          backgroundDim: preset?.backgroundDim ?? 0,
          glassOpacity: g.opacity,
          glassBlurPx: Math.round(g.blurPx),
          glassTint: g.tint,
          accentColor: preset?.accentColor ?? null,
          reduceMotion: calmMode,
        },
      });

      // progressive disclosure
      await tx.userDisclosure.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          mode: calmMode ? "on_interaction" : "always",
          widgetOverrides: calmMode ? Object.fromEntries(SAFETY_WIDGETS.map((w) => [w, "always"])) : {},
        },
      });

      // unlock progression
      await tx.userProgression.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          unlockedFeatures: ["dashboard", "workouts", "trainer"],
          gatingEnabled: calmMode ? true : false,
        },
      });
    });

    res.json({ ok: true });
  }),
);

// ── injuries ────────────────────────────────────────────────────────────────
meRouter.get("/injuries", asyncHandler(async (req, res) => {
  res.json(await prisma.injuryNote.findMany({ where: { userId: uid(req) }, orderBy: { createdAt: "desc" } }));
}));
meRouter.post(
  "/injuries",
  validate({ body: z.object({ tag: z.string().min(1), note: z.string().optional() }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await prisma.injuryNote.create({ data: { ...req.body, userId: uid(req) } }));
  }),
);
meRouter.delete("/injuries/:id", asyncHandler(async (req, res) => {
  await prisma.injuryNote.deleteMany({ where: { id: req.params.id, userId: uid(req) } });
  res.status(204).end();
}));

// ── equipment / device connections ──────────────────────────────────────────
meRouter.get("/equipment", asyncHandler(async (req, res) => {
  const all = await prisma.equipment.findMany({ orderBy: { name: "asc" } });
  const mine = new Set(
    (await prisma.userEquipment.findMany({ where: { userId: uid(req) } })).map((e) => e.equipmentId),
  );
  res.json(all.map((e) => ({ ...e, owned: mine.has(e.id) })));
}));

meRouter.put(
  "/equipment",
  validate({ body: z.object({ equipmentKeys: z.array(z.string()) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const equipment = await prisma.equipment.findMany({ where: { key: { in: req.body.equipmentKeys } } });
    await prisma.$transaction([
      prisma.userEquipment.deleteMany({ where: { userId } }),
      prisma.userEquipment.createMany({
        data: equipment.map((e) => ({ userId, equipmentId: e.id })),
        skipDuplicates: true,
      }),
    ]);
    res.json({ ok: true, count: equipment.length });
  }),
);

meRouter.get("/devices", asyncHandler(async (req, res) => {
  const rows = await prisma.deviceConnection.findMany({ where: { userId: uid(req) } });
  // never leak provider tokens to the client
  res.json(
    rows.map(({ accessToken, refreshToken, ...safe }) => ({
      ...safe,
      oauthConnected: !!accessToken,
    })),
  );
}));

/**
 * Start a third-party wearable OAuth flow (§3.3). Returns the provider consent
 * URL for the client to open; `409` (not `501`) when the provider's client
 * credentials aren't configured on this deployment.
 */
meRouter.get(
  "/devices/:provider/connect",
  validate({ params: z.object({ provider: z.enum(["whoop", "oura", "garmin"]) }) }),
  asyncHandler(async (req, res) => {
    const provider = req.params.provider as WearableProvider;
    if (!isConfigured(provider)) {
      const cfg = providerConfig(provider);
      // 200, not an error — the client shows the message and stays put.
      return res.json({
        provider,
        configured: false,
        status: "not_configured",
        message: cfg.kind === "unavailable" ? cfg.reason : "not configured",
      });
    }
    res.json({ provider, configured: true, authorizeUrl: authorizeUrl(uid(req), provider) });
  }),
);

/** Manually trigger a sync for a connected wearable. */
meRouter.post(
  "/devices/:provider/sync",
  validate({ params: z.object({ provider: z.enum(["whoop", "oura", "garmin"]) }) }),
  asyncHandler(async (req, res) => {
    const provider = req.params.provider as WearableProvider;
    const conn = await prisma.deviceConnection.findUnique({
      where: { userId_provider: { userId: uid(req), provider } },
    });
    if (!conn) throw notFound("Not connected");
    if (!conn.accessToken) throw badRequest("This connection has no OAuth token — reconnect it");
    const result = await syncConnection(conn.id);
    res.json(result);
  }),
);

meRouter.delete(
  "/devices/:provider",
  validate({ params: z.object({ provider: z.string() }) }),
  asyncHandler(async (req, res) => {
    await revokeConnection(uid(req), req.params.provider as WearableProvider);
    res.status(204).end();
  }),
);

/**
 * Batch health-metric ingest from the mobile companion (§3.2). Idempotent:
 * dedups on (userId, metricType, recordedAt) so re-syncs are safe. Only writes
 * real rows; DeviceConnection.lastSyncAt advances only on success.
 */
const healthSampleSchema = z.object({
  provider: z.enum(["apple_health", "health_connect"]),
  samples: z
    .array(
      z.object({
        type: z.enum(["sleep", "hrv", "resting_hr", "steps"]),
        value: z.number(),
        unit: z.string(),
        recordedAt: z.coerce.date().optional(),
        date: z.coerce.date().optional(),
        start: z.coerce.date().optional(),
        end: z.coerce.date().optional(),
        sourceBundleId: z.string().optional(),
      }),
    )
    .max(2000),
});

meRouter.post(
  "/health/samples", // → POST /me/health/samples
  validate({ body: healthSampleSchema }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { provider, samples } = req.body as z.infer<typeof healthSampleSchema>;

    await prisma.deviceConnection.upsert({
      where: { userId_provider: { userId, provider } },
      update: {},
      create: { userId, provider, status: "connected" },
    });

    try {
      const normalized = samples.map((s) => ({
        userId,
        metricType: s.type as never,
        value: s.value,
        unit: s.unit,
        recordedAt: s.recordedAt ?? s.end ?? s.date ?? new Date(),
        source: "health_sync" as const,
      }));

      // dedup against what's already stored in the same instants
      const existing = await prisma.progressMetric.findMany({
        where: {
          userId,
          source: "health_sync",
          metricType: { in: [...new Set(normalized.map((n) => n.metricType))] },
          recordedAt: { in: normalized.map((n) => n.recordedAt) },
        },
        select: { metricType: true, recordedAt: true },
      });
      const seen = new Set(existing.map((e) => `${e.metricType}@${e.recordedAt.getTime()}`));
      const fresh = normalized.filter((n) => !seen.has(`${n.metricType}@${n.recordedAt.getTime()}`));

      if (fresh.length) await prisma.progressMetric.createMany({ data: fresh });

      await prisma.deviceConnection.update({
        where: { userId_provider: { userId, provider } },
        data: { lastSyncAt: new Date(), lastError: null, lastErrorAt: null, status: "connected" },
      });

      res.status(201).json({ received: samples.length, ingested: fresh.length, deduped: samples.length - fresh.length });
    } catch (err) {
      await prisma.deviceConnection
        .update({
          where: { userId_provider: { userId, provider } },
          data: { lastError: (err as Error).message.slice(0, 300), lastErrorAt: new Date() },
        })
        .catch(() => {});
      throw err;
    }
  }),
);
meRouter.put(
  "/devices/:provider",
  validate({ body: z.object({ status: z.enum(["connected", "disconnected"]) }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const { provider } = req.params;
    const row = await prisma.deviceConnection.upsert({
      where: { userId_provider: { userId, provider } },
      update: { status: req.body.status, lastSyncAt: req.body.status === "connected" ? new Date() : undefined },
      create: { userId, provider, status: req.body.status, lastSyncAt: new Date() },
    });
    res.json(row);
  }),
);

// ── data export ──────────────────────────────────────────────────────────────
meRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const userId = uid(req);

    const sessions = await prisma.workoutSession.findMany({
      where: { userId },
      include: {
        performances: {
          include: { sets: true, exercise: { select: { name: true } } },
          orderBy: { order: "asc" },
        },
      },
      orderBy: { startedAt: "asc" },
    });

    const foodLogs = await prisma.foodLog.findMany({
      where: { userId },
      orderBy: { loggedAt: "asc" },
    });

    const rows: string[] = [];

    // ── workouts CSV ─────────────────────────────────────────────────────────
    rows.push("## workouts");
    rows.push("session_date,session_name,exercise,set_number,weight_kg,reps,rpe,warmup,estimated_1rm");
    for (const s of sessions) {
      const date = s.startedAt.toISOString().slice(0, 10);
      for (const perf of s.performances) {
        let workingSetNum = 0;
        for (const set of perf.sets) {
          if (!set.isWarmup) workingSetNum++;
          const w = set.weightKg ?? "";
          const reps = set.reps ?? "";
          const rpe = set.rpe ?? "";
          const e1rm =
            set.weightKg && set.reps
              ? Math.round(set.weightKg * (1 + set.reps / 30))
              : "";
          rows.push(
            `${date},"${s.name}","${perf.exercise.name}",${workingSetNum},${w},${reps},${rpe},${set.isWarmup ? 1 : 0},${e1rm}`,
          );
        }
      }
    }

    // ── nutrition CSV ─────────────────────────────────────────────────────────
    rows.push("");
    rows.push("## nutrition");
    rows.push("date,meal_type,food_name,brand,calories,protein_g,carbs_g,fat_g,quantity,serving_unit");
    for (const entry of foodLogs) {
      const date = entry.loggedAt.toISOString().slice(0, 10);
      const name = `"${entry.foodName.replace(/"/g, '""')}"`;
      const brand = `"${(entry.brand ?? "").replace(/"/g, '""')}"`;
      rows.push(
        `${date},${entry.mealType},${name},${brand},${entry.calories ?? ""},${entry.protein ?? ""},${entry.carbs ?? ""},${entry.fat ?? ""},${entry.quantity ?? ""},${entry.servingUnit ?? ""}`,
      );
    }

    const csv = rows.join("\n");
    const filename = `forma-export-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  }),
);
