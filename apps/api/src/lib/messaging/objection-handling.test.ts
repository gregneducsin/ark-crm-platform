import { describe, it, expect } from "vitest";
import { OBJECTION_LIBRARY, getObjectionScript, AI_DISCLOSURE_SCRIPT } from "./objection-handling.js";
import { getTopicByKey } from "./knowledge-catalog.js";
import { interactivePostCheck } from "./safety.js";
import type { ClaudeInteractiveResult } from "./types.js";

const EM_DASH_RE = /—|--/;

function baseResult(overrides: Partial<ClaudeInteractiveResult> = {}): ClaudeInteractiveResult {
  return {
    action: "reply",
    reply: null,
    confidence: 0.9,
    detectedIntents: [],
    detectedIntent: "unknown",
    knowledgeTopicsUsed: [],
    requiresStaff: false,
    slotUpdates: {},
    resumeTopic: null,
    safetyCodes: [],
    nextQuestion: null,
    linkProvided: false,
    objectionStage: 0,
    objectionKey: null,
    promoOffered: false,
    inboundSentiment: null,
    learnedFirstName: null,
    ...overrides,
  };
}

describe("OBJECTION_LIBRARY structure", () => {
  it("has all 7 approved objection keys, each exactly once", () => {
    const keys = OBJECTION_LIBRARY.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(
      ["found_cheaper", "is_legit", "no_time", "not_qualified", "price", "side_effects", "think_about_it"].sort(),
    );
  });

  it("getObjectionScript finds an existing key and returns undefined for an unknown one", () => {
    expect(getObjectionScript("price")).toBeDefined();
    // @ts-expect-error - intentionally an invalid key to test the not-found path
    expect(getObjectionScript("not_a_real_objection")).toBeUndefined();
  });

  for (const objection of OBJECTION_LIBRARY) {
    describe(`objection: ${objection.key}`, () => {
      it("rebuttal and secondAttempt each have a single trailing question, no em dashes", () => {
        for (const stage of [objection.rebuttal, objection.secondAttempt]) {
          expect(stage.nextQuestion, `${objection.key} nextQuestion`).toBeDefined();
          const nq = stage.nextQuestion!;
          expect(nq.trim().endsWith("?")).toBe(true);
          expect((nq.match(/\?/g) ?? []).length).toBe(1);
          expect(EM_DASH_RE.test(stage.reply)).toBe(false);
          expect(EM_DASH_RE.test(nq)).toBe(false);
        }
      });

      it("standDown has no nextQuestion and contains no question mark at all", () => {
        expect(objection.standDown.nextQuestion).toBeUndefined();
        expect(objection.standDown.reply).not.toContain("?");
        expect(EM_DASH_RE.test(objection.standDown.reply)).toBe(false);
      });

      it("every required topic exists in the knowledge catalog", () => {
        for (const stage of [objection.rebuttal, objection.secondAttempt, objection.standDown]) {
          for (const topicKey of stage.requiredTopics) {
            expect(getTopicByKey(topicKey), `topic "${topicKey}" referenced by ${objection.key}`).toBeDefined();
          }
        }
      });

      it("secondAttempt does not repeat the rebuttal's reply text verbatim", () => {
        expect(objection.secondAttempt.reply).not.toBe(objection.rebuttal.reply);
      });

      it("rebuttal and secondAttempt pass interactivePostCheck as a reply action with declared topics", () => {
        for (const stage of [objection.rebuttal, objection.secondAttempt]) {
          const result = interactivePostCheck(
            baseResult({ reply: stage.reply, nextQuestion: stage.nextQuestion ?? null, knowledgeTopicsUsed: [...stage.requiredTopics] }),
            null,
          );
          expect(result.ok, `${objection.key} stage should pass postCheck: ${!result.ok ? result.code : ""}`).toBe(true);
        }
      });

      it("standDown passes interactivePostCheck as a pause action (no question required)", () => {
        const result = interactivePostCheck(baseResult({ action: "pause", reply: objection.standDown.reply, nextQuestion: null }), null);
        expect(result.ok, `${objection.key} standDown should pass postCheck: ${!result.ok ? result.code : ""}`).toBe(true);
      });

      it("rebuttal citing its required topics is rejected when those topics aren't in the permitted set for the turn (proves topic gating is real)", () => {
        if (objection.rebuttal.requiredTopics.length === 0) return;
        const result = interactivePostCheck(
          baseResult({
            reply: objection.rebuttal.reply,
            nextQuestion: objection.rebuttal.nextQuestion ?? null,
            knowledgeTopicsUsed: [...objection.rebuttal.requiredTopics],
          }),
          null,
          new Set(["__unrelated_topic_not_actually_permitted__"]),
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe("UNKNOWN_KNOWLEDGE_TOPIC");
      });
    });
  }
});

describe("AI_DISCLOSURE_SCRIPT", () => {
  it("never claims to be human", () => {
    const text = `${AI_DISCLOSURE_SCRIPT.reply} ${AI_DISCLOSURE_SCRIPT.nextQuestion}`.toLowerCase();
    expect(text).not.toMatch(/\bi'?m not an ai\b/);
    expect(text).not.toMatch(/\bi'?m a (real )?person\b/);
    expect(text).not.toMatch(/\bi'?m human\b/);
  });

  it("discloses that it is an automated assistant", () => {
    expect(AI_DISCLOSURE_SCRIPT.reply.toLowerCase()).toContain("automated assistant");
  });

  it("offers a human handoff", () => {
    expect(AI_DISCLOSURE_SCRIPT.reply.toLowerCase()).toContain("talk to a person");
  });

  it("is marked non-paraphrasable — must be used verbatim", () => {
    expect(AI_DISCLOSURE_SCRIPT.allowedParaphrase).toBe(false);
  });

  it("has a single trailing question and no em dashes", () => {
    expect(AI_DISCLOSURE_SCRIPT.nextQuestion?.trim().endsWith("?")).toBe(true);
    expect(EM_DASH_RE.test(AI_DISCLOSURE_SCRIPT.reply)).toBe(false);
  });

  it("passes interactivePostCheck as a reply action", () => {
    const result = interactivePostCheck(baseResult({ reply: AI_DISCLOSURE_SCRIPT.reply, nextQuestion: AI_DISCLOSURE_SCRIPT.nextQuestion ?? null }), null);
    expect(result.ok).toBe(true);
  });
});
