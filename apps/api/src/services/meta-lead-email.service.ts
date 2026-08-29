import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { db, metaLeadEmailTriggersTable, abandonedCartEmailTriggersTable, customersTable, purchasesTable } from "@luma/db";
import { getOrCreateEmailConversation, appendEmailMessage, updateEmailConversationState } from "./email-conversations.service.js";
import { createIntakeLink } from "./intake-links.service.js";
import { sendTriggerEmail } from "../lib/email/send-trigger-email.js";
import {
  renderAbandonedCartOpenerEmail,
  renderAbandonedCartUrgencyEmail,
  renderAbandonedCartEducationalEmail,
  renderAbandonedCartPlanComparisonEmail,
  type RenderedEmail,
} from "../lib/email/templates.js";
import { isCustomerEmailDnd } from "./dnd.service.js";
import { logger } from "../lib/logger.js";
import { notifySlack } from "../lib/slack.js";

/**
 * The same 4-step nurture sequence as abandoned-cart-email.service.ts —
 * identical templates and cadence — armed instead off a Meta lead-gen
 * form-fill. See metaLeadEmailTriggersTable's docstring
 * (packages/db/src/schema/email.ts) for why this is its own table rather
 * than reusing abandonedCartEmailTriggersTable.
 */
export type MetaLeadEmailStep = "opener" | "urgency" | "educational" | "plan_comparison";

const STEP_ORDER: readonly MetaLeadEmailStep[] = ["opener", "urgency", "educational", "plan_comparison"];

const STEP_DELAY_MS: Record<MetaLeadEmailStep, number> = {
  opener: 10 * 60 * 1000,
  urgency: 24 * 60 * 60 * 1000,
  educational: 7 * 24 * 60 * 60 * 1000,
  plan_comparison: 10 * 24 * 60 * 60 * 1000,
};

/**
 * Arms all 4 steps of the sequence at once, called alongside sendMetaLeadOpener
 * from the GHL webhook handler on a Meta form-fill lead. Idempotent per step:
 * the unique index on (personId, step) means a duplicate lead delivery for
 * the same person can't double-schedule any step.
 *
 * Also skips arming this sequence while the person already has an active
 * abandoned-cart-email sequence in flight (abandoned-cart-email.service.ts)
 * — same templates, different entry point, so a customer who's both a GHL
 * lead and separately abandoned the Bask questionnaire shouldn't get
 * enrolled in both. See the identical check there.
 */
export async function scheduleMetaLeadEmailSequence(personId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, personId)).for("update");

    const [existing] = await tx
      .select({ id: metaLeadEmailTriggersTable.id })
      .from(metaLeadEmailTriggersTable)
      .where(and(eq(metaLeadEmailTriggersTable.personId, personId), inArray(metaLeadEmailTriggersTable.status, ["pending", "processing"])))
      .limit(1);
    if (existing) return;

    const [existingAbandonedCart] = await tx
      .select({ id: abandonedCartEmailTriggersTable.id })
      .from(abandonedCartEmailTriggersTable)
      .where(and(eq(abandonedCartEmailTriggersTable.personId, personId), inArray(abandonedCartEmailTriggersTable.status, ["pending", "processing"])))
      .limit(1);
    if (existingAbandonedCart) return;

    const now = Date.now();
    await tx
      .insert(metaLeadEmailTriggersTable)
      .values(STEP_ORDER.map((step) => ({ personId, step, dueAt: new Date(now + STEP_DELAY_MS[step]) })))
      .onConflictDoNothing({ target: [metaLeadEmailTriggersTable.personId, metaLeadEmailTriggersTable.step] });
  });
}

function renderStep(step: MetaLeadEmailStep, firstName: string, ctaUrl: string, unsubscribeUrl: string): RenderedEmail {
  switch (step) {
    case "opener":
      return renderAbandonedCartOpenerEmail(firstName, ctaUrl, unsubscribeUrl);
    case "urgency":
      return renderAbandonedCartUrgencyEmail(firstName, ctaUrl, unsubscribeUrl);
    case "educational":
      return renderAbandonedCartEducationalEmail(firstName, ctaUrl, unsubscribeUrl);
    case "plan_comparison":
      return renderAbandonedCartPlanComparisonEmail(firstName, ctaUrl, unsubscribeUrl);
  }
}

type EligibilityResult = { ok: true } | { ok: false; reason: string };

/**
 * Simpler than the abandoned-cart version's isStillEligible — there's no
 * questionnaire event to recheck the status of for a Meta lead, so this only
 * checks purchase status and email DND.
 */
async function isStillEligible(personId: string): Promise<EligibilityResult> {
  const [purchased] = await db.select({ id: purchasesTable.id }).from(purchasesTable).where(and(eq(purchasesTable.customerId, personId), eq(purchasesTable.status, "completed"))).limit(1);
  if (purchased) return { ok: false, reason: "already_purchased" };

  if (await isCustomerEmailDnd(personId)) return { ok: false, reason: "opted_out" };

  return { ok: true };
}

export interface MetaLeadEmailSweepResult {
  readonly sentCount: number;
  readonly cancelledCount: number;
  readonly failedCount: number;
}

/**
 * Sends every due step across every Meta lead's sequence, unless no longer
 * eligible (rechecked now, not trusted from schedule time). Each step mints
 * a fresh per-lead $20-off intake link at send time — see the identical
 * reasoning on sweepAbandonedCartEmailTriggers.
 *
 * Safe to call repeatedly, including from overlapping sweep runs — same
 * atomic pending->processing claim pattern as every other sweep here.
 */
export async function sweepMetaLeadEmailTriggers(): Promise<MetaLeadEmailSweepResult> {
  const claimed = await db
    .update(metaLeadEmailTriggersTable)
    .set({ status: "processing" })
    .where(and(eq(metaLeadEmailTriggersTable.status, "pending"), lte(metaLeadEmailTriggersTable.dueAt, sql`now()`)))
    .returning({
      id: metaLeadEmailTriggersTable.id,
      personId: metaLeadEmailTriggersTable.personId,
      step: metaLeadEmailTriggersTable.step,
    });

  let sentCount = 0;
  let cancelledCount = 0;
  let failedCount = 0;

  for (const trigger of claimed) {
    const step = trigger.step as MetaLeadEmailStep;
    const eligible = await isStillEligible(trigger.personId);

    if (!eligible.ok) {
      await db
        .update(metaLeadEmailTriggersTable)
        .set({ status: "cancelled", cancelledReason: eligible.reason })
        .where(eq(metaLeadEmailTriggersTable.id, trigger.id));
      cancelledCount++;
      continue;
    }

    const [customer] = await db.select({ firstName: customersTable.firstName, email: customersTable.email }).from(customersTable).where(eq(customersTable.id, trigger.personId));
    if (!customer) {
      logger.warn({ personId: trigger.personId, step }, "meta-lead email: trigger references a customer that no longer exists");
      await db.update(metaLeadEmailTriggersTable).set({ status: "failed", failureReason: "CUSTOMER_NOT_FOUND" }).where(eq(metaLeadEmailTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    let ctaUrl: string;
    try {
      const minted = await createIntakeLink(trigger.personId, "first_month_20", "meta_form");
      ctaUrl = minted.url;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ personId: trigger.personId, step, reason }, "meta-lead email: failed to mint intake link");
      // A broken intake-link config (bad env, misconfigured route) fails on
      // every trigger, not just this one — this can silently zero out the
      // entire nurture sequence with nothing surfacing outside server logs.
      void notifySlack(`Meta-lead email (${step}): failed to mint intake link — ${reason}`);
      await db.update(metaLeadEmailTriggersTable).set({ status: "failed", failureReason: reason }).where(eq(metaLeadEmailTriggersTable.id, trigger.id));
      failedCount++;
      continue;
    }

    const emailConversation = await getOrCreateEmailConversation(trigger.personId);
    const result = await sendTriggerEmail({
      persona: "alexis",
      personId: trigger.personId,
      conversationId: emailConversation.id,
      email: customer.email,
      render: (unsubscribeUrl) => renderStep(step, customer.firstName, ctaUrl, unsubscribeUrl),
      appendMessage: appendEmailMessage,
      logLabel: `meta-lead email (${step})`,
    });

    if (result.status === "sent") {
      await db
        .update(metaLeadEmailTriggersTable)
        .set({ status: "sent", sentAt: sql`now()`, messageId: result.messageId })
        .where(eq(metaLeadEmailTriggersTable.id, trigger.id));
      // Same reasoning as the abandoned-cart sequence's identical line — the
      // opener promises $20 off directly, so the eventual send_form in the
      // reply-driven conversation must use the promo link, not the plain one.
      if (step === "opener") {
        await updateEmailConversationState(emailConversation.id, { promoOffered: true });
      }
      sentCount++;
    } else if (result.status === "dnd") {
      await db
        .update(metaLeadEmailTriggersTable)
        .set({ status: "cancelled", cancelledReason: "opted_out" })
        .where(eq(metaLeadEmailTriggersTable.id, trigger.id));
      cancelledCount++;
    } else {
      await db
        .update(metaLeadEmailTriggersTable)
        .set({ status: "failed", failureReason: result.status })
        .where(eq(metaLeadEmailTriggersTable.id, trigger.id));
      failedCount++;
    }
  }

  if (sentCount > 0 || cancelledCount > 0 || failedCount > 0) {
    logger.info({ sentCount, cancelledCount, failedCount }, "meta-lead email sweep completed");
  }

  return { sentCount, cancelledCount, failedCount };
}
