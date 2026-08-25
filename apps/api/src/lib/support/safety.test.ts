import { describe, it, expect } from "vitest";
import { supportPreCheck, supportPostCheck } from "./safety.js";
import { getTopicByKey } from "../messaging/knowledge-catalog.js";
import type { SophieInteractiveResult } from "./types.js";

function reply(overrides: Partial<SophieInteractiveResult> = {}): SophieInteractiveResult {
  return {
    action: "reply",
    reply: "Your order has been received and is with the doctor for review.",
    confidence: 0.9,
    detectedIntents: [],
    knowledgeTopicsUsed: [],
    requiresStaff: false,
    safetyCodes: [],
    nextQuestion: "Is there anything else I can help with?",
    inboundSentiment: null,
    ...overrides,
  };
}

describe("supportPreCheck", () => {
  it("passes ordinary messages", () => {
    expect(supportPreCheck("When will my order ship?")).toEqual({ blocked: false });
  });

  it("blocks STOP as opt-out", () => {
    expect(supportPreCheck("STOP")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("blocks emergency content", () => {
    expect(supportPreCheck("this is an emergency")).toEqual({ blocked: true, code: "EMERGENCY_CONTENT" });
  });

  it("blocks prescription-specific questions", () => {
    expect(supportPreCheck("what dosage am I on")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("can I change my prescription")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("what side effects should I expect")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
  });

  it("does not block plain order/shipping questions", () => {
    expect(supportPreCheck("where is my tracking number")).toEqual({ blocked: false });
    expect(supportPreCheck("how do I log into the portal")).toEqual({ blocked: false });
  });

  it("does not block plain fulfillment questions that happen to mention medication generically", () => {
    expect(supportPreCheck("when will my medication ship")).toEqual({ blocked: false });
    expect(supportPreCheck("has my medication been sent yet")).toEqual({ blocked: false });
  });

  it("blocks natural rephrasings of prescription-specific questions that previously slipped through", () => {
    expect(supportPreCheck("how many mg do I take")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("what medication am I on")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("what am I taking")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("why am I prescribed this")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("my dose hasn't changed, is that right")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
  });

  it("blocks legal content", () => {
    expect(supportPreCheck("I'm going to get my lawyer involved")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
    // No trailing space/comma after "sue" — was previously missed.
    expect(supportPreCheck("I am going to sue")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
    expect(supportPreCheck("I will sue.")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
    expect(supportPreCheck("are you going to sue?")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
  });

  it("does not false-positive on words that merely contain the substring 'sue'", () => {
    // "pursue this" previously matched the old "sue " substring check.
    expect(supportPreCheck("I want to pursue this further")).toEqual({ blocked: false });
    expect(supportPreCheck("this is an issue with my order")).toEqual({ blocked: false });
  });

  it("does not treat '911' embedded in an unrelated number as an emergency", () => {
    expect(supportPreCheck("My tracking number is 78911, any updates?")).toEqual({ blocked: false });
  });

  it("still blocks a real 911 mention", () => {
    expect(supportPreCheck("This is a 911 emergency, please call me")).toEqual({ blocked: true, code: "EMERGENCY_CONTENT" });
  });

  it("does not treat 'omg' as a dosage ('mg') mention", () => {
    expect(supportPreCheck("OMG thank you so much!!")).toEqual({ blocked: false });
  });

  it("still blocks a real dosage-in-digits mention", () => {
    expect(supportPreCheck("I take 5mg right now")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
  });

  it("does not treat a non-medical safety question as a prescription question", () => {
    expect(supportPreCheck("Is it safe to leave the package on my porch?")).toEqual({ blocked: false });
  });

  it("still blocks medication-safety questions phrased as 'is it safe'", () => {
    expect(supportPreCheck("Is it safe to take this with my other meds?")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
    expect(supportPreCheck("Is it safe for me to double up this week?")).toEqual({ blocked: true, code: "PRESCRIPTION_QUESTION" });
  });

  it("blocks a report that the medication's cold-chain may have failed in transit", () => {
    expect(supportPreCheck("One ice pack on one side. Hot to the touch providing no refrigeration at all!")).toEqual({ blocked: true, code: "COLD_CHAIN_CONCERN" });
    expect(supportPreCheck("the package wasn't refrigerated when it arrived")).toEqual({ blocked: true, code: "COLD_CHAIN_CONCERN" });
    expect(supportPreCheck("it was warm to the touch")).toEqual({ blocked: true, code: "COLD_CHAIN_CONCERN" });
  });

  it("does not treat 'end'/'quit' as a stop word when it's the tail of an unrelated question", () => {
    expect(supportPreCheck("When does this program end?")).toEqual({ blocked: false });
    expect(supportPreCheck("Can I quit anytime if it's not working?")).toEqual({ blocked: false });
  });

  it("still blocks a bare END/QUIT stop request", () => {
    expect(supportPreCheck("quit")).toEqual({ blocked: true, code: "STOP_WORD" });
  });
});

function check(raw: SophieInteractiveResult, lastDraft: string | null = null, permittedTopicKeys?: ReadonlySet<string>) {
  return permittedTopicKeys ? supportPostCheck(raw, lastDraft, permittedTopicKeys) : supportPostCheck(raw, lastDraft);
}

describe("supportPostCheck", () => {
  it("accepts an ordinary reply", () => {
    const result = check(reply());
    expect(result.ok).toBe(true);
  });

  it("strips an em dash from reply, replacing it with a comma — a code-level backstop for the prompt's own no-dash rule", () => {
    const result = check(reply({ reply: "Good news — your order has been received." }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.reply).toBe("Good news, your order has been received.");
      expect(result.result.reply).not.toMatch(/[—–]/);
    }
  });

  it("rejects an unapproved URL", () => {
    const result = check(reply({ reply: "Check here: https://example.com/random" }));
    expect(result).toEqual({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("rejects an unapproved URL even without an http(s):// scheme", () => {
    const result = check(reply({ reply: "Check out tryark-fake.com/abc123 for more." }));
    expect(result).toEqual({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("still allows the approved portal URL echoed without its scheme", () => {
    const result = check(reply({ reply: "You can check that in the portal: patient.tryark.com/login" }));
    expect(result.ok).toBe(true);
  });

  it("accepts the approved portal URL", () => {
    const result = check(reply({ reply: "You can check that in the portal: https://patient.tryark.com/login" }));
    expect(result.ok).toBe(true);
  });

  it("accepts the approved write-a-review URL, even though its query string contains a '?'", () => {
    const result = check(
      reply({ reply: "We'd love it if you left a review: https://www.consumeraffairs.com/review/write/?brand_id=24325" }),
    );
    expect(result.ok).toBe(true);
  });

  it("still rejects a genuine clarifying question mark alongside an approved URL with a query string", () => {
    const result = check(
      reply({ reply: "Would you leave a review? Here's the link: https://www.consumeraffairs.com/review/write/?brand_id=24325" }),
    );
    expect(result).toEqual({ ok: false, code: "QUESTION_MARK_IN_REPLY" });
  });

  it("rejects a question mark inside reply", () => {
    const result = check(reply({ reply: "Do you want me to check on that?" }));
    expect(result).toEqual({ ok: false, code: "QUESTION_MARK_IN_REPLY" });
  });

  it("rejects clinical language in Sophie's own reply, even mentioning a medication name", () => {
    const result = check(reply({ reply: "Your tirzepatide dose is being adjusted." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects dosage/side-effect language unconditionally", () => {
    expect(check(reply({ reply: "The dosing schedule is 5mg weekly." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(check(reply({ reply: "Side effects are common with this medication." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects the bare word 'dose' as well as 'dosage'", () => {
    expect(check(reply({ reply: "Your dose hasn't changed." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(check(reply({ reply: "Both doses are still on file." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects brand and generic medication names when compounded_medication isn't declared", () => {
    expect(check(reply({ reply: "You're currently on Mounjaro." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(check(reply({ reply: "That's different from Ozempic." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(check(reply({ reply: "Wegovy works similarly." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(check(reply({ reply: "Zepbound is a different brand." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(check(reply({ reply: "Ours contains semaglutide." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
    expect(check(reply({ reply: "Ours contains tirzepatide." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("accepts the real approved text for medication_onset_timeline and appetite_hunger_management, declared as their own topic", () => {
    for (const key of ["medication_onset_timeline", "appetite_hunger_management"]) {
      const topic = getTopicByKey(key);
      expect(topic).toBeDefined();
      const result = check(reply({ reply: topic!.approvedText, knowledgeTopicsUsed: [key] }), null, new Set([key]));
      expect(result.ok, `${key} should pass supportPostCheck with its own approved text`).toBe(true);
    }
  });

  it("allows brand/generic medication names when compounded_medication is declared", () => {
    const withTopic = { knowledgeTopicsUsed: ["compounded_medication"] };
    expect(check(reply({ reply: "It's compounded, not the Ozempic brand.", ...withTopic })).ok).toBe(true);
    expect(check(reply({ reply: "Ours has the same active ingredient as Wegovy.", ...withTopic })).ok).toBe(true);
    expect(check(reply({ reply: "It's compounded, not the Mounjaro brand.", ...withTopic })).ok).toBe(true);
    expect(check(reply({ reply: "Ours has the same active ingredient as Zepbound.", ...withTopic })).ok).toBe(true);
  });

  it("still rejects individualized clinical language even when compounded_medication is declared", () => {
    const withTopic = { knowledgeTopicsUsed: ["compounded_medication"] };
    expect(check(reply({ reply: "Your tirzepatide dose is being adjusted.", ...withTopic }))).toEqual({
      ok: false,
      code: "PROHIBITED_CLINICAL",
    });
  });

  it("rejects the noun form 'contraindications', not just the verb 'contraindicated'", () => {
    expect(check(reply({ reply: "There are no contraindications with this." }))).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("allows the plain word 'prescription' as a status noun", () => {
    const result = check(reply({ reply: "Your prescription was written and sent to the pharmacy." }));
    expect(result.ok).toBe(true);
  });

  it("rejects a repeated draft", () => {
    const draft = "Your order shipped today.";
    const result = check(reply({ reply: draft }), draft);
    expect(result).toEqual({ ok: false, code: "REPEATED_DRAFT" });
  });

  it("requires nextQuestion for action=reply", () => {
    const result = check(reply({ nextQuestion: null }));
    expect(result).toEqual({ ok: false, code: "MISSING_NEXT_QUESTION" });
  });

  it("rejects nextQuestion for action=pause", () => {
    const result = check(reply({ action: "pause", nextQuestion: "Anything else?" }));
    expect(result).toEqual({ ok: false, code: "UNEXPECTED_NEXT_QUESTION" });
  });

  it("overrides action to staff_review when requiresStaff is true", () => {
    const result = check(reply({ requiresStaff: true }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe("staff_review");
      expect(result.result.reply).toBeNull();
      expect(result.result.nextQuestion).toBeNull();
    }
  });

  it("rejects an unknown knowledge topic when a permitted set is given", () => {
    const result = check(reply({ knowledgeTopicsUsed: ["not_a_real_topic"] }), null, new Set(["portal_help"]));
    expect(result).toEqual({ ok: false, code: "UNKNOWN_KNOWLEDGE_TOPIC" });
  });
});
