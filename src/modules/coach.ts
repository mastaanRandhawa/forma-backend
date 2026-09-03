/**
 * Coach role module (§5.1)
 *
 * Coaches can:
 *   - Request to be linked to an athlete (athlete must approve)
 *   - Read summary session data for linked athletes
 *   - Publish workout templates visible to their athletes
 *
 * Athletes can:
 *   - List pending coach requests and accept/revoke
 *   - Revoke a coach's access at any time
 *
 * Data access: coaches see anonymised summary only (name, totalVolumeKg,
 * sessions per week, last session, PRs). Raw set data stays private.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound, forbidden, badRequest } from "../lib/errors.js";

export const coachRouter = Router();
coachRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

// ── coach views ────────────────────────────────────────────────────────────────

/** GET /coach/athletes — list this coach's active athletes */
coachRouter.get(
  "/athletes",
  asyncHandler(async (req, res) => {
    const coachId = uid(req);
    const coach = await prisma.user.findUnique({ where: { id: coachId }, select: { role: true } });
    if (coach?.role !== "coach") throw forbidden("Coach role required");

    const links = await prisma.coachAthlete.findMany({
      where: { coachId, status: "active" },
      include: { athlete: { select: { id: true, name: true, email: true } } },
    });
    res.json(links.map((l) => ({ ...l.athlete, linkedSince: l.acceptedAt })));
  }),
);

/** GET /coach/athletes/:athleteId/summary — session summary for one athlete */
coachRouter.get(
  "/athletes/:athleteId/summary",
  asyncHandler(async (req, res) => {
    const coachId = uid(req);
    const { athleteId } = req.params;

    const link = await prisma.coachAthlete.findFirst({ where: { coachId, athleteId, status: "active" } });
    if (!link) throw forbidden("No active link with this athlete");

    const since = new Date(Date.now() - 28 * 86400_000);
    const sessions = await prisma.workoutSession.findMany({
      where: { userId: athleteId, status: "completed", startedAt: { gte: since } },
      select: { startedAt: true, totalVolumeKg: true, name: true, durationSeconds: true },
      orderBy: { startedAt: "desc" },
      take: 20,
    });

    const prs = await prisma.personalRecord.findMany({
      where: { userId: athleteId },
      include: { exercise: { select: { name: true } } },
      orderBy: { achievedAt: "desc" },
      take: 5,
    });

    res.json({
      athleteId,
      sessionsLast28Days: sessions.length,
      avgVolumeKg: sessions.length
        ? Math.round(sessions.reduce((s, r) => s + r.totalVolumeKg, 0) / sessions.length)
        : 0,
      recentSessions: sessions.map((s) => ({
        name: s.name,
        date: s.startedAt.toISOString().slice(0, 10),
        volumeKg: Math.round(s.totalVolumeKg),
        durationMin: Math.round(s.durationSeconds / 60),
      })),
      recentPRs: prs.map((p) => ({ exercise: p.exercise.name, type: p.recordType, value: p.value })),
    });
  }),
);

/** POST /coach/request/:athleteId — coach requests to link to an athlete */
coachRouter.post(
  "/request/:athleteId",
  asyncHandler(async (req, res) => {
    const coachId = uid(req);
    const { athleteId } = req.params;
    const coach = await prisma.user.findUnique({ where: { id: coachId }, select: { role: true } });
    if (coach?.role !== "coach") throw forbidden("Coach role required");
    if (coachId === athleteId) throw badRequest("Cannot coach yourself");

    const existing = await prisma.coachAthlete.findFirst({ where: { coachId, athleteId } });
    if (existing?.status === "active") return res.json({ status: "already_linked" });

    let link;
    if (existing) {
      link = await prisma.coachAthlete.update({ where: { id: existing.id }, data: { status: "pending" } });
    } else {
      link = await prisma.coachAthlete.create({ data: { coachId, athleteId, status: "pending" } });
    }
    res.status(201).json(link);
  }),
);

// ── athlete views ──────────────────────────────────────────────────────────────

/** GET /coach/invites — athlete lists pending coach requests */
coachRouter.get(
  "/invites",
  asyncHandler(async (req, res) => {
    const athleteId = uid(req);
    const links = await prisma.coachAthlete.findMany({
      where: { athleteId, status: "pending" },
      include: { coach: { select: { id: true, name: true, email: true } } },
    });
    res.json(links.map((l) => ({ ...l.coach, linkId: l.id, requestedAt: l.createdAt })));
  }),
);

/** POST /coach/invites/:linkId/accept — athlete accepts */
coachRouter.post(
  "/invites/:linkId/accept",
  asyncHandler(async (req, res) => {
    const athleteId = uid(req);
    const link = await prisma.coachAthlete.findFirst({ where: { id: req.params.linkId, athleteId, status: "pending" } });
    if (!link) throw notFound("Invite not found");
    res.json(await prisma.coachAthlete.update({
      where: { id: link.id },
      data: { status: "active", acceptedAt: new Date() },
    }));
  }),
);

/** DELETE /coach/invites/:linkId — athlete revokes access */
coachRouter.delete(
  "/invites/:linkId",
  asyncHandler(async (req, res) => {
    const athleteId = uid(req);
    const link = await prisma.coachAthlete.findFirst({ where: { id: req.params.linkId, athleteId } });
    if (!link) throw notFound("Link not found");
    await prisma.coachAthlete.update({ where: { id: link.id }, data: { status: "revoked" } });
    res.status(204).end();
  }),
);
