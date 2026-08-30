import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { asyncHandler } from "../lib/http.js";
import { validate } from "../middleware/validate.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { notFound, badRequest } from "../lib/errors.js";
import { trainerReply } from "../services/ai.js";

export const chatRouter = Router();
chatRouter.use(requireAuth);
const uid = (req: unknown) => (req as AuthedRequest).userId;

chatRouter.get(
  "/",
  validate({ query: z.object({ take: z.coerce.number().max(200).default(50), before: z.coerce.date().optional() }) }),
  asyncHandler(async (req, res) => {
    const { take, before } = req.query as unknown as { take: number; before?: Date };
    const messages = await prisma.chatMessage.findMany({
      where: { userId: uid(req), ...(before ? { createdAt: { lt: before } } : {}) },
      orderBy: { createdAt: "desc" },
      take,
    });
    res.json(messages.reverse());
  }),
);

/** Shared send path for text (POST /) and voice (POST /voice). */
async function handleMessage(userId: string, content: string, viaVoice: boolean) {
  const [trainer, history] = await Promise.all([
    prisma.trainer.findUniqueOrThrow({ where: { userId } }),
    prisma.chatMessage.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 10 }),
  ]);

  const userMessage = await prisma.chatMessage.create({ data: { userId, role: "user", content, viaVoice } });

  const replyText = await trainerReply({
    trainer,
    history: history.reverse().map((m) => ({ role: m.role, content: m.content })),
    userMessage: content,
  });

  const trainerMessage = await prisma.chatMessage.create({
    data: {
      userId,
      role: "trainer",
      content: replyText,
      viaVoice,
      trainerSnapshot: {
        name: trainer.name,
        coachingDirectness: trainer.coachingDirectness,
        motivationLevel: trainer.motivationLevel,
        coachingDetail: trainer.coachingDetail,
        formStrictness: trainer.formStrictness,
        humor: trainer.humor,
        voiceId: trainer.voiceId,
      },
    },
  });

  return { userMessage, trainerMessage };
}

chatRouter.post(
  "/",
  validate({ body: z.object({ content: z.string().min(1).max(4000) }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await handleMessage(uid(req), (req.body as { content: string }).content, false));
  }),
);

/** Voice Conversation Mode (T3) — client does STT/TTS, sends the transcript. */
chatRouter.post(
  "/voice",
  validate({ body: z.object({ transcript: z.string().min(1).max(4000) }) }),
  asyncHandler(async (req, res) => {
    res.status(201).json(await handleMessage(uid(req), (req.body as { transcript: string }).transcript, true));
  }),
);

/** Apply an "ApplyAction" card embedded in a trainer message (T1). */
chatRouter.post(
  "/messages/:id/apply",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const msg = await prisma.chatMessage.findFirst({ where: { id: req.params.id, userId, role: "trainer" } });
    if (!msg) throw notFound("Message not found");
    const rich = (msg.richContent ?? {}) as { applyAction?: { type: string; payload?: Record<string, unknown> } };
    if (!rich.applyAction) throw badRequest("Message has no apply action");

    // The action types the trainer can propose. Extend as the AI layer grows.
    let result: unknown = { acknowledged: true };
    if (rich.applyAction.type === "shorten_workout") {
      const w = await prisma.workout.findFirst({
        where: { userId, isTemplate: false, scheduledDate: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
        include: { exercises: { orderBy: { order: "asc" } } },
        orderBy: { scheduledDate: "asc" },
      });
      if (w && w.exercises.length > 3) {
        const drop = w.exercises.slice(-2).map((e) => e.id);
        await prisma.workoutExercise.deleteMany({ where: { id: { in: drop } } });
        result = { workoutId: w.id, removed: drop.length };
      }
    }

    await prisma.chatMessage.update({ where: { id: msg.id }, data: { appliedAt: new Date() } });
    res.json({ ok: true, result });
  }),
);

chatRouter.delete("/", asyncHandler(async (req, res) => {
  await prisma.chatMessage.deleteMany({ where: { userId: uid(req) } });
  res.status(204).end();
}));

/** Context-aware suggested prompts (T1). */
chatRouter.get(
  "/suggested-prompts",
  asyncHandler(async (req, res) => {
    const userId = uid(req);
    const lastSession = await prisma.workoutSession.findFirst({
      where: { userId, status: "completed" },
      orderBy: { startedAt: "desc" },
      include: { performances: { include: { sets: true } } },
    });
    const prompts = ["What should I train today?", "How's my bench progressing?"];
    const lowForm = lastSession?.performances.some((p) => p.sets.some((s) => (s.formScore ?? 100) < 70));
    if (lowForm) prompts.push("My form dropped last session, what happened?");
    prompts.push("Make today's workout shorter");
    res.json(prompts);
  }),
);
