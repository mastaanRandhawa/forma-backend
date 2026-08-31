import { Router } from "express";
import { authLimiter, aiLimiter } from "./middleware/rateLimit.js";
import { requireAuth, requireVerifiedEmail } from "./middleware/auth.js";
import { authRouter } from "./modules/auth.js";
import { meRouter } from "./modules/me.js";
import { trainerRouter } from "./modules/trainer.js";
import { libraryRouter } from "./modules/library.js";
import { workoutsRouter } from "./modules/workouts.js";
import { programsRouter } from "./modules/programs.js";
import { sessionsRouter } from "./modules/sessions.js";
import { progressRouter } from "./modules/progress.js";
import { foodRouter } from "./modules/food.js";
import { goalsRouter } from "./modules/goals.js";
import { chatRouter } from "./modules/chat.js";
import { storeRouter } from "./modules/store.js";
import { customizationRouter } from "./modules/customization.js";
import { bodyRouter } from "./modules/body.js";
import { dashboardRouter } from "./modules/dashboard.js";
import { notificationsRouter } from "./modules/notifications.js";
import { achievementsRouter } from "./modules/achievements.js";
import { subscriptionRouter } from "./modules/subscription.js";
import { docsRouter } from "./modules/docs.js";
import { configRouter } from "./modules/config.js";
import { oauthRouter } from "./modules/oauth.js";

export const api = Router();

api.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
api.use("/docs", docsRouter); // GET /docs, /docs/openapi.json, /docs/openapi.yaml
api.use("/config", configRouter); // GET /config/appearance-presets (auth optional)
api.use("/oauth", oauthRouter); // GET /oauth/:provider/callback — wearable OAuth (public, state-signed)

api.use("/auth", authLimiter, authRouter);

// Everything below is the application proper: requires a valid session AND a
// verified email address. `requireAuth` is idempotent, so the modules keeping
// their own `router.use(requireAuth)` is harmless.
const app = [requireAuth, requireVerifiedEmail];
api.use("/me", app, meRouter);
api.use("/trainer", app, trainerRouter);
api.use("/library", app, libraryRouter);
api.use("/workouts", app, workoutsRouter);
api.use("/programs", app, programsRouter);
api.use("/sessions", app, sessionsRouter);
api.use("/progress", app, progressRouter);
api.use("/food", app, foodRouter);
api.use("/goals", app, goalsRouter);
api.use("/chat", aiLimiter, app, chatRouter);
api.use("/store", app, storeRouter);
api.use("/customization", app, customizationRouter);
api.use("/body", app, bodyRouter);
api.use("/dashboard", app, dashboardRouter);
api.use("/notifications", app, notificationsRouter);
api.use("/achievements", app, achievementsRouter);
api.use("/subscription", app, subscriptionRouter);
