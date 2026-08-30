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
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN.split(",").map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan(isProd ? "combined" : "dev"));
  app.use(globalLimiter);

  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
