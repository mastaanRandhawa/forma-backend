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

/**
 * Extra-tight limit for the credential-guessing surface: login + MFA challenge.
 * Layered on top of `authLimiter` and the per-account lockout in modules/auth.ts.
 */
export const loginLimiter = rateLimit({
  windowMs: 5 * 60_000,
  limit: isProd ? 15 : 100_000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "too_many_requests", message: "Too many attempts, try again in a few minutes" } },
});

/**
 * Food search / barcode lookup. Sits in front of the external providers, whose
 * own limits are ~10–15 req/min/IP — this keeps us well under and absorbs
 * debounce bursts. Diary CRUD is not limited by this.
 */
export const foodLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 40 : 100_000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Slow down on food lookups for a moment" } },
});

/** Limit AI calls (cost control). */
export const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: isProd ? 20 : 100_000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Easy — give the coach a second" } },
});
