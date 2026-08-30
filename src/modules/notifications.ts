import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

// ── Notifications Center (H2) ───────────────────────────────────────────────
notificationsRouter.get(
  "/",
  validate({ query: z.object({ unread: z.enum(["true", "false"]).optional(), take: z.coerce.number().max(100).default(50) }) }),
  asyncHandler(async (req, res) => {
    const { unread, take } = req.query as unknown as { unread?: string; take: number };
    const [items, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: uid(req), ...(unread === "true" ? { readAt: null } : {}) },
        orderBy: { createdAt: "desc" },
        take,
      }),
      prisma.notification.count({ where: { userId: uid(req), readAt: null } }),
    ]);
    res.json({ items, unreadCount });
  }),
);

notificationsRouter.post("/:id/read", asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { id: req.params.id, userId: uid(req) }, data: { readAt: new Date() } });
  res.json({ ok: true });
}));

notificationsRouter.post("/read-all", asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: uid(req), readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
}));

notificationsRouter.delete("/:id", asyncHandler(async (req, res) => {
  await prisma.notification.deleteMany({ where: { id: req.params.id, userId: uid(req) } });
  res.status(204).end();
}));

// ── Notification Preferences (S6) ──────────────────────────────────────────
const prefsSchema = z.object({
  workoutReminders: z.boolean().optional(),
  restTimerAlerts: z.boolean().optional(),
  trainerMessages: z.boolean().optional(),
  milestones: z.boolean().optional(),
  weeklySummary: z.boolean().optional(),
  checkIns: z.boolean().optional(),
  reminderTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
});

notificationsRouter.get("/preferences", asyncHandler(async (req, res) => {
  const userId = uid(req);
  const prefs = await prisma.notificationPreference.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
  res.json(prefs);
}));

notificationsRouter.put(
  "/preferences",
  validate({ body: prefsSchema }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const prefs = await prisma.notificationPreference.upsert({
      where: { userId },
      update: req.body,
      create: { userId, ...req.body },
    });
    res.json(prefs);
  }),
);
