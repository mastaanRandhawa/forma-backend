import { env } from "../env.js";

/**
 * AI orchestration (§22.7). When ANTHROPIC_API_KEY is unset we return
 * deterministic canned copy so the whole app is usable offline / in dev.
 *
 * Live path: swap the fetch below for the Anthropic SDK. Never send raw video
 * or per-frame pose data here — only computed session facts.
 */

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

  const system = buildSystemPrompt(ctx.trainer, ctx.facts);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.AI_MODEL,
      max_tokens: 400,
      system,
      messages: [
        ...ctx.history.map((m) => ({ role: m.role === "trainer" ? "assistant" : "user", content: m.content })),
        { role: "user", content: ctx.userMessage },
      ],
    }),
  });
  if (!res.ok) return cannedReply(ctx);
  const data = (await res.json()) as { content?: { text?: string }[] };
  return data.content?.[0]?.text?.trim() || cannedReply(ctx);
}

export async function sessionComment(
  trainer: TrainerConfig,
  facts: Record<string, unknown>,
): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) {
    const vol = facts.totalVolumeKg ? `${Math.round(Number(facts.totalVolumeKg))} kg moved` : "solid work";
    const prs = Number(facts.prCount ?? 0);
    return prs > 0
      ? `${vol} and ${prs} new PR${prs > 1 ? "s" : ""} today. That is the session to build on.`
      : `${vol} today. Recovery permitting, we push the top set next time.`;
  }
  return trainerReply({
    trainer,
    history: [],
    userMessage: "Give me a two-sentence post-workout comment based on these facts.",
    facts,
  });
}

function buildSystemPrompt(t: TrainerConfig, facts?: Record<string, unknown>) {
  const tone = t.coachingDirectness > 0.7 ? "direct and blunt" : t.motivationLevel > 0.7 ? "warm and encouraging" : "measured";
  const detail = t.coachingDetail > 0.7 ? "Reference specific numbers." : "Keep it short.";
  return [
    `You are ${t.name}, a personal trainer inside the Forma app. Your tone is ${tone}.`,
    detail,
    t.humor > 0.6 ? "A little humour is fine." : "",
    "Only discuss training, recovery, nutrition basics, and the user's data. Refuse medical diagnosis.",
    facts ? `Session facts: ${JSON.stringify(facts)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function cannedReply(ctx: ChatContext): string {
  const m = ctx.userMessage.toLowerCase();
  if (m.includes("today")) return "Based on your plan, today is upper body push. Chest and shoulders are recovered, so aim to beat your last top set.";
  if (m.includes("shoulder") || m.includes("pain") || m.includes("hurt"))
    return "Let's play it safe. Drop to a neutral grip, cap RPE at 8, and if it still pinches we swap to a machine press. I've noted it.";
  if (m.includes("progress") || m.includes("bench")) return "Your bench estimated 1RM is trending up about 12% over the last 8 weeks. Keep the current rep ranges for two more weeks.";
  if (m.includes("shorter") || m.includes("time")) return "I can trim today to 30 minutes by cutting the accessory work down to one superset. Want me to apply that?";
  return "Got it. Tell me a bit more and I'll adjust the plan.";
}
