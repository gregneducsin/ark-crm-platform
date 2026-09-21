import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { scheduleLeadCheckin } from "./lead-checkin.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { isSalesSmsPaused } from "../lib/sales-sms.js";
import { renderMetaLeadOpener } from "../lib/messaging/follow-up-templates.js";
import { logger } from "../lib/logger.js";
import { isCustomerSmsDnd } from "./dnd.service.js";
import { withPersonLock } from "../lib/db-lock.js";

/**
 * Sends the opener for a Meta lead-gen form-fill lead immediately, on the
 * same request that processes the GHL webhook — no sweep, no `dueAt`, this
 * fires instantly per the "respond fast to ad leads" requirement. Failures
 * are caught and logged, never thrown, so a missing SMS provider or send
 * error never turns into a webhook 500 (the webhook's own idempotency on
 * eventId is what prevents a duplicate delivery from double-sending).
 *
 * While sales SMS is paused, this opener is skipped entirely (not retried
 * later — there's no trigger row backing this fire-instantly path, unlike
 * abandoned-cart/lead-checkin/objection-reengagement/follow-up-jobs), same
 * as a DND skip below. A lead that comes in during the pause simply doesn't
 * get an automated opener; new leads after sales resumes are unaffected.
 */
export async function sendMetaLeadOpener(personId: string): Promise<void> {
  if (isSalesSmsPaused()) {
    logger.warn({ personId }, "meta-lead opener not sent: sales SMS is paused");
    return;
  }

  const [customer] = await db.select({ firstName: customersTable.firstName, phone: customersTable.phone }).from(customersTable).where(eq(customersTable.id, personId));
  if (!customer?.phone) {
    logger.warn({ personId }, "meta-lead opener not sent: no phone number on file");
    return;
  }
  if (await isCustomerSmsDnd(personId)) {
    logger.warn({ personId }, "meta-lead opener not sent: customer is do-not-disturb");
    return;
  }

  const text = renderMetaLeadOpener(customer.firstName);
  // Narrowed to a plain string here, before the closure below — TS doesn't
  // carry the `!customer?.phone` narrowing above into a nested closure.
  const phone = customer.phone;
  // Arms the 6-day check-in the moment we're about to send this lead's very
  // first message — see the identical comment in abandoned-cart.service.ts.
  await scheduleLeadCheckin(personId);

  // Locked against the same per-person key processInboundMessage uses
  // (alexis-dispatch.service.ts) — this fires the instant a GHL webhook lands,
  // which can race a live inbound turn for the same person (e.g. they text
  // in at almost the same moment the lead webhook arrives). The conversation
  // read/write needs to happen atomically with respect to that turn, same
  // reasoning as every other proactive sender.
  await withPersonLock(personId, async () => {
    const conversation = await getOrCreateConversation(personId, "meta_form");
    try {
      const result = await getSmsProvider().sendMessage(phone, text);
      await appendMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId, deliveryStatus: "sent" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn({ personId, reason }, "meta-lead opener send failed");
      // Still logged for visibility even though the send failed — this is
      // what Alexis's opener would have said, once a provider exists.
      await appendMessage(conversation.id, "outbound", text, { deliveryStatus: "failed" });
    }
  });
}
