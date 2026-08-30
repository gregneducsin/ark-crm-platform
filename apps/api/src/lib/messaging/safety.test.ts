import { describe, it, expect } from "vitest";
import { interactivePreCheck, interactivePostCheck } from "./safety.js";
import { APPROVED_REVIEW_URLS } from "./knowledge-catalog.js";
import type { ClaudeInteractiveResult } from "./types.js";

function reply(overrides: Partial<ClaudeInteractiveResult> = {}): ClaudeInteractiveResult {
  return {
    action: "reply",
    reply: "Tirzepatide is a popular option.",
    confidence: 0.9,
    detectedIntents: [],
    detectedIntent: "unknown",
    knowledgeTopicsUsed: [],
    requiresStaff: false,
    slotUpdates: {},
    resumeTopic: null,
    safetyCodes: [],
    nextQuestion: "Would you like to go over the pricing?",
    linkProvided: false,
    objectionStage: 0,
    objectionKey: null,
    promoOffered: false,
    inboundSentiment: null,
    learnedFirstName: null,
    ...overrides,
  };
}

function check(
  raw: ClaudeInteractiveResult,
  lastDraft: string | null = null,
  permittedTopicKeys?: ReadonlySet<string>,
) {
  return permittedTopicKeys ? interactivePostCheck(raw, lastDraft, permittedTopicKeys) : interactivePostCheck(raw, lastDraft);
}

// ── Pre-check ──────────────────────────────────────────────────────────────

describe("interactivePreCheck", () => {
  it("passes ordinary messages", () => {
    expect(interactivePreCheck("How much is semaglutide?")).toEqual({ blocked: false });
  });

  it("blocks STOP as OPT_OUT", () => {
    expect(interactivePreCheck("STOP")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("blocks UNSUBSCRIBE as OPT_OUT", () => {
    expect(interactivePreCheck("please unsubscribe me")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("blocks opt-out phrases as OPT_OUT", () => {
    expect(interactivePreCheck("please don't contact me again")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("does not treat bare CANCEL as opt-out", () => {
    const result = interactivePreCheck("can i cancel it whenever?");
    expect(result.blocked).toBe(false);
  });

  it("blocks END/QUIT as STOP_WORD", () => {
    expect(interactivePreCheck("quit")).toEqual({ blocked: true, code: "STOP_WORD" });
  });

  it("blocks emergency content", () => {
    expect(interactivePreCheck("this is an emergency")).toEqual({ blocked: true, code: "EMERGENCY_CONTENT" });
  });

  it("blocks suitability questions before medical content", () => {
    // Contains "medication" (a MEDICAL_WORDS_LOWER entry) but should classify as suitability.
    expect(interactivePreCheck("which medication is right for me?")).toEqual({
      blocked: true,
      code: "SUITABILITY_QUESTION",
    });
  });

  it("blocks medical content", () => {
    expect(interactivePreCheck("what's the diagnosis?")).toEqual({ blocked: true, code: "MEDICAL_CONTENT" });
  });

  it("blocks an active side-effect report as SIDE_EFFECT_REPORT, not the generic MEDICAL_CONTENT", () => {
    expect(interactivePreCheck("It makes my stomach hurt and I throw up in the morning.")).toEqual({ blocked: true, code: "SIDE_EFFECT_REPORT" });
    expect(interactivePreCheck("I have really bad nausea and diarrhea since starting this.")).toEqual({ blocked: true, code: "SIDE_EFFECT_REPORT" });
  });

  it("does not block plain dosing questions — titration's approved text is the real dosing protocol, and the post-check requires citing it", () => {
    expect(interactivePreCheck("What's the dosage?")).toEqual({ blocked: false });
    expect(interactivePreCheck("How does dosing work?")).toEqual({ blocked: false });
  });

  it("still blocks individualized dosing requests via suitability, not the (now removed) blanket dosage/dosing block", () => {
    expect(interactivePreCheck("What should I take?")).toEqual({ blocked: true, code: "SUITABILITY_QUESTION" });
    expect(interactivePreCheck("Should I increase my dose?")).toEqual({ blocked: true, code: "SUITABILITY_QUESTION" });
  });

  it("does not block plain shipping-timing questions despite containing 'medication'", () => {
    expect(interactivePreCheck("How long will it take to get my medication?")).toEqual({ blocked: false });
    expect(interactivePreCheck("When will my prescription arrive?")).toEqual({ blocked: false });
    expect(interactivePreCheck("How long does shipping take?")).toEqual({ blocked: false });
  });

  it("still blocks onset-timing questions — medication_onset_timeline is Sophie-only, Alexis has no approved answer for a lead", () => {
    expect(interactivePreCheck("How long until my medication starts working?")).toEqual({ blocked: true, code: "MEDICAL_CONTENT" });
    expect(interactivePreCheck("When will I start seeing results?")).toEqual({ blocked: false }); // no MEDICAL_WORDS_LOWER term present at all
  });

  it("still blocks medication questions that aren't about shipping timing", () => {
    expect(interactivePreCheck("Will this medication interact badly with my other medication?")).toEqual({ blocked: true, code: "MEDICAL_CONTENT" });
  });

  it("does not block a short reply that's just naming which of our own topics the customer wants, when it directly answers a question we just asked", () => {
    // Real production case: Alexis asked "is there something specific about
    // the process you'd like me to go over?" and the customer answered
    // "Medication and plans" — not an unprompted medical question at all.
    expect(interactivePreCheck("Medication and plans", "Is there something specific about the process you'd like me to go over?")).toEqual({ blocked: false });
    expect(interactivePreCheck("medication", "What would help clarify?")).toEqual({ blocked: false });
  });

  it("still blocks the same short reply when we didn't just ask anything", () => {
    expect(interactivePreCheck("Medication and plans", null)).toEqual({ blocked: true, code: "MEDICAL_CONTENT" });
  });

  it("still blocks a longer or question-phrased reply even when we just asked something — only a short, non-question answer is exempted", () => {
    expect(
      interactivePreCheck("Well I'm currently on a different medication and I'm not sure if I should switch", "Is there something specific you'd like me to go over?"),
    ).toEqual({ blocked: true, code: "MEDICAL_CONTENT" });
    expect(interactivePreCheck("what medication do you recommend?", "Is there something specific you'd like me to go over?")).toEqual({
      blocked: true,
      code: "MEDICAL_CONTENT",
    });
  });

  it("does not block plain process questions despite containing 'prescription' or 'treatment'", () => {
    expect(interactivePreCheck("Do I need a prescription?")).toEqual({ blocked: false });
    expect(interactivePreCheck("How do I get my prescription?")).toEqual({ blocked: false });
    expect(interactivePreCheck("What treatment options do you have?")).toEqual({ blocked: false });
    expect(interactivePreCheck("How does treatment work?")).toEqual({ blocked: false });
  });

  it("still blocks individualized questions that happen to contain 'prescription' or 'treatment'", () => {
    expect(interactivePreCheck("Is this treatment safe for my heart condition?")).toEqual({ blocked: true, code: "MEDICAL_CONTENT" });
    expect(interactivePreCheck("Will you prescribe me a higher dose?")).toEqual({ blocked: true, code: "MEDICAL_CONTENT" });
  });

  it("does not block 'how long does the prescription/approval take' — the review-process duration, not a treatment-duration question", () => {
    expect(interactivePreCheck("How long does the prescription take.")).toEqual({ blocked: false });
    expect(interactivePreCheck("How long does it take to get approved?")).toEqual({ blocked: false });
    expect(interactivePreCheck("How long until I get prescribed?")).toEqual({ blocked: false });
  });

  it("blocks legal content", () => {
    expect(interactivePreCheck("I'm going to sue you")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
    // No trailing space/comma after "sue" — was previously missed.
    expect(interactivePreCheck("I am going to sue")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
    expect(interactivePreCheck("I will sue.")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
    expect(interactivePreCheck("are you going to sue?")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
    expect(interactivePreCheck("I might sue!")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
    expect(interactivePreCheck("she sued her last provider")).toEqual({ blocked: true, code: "LEGAL_CONTENT" });
  });

  it("does not false-positive on words that merely contain the substring 'sue'", () => {
    // "pursue this" previously matched the old "sue " substring check.
    expect(interactivePreCheck("I want to pursue this further")).toEqual({ blocked: false });
    expect(interactivePreCheck("this is an issue with my order")).toEqual({ blocked: false });
    expect(interactivePreCheck("hopefully nothing bad will ensue")).toEqual({ blocked: false });
  });

  it("does not block general side-effect questions (handled by topic-gated post-check instead)", () => {
    expect(interactivePreCheck("what are the side effects?")).toEqual({ blocked: false });
  });

  it("prioritizes OPT_OUT over other categories", () => {
    expect(interactivePreCheck("STOP, this is an emergency")).toEqual({ blocked: true, code: "OPT_OUT" });
  });

  it("does not treat '911' embedded in an unrelated number as an emergency", () => {
    expect(interactivePreCheck("My order number is 78911, when will it ship?")).toEqual({ blocked: false });
    expect(interactivePreCheck("I live at 91123 in California")).toEqual({ blocked: false });
  });

  it("still blocks a real 911 mention", () => {
    expect(interactivePreCheck("This is a 911 emergency, please call me")).toEqual({ blocked: true, code: "EMERGENCY_CONTENT" });
  });

  it("does not block 'when will/do I get my prescription/medication' despite no 'arrive'/'ship' wording", () => {
    expect(interactivePreCheck("When will I get my prescription?")).toEqual({ blocked: false });
    expect(interactivePreCheck("When am I getting my medication?")).toEqual({ blocked: false });
  });

  it("does not treat 'end'/'quit' as a stop word when it's the tail of an unrelated question", () => {
    expect(interactivePreCheck("When does this program end?")).toEqual({ blocked: false });
    expect(interactivePreCheck("Does the plan ever end?")).toEqual({ blocked: false });
    expect(interactivePreCheck("Can I quit anytime if it's not working?")).toEqual({ blocked: false });
  });

  it("still blocks a bare END/QUIT stop request", () => {
    expect(interactivePreCheck("quit")).toEqual({ blocked: true, code: "STOP_WORD" });
    expect(interactivePreCheck("END")).toEqual({ blocked: true, code: "STOP_WORD" });
  });
});

// ── Post-check: URL allowlisting ──────────────────────────────────────────────

describe("interactivePostCheck: question mark must stay out of reply", () => {
  it("rejects a reply containing a question mark, even when nextQuestion is also present", () => {
    const result = check(reply({ reply: "Which one would you like, semaglutide or tirzepatide?", nextQuestion: "Which one sounds better?" }));
    expect(result).toEqual({ ok: false, code: "QUESTION_MARK_IN_REPLY" });
  });

  it("allows a reply with no question mark at all", () => {
    const result = check(reply({ reply: "Semaglutide is the more affordable option." }));
    expect(result.ok).toBe(true);
  });
});

describe("interactivePostCheck: em dash sanitization", () => {
  it("strips an em dash from reply, replacing it with a comma — a code-level backstop for the prompt's own no-dash rule", () => {
    const result = check(reply({ reply: "That's a great question — tirzepatide is a popular option." }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.reply).toBe("That's a great question, tirzepatide is a popular option.");
      expect(result.result.reply).not.toMatch(/[—–]/);
    }
  });

  it("strips an en dash from nextQuestion too", () => {
    const result = check(reply({ nextQuestion: "Would you like semaglutide – or tirzepatide?" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nextQuestion).not.toMatch(/[—–]/);
    }
  });
});

describe("interactivePostCheck: URLs", () => {
  it("allows the fixed review-site URLs", () => {
    for (const url of APPROVED_REVIEW_URLS) {
      const result = check(reply({ reply: `Here you go: ${url}` }));
      expect(result.ok).toBe(true);
    }
  });

  it("rejects an intake/signup-shaped URL even if it looks plausible", () => {
    const result = check(reply({ reply: "Here you go: https://start.tryark.com/start-online-visit/863ljl-78f0cabe" }));
    expect(result).toEqual({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("rejects any other URL", () => {
    const result = check(reply({ reply: "Sign up here: https://evil.example.com/phish" }));
    expect(result).toEqual({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("rejects an unapproved URL even without an http(s):// scheme", () => {
    const result = check(reply({ reply: "Check out tryark-fake.com/abc123 for more." }));
    expect(result).toEqual({ ok: false, code: "UNAPPROVED_URL" });
  });

  it("still allows an approved URL echoed without its scheme", () => {
    const result = check(reply({ reply: "Here you go: consumersverified.com/ark-health" }));
    expect(result.ok).toBe(true);
  });
});

// ── Post-check: unconditional clinical language ───────────────────────────────

describe("interactivePostCheck: unconditional clinical language", () => {
  it("rejects diagnose regardless of declared topics", () => {
    const result = check(reply({ reply: "I can diagnose your condition.", knowledgeTopicsUsed: ["product_comparison"] }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects contraindicated", () => {
    const result = check(reply({ reply: "That would be contraindicated for you." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects the noun form 'contraindications', not just the verb 'contraindicated'", () => {
    const result = check(reply({ reply: "There are no contraindications with this." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("rejects symptom", () => {
    const result = check(reply({ reply: "Tell me about your symptom." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });
});

// ── Post-check: topic-gated language ──────────────────────────────────────────

describe("interactivePostCheck: topic-gated language", () => {
  it("rejects dosing language without the titration topic", () => {
    const result = check(reply({ reply: "Let's talk about dosing.", knowledgeTopicsUsed: [] }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_CLINICAL" });
  });

  it("allows dosing language with the titration topic declared", () => {
    const result = check(reply({ reply: "Let's talk about dosing.", knowledgeTopicsUsed: ["titration"] }));
    expect(result.ok).toBe(true);
  });

  it("rejects payment-platform names without the insurance_payment topic", () => {
    const result = check(reply({ reply: "We work with Affirm.", knowledgeTopicsUsed: [] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });
});

// ── Post-check: pricing / financing claims ────────────────────────────────────

describe("interactivePostCheck: pricing and financing claims", () => {
  it("rejects guaranteed-pricing language", () => {
    const result = check(reply({ reply: "We guarantee the lowest price.", knowledgeTopicsUsed: ["semaglutide_pricing"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects unsupported financing terms even with insurance_payment declared", () => {
    const result = check(
      reply({ reply: "Financing is available at checkout with no credit check.", knowledgeTopicsUsed: ["insurance_payment"] }),
    );
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects dollar amounts with no pricing topic declared", () => {
    const result = check(reply({ reply: "That plan is $80 per month.", knowledgeTopicsUsed: [] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("allows dollar amounts with a pricing topic declared", () => {
    const result = check(reply({ reply: "That plan is $116.67 per month.", knowledgeTopicsUsed: ["semaglutide_pricing"] }));
    expect(result.ok).toBe(true);
  });

  it("rejects a fabricated price even when a pricing topic is declared", () => {
    const result = check(reply({ reply: "Tirzepatide is $299 a month right now.", knowledgeTopicsUsed: ["tirzepatide_pricing"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects a fabricated promo discount even when first_month_offer and a product topic are both declared", () => {
    const result = check(
      reply({ reply: "With $50 off, semaglutide is $70 for the first month.", knowledgeTopicsUsed: ["semaglutide_pricing", "first_month_offer"] }),
    );
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("allows every real approved figure across both products, all plan lengths, and the promo-adjusted month-to-month prices", () => {
    const approvedReplies = [
      "Semaglutide is $175 a month month-to-month, $116.67 a month ($350 total) for 3 months, $108.33 a month ($650 total) for 6 months, or $91.67 a month ($1,100 total) for 12 months.",
      "Tirzepatide is $225 a month month-to-month, $188.33 a month ($565 total) for 3 months, $175 a month ($1,050 total) for 6 months, or $125 a month ($1,500 total) for 12 months.",
      "With $20 off, semaglutide is $155 and tirzepatide is $205 for the first month.",
    ];
    for (const text of approvedReplies) {
      const result = check(reply({ reply: text, knowledgeTopicsUsed: ["semaglutide_pricing", "tirzepatide_pricing", "first_month_offer"] }));
      expect(result.ok).toBe(true);
    }
  });
});

// ── Post-check: insurance negation zone ───────────────────────────────────────

describe("interactivePostCheck: insurance-acceptance negation", () => {
  it("allows the approved negated form", () => {
    const result = check(
      reply({ reply: "We don't accept insurance, but payment options are available.", knowledgeTopicsUsed: ["insurance_payment"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an affirmative insurance-acceptance claim even with the topic declared", () => {
    const result = check(reply({ reply: "We accept insurance.", knowledgeTopicsUsed: ["insurance_payment"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects passive affirmative forms", () => {
    const result = check(reply({ reply: "Insurance is accepted.", knowledgeTopicsUsed: ["insurance_payment"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects insurance mention entirely without the topic declared", () => {
    const result = check(reply({ reply: "We don't take insurance.", knowledgeTopicsUsed: [] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects affirmative acceptance claims phrased with verbs beyond accept/work-with/bill", () => {
    const cases = [
      "We take insurance.",
      "Your insurance covers this.",
      "This is covered by insurance.",
      "We honor insurance plans.",
      "Insurance is welcome here.",
      "You can use your insurance for this.",
      "We are in-network with most insurance plans.",
      "Insurance may cover part of this.",
    ];
    for (const text of cases) {
      const result = check(reply({ reply: text, knowledgeTopicsUsed: ["insurance_payment"] }));
      expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
    }
  });

  it("allows the correctly negated form of every expanded acceptance verb, including contracted 'to be' negation", () => {
    const cases = [
      "We don't take insurance.",
      "Your insurance doesn't cover this.",
      "This isn't covered by insurance.",
      "We don't honor insurance plans.",
      "We can't use your insurance for this.",
      "We're not in-network with insurance.",
      "Insurance isn't accepted here.",
      "Insurance isn't welcome here — we work on a self-pay basis.",
    ];
    for (const text of cases) {
      const result = check(reply({ reply: text, knowledgeTopicsUsed: ["insurance_payment"] }));
      expect(result.ok).toBe(true);
    }
  });
});

// ── Post-check: promotion rules ───────────────────────────────────────────────

describe("interactivePostCheck: first_month_offer promotion rules", () => {
  it("allows the approved $20 offer language", () => {
    const result = check(
      reply({ reply: "New customers get $20 off their first month.", knowledgeTopicsUsed: ["first_month_offer"] }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects stacking claims", () => {
    const result = check(
      reply({ reply: "This can be combined with other promotions.", knowledgeTopicsUsed: ["first_month_offer"] }),
    );
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects non-new-customer eligibility claims", () => {
    const result = check(
      reply({ reply: "Returning customers can also get this discount.", knowledgeTopicsUsed: ["first_month_offer"] }),
    );
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });

  it("rejects an invented discount amount", () => {
    const result = check(reply({ reply: "New customers get $50 off.", knowledgeTopicsUsed: ["first_month_offer"] }));
    expect(result).toEqual({ ok: false, code: "UNSUPPORTED_PRICING_CLAIM" });
  });
});

// ── Post-check: staff availability, templates, repeated drafts, confidence ───

describe("interactivePostCheck: other hard rejections", () => {
  it("rejects staff-24/7-availability claims", () => {
    const result = check(reply({ reply: "Our staff is standing by 24/7 to help." }));
    expect(result).toEqual({ ok: false, code: "PROHIBITED_STAFF_CLAIM" });
  });

  it("allows an approved template variable", () => {
    const result = check(reply({ reply: "Here is your link: [UNIVERSAL_SIGNUP_LINK]" }));
    expect(result.ok).toBe(true);
  });

  it("rejects a disallowed template variable", () => {
    const result = check(reply({ reply: "Here is your link: [SECRET_INTERNAL_VAR]" }));
    expect(result).toEqual({ ok: false, code: "DISALLOWED_TEMPLATE" });
  });

  it("rejects a repeated draft", () => {
    const draft = "Tirzepatide is our most popular option.";
    const result = check(reply({ reply: draft, nextQuestion: "Are you ready to get started?" }), draft);
    expect(result).toEqual({ ok: false, code: "REPEATED_DRAFT" });
  });

  it("treats repeated-draft comparison as punctuation/case-insensitive", () => {
    const result = check(
      reply({ reply: "Tirzepatide is our most popular option!", nextQuestion: "Are you ready to get started?" }),
      "tirzepatide is our most popular option",
    );
    expect(result).toEqual({ ok: false, code: "REPEATED_DRAFT" });
  });

  it("rejects low-confidence replies", () => {
    const result = check(reply({ confidence: 0.2 }));
    expect(result).toEqual({ ok: false, code: "LOW_CONFIDENCE" });
  });
});

// ── Post-check: knowledge-topic gating ────────────────────────────────────────

describe("interactivePostCheck: knowledge-topic gating", () => {
  it("rejects a topic that was not permitted for this turn", () => {
    const result = check(
      reply({ knowledgeTopicsUsed: ["tirzepatide_pricing"] }),
      null,
      new Set(["product_comparison"]),
    );
    expect(result).toEqual({ ok: false, code: "UNKNOWN_KNOWLEDGE_TOPIC" });
  });

  it("allows a topic that was permitted for this turn", () => {
    const result = check(
      reply({ knowledgeTopicsUsed: ["product_comparison"] }),
      null,
      new Set(["product_comparison"]),
    );
    expect(result.ok).toBe(true);
  });

  it("skips the check entirely when permittedTopicKeys is empty", () => {
    const result = check(reply({ knowledgeTopicsUsed: ["anything_at_all"] }));
    expect(result.ok).toBe(true);
  });
});

// ── Post-check: nextQuestion format ───────────────────────────────────────────

describe("interactivePostCheck: nextQuestion format", () => {
  it("rejects a missing nextQuestion for a reply action", () => {
    const result = check(reply({ nextQuestion: null }));
    expect(result).toEqual({ ok: false, code: "MISSING_NEXT_QUESTION" });
  });

  it("rejects a nextQuestion that doesn't end with a question mark", () => {
    const result = check(reply({ nextQuestion: "Let me know if you're ready" }));
    expect(result).toEqual({ ok: false, code: "INVALID_NEXT_QUESTION" });
  });

  it("rejects a nextQuestion with more than one question mark", () => {
    const result = check(reply({ nextQuestion: "Are you ready? Or do you have questions?" }));
    expect(result).toEqual({ ok: false, code: "INVALID_NEXT_QUESTION" });
  });

  it("rejects an unexpected nextQuestion on a no-question action", () => {
    const result = check(reply({ action: "staff_review", reply: null, nextQuestion: "Are you ready?" }));
    expect(result).toEqual({ ok: false, code: "UNEXPECTED_NEXT_QUESTION" });
  });

  it("allows a well-formed single trailing question", () => {
    const result = check(reply({ nextQuestion: "Would you like to go over the pricing?" }));
    expect(result.ok).toBe(true);
  });
});

// ── Post-check: requiresStaff safety-net override ─────────────────────────────

describe("interactivePostCheck: requiresStaff override", () => {
  it("forces action to staff_review and discards the reply when requiresStaff is true", () => {
    const result = check(reply({ requiresStaff: true }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.action).toBe("staff_review");
      expect(result.result.reply).toBeNull();
      expect(result.result.nextQuestion).toBeNull();
    }
  });
});

// ── Post-check: slot validation ───────────────────────────────────────────────

describe("interactivePostCheck: slot validation", () => {
  it("accepts a valid slot update", () => {
    const result = check(reply({ slotUpdates: { selectedProduct: "tirzepatide" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedSlotUpdates).toEqual({ selectedProduct: "tirzepatide" });
    }
  });

  it("rejects an unknown slot key", () => {
    const result = check(reply({ slotUpdates: { notARealSlot: "value" } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_KEY" });
  });

  it("rejects an invalid value for a known slot key", () => {
    const result = check(reply({ slotUpdates: { selectedProduct: "aspirin" } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_VALUE" });
  });

  it("accepts a free-text state slot value", () => {
    const result = check(reply({ slotUpdates: { state: "Texas" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedSlotUpdates).toEqual({ state: "Texas" });
    }
  });

  it("accepts a null state slot value", () => {
    const result = check(reply({ slotUpdates: { state: null } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedSlotUpdates).toEqual({ state: null });
    }
  });

  it("rejects an empty-string state slot value", () => {
    const result = check(reply({ slotUpdates: { state: "" } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_VALUE" });
  });

  it("rejects a state slot value over the length cap", () => {
    const result = check(reply({ slotUpdates: { state: "x".repeat(61) } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_VALUE" });
  });

  it("rejects a non-string state slot value", () => {
    const result = check(reply({ slotUpdates: { state: 12 } }));
    expect(result).toEqual({ ok: false, code: "INVALID_SLOT_VALUE" });
  });

  it("treats a drug name mistakenly placed in currentlyTaking as answering both slots", () => {
    const result = check(reply({ slotUpdates: { currentlyTaking: "tirzepatide" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedSlotUpdates).toEqual({ currentlyTaking: "yes", selectedProduct: "tirzepatide" });
    }
  });

  it("does not overwrite an explicitly-set selectedProduct when normalizing currentlyTaking", () => {
    const result = check(reply({ slotUpdates: { currentlyTaking: "semaglutide", selectedProduct: "tirzepatide" } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.validatedSlotUpdates).toEqual({ currentlyTaking: "yes", selectedProduct: "tirzepatide" });
    }
  });
});
