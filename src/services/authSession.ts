import type { Request } from "express";
import { prisma } from "../prisma.js";
import { env } from "../env.js";
import { signAccessToken, newRefreshToken, hashRefreshToken } from "../lib/auth.js";
import { clientIp, clientUa } from "./audit.js";

const REMEMBER_DAYS = env.REFRESH_TOKEN_TTL_DAYS; // 30
const SESSION_DAYS = 1; // "remember me" off → short-lived

/**
 * Read the refresh token from the request body (SPA + native both send it there;
 * it is stored client-side, never in an ambient cookie, so there is no CSRF
 * surface — every authenticated call carries an explicit Authorization header).
 */
export const readRefreshToken = (req: Request): string | null =>
  (req.body as { refreshToken?: string } | undefined)?.refreshToken ?? null;

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

/** Create a brand-new session (login / register / social). */
export async function issueSession(
  user: { id: string; email: string },
  req: Request,
  opts: { rememberMe?: boolean } = {},
): Promise<IssuedSession> {
  const rememberMe = opts.rememberMe ?? false;
  const ttlDays = rememberMe ? REMEMBER_DAYS : SESSION_DAYS;

  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      userAgent: clientUa(req),
      ip: clientIp(req),
    },
  });

  const refresh = newRefreshToken(ttlDays);
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      sessionId: session.id,
      tokenHash: refresh.hash,
      expiresAt: refresh.expiresAt,
      userAgent: clientUa(req),
      ip: clientIp(req),
    },
  });

  return {
    accessToken: signAccessToken({ sub: user.id, email: user.email, sid: session.id }),
    refreshToken: refresh.raw,
    sessionId: session.id,
  };
}

/**
 * Rotate a refresh token within its session. Revokes the presented token, mints a
 * fresh one bound to the same Session, returns a new access token. Returns null
 * when the token is unknown / expired / revoked, or its session is gone.
 */
export async function rotateSession(rawRefresh: string, req: Request): Promise<IssuedSession | null> {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawRefresh) },
    include: { user: true, session: true },
  });
  if (!record || record.revokedAt || record.expiresAt < new Date()) return null;

  const session = record.session;
  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    if (session) await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return null;
  }

  const remainingDays = Math.max(1, Math.ceil((session.expiresAt.getTime() - Date.now()) / 86_400_000));
  const refresh = newRefreshToken(remainingDays);
  const expiresAt = session.expiresAt < refresh.expiresAt ? session.expiresAt : refresh.expiresAt;

  await prisma.$transaction([
    prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } }),
    prisma.refreshToken.create({
      data: {
        userId: record.userId,
        sessionId: session.id,
        tokenHash: refresh.hash,
        expiresAt,
        userAgent: clientUa(req),
        ip: clientIp(req),
      },
    }),
    prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }),
  ]);

  return {
    accessToken: signAccessToken({ sub: record.userId, email: record.user.email, sid: session.id }),
    refreshToken: refresh.raw,
    sessionId: session.id,
  };
}

export async function revokeSession(sessionId: string, userId?: string): Promise<boolean> {
  const where = userId ? { id: sessionId, userId } : { id: sessionId };
  const { count } = await prisma.session.updateMany({ where, data: { revokedAt: new Date() } });
  if (count) await prisma.refreshToken.updateMany({ where: { sessionId }, data: { revokedAt: new Date() } });
  return count > 0;
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null, ...(exceptSessionId ? { sessionId: { not: exceptSessionId } } : {}) },
    data: { revokedAt: new Date() },
  });
  return count;
}

export async function listSessions(userId: string, currentSessionId: string | null) {
  const rows = await prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: { id: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true },
  });
  return rows.map((s) => ({ ...s, current: s.id === currentSessionId }));
}
