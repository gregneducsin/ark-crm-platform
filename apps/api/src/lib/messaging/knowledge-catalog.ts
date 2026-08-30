/**
 * Approved knowledge catalog for the Claude interactive bot-preview.
 *
 * Entries with enabledForPreview: true are injected into the Claude system
 * prompt during bot-test sessions. Claude may ONLY reference content from
 * this catalog — any response that cites a topic not in the permitted set is
 * rejected by the post-check (UNKNOWN_KNOWLEDGE_TOPIC).
 *
 * All entries marked alexisSourceVersion: "alexis-knowledge-v1" are derived from
 * the immutable source document stored in alexis-knowledge-source.ts, which was
 * approved by medical staff and legal counsel. Their legalStatus, pricing,
 * clinical statements, and approved response examples must remain consistent
 * with that source document.
 *
 * Legal status meanings:
 *   "approved"                       — cleared for all environments.
 *   "pending_user_clinical_approval" — dev/preview only; must NOT appear in
 *                                      production templates or be deployed.
 *
 * No database imports. No outbound messaging SDK imports.
 */

// No database imports. No outbound SMS SDK imports.

export interface KnowledgeTopic {
  readonly key: string;
  /** Exact approved copy. Claude may paraphrase if allowedParaphrase is true. */
  readonly approvedText: string;
  readonly allowedParaphrase: boolean;
  readonly legalStatus: "approved" | "pending_user_clinical_approval";
  readonly clinicalStatus: "approved" | "pending_clinical_review";
  /** ISO date string — when this entry was last reviewed. */
  readonly lastReviewedDate: string;
  /** Content categories Claude must never add when using this topic. */
  readonly prohibitedClaims: readonly string[];
  /** Whether this topic is passed to Claude during the preview session. */
  readonly enabledForPreview: boolean;
  /**
   * Version of the Alexis knowledge source document this entry is derived from.
   * Undefined for entries not yet sourced from the Alexis document.
   */
  readonly alexisSourceVersion?: string;
}

/**
 * Fixed URLs Claude is allowed to output verbatim. Deliberately does NOT
 * include an intake/signup URL: those are minted per-lead by
 * intake-links.service.ts (createIntakeLink) at send_form time, so Claude
 * never sees a real token to output. On action=send_form, Claude's reply
 * must contain no URL at all — the caller appends the freshly minted link.
 */
export const APPROVED_REVIEW_URLS = new Set([
  "https://www.consumeraffairs.com/health/ark-health.html",
  "https://consumersverified.com/ark-health",
]);

export const KNOWLEDGE_CATALOG: readonly KnowledgeTopic[] = [
  // ── Product comparison ─────────────────────────────────────────────────────
  // Source: alexis-knowledge-v1 §MEDICATIONS OFFERED, §COMPARING TIRZEPATIDE AND SEMAGLUTIDE
  // Key rule from source: customer chooses the medication — do NOT imply the
  // provider chooses between semaglutide and tirzepatide.
  {
    key: "product_comparison",
    approvedText:
      "We offer two weight-loss treatment options: semaglutide and tirzepatide. " +
      "You choose which medication you would like to request. " +
      "Tirzepatide has demonstrated greater average weight loss than semaglutide in clinical studies. " +
      "Most of our customers choose tirzepatide. " +
      "Semaglutide is the more affordable option. " +
      "Individual results vary. " +
      "The requested prescription still goes through the medical questionnaire and provider-review process.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: [
      "provider_chooses_medication",
      "personal_effectiveness_guarantee",
      "fewer_side_effects_guarantee",
      "mechanism_of_action",
      "contraindications",
      "safety_rankings",
      "clinical_suitability",
      "weight_loss_percentages_as_personal_prediction",
    ],
    enabledForPreview: true,
  },

  // ── Semaglutide pricing ────────────────────────────────────────────────────
  // Source: Ark Health transparent-pricing page (owner-supplied 2026-08-25).
  // Exact prices: $175/mo (month-to-month), $117/mo ($350 total, 3-mo, save $175),
  // $108/mo ($650 total, 6-mo, save $400), $92/mo ($1,100 total, 12-mo, save $1,000)
  {
    key: "semaglutide_pricing",
    approvedText:
      "Semaglutide pricing: " +
      "Month-to-month: $175 per month, no commitment. " +
      "3-month plan: $117 per month, $350 billed every 3 months (save $175 vs. month-to-month). " +
      "6-month plan: $108 per month, $650 billed every 6 months (save $400 vs. month-to-month). " +
      "12-month plan: $92 per month, $1,100 billed annually (save $1,000 vs. month-to-month). " +
      "When quoting a multi-month plan, clearly state both the monthly equivalent and the total plan price. " +
      "Never quote prices, discounts, promotions, coupon codes, or membership rates outside these amounts.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-25",
    prohibitedClaims: [
      "invented_price",
      "invented_discount",
      "invented_promotion",
      "coupon_code",
      "guaranteed_lowest_price",
      "eligibility_guarantees",
      "insurance_coverage",
      "automatic_dose_increase",
      "financing_approval_guarantee",
    ],
    enabledForPreview: true,
  },

  // ── Tirzepatide pricing ────────────────────────────────────────────────────
  // Source: Ark Health transparent-pricing page (owner-supplied 2026-08-25).
  // Exact prices: $225/mo (month-to-month), $188/mo ($565 total, 3-mo, save $110),
  // $175/mo ($1,050 total, 6-mo, save $300), $125/mo ($1,500 total, 12-mo, save $1,200)
  {
    key: "tirzepatide_pricing",
    approvedText:
      "Tirzepatide pricing: " +
      "Month-to-month: $225 per month, no commitment. " +
      "3-month plan: $188 per month, $565 billed every 3 months (save $110 vs. month-to-month). " +
      "6-month plan: $175 per month, $1,050 billed every 6 months (save $300 vs. month-to-month). " +
      "12-month plan: $125 per month, $1,500 billed annually (save $1,200 vs. month-to-month). " +
      "When quoting a multi-month plan, clearly state both the monthly equivalent and the total plan price. " +
      "Never quote prices, discounts, promotions, coupon codes, or membership rates outside these amounts.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-25",
    prohibitedClaims: [
      "invented_price",
      "invented_discount",
      "invented_promotion",
      "coupon_code",
      "guaranteed_lowest_price",
      "eligibility_guarantees",
      "insurance_coverage",
      "automatic_dose_increase",
      "financing_approval_guarantee",
    ],
    enabledForPreview: true,
  },

  // ── Titration / dose progression ──────────────────────────────────────────
  // Source: alexis-knowledge-v1 §TITRATION
  {
    key: "titration",
    approvedText:
      "Customers may request to titrate upward each month. " +
      "Tirzepatide dose progression: 2.5 mg → 5 mg → 7.5 mg → 10 mg → 12.5 mg → 15 mg once weekly. " +
      "Semaglutide dose progression: 0.25 mg → 0.5 mg → 1 mg → 1.7 mg → 2.4 mg once weekly. " +
      "Do not tell customers to independently change their dose without going through the " +
      "program's prescription and provider-review process. " +
      "Do not imply that every customer must begin at the lowest dose if they are already " +
      "transferring from another provider with an existing prescription.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: [
      "independent_dose_change",
      "guaranteed_dose_approval",
      "automatic_dose_increase",
      "doses_outside_progression",
    ],
    enabledForPreview: true,
  },

  // ── Previous prescriptions (transfer patients) ────────────────────────────
  // Source: alexis-knowledge-v1 §PREVIOUS PRESCRIPTIONS
  {
    key: "previous_prescriptions",
    approvedText:
      "If a customer already has a valid prescription for semaglutide or tirzepatide from another provider, " +
      "they should provide the prescription information and their current or most recent dose during the medical intake process. " +
      "Our medical providers will use the existing prescription information when reviewing and approving the medication. " +
      "The customer does not automatically need to restart at the introductory dose simply because they are transferring from another provider. " +
      "For example, a customer prescribed 5 mg of tirzepatide by another provider may request to continue from that point " +
      "or request the next appropriate dose, such as 7.5 mg, as part of our program.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: [
      "guaranteed_dose_continuation",
      "guaranteed_prescription_approval",
      "independent_dose_change",
      "override_other_provider",
    ],
    enabledForPreview: true,
  },

  // ── Weight-loss expectations ───────────────────────────────────────────────
  // Source: alexis-knowledge-v1 §TIRZEPATIDE, §WEIGHT-LOSS EXPECTATIONS
  {
    key: "weight_loss_expectations",
    approvedText:
      "Individual results vary. Never guarantee weight loss or a specific amount. " +
      "In a major 72-week obesity clinical trial, tirzepatide demonstrated average weight reduction " +
      "of approximately 15% to 21%, depending on dose. " +
      "Clinical studies have shown substantial average weight loss with both medications, " +
      "with tirzepatide generally producing greater average weight loss than semaglutide. " +
      "Always present study results as study results, not as a prediction of the customer's outcome.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: [
      "guaranteed_weight_loss",
      "personal_weight_loss_prediction",
      "specific_pound_guarantee",
      "clinical_results_as_personal_prediction",
    ],
    enabledForPreview: true,
  },

  // ── Medication onset timing ─────────────────────────────────────────────────
  // Source: owner-confirmed 2026-08-20. General onset-timing education only —
  // never a personalized prediction of when any one customer will notice
  // changes. Sophie-only: excluded from Alexis via ALEXIS_EXCLUDED_TOPIC_KEYS below
  // — this is a question an existing patient already taking the medication
  // asks, not a prospect. Wording deliberately avoids "dose"/"dosing" — Sophie's
  // own post-check (lib/support/safety.ts's SOPHIE_PROHIBITED_CLINICAL_RE)
  // unconditionally rejects those words in her reply, no topic-gate exception,
  // so the approved text itself has to stay inside that vocabulary.
  {
    key: "medication_onset_timeline",
    approvedText:
      "Many people notice initial appetite changes within the first few weeks of treatment, though this varies from person to person. " +
      "If you haven't noticed changes yet, that's common early on — your care team can review your progress at your next check-in.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-20",
    prohibitedClaims: ["guaranteed_onset_timeline", "specific_day_or_week_promise", "personal_response_prediction"],
    enabledForPreview: true,
  },

  // ── Appetite / still feeling hungry ────────────────────────────────────────
  // Source: owner-confirmed 2026-08-20. General, non-personalized coping tips
  // only — never tells a customer to change their own dose. Sophie-only, same
  // reasoning and same "dose"-free wording constraint as
  // medication_onset_timeline above.
  {
    key: "appetite_hunger_management",
    approvedText:
      "It's common to still feel hungry sometimes, especially early in treatment. " +
      "Eating slowly, prioritizing protein and fiber, drinking enough water, and staying active can all help for some people. " +
      "If hunger doesn't improve or you're concerned, your care team can help figure out the right next step.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-20",
    prohibitedClaims: ["independent_dose_change", "guaranteed_appetite_suppression", "personalized_dietary_prescription"],
    enabledForPreview: true,
  },

  // ── Insurance and payment options ─────────────────────────────────────────
  // Source: alexis-knowledge-v1 §INSURANCE AND PAYMENT OPTIONS
  {
    key: "insurance_payment",
    approvedText:
      "We do not accept health insurance. " +
      "Payment-plan options may be available through Affirm, Klarna, and Afterpay, subject to approval. " +
      "Approval for these payment services is determined by the applicable financing provider. " +
      "Never guarantee that a customer will qualify for financing.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: ["insurance_acceptance", "financing_approval_guarantee", "payment_plan_guarantee"],
    enabledForPreview: true,
  },

  // ── Existing-customer current rate ────────────────────────────────────────
  // Source: owner-confirmed. Deliberately narrow: reassures an existing
  // customer they're already on their plan's current rate, without quoting
  // any dollar figure or promising a rate that could later be false (a
  // "lowest ever" claim would become inaccurate the moment a bigger
  // promotion runs). Sophie-only — Alexis talks pricing with prospects who
  // haven't committed yet, this is specifically the "am I missing a better
  // deal" reassurance for someone who already has.
  {
    key: "existing_customer_current_rate",
    approvedText:
      "You're already enrolled at the current rate for your plan, so there's nothing additional to apply on top of what you're on now. " +
      "If a new promotion becomes available that applies to your plan, our team will reach out to you directly.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-18",
    prohibitedClaims: ["lowest_rate_ever_guarantee", "future_price_lock_guarantee", "specific_discount_amount"],
    enabledForPreview: true,
  },

  // ── How the program works / enrollment ────────────────────────────────────
  // Source: alexis-knowledge-v1 §MEDICAL QUESTIONNAIRE AND ENROLLMENT
  {
    key: "how_ark_works",
    approvedText:
      "1. You select your preferred medication and plan. " +
      "2. You complete the approximately 5-minute medical questionnaire. " +
      "3. A licensed medical provider reviews the submitted information. " +
      "4. The prescription request is processed according to the information provided and your medical history. " +
      "5. If approved, the prescription proceeds through the program. " +
      "Keep explanations simple unless the customer asks for additional detail. " +
      "Guide the customer toward beginning or completing the questionnaire whenever appropriate.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: [
      "guaranteed_approval_timing",
      "guaranteed_delivery_speed",
      "15_minute_approval",
      "2_3_day_delivery_guarantee",
      "guaranteed_prescription_approval",
    ],
    enabledForPreview: true,
  },

  // ── How it works, for a patient who already purchased ──────────────────────
  // Sophie's own version of how_ark_works above. That topic is written for a
  // prospect who hasn't signed up yet ("you select your plan... complete the
  // questionnaire... guide the customer toward completing the questionnaire")
  // — every sentence of it is wrong for a patient Sophie is talking to, who has
  // already done all of that. This describes the same underlying process
  // (medical review -> prescription -> pharmacy -> shipping) from "what
  // happens after you've ordered" instead, using only facts already approved
  // elsewhere for Sophie (see lib/support/templates.ts's fixed status
  // messages) — no new claims, just the appropriate framing for the audience.
  {
    key: "how_ark_works_after_purchase",
    approvedText:
      "After your order comes in, a licensed medical provider reviews the information you submitted. " +
      "If approved, your prescription is written and sent to the pharmacy, then shipped to you with a tracking number. " +
      "You can check where things stand anytime through the patient portal.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-17",
    prohibitedClaims: ["guaranteed_approval_timing", "guaranteed_delivery_speed", "guaranteed_prescription_approval"],
    enabledForPreview: true,
  },

  // ── Plan inclusions ────────────────────────────────────────────────────────
  // STATUS: EXCLUDED from alexis-knowledge-v1 itself, but separately owner-
  // confirmed approved for Alexis's use — see legalStatus/enabledForPreview below.
  {
    key: "plan_inclusions",
    approvedText:
      "Plans include the prescribed medication course, required supplies, " +
      "licensed-provider review, applicable taxes and shipping, and pharmacy home " +
      "delivery. There are no membership fees or hidden membership charges. " +
      "A licensed provider determines whether any dose change is appropriate.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    prohibitedClaims: ["automatic_dose_increase", "guaranteed_dose_adjustment", "hidden_fee_guarantee"],
    enabledForPreview: true,
  },

  // ── Customer reviews ───────────────────────────────────────────────────────
  // Source: approved review site links supplied by the owner.
  // Share BOTH links when a patient asks about reviews, testimonials, or customer
  // experiences. Do NOT volunteer unless asked.
  {
    key: "customer_reviews",
    approvedText:
      "Customers can read verified reviews on two independent platforms:\n" +
      "ConsumerAffairs: https://www.consumeraffairs.com/health/ark-health.html\n" +
      "ConsumersVerified: https://consumersverified.com/ark-health\n" +
      "Share both links together when a patient asks about reviews or customer feedback.",
    allowedParaphrase: false,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: [
      "invented_star_rating", // never fabricate a rating or score
      "guaranteed_positive_outcome", // reviews reflect real customers, not guarantees
      "review_count_claim", // do not state a number of reviews
    ],
    enabledForPreview: true,
  },

  // ── Cancellation policy ────────────────────────────────────────────────────
  // Source: patient portal self-service cancellation; 7-day notice requirement
  // confirmed by the owner. This entry answers "can i cancel?" / "how do i
  // cancel?" questions — it does NOT instruct the bot to cancel anything.
  // Do NOT imply refunds, prorated credits, instant cancellation, or fee waivers.
  {
    key: "cancellation_policy",
    approvedText:
      "You can cancel your plan anytime by logging into your patient portal. " +
      "To avoid being charged for the next shipment, cancellations must be submitted " +
      "at least 7 days before your next refill date.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: [
      "instant_cancellation", // portal processing takes effect before the 7-day window
      "cancellation_fee_refund", // no refunds are promised
      "prorated_refund", // no prorated credits are approved
      "automatic_cancellation", // patient must act in the portal
      "phone_cancellation", // portal is the approved self-service channel
    ],
    enabledForPreview: true,
  },

  // ── Side effects (tolerability) ───────────────────────────────────────────
  // Source: alexis-knowledge-v1 §COMPARING TIRZEPATIDE AND SEMAGLUTIDE
  // Approved script: acknowledge GI side effects exist, vary per person, and
  // invite the customer to share which medication they are considering.
  // Individualized assessment (personal history / symptoms) must still go to
  // the medical team — reflected in prohibitedClaims below.
  {
    key: "side_effects",
    approvedText:
      "Both medications can cause side effects, particularly gastrointestinal side effects, and everyone's experience is different. " +
      "Which medication are you considering? " +
      "Questions about your personal medical history, symptoms, or how a specific medication may affect you individually should be reviewed by the medical team during the provider-review step.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-knowledge-v1",
    prohibitedClaims: [
      "fewer_side_effects_guarantee", // never claim one med has universally fewer SE
      "personalized_side_effect_assessment", // no individualized medical judgment
      "specific_side_effect_list_as_advice", // don't enumerate specific adverse events as advice
      "contraindications", // contraindication assessment belongs to provider
    ],
    enabledForPreview: true,
  },

  // ── Shipping and delivery ─────────────────────────────────────────────────
  // Source: owner-confirmed — typically 2-3 business days after approval.
  // No-signature-required added 2026-08-23 after a real patient (Charlotte
  // Hunt, via Sophie/SMS) asked whether she needed to be home for delivery —
  // Sophie had no approved fact to answer with and correctly stayed vague
  // rather than guess, which flagged the conversation for staff instead of
  // just answering. Owner confirmed no signature is ever required.
  // Do not guarantee a specific carrier, tracking timeline, or cold-chain detail.
  {
    key: "shipping_delivery",
    approvedText:
      "Once your prescription is approved, your medication is typically shipped within 2 to 3 business days and delivered directly to your address. " +
      "Shipping is included in your plan. No signature is required for delivery — the package can be left at your door. " +
      "You'll receive a tracking number once it ships, so you can follow its progress and reach out to the carrier directly if you have specific delivery instructions.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-23",
    prohibitedClaims: [
      "guaranteed_delivery_date", // exact arrival date cannot be promised
      "specific_carrier_guarantee", // carrier not specified in approved text
      "overnight_shipping", // not an approved claim
      "free_expedited_shipping", // standard shipping only
    ],
    enabledForPreview: true,
  },

  // ── Compounded medication ─────────────────────────────────────────────────
  // Source: owner-confirmed — all medications are compounded by licensed
  // compounding pharmacies. Brand-name versions (Ozempic, Wegovy, Mounjaro,
  // Zepbound) are available directly from manufacturers at significantly higher cost.
  // Do not make FDA-approval claims for compounded medications — compounded
  // drugs are not individually FDA-approved products.
  {
    key: "compounded_medication",
    approvedText:
      "Our medications are compounded — they're not the brand-name versions like Ozempic, Wegovy, Mounjaro, or Zepbound. " +
      "Compounded medications contain the same active ingredient (semaglutide or tirzepatide) and are prepared by licensed compounding pharmacies. " +
      "Brand-name versions sourced directly from the pharmaceutical manufacturers typically cost two to three times more. " +
      "Compounded medications are not individually FDA-approved products.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    prohibitedClaims: [
      "fda_approved_compounded", // compounded drugs are not individually FDA-approved
      "bioequivalence_guarantee", // cannot guarantee identical bioequivalence to brand
      "brand_inferiority_claim", // do not disparage brand products
      "same_manufacturer", // compounded is not from the original manufacturer
    ],
    enabledForPreview: true,
  },

  // ── Eligibility requirements ──────────────────────────────────────────────
  // Source: owner-confirmed — eligibility is determined by the provider during
  // the intake review based on BMI and other health factors.
  // Primary instruction: direct the patient to the questionnaire.
  // Do not pre-screen or guarantee eligibility.
  {
    key: "eligibility_requirements",
    approvedText:
      "Eligibility is determined by a licensed provider during the intake review. " +
      "Generally, a BMI over 23 is accepted, though other health factors also apply. " +
      "The best way to find out if you qualify is to complete the short medical questionnaire, which takes about 5 minutes. " +
      "We can't guarantee eligibility before the provider reviews your information.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    prohibitedClaims: [
      "guaranteed_eligibility", // provider determines eligibility, not Alexis
      "specific_bmi_cutoff_as_guarantee", // BMI is one factor; do not state a specific cutoff as a guarantee
      "pre_screening_eligibility", // Alexis cannot pre-screen
      "automatic_approval", // provider review is required
    ],
    enabledForPreview: true,
  },

  // ── Refund policy ─────────────────────────────────────────────────────────
  // Source: owner-confirmed — no refunds; cancellation anytime via patient portal.
  // Common context: patients who stop seeing results or struggle with injection
  // consistency. Acknowledge without arguing, then note cancellation option.
  {
    key: "refund_policy",
    approvedText:
      "We don't offer refunds, but you can cancel your plan anytime through the patient portal. " +
      "Results vary from person to person and depend on consistency with the programme, including keeping up with injections. " +
      "If you have concerns about your progress, the medical team can review your case during the provider-review step.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    prohibitedClaims: [
      "refund_promise", // no refunds are offered
      "satisfaction_guarantee", // no money-back guarantee
      "prorated_refund", // no prorated credits
      "results_guarantee", // individual results vary
    ],
    enabledForPreview: true,
  },

  // ── Privacy and HIPAA ─────────────────────────────────────────────────────
  // Source: owner-confirmed — HIPAA-compliant, secure systems.
  {
    key: "privacy_hipaa",
    approvedText:
      "Your information is protected under HIPAA. " +
      "We use secure, HIPAA-compliant systems to store and handle your health information. " +
      "Your data is never sold.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    prohibitedClaims: [
      "absolute_security_guarantee", // no system is 100% breach-proof
      "specific_encryption_claims", // do not invent technical specs
    ],
    enabledForPreview: true,
  },

  // ── Auto-refill ───────────────────────────────────────────────────────────
  // Source: owner-confirmed — plans auto-refill; cancel anytime in patient portal
  // with 7-day notice (consistent with cancellation_policy topic).
  {
    key: "auto_refill",
    approvedText:
      "Your plan auto-refills on your scheduled refill date so you don't have to reorder manually. " +
      "You can manage or cancel your subscription anytime through the patient portal. " +
      "To avoid being charged for the next shipment, cancel at least 7 days before your next refill date.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    prohibitedClaims: [
      "instant_cancellation", // 7-day notice window applies
      "prorated_refund_on_cancel", // no refunds on cancellation
      "pause_option", // only cancellation is confirmed; pause not approved
    ],
    enabledForPreview: true,
  },

  // ── First month offer ──────────────────────────────────────────────────────
  // SOURCE: alexis-promotion-v1 (separately versioned; not part of alexis-knowledge-v1).
  // Approved by the owner who attested that medical staff and legal reviewed the terms.
  // approvedAt: null — owner has not supplied an explicit approval date.
  {
    key: "first_month_offer",
    approvedText:
      "New customers can receive $20 off their first month. " +
      "The discount is automatically applied and cannot be combined with another promotion.",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-15",
    alexisSourceVersion: "alexis-promotion-v1",
    prohibitedClaims: [
      "eligibility_after_prior_purchase", // discount applies to new customers only
      "stackable_promotions", // cannot be combined with another promotion
      "guaranteed_eligibility", // never promise eligibility
      "invented_coupon_code", // no code required; automatically applied
      "offer_expiry_date", // no expiration unless a later approved source supplies one
      "plans_other_than_semaglutide_or_tirzepatide", // applies to both plans only
    ],
    enabledForPreview: true,
  },
  // ── Patient portal ─────────────────────────────────────────────────────────
  // Source: owner-confirmed patient login URL. Sophie-only topic — Alexis has no
  // reason to send an existing-customer portal link to a prospect.
  {
    key: "portal_help",
    approvedText:
      "You can manage your account, check your order, and message the care team anytime through the patient portal: " +
      "https://patient.tryark.com/login",
    allowedParaphrase: true,
    legalStatus: "approved",
    clinicalStatus: "approved",
    lastReviewedDate: "2026-08-16",
    prohibitedClaims: ["guaranteed_response_time", "portal_medical_advice"],
    enabledForPreview: true,
  },
] as const;

/**
 * Topic keys explicitly marked Sophie-only in their catalog entry's comment —
 * excluded from Alexis's topic list even though enabledForPreview is true.
 *
 * portal_help: Alexis has no legitimate use for a patient-portal login link
 * aimed at a prospect who hasn't purchased and has no account to log into.
 * (Alexis's URL allowlist would also reject the literal link if Claude tried
 * to output it, but that shouldn't be the only thing stopping her from
 * citing/paraphrasing the topic in the first place.)
 *
 * how_ark_works_after_purchase: written entirely from "after your order
 * comes in..." — premature and wrong for a prospect who hasn't ordered yet.
 * Alexis has her own pre-purchase version, how_ark_works.
 *
 * existing_customer_current_rate is excluded for the same reason as portal_help:
 * it reassures an existing customer about the rate they're *already enrolled at*,
 * which doesn't apply to a prospect who hasn't purchased yet. Alexis's pricing
 * conversations with prospects are handled by her own pre-purchase pricing topics.
 *
 * medication_onset_timeline and appetite_hunger_management: both are
 * questions an existing patient already taking the medication asks, not a
 * prospect deciding whether to sign up — see each topic's own comment.
 */
const ALEXIS_EXCLUDED_TOPIC_KEYS = new Set([
  "portal_help",
  "how_ark_works_after_purchase",
  "existing_customer_current_rate",
  "medication_onset_timeline",
  "appetite_hunger_management",
]);

/** All topics available for the development bot-test preview. */
export function getPreviewEnabledTopics(): readonly KnowledgeTopic[] {
  return KNOWLEDGE_CATALOG.filter((t) => t.enabledForPreview && !ALEXIS_EXCLUDED_TOPIC_KEYS.has(t.key));
}

/**
 * The fixed approved patient-portal login URL — the Sophie equivalent of
 * APPROVED_REVIEW_URLS. Sophie may output this verbatim; Alexis never does.
 */
export const APPROVED_PORTAL_URL = "https://patient.tryark.com/login";

/**
 * Direct "write a review" deep link — Sophie-only, used specifically in the
 * post-delivery review-request flow when the patient's sentiment is
 * positive. Distinct from APPROVED_REVIEW_URLS (the two general
 * read-reviews pages Alexis and Sophie both may share when asked about
 * reviews generally): this one is for actually asking someone to submit a
 * review, so it goes straight to the write-a-review form, not an overview page.
 */
export const APPROVED_REVIEW_WRITE_URL = "https://www.consumeraffairs.com/review/write/?brand_id=24325";

/**
 * Topic keys Sophie (the post-purchase support bot) is allowed to use — a
 * subset of the same catalog Alexis draws from, reused verbatim rather than
 * duplicated. Deliberately excludes every pre-purchase/sales/clinical topic
 * (product_comparison, pricing, titration, previous_prescriptions, weight
 * loss expectations, side_effects, eligibility, first_month_offer) — Sophie's
 * whole domain is post-purchase customer service with zero individualized
 * clinical content; anything clinical routes to staff.
 *
 * compounded_medication and existing_customer_current_rate are the two
 * narrow exceptions: general product/account information rather than
 * individualized clinical or new-sale pricing guidance. compounded_medication
 * covers "how does my medication compare to a brand name" (semaglutide/
 * Ozempic/Wegovy, tirzepatide/Mounjaro/Zepbound) — see the topic-gated rule
 * in lib/support/safety.ts. existing_customer_current_rate covers "am I
 * missing a better deal" from someone who's already enrolled, without
 * quoting any dollar figure or promising a rate that could later be false.
 *
 * how_ark_works_after_purchase, not how_ark_works: the latter is written
 * entirely for a prospect who hasn't signed up yet (select a plan, complete
 * the questionnaire) — wrong framing for every patient Sophie talks to, who's
 * already done that. See how_ark_works_after_purchase's own comment above.
 *
 * medication_onset_timeline and appetite_hunger_management are two more
 * exceptions, for the same reason: general, non-personalized education (when
 * effects typically start, coping with residual hunger) that an existing
 * patient legitimately asks Sophie, not individualized clinical guidance.
 * Both are worded to avoid "dose"/"mg"/"side effect" — see each topic's own
 * comment for why: Sophie's SOPHIE_PROHIBITED_CLINICAL_RE rejects those words
 * in her reply unconditionally, with no topic-gate exception.
 */
export const SOPHIE_TOPIC_KEYS = new Set([
  "insurance_payment",
  "how_ark_works_after_purchase",
  "customer_reviews",
  "cancellation_policy",
  "shipping_delivery",
  "privacy_hipaa",
  "auto_refill",
  "portal_help",
  "compounded_medication",
  "existing_customer_current_rate",
  "medication_onset_timeline",
  "appetite_hunger_management",
]);

/** Topics available to Sophie's conversation loop. */
export function getSophieEnabledTopics(): readonly KnowledgeTopic[] {
  return KNOWLEDGE_CATALOG.filter((t) => t.enabledForPreview && SOPHIE_TOPIC_KEYS.has(t.key));
}

/** Look up a topic by its key. Returns undefined when not found. */
export function getTopicByKey(key: string): KnowledgeTopic | undefined {
  return KNOWLEDGE_CATALOG.find((t) => t.key === key);
}

/**
 * Topic keys whose dollar amounts represent product subscription prices.
 * Dollar amounts are permitted in replies that declare at least one of these keys.
 */
export const PRODUCT_PRICING_TOPIC_KEYS = new Set(["semaglutide_pricing", "tirzepatide_pricing"]);

/**
 * All topic keys that carry approved dollar-amount claims.
 * Superset of PRODUCT_PRICING_TOPIC_KEYS — includes the promotion entry.
 */
export const APPROVED_PRICING_TOPIC_KEYS = new Set(["semaglutide_pricing", "tirzepatide_pricing", "first_month_offer"]);

/**
 * Topic keys derived from the alexis-promotion-v1 approved promotion entry.
 * These are separately versioned from alexis-knowledge-v1.
 */
export const ALEXIS_PROMOTION_V1_TOPIC_KEYS = new Set(["first_month_offer"]);

/**
 * Topic keys derived from the alexis-knowledge-v1 source document.
 * These entries must remain consistent with alexis-knowledge-source.ts.
 *
 * semaglutide_pricing and tirzepatide_pricing are deliberately NOT included:
 * their pricing was rebuilt from Ark Health's own transparent-pricing page
 * (owner-supplied 2026-08-25), not from the immutable alexis-knowledge-v1
 * document, so they're no longer consistency-checked against it here.
 */
export const ALEXIS_V1_TOPIC_KEYS = new Set([
  "product_comparison",
  "titration",
  "previous_prescriptions",
  "weight_loss_expectations",
  "side_effects",
  "insurance_payment",
  "how_ark_works",
  "customer_reviews",
  "cancellation_policy",
]);
