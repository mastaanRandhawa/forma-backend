import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";

/**
 * AI orchestration (§22.7). When ANTHROPIC_API_KEY is unset — or a live call
 * fails — we return canned copy so the app stays usable offline / in dev.
 *
 * Never send raw video or per-frame pose data here — only computed session facts.
 */

// Built on first live call so the canned path never needs a key. A chat reply
// sits in the request path, so cap the wait: 30 s per attempt, one retry.
let client: Anthropic | null = null;
const anthropic = () =>
  (client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 30_000, maxRetries: 1 }));

interface TrainerConfig {
  name: string;
  coachingDirectness: number;
  motivationLevel: number;
  coachingDetail: number;
  humor: number;
}

interface ChatContext {
  trainer: TrainerConfig;
  history: { role: "user" | "trainer"; content: string }[];
  userMessage: string;
  facts?: Record<string, unknown>;
}

export async function trainerReply(ctx: ChatContext): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) return cannedReply(ctx);

  try {
    const message = await anthropic().messages.create({
      model: env.AI_MODEL,
      // max_tokens covers thinking as well as the answer; the system prompt is
      // what keeps replies short. Low effort suits chat.
      max_tokens: 16000,
      output_config: { effort: "low" },
      system: buildSystemPrompt(ctx.trainer, ctx.facts),
      messages: [
        ...ctx.history.map((m): Anthropic.MessageParam => ({
          role: m.role === "trainer" ? "assistant" : "user",
          content: m.content,
        })),
        { role: "user", content: ctx.userMessage },
      ],
    });
    return replyText(message) || cannedReply(ctx);
  } catch (err) {
    console.error("trainer reply failed", err);
    return cannedReply(ctx);
  }
}

/**
 * The reply's text blocks joined. Thinking blocks are skipped (they can come
 * first), and a refusal reads as empty so the caller falls back.
 */
export function replyText(message: Pick<Anthropic.Message, "content" | "stop_reason">): string {
  if (message.stop_reason === "refusal") return "";
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export async function sessionComment(
  trainer: TrainerConfig,
  facts: Record<string, unknown>,
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    return cannedDebrief(facts);
  }
  return trainerReply({
    trainer,
    history: [],
    userMessage:
      "Write a 2–3 sentence post-workout debrief. Reference specific sets or PRs from the facts. " +
      "Note what went well and give one concrete thing to watch for next session. No generic filler.",
    facts,
  });
}

function cannedDebrief(facts: Record<string, unknown>): string {
  const vol = facts.totalVolumeKg ? `${Math.round(Number(facts.totalVolumeKg))} kg` : null;
  const prs = Number(facts.prCount ?? 0);
  const exercises = Number(facts.exercises ?? 0);
  const durationMin = Math.round(Number(facts.durationSeconds ?? 0) / 60);
  const readiness = Number(facts.readiness ?? 0);
  const abovePlan = Boolean(facts.aboveTargetSets);
  const belowPlan = Boolean(facts.belowTargetSets);

  const parts: string[] = [];

  if (prs > 0) {
    parts.push(`${prs} new PR${prs > 1 ? "s" : ""} today — that's the headline.`);
  } else if (vol) {
    parts.push(`${vol} across ${exercises} exercise${exercises !== 1 ? "s" : ""} in ${durationMin} minutes.`);
  }

  if (abovePlan) {
    parts.push("You exceeded the target sets — solid output, especially if RPE stayed controlled.");
  } else if (belowPlan && readiness < 60) {
    parts.push(`With readiness at ${readiness}, pulling back was the right call — not every session needs to be a PB.`);
  } else if (belowPlan) {
    parts.push("A couple of sets fell short of the plan. Check sleep tonight and come in fresh next time.");
  }

  const highRpeExercise = facts.highRpeExercise as string | undefined;
  if (highRpeExercise) {
    parts.push(`Watch the RPE on ${highRpeExercise} next session — if it stays high at the same weight, we deload that lift.`);
  } else {
    parts.push("Recovery permitting, push the top set by 2.5 kg next time.");
  }

  return parts.join(" ");
}

function buildSystemPrompt(t: TrainerConfig, facts?: Record<string, unknown>) {
  const tone = t.coachingDirectness > 0.7 ? "direct and blunt" : t.motivationLevel > 0.7 ? "warm and encouraging" : "measured";
  const detail = t.coachingDetail > 0.7 ? "Reference specific numbers." : "Keep it short.";

  // inject Kai memory as a separate block so it reads naturally
  const memories = facts?.kaiMemory as string[] | undefined;
  const memoryBlock = memories?.length
    ? `What you remember about this user: ${memories.join(" | ")}`
    : "";

  const factsWithoutMemory = facts
    ? Object.fromEntries(Object.entries(facts).filter(([k]) => k !== "kaiMemory"))
    : null;

  return [
    `You are ${t.name}, a personal trainer inside the Forma app. Your tone is ${tone}.`,
    detail,
    t.humor > 0.6 ? "A little humour is fine." : "",
    "Only discuss training, recovery, nutrition basics, and the user's data. Refuse medical diagnosis.",
    "Any weights, reps, sets, or RPE targets are already decided by Forma's rules engine and passed to you in the facts. Use those exact numbers — never invent or override them.",
    "'Muscle activation' means how much a muscle was worked recently. Never describe a muscle as 'recovered' or 'not recovered' from an activation score.",
    memoryBlock,
    factsWithoutMemory && Object.keys(factsWithoutMemory).length
      ? `Session facts (authoritative): ${JSON.stringify(factsWithoutMemory)}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Offline / failure copy. It must not state facts about the user — it has
 * none — so it gives general guidance and says the coach is unavailable.
 */
export function cannedReply(ctx: ChatContext): string {
  const m = ctx.userMessage.toLowerCase();
  if (m.includes("shoulder") || m.includes("pain") || m.includes("hurt"))
    return "Play it safe: skip whatever aggravates it today and train around it. If the pain is sharp or still there in a few days, get it checked by a physio or doctor.";
  return "I can't reach the coaching service right now, so I can't look at your training properly. Your plan and history are still on the Workouts and Progress tabs. Try me again in a bit.";
}
