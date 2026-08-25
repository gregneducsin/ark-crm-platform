/**
 * Fixed, pre-approved follow-up nudges for a lead who clicked the intake
 * link but hasn't completed the Bask questionnaire yet. These are sent
 * automatically by the follow-up sweep, not drafted per-send by Claude —
 * proactive outbound check-ins don't have an inbound message to react to,
 * so there's nothing for the guardrail loop to validate against; the fixed
 * approved text is the guardrail here.
 *
 * Sequence: provider_check_in fires 2 hours after the click (if still
 * incomplete). If that send succeeds, intake_questions_check_in is
 * scheduled 1 hour after — relative to when the first one actually sent,
 * not a fixed offset from the click, so the "an hour later" promise holds
 * even if the sweep runs a few minutes late.
 *
 * Every template below is a small set of pre-approved variants, picked at
 * random (see pickVariant), not one fixed string — every lead getting the
 * exact same byte-for-byte sentence reads as templated. Every variant for a
 * given step still satisfies the same structural rules (checked in this
 * file's tests): one trailing question mark where a question mark is
 * expected, none where it isn't, no em dash, same required content (the
 * $20 offer, asking about state, etc).
 */

function pickVariant(variants: readonly string[]): string {
  return variants[Math.floor(Math.random() * variants.length)];
}

export type FollowUpMessageStep = "provider_check_in" | "intake_questions_check_in";

/**
 * provider_check_in fires only ~2 hours after the opener (which already
 * introduced Alexis by name and company) in the same thread — repeating the
 * full self-introduction there read as robotic rather than as a real
 * follow-up from someone the recipient just heard from, so it's dropped
 * here the same way intake_questions_check_in already omits it.
 */
const TEMPLATES: Record<FollowUpMessageStep, (firstName: string) => string> = {
  provider_check_in: (firstName) =>
    pickVariant([
      `Hey ${firstName}, should I go ahead and let the doctors know to look out for your completed questionnaire?`,
      `Hey ${firstName}, want me to give the doctors a heads-up to expect your completed questionnaire?`,
    ]),
  intake_questions_check_in: (firstName) =>
    pickVariant([
      `Hey ${firstName}, just checking in. Do you have any questions about the intake form?`,
      `Hey ${firstName}, checking back in. Any questions on the intake form so far?`,
    ]),
};

export function renderFollowUpMessage(step: FollowUpMessageStep, firstName: string): string {
  return TEMPLATES[step](firstName.trim() || "there");
}

/**
 * The very first outbound message to a lead who abandoned the Bask
 * questionnaire — fired 10 minutes after Bask's `abandoned` webhook event,
 * 24/7, no monitored-hours window. Fixed template, not AI-drafted, same
 * reasoning as the follow-up nudges above. Mentions the $20-off offer
 * directly but deliberately does not include a link — if the customer
 * responds with interest, the normal Alexis conversation loop (runAlexisTurn)
 * takes over and mints the real link via action=send_form.
 */
export function renderAbandonedCartOpener(firstName: string): string {
  const name = firstName.trim() || "there";
  return pickVariant([
    `Hi ${name}, this is Alexis with Ark Health. I noticed you started your online visit but didn't get a chance to finish it. Complete your enrollment now and get $20 off your first month. Want me to send the link to get started?`,
    `Hi ${name}, this is Alexis with Ark Health. Looks like you started your online visit but didn't quite finish it. Complete your enrollment and get $20 off your first month. Want the link so you can pick back up?`,
  ]);
}

/**
 * Same abandoned-questionnaire nudge as renderAbandonedCartOpener, for a
 * lead who already has an active conversation with Alexis by the time this
 * fires — most commonly, they came in as a Meta lead first and only later
 * started (then abandoned) the Bask questionnaire separately. Drops the
 * self-introduction — same reasoning as provider_check_in/
 * intake_questions_check_in above — since repeating "Hi, this is Alexis with
 * Ark Health" into an already-ongoing thread reads as a robotic duplicate,
 * not a genuine follow-up. The abandoned-questionnaire signal itself is
 * still real and worth sending, just without re-introducing her.
 */
export function renderAbandonedCartFollowUp(firstName: string): string {
  const name = firstName.trim() || "there";
  return pickVariant([
    `Hey ${name}, noticed you started your online visit but didn't get a chance to finish it. Complete your enrollment now and get $20 off your first month. Want me to send the link to get started?`,
    `Hey ${name}, looks like you started your online visit but didn't quite finish it. Complete your enrollment and get $20 off your first month. Want the link so you can pick back up?`,
  ]);
}

/**
 * The very first outbound message to a lead who just submitted a Meta
 * (Facebook/Instagram) lead-gen form — fired instantly on receipt of the
 * webhook, 24/7, no monitored-hours window. Fixed template, not AI-drafted,
 * same reasoning as the abandoned-cart opener. Cold outreach, not a
 * "finish what you started" message — asks for state first (doubles as the
 * reason for the text: checking current promotions). The normal Alexis
 * conversation loop (runAlexisTurn) takes over from the reply.
 */
export function renderMetaLeadOpener(firstName: string): string {
  const name = firstName.trim() || "there";
  return pickVariant([
    `Hey ${name}, this is Alexis with Ark Health. I wanted to check what state you're in to see what promotions we have running for you right now.`,
    `Hey ${name}, this is Alexis with Ark Health. Wanted to check what state you're located in so I can share the promotions available for you right now.`,
  ]);
}

/**
 * The 6-day check-in — fired once per lead, 6 days after the very first
 * outbound message Alexis ever sent them (see lead-checkin.service.ts), 24/7,
 * no monitored-hours window. Fixed template, not AI-drafted, same reasoning
 * as the openers above. Which variant fires depends on the conversation's
 * currentlyTaking slot at send time: still unanswered -> ask directly;
 * already answered (yes or no) -> a re-engagement question instead, since
 * asking the same thing twice would be redundant. No self-introduction here
 * either — same reasoning as provider_check_in above — this is still the
 * same phone thread Alexis already introduced herself in, even six days later.
 */
export function renderCurrentlyTakingCheckin(firstName: string): string {
  const name = firstName.trim() || "there";
  return pickVariant([
    `Hi ${name}, quick question, are you currently taking semaglutide or tirzepatide?`,
    `Hi ${name}, quick one for you, are you currently on semaglutide or tirzepatide?`,
  ]);
}

export function renderReengagementCheckin(firstName: string): string {
  const name = firstName.trim() || "there";
  return pickVariant([
    `Hi ${name}, still thinking it over? What's the biggest thing holding you back from getting started?`,
    `Hi ${name}, still weighing it? What's the main thing holding you back from getting started?`,
  ]);
}
