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

function cannedReply(ctx: ChatContext): string {
  const m = ctx.userMessage.toLowerCase();
  if (m.includes("today")) return "Based on your plan, today is upper body push. Aim to beat your last top set on the first compound.";
  if (m.includes("shoulder") || m.includes("pain") || m.includes("hurt"))
    return "Let's play it safe. Drop to a neutral grip, cap RPE at 8, and if it still pinches we swap to a machine press. I've noted it.";
  if (m.includes("progress") || m.includes("bench")) return "Your bench estimated 1RM is trending up about 12% over the last 8 weeks. Keep the current rep ranges for two more weeks.";
  if (m.includes("shorter") || m.includes("time")) return "I can trim today to 30 minutes by cutting the accessory work down to one superset. Want me to apply that?";
  return "Got it. Tell me a bit more and I'll adjust the plan.";
}
