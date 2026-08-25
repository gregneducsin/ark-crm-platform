import { describe, it, expect } from "vitest";
import { getPreviewEnabledTopics, getSophieEnabledTopics, getTopicByKey } from "./knowledge-catalog.js";

describe("Alexis/Sophie topic-list separation", () => {
  it("Alexis's topic list excludes portal_help (a prospect has no portal account)", () => {
    const alexisKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(alexisKeys.has("portal_help")).toBe(false);
  });

  it("Sophie's topic list includes portal_help", () => {
    const sophieKeys = new Set(getSophieEnabledTopics().map((t) => t.key));
    expect(sophieKeys.has("portal_help")).toBe(true);
  });

  it("Sophie's topic list uses how_ark_works_after_purchase, not the enrollment-oriented how_ark_works", () => {
    const sophieKeys = new Set(getSophieEnabledTopics().map((t) => t.key));
    expect(sophieKeys.has("how_ark_works_after_purchase")).toBe(true);
    expect(sophieKeys.has("how_ark_works")).toBe(false);
  });

  it("Alexis's topic list uses how_ark_works, not Sophie's post-purchase version", () => {
    const alexisKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(alexisKeys.has("how_ark_works")).toBe(true);
    expect(alexisKeys.has("how_ark_works_after_purchase")).toBe(false);
  });

  it("existing_customer_current_rate is Sophie-only — Alexis talks pricing with prospects who haven't committed yet", () => {
    const sophieKeys = new Set(getSophieEnabledTopics().map((t) => t.key));
    const alexisKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    expect(sophieKeys.has("existing_customer_current_rate")).toBe(true);
    expect(alexisKeys.has("existing_customer_current_rate")).toBe(false);
  });

  it("existing_customer_current_rate's approved text carries no dollar figure — reassurance only, never a new pricing claim", () => {
    const topic = getTopicByKey("existing_customer_current_rate");
    expect(topic).toBeDefined();
    expect(topic!.approvedText).not.toMatch(/\$\d/);
  });

  it("how_ark_works_after_purchase does not repeat the pre-purchase enrollment framing", () => {
    const topic = getTopicByKey("how_ark_works_after_purchase");
    expect(topic).toBeDefined();
    const text = topic!.approvedText.toLowerCase();
    expect(text).not.toContain("select your preferred medication");
    expect(text).not.toContain("complete the");
    expect(text).not.toContain("questionnaire");
    expect(text).not.toContain("guide the customer toward");
  });

  it("how_ark_works_after_purchase and how_ark_works are both approved and preview-enabled", () => {
    const afterPurchase = getTopicByKey("how_ark_works_after_purchase");
    const enrollment = getTopicByKey("how_ark_works");
    expect(afterPurchase?.legalStatus).toBe("approved");
    expect(afterPurchase?.enabledForPreview).toBe(true);
    expect(enrollment?.legalStatus).toBe("approved");
    expect(enrollment?.enabledForPreview).toBe(true);
  });

  it("medication_onset_timeline and appetite_hunger_management are Sophie-only — approved and available to Sophie, but excluded from Alexis's topic list", () => {
    const alexisKeys = new Set(getPreviewEnabledTopics().map((t) => t.key));
    const sophieKeys = new Set(getSophieEnabledTopics().map((t) => t.key));
    for (const key of ["medication_onset_timeline", "appetite_hunger_management"]) {
      const topic = getTopicByKey(key);
      expect(topic?.legalStatus).toBe("approved");
      expect(topic?.clinicalStatus).toBe("approved");
      expect(sophieKeys.has(key)).toBe(true);
      expect(alexisKeys.has(key)).toBe(false);
    }
  });

  it("medication_onset_timeline and appetite_hunger_management avoid words Sophie's own post-check unconditionally rejects (dose/mg/side effect/symptom/diagnos/contraindicat)", () => {
    const forbidden = /\bdos(e|es|age|ages|ing)\b|\b\d+\s?mg\b|\bside.?effect|\bsymptom|\bdiagnos(e|is|ed|ing)\b|\bcontraindicat(e|ed|es|ing|ion|ions)\b/i;
    for (const key of ["medication_onset_timeline", "appetite_hunger_management"]) {
      const topic = getTopicByKey(key);
      expect(topic?.approvedText).toBeDefined();
      expect(forbidden.test(topic!.approvedText)).toBe(false);
    }
  });
});
