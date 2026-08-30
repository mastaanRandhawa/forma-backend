import { Router } from "express";
import { authLimiter, aiLimiter } from "./middleware/rateLimit.js";
import { authRouter } from "./modules/auth.js";
import { meRouter } from "./modules/me.js";
import { trainerRouter } from "./modules/trainer.js";
import { libraryRouter } from "./modules/library.js";
import { workoutsRouter } from "./modules/workouts.js";
import { programsRouter } from "./modules/programs.js";
import { sessionsRouter } from "./modules/sessions.js";
import { progressRouter } from "./modules/progress.js";
import { goalsRouter } from "./modules/goals.js";
import { chatRouter } from "./modules/chat.js";
import { storeRouter } from "./modules/store.js";
import { bodyRouter } from "./modules/body.js";
import { dashboardRouter } from "./modules/dashboard.js";
import { notificationsRouter } from "./modules/notifications.js";
import { achievementsRouter } from "./modules/achievements.js";
import { subscriptionRouter } from "./modules/subscription.js";
import { docsRouter } from "./modules/docs.js";
import { configRouter } from "./modules/config.js";

export const api = Router();

api.get("/health", (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
api.use("/docs", docsRouter); // GET /docs, /docs/openapi.json, /docs/openapi.yaml
api.use("/config", configRouter); // GET /config/appearance-presets (auth optional)

api.use("/auth", authLimiter, authRouter);
api.use("/me", meRouter);
api.use("/trainer", trainerRouter);
api.use("/library", libraryRouter);
api.use("/workouts", workoutsRouter);
api.use("/programs", programsRouter);
api.use("/sessions", sessionsRouter);
api.use("/progress", progressRouter);
api.use("/goals", goalsRouter);
api.use("/chat", aiLimiter, chatRouter);
api.use("/store", storeRouter);
api.use("/body", bodyRouter);
api.use("/dashboard", dashboardRouter);
api.use("/notifications", notificationsRouter);
api.use("/achievements", achievementsRouter);
api.use("/subscription", subscriptionRouter);
