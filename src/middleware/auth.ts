import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/auth.js";
import { forbidden, unauthorized } from "../lib/errors.js";
import { prisma } from "../prisma.js";

export interface AuthContext {
  userId: string;
  email: string;
  role: "user" | "coach" | "admin";
  sessionId: string;
  emailVerified: boolean;
}

export interface AuthedRequest extends Request {
  /** @deprecated prefer `req.auth` — kept so existing modules compile unchanged. */
  userId: string;
  /** @deprecated prefer `req.auth.email`. */
  userEmail: string;
  auth: AuthContext;
}

const LAST_SEEN_THROTTLE_MS = 5 * 60_000;

/**
 * Authenticated-session guard. Beyond verifying the access-token signature it
 * independently checks, on every request:
 *   1. the token carries a session id (`sid`),
 *   2. that Session exists, is not revoked, and has not expired,
 *   3. the user account still exists and is not soft-deleted.
 * Authorization (role / ownership) is decided downstream from `req.auth`, never
 * from anything the client sent.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  // Idempotent: safe to list both at the router mount and inside a module.
  if ((req as AuthedRequest).auth) return next();

  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return next(unauthorized("Missing bearer token"));

  let payload: ReturnType<typeof verifyAccessToken>;
  try {
    payload = verifyAccessToken(header.slice(7));
  } catch {
    return next(unauthorized("Invalid or expired token", "session_expired"));
  }
  if (!payload.sid) return next(unauthorized("Invalid token", "session_expired"));

  try {
    const session = await prisma.session.findUnique({
      where: { id: payload.sid },
      select: { id: true, revokedAt: true, expiresAt: true, lastSeenAt: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return next(unauthorized("Session expired or revoked", "session_expired"));
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true, deletedAt: true, emailVerifiedAt: true, authProvider: true },
    });
    if (!user || user.deletedAt) {
      return next(unauthorized("Account is not active", "account_inactive"));
    }

    const ctx: AuthContext = {
      userId: user.id,
      email: user.email,
      role: user.role,
      sessionId: session.id,
      emailVerified: user.authProvider !== "email" || user.emailVerifiedAt != null,
    };
    (req as AuthedRequest).auth = ctx;
    (req as AuthedRequest).userId = user.id;
    (req as AuthedRequest).userEmail = user.email;

    if (Date.now() - session.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      void prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Populates `req.auth` when a valid token is present, but never rejects. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return next();
  try {
    const payload = verifyAccessToken(header.slice(7));
    if (payload.sid) {
      const session = await prisma.session.findUnique({
        where: { id: payload.sid },
        select: { id: true, revokedAt: true, expiresAt: true },
      });
      const user =
        session && !session.revokedAt && session.expiresAt > new Date()
          ? await prisma.user.findUnique({
              where: { id: payload.sub },
              select: { id: true, email: true, role: true, deletedAt: true, emailVerifiedAt: true, authProvider: true },
            })
          : null;
      if (user && !user.deletedAt) {
        (req as AuthedRequest).auth = {
          userId: user.id,
          email: user.email,
          role: user.role,
          sessionId: session!.id,
          emailVerified: user.authProvider !== "email" || user.emailVerifiedAt != null,
        };
        (req as AuthedRequest).userId = user.id;
        (req as AuthedRequest).userEmail = user.email;
      }
    }
  } catch {
    /* ignore — treat as anonymous */
  }
  next();
}

/**
 * Gate the main application behind a verified email address. Mounted after
 * `requireAuth` on the product routers; the auth + verification endpoints stay
 * reachable so the user can actually get verified.
 */
export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction) {
  const auth = (req as AuthedRequest).auth;
  if (auth && !auth.emailVerified) {
    return next(forbidden("Email address not verified", "email_not_verified"));
  }
  next();
}

/** Role check — the only source of truth is `req.auth.role` (from the DB). */
export const requireRole =
  (role: AuthContext["role"]) => (req: Request, _res: Response, next: NextFunction) => {
    const auth = (req as AuthedRequest).auth;
    if (!auth) return next(unauthorized());
    if (auth.role !== role) return next(forbidden("Insufficient permissions"));
    next();
  };
