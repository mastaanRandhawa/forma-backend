import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound } from "../lib/errors.js";

export const goalsRouter = Router();
goalsRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

/** period key: daily -> YYYY-MM-DD, weekly -> YYYY-Www (ISO week). */
function periodKey(cadence: "daily" | "weekly", d = new Date()) {
  if (cadence === "daily") return d.toISOString().slice(0, 10);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

goalsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const goals = await prisma.goal.findMany({ where: { userId: uid(req), active: true }, orderBy: { createdAt: "asc" } });
    const out = await Promise.all(
      goals.map(async (g) => {
        const key = periodKey(g.cadence);
        const entry = await prisma.goalEntry.findUnique({ where: { goalId_periodKey: { goalId: g.id, periodKey: key } } });
        return { ...g, current: entry?.value ?? 0, completed: entry?.completed ?? false, periodKey: key };
      }),
    );
    res.json(out);
  }),
);

goalsRouter.post(
  "/",
  validate({
    body: z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      target: z.number().positive(),
      unit: z.string(),
      cadence: z.enum(["daily", "weekly"]),
      tone: z.string().default("pink"),
    }),
  }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const body = req.body as {
      key: string; label: string; target: number; unit: string;
      cadence: "daily" | "weekly"; tone: string;
    };
    const goal = await prisma.goal.upsert({
      where: { userId_key: { userId, key: body.key } },
      update: body,
      create: { ...body, userId },
    });
    res.status(201).json(goal);
  }),
);

/** Log progress toward a goal for the current period (set or increment). */
goalsRouter.post(
  "/:id/log",
  validate({ body: z.object({ value: z.number(), mode: z.enum(["set", "increment"]).default("set") }) }),
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const goal = await prisma.goal.findFirst({ where: { id: req.params.id, userId } });
    if (!goal) throw notFound("Goal not found");
    const { value, mode } = req.body as { value: number; mode: "set" | "increment" };
    const key = periodKey(goal.cadence);

    const existing = await prisma.goalEntry.findUnique({ where: { goalId_periodKey: { goalId: goal.id, periodKey: key } } });
    const next = mode === "increment" ? (existing?.value ?? 0) + value : value;
    const entry = await prisma.goalEntry.upsert({
      where: { goalId_periodKey: { goalId: goal.id, periodKey: key } },
      update: { value: next, completed: next >= goal.target },
      create: { goalId: goal.id, periodKey: key, value: next, completed: next >= goal.target },
    });
    res.json({ ...goal, current: entry.value, completed: entry.completed, periodKey: key });
  }),
);

goalsRouter.delete("/:id", asyncHandler(async (req, res) => {
  await prisma.goal.updateMany({ where: { id: req.params.id, userId: uid(req) }, data: { active: false } });
  res.status(204).end();
}));
