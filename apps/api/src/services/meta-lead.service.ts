import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { scheduleLeadCheckin } from "./lead-checkin.service.js";
import { getSmsProvider } from "../lib/sms-provider.js";
import { renderMetaLeadOpener } from "../lib/messaging/follow-up-templates.js";
import { logger } from "../lib/logger.js";
import { isCustomerSmsDnd } from "./dnd.service.js";

/**
 * Sends the opener for a Meta lead-gen form-fill lead immediately, on the
 * same request that processes the GHL webhook — no sweep, no `dueAt`, this
 * fires instantly per the "respond fast to ad leads" requirement. Failures
 * are caught and logged, never thrown, so a missing SMS provider or send
 * error never turns into a webhook 500 (the webhook's own idempotency on
 * eventId is what prevents a duplicate delivery from double-sending).
 */
export async function sendMetaLeadOpener(personId: string): Promise<void> {
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
  const conversation = await getOrCreateConversation(personId, "meta_form");
  // Arms the 6-day check-in the moment we're about to send this lead's very
  // first message — see the identical comment in abandoned-cart.service.ts.
  await scheduleLeadCheckin(personId);

  try {
    const result = await getSmsProvider().sendMessage(customer.phone, text);
    await appendMessage(conversation.id, "outbound", text, { providerMessageId: result.providerMessageId });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ personId, reason }, "meta-lead opener send failed");
    // Still logged for visibility even though the send failed — this is what
    // Alexis's opener would have said, once a provider exists.
    await appendMessage(conversation.id, "outbound", text, {});
  }
}
