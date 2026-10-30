import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { cannedReply, replyText, trainerReply } from "./ai.js";

const thinking = { type: "thinking", thinking: "", signature: "sig" } as Anthropic.ContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.ContentBlock;

describe("replyText", () => {
  it("skips a leading thinking block", () => {
    expect(replyText({ content: [thinking, text("Good session. ")], stop_reason: "end_turn" })).toBe("Good session.");
  });
  it("joins several text blocks", () => {
    expect(replyText({ content: [text("Up 2.5 kg"), text(" next week.")], stop_reason: "end_turn" })).toBe("Up 2.5 kg next week.");
  });
  it("treats a refusal as empty so the caller falls back", () => {
    expect(replyText({ content: [text("partial")], stop_reason: "refusal" })).toBe("");
  });
  it("is empty when only thinking came back", () => {
    expect(replyText({ content: [thinking], stop_reason: "max_tokens" })).toBe("");
  });
});

describe("canned replies", () => {
  const trainer = { name: "Kai", coachingDirectness: 0.5, motivationLevel: 0.5, coachingDetail: 0.5, humor: 0.5 };
  const ask = (userMessage: string) => cannedReply({ trainer, history: [], userMessage });

  it("state no numbers about the user", () => {
    for (const m of ["what's today?", "how is my bench progressing", "make it shorter", "my shoulder hurts", "hi"]) {
      expect(ask(m)).not.toMatch(/\d/);
    }
  });
  it("are what trainerReply returns without a key (tests run keyless)", async () => {
    await expect(trainerReply({ trainer, history: [], userMessage: "hi" })).resolves.toBe(ask("hi"));
  });
});
