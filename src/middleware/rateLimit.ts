import rateLimit from "express-rate-limit";
import { isProd } from "../env.js";

/** Generous global limit — protects against runaway clients, not a WAF. */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 240 : 100_000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many requests, slow down" } },
});

/** Tight limit on auth endpoints — credential stuffing / brute force. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: isProd ? 20 : 100_000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: { code: "rate_limited", message: "Too many attempts, try again later" } },
});

/** Limit AI calls (cost control). */
export const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 20 : 100_000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Easy — give the coach a second" } },
});
