import crypto from "node:crypto";

/** SHA-256 hex digest — used for opaque token lookups (never store the raw token). */
export const sha256 = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");

/** URL-safe random token, `bytes` of entropy (default 32 → 43 chars). */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/** Constant-time compare of two strings (hashed first to equalize length). */
export const safeEqual = (a: string, b: string) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest(),
  );
