/**
 * Kai memory (§3.3)
 *
 * Extracts structured facts from chat messages and injects the most relevant
 * ones into future Kai system prompts.
 *
 * Extraction is keyword-heuristic (no LLM round-trip). The live AI path can
 * be upgraded to a classifier prompt when budget allows.
 */

import { prisma } from "../prisma.js";

export type MemoryKind = "injury" | "goal" | "pr_pride" | "complaint" | "preference" | "context";

interface MemoryCandidate {
  kind: MemoryKind;
  subject: string;
  content: string;
}

// ── extraction heuristics ─────────────────────────────────────────────────────

const INJURY_PATTERNS = [
  /(?:my|the)\s+(\w+(?:\s+\w+)?)\s+(?:hurts?|aches?|is\s+sore|is\s+clicking|is\s+tight|is\s+injured)/i,
  /(?:pain|strain|pull|tweak)\s+(?:in|my)\s+(\w+(?:\s+\w+)?)/i,
];

const PR_PRIDE_PATTERNS = [
  /(?:just|finally|new)\s+(?:hit|got|set|pulled|pressed|squatted|benched)\s+([0-9]+\s*(?:kg|lb))/i,
  /(?:i\s+)?(?:pr['d]?|personal\s+record)\s+(?:on|in|with)?\s*(\w+)/i,
];

const GOAL_PATTERNS = [
  /(?:want\s+to|trying\s+to|goal\s+is\s+to)\s+(.{5,60})/i,
  /(?:building|gaining|losing|improving)\s+(.{3,40})/i,
];

const COMPLAINT_PATTERNS = [
  /(?:tired of|hate|don't like|struggling with)\s+(.{3,50})/i,
  /(?:always|keep)\s+(?:failing|missing|skipping)\s+(.{3,40})/i,
];

function extractCandidates(text: string): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];

  for (const re of INJURY_PATTERNS) {
    const m = text.match(re);
    if (m) {
      const subject = m[1].toLowerCase().replace(/\s+/g, "_");
      candidates.push({
        kind: "injury",
        subject,
        content: `User mentioned ${m[1]} injury or pain: "${text.slice(0, 120)}"`,
      });
    }
  }

  for (const re of PR_PRIDE_PATTERNS) {
    const m = text.match(re);
    if (m) {
      candidates.push({
        kind: "pr_pride",
        subject: m[1].toLowerCase().replace(/\s+/g, "_"),
        content: `User is proud of a PR: "${text.slice(0, 120)}"`,
      });
    }
  }

  for (const re of GOAL_PATTERNS) {
    const m = text.match(re);
    if (m) {
      candidates.push({
        kind: "goal",
        subject: m[1].toLowerCase().slice(0, 40).replace(/\s+/g, "_"),
        content: `User stated goal: "${text.slice(0, 120)}"`,
      });
    }
  }

  for (const re of COMPLAINT_PATTERNS) {
    const m = text.match(re);
    if (m) {
      candidates.push({
        kind: "complaint",
        subject: m[1].toLowerCase().slice(0, 40).replace(/\s+/g, "_"),
        content: `User complaint: "${text.slice(0, 120)}"`,
      });
    }
  }

  return candidates;
}

// ── public API ────────────────────────────────────────────────────────────────

/** Call after every user chat message to extract and upsert memories. */
export async function extractMemories(userId: string, text: string): Promise<void> {
  const candidates = extractCandidates(text);
  if (!candidates.length) return;

  await Promise.all(
    candidates.map((c) =>
      prisma.kaiMemory.upsert({
        where: {
          // synthetic unique — use a raw update if no unique index exists yet
          id: `${userId}:${c.kind}:${c.subject}`,
        },
        update: { content: c.content, score: 1.0, updatedAt: new Date() },
        create: {
          id: `${userId}:${c.kind}:${c.subject}`,
          userId,
          kind: c.kind,
          subject: c.subject,
          content: c.content,
        },
      }).catch(() =>
        // fallback: just create (id may already exist with different content)
        prisma.kaiMemory.create({
          data: { userId, kind: c.kind, subject: c.subject, content: c.content },
        }).catch(() => null),
      ),
    ),
  );
}

/** Retrieve the top-N most relevant memories as prompt-injectable strings. */
export async function recallMemories(userId: string, limit = 5): Promise<string[]> {
  const rows = await prisma.kaiMemory.findMany({
    where: { userId },
    orderBy: [{ score: "desc" }, { updatedAt: "desc" }],
    take: limit,
  });
  return rows.map((r) => r.content);
}

/** Decay all memory scores for a user slightly (call weekly / on session end). */
export async function decayMemories(userId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "KaiMemory"
    SET score = score * 0.95
    WHERE "userId" = ${userId} AND score > 0.01
  `;
}
