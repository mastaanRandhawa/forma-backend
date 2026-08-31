import type { Request } from "express";
import { prisma } from "../prisma.js";

export type AuthEventName =
  | "register"
  | "login_success"
  | "login_failed"
  | "login_locked"
  | "mfa_challenged"
  | "mfa_success"
  | "mfa_failed"
  | "recovery_code_used"
  | "token_refreshed"
  | "logout"
  | "logout_all"
  | "session_revoked"
  | "password_reset_requested"
  | "password_reset_completed"
  | "password_changed"
  | "email_verification_sent"
  | "email_verified"
  | "email_change_requested"
  | "email_changed"
  | "mfa_enabled"
  | "mfa_disabled"
  | "recovery_codes_regenerated"
  | "connected_account_unlinked"
  | "account_deleted";

/** Client IP, honouring the `trust proxy` setting configured on the app. */
export const clientIp = (req: Request) => (req.ip ?? req.socket.remoteAddress ?? "").slice(0, 45);
export const clientUa = (req: Request) => String(req.headers["user-agent"] ?? "").slice(0, 300);

/**
 * Append an entry to the auth audit trail. Best-effort: a logging failure must
 * never break the request. Never pass raw tokens, passwords, or secrets in `meta`.
 */
export async function logAuthEvent(
  req: Request,
  event: AuthEventName,
  opts: { userId?: string | null; email?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await prisma.authEvent.create({
      data: {
        event,
        userId: opts.userId ?? null,
        email: opts.email?.toLowerCase() ?? null,
        ip: clientIp(req),
        userAgent: clientUa(req),
        meta: opts.meta ? (opts.meta as object) : undefined,
      },
    });
  } catch (err) {
    console.error("audit log failed", event, err);
  }
}
