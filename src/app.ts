import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env, isProd } from "./env.js";
import { api } from "./routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestId } from "./middleware/requestId.js";
import { globalLimiter } from "./middleware/rateLimit.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);

  app.use(requestId);
  app.use(
    helmet({
      // API is JSON-only and consumed cross-origin by the SPA; HSTS in prod, and
      // don't let helmet's COEP/CORP defaults interfere with credentialed CORS.
      hsts: isProd ? { maxAge: 15_552_000, includeSubDomains: true } : false,
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy: false,
    }),
  );
  // Allowed browser origins: the configured WEB_ORIGIN list (production), plus
  // ANY localhost / 127.0.0.1 / [::1] port so every local dev server — whatever
  // port Vite lands on — works without touching env. Non-browser callers (curl,
  // the mobile app, server-to-server) send no Origin and are always allowed.
  const allowList = new Set(
    env.WEB_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  );
  const isLocalhost = (origin: string) =>
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

  app.use(
    cors({
      origin(origin, cb) {
        const ok = !origin || allowList.has(origin) || (!isProd && isLocalhost(origin));
        // `false` (not an Error) → no CORS headers, the browser blocks it, no 500.
        cb(null, ok);
      },
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "X-Client-Platform"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(isProd ? "combined" : "dev"));
  app.use(globalLimiter);

  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
