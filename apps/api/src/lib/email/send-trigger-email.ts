import { sendTrackedEmail, flagEmailForReview, type ConversationEmailPersona } from "../../services/email-delivery.service.js";
import { htmlToPlainText, type RenderedEmail } from "./templates.js";
import { buildUnsubscribeUrl } from "./unsubscribe.js";
import { isCustomerEmailDnd } from "../../services/dnd.service.js";
import { logger } from "../logger.js";

export type SendTriggerEmailResult =
  | { readonly status: "sent"; readonly messageId: string }
  | { readonly status: "dnd" }
  | { readonly status: "render_failed" }
  | { readonly status: "send_failed" };

/** Fixed-template emails share the durable reply transport and staff-review behavior. */
export async function sendTriggerEmail(params: {
  persona: ConversationEmailPersona;
  personId: string;
  conversationId: string;
  email: string;
  /** Renders the template given this customer's unsubscribe URL — called (and its own failures caught) inside this function, not by the caller, so a config error (e.g. INTAKE_LINK_BASE_URL unset) fails soft like every other send failure instead of throwing out of the trigger pipeline that called this. */
  render: (unsubscribeUrl: string) => RenderedEmail;
  logLabel: string;
}): Promise<SendTriggerEmailResult> {
  const { persona, personId, conversationId, email, render, logLabel } = params;

  if (await isCustomerEmailDnd(personId)) {
    logger.warn({ personId, conversationId }, `${logLabel} email not sent: customer is do-not-disturb`);
    return { status: "dnd" };
  }

  let unsubscribeUrl: string;
  let rendered: RenderedEmail;
  try {
    unsubscribeUrl = buildUnsubscribeUrl(personId);
    rendered = render(unsubscribeUrl);
  } catch (err) {
    logger.warn({ personId, conversationId, reason: err instanceof Error ? err.message : String(err) }, `${logLabel} email not sent: failed to render`);
    await flagEmailForReview(persona, conversationId, "An automated email could not be prepared. Please review this conversation and reply.");
    return { status: "render_failed" };
  }

  const result = await sendTrackedEmail({ persona, personId, conversationId, email, subject: rendered.subject,
    body: htmlToPlainText(rendered.html), render: () => rendered.html, transactional: persona === "sophie" });
  return result.status === "sent" ? result : { status: "send_failed" };
}
