import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, questionnaireEventsTable, webhookEventsTable } from "@luma/db";
import { baskQuestionnaireWebhookRequestSchema, baskQuestionnaireAbandonedWebhookRequestSchema } from "@luma/shared";
import { unwrapBaskEnvelope } from "../lib/bask-webhook-envelope.js";

const { sms, email } = vi.hoisted(() => ({ sms: vi.fn(), email: vi.fn() }));
vi.mock("./abandoned-cart.service.js", () => ({ scheduleAbandonedCartOpener: sms }));
vi.mock("./abandoned-cart-email.service.js", () => ({ scheduleAbandonedCartEmailSequence: email }));
const { handleBaskQuestionnaireWebhook, handleBaskQuestionnaireAbandonedWebhook } = await import("./webhooks.service.js");

const link = "https://bask.example.com/resume?token=synthetic";
function payload() {
  const id = crypto.randomUUID();
  return { eventId: id, externalPersonId: id, email: `resume-${id}@example.com`, questionnaireId: id, status: "abandoned" as const };
}
async function readEvent(externalPersonId: string) {
  const [row] = await db.select().from(questionnaireEventsTable)
    .where(eq(questionnaireEventsTable.externalPersonId, externalPersonId));
  return row;
}

describe("questionnaire resume links through the shared endpoint contract", () => {
  beforeEach(() => { sms.mockClear(); email.mockClear(); });

  it.each(["magicLink", "Data Magic Link", "resumeUrl"])("preserves and saves %s in a flat Zapier payload", async (key) => {
    const input = payload();
    const parsed = baskQuestionnaireWebhookRequestSchema.parse({ ...input, [key]: link });
    expect(await handleBaskQuestionnaireWebhook(parsed)).toEqual({ duplicate: false });
    expect((await readEvent(input.externalPersonId)).resumeUrl).toBe(link);
    const [audit] = await db.select().from(webhookEventsTable).where(and(
      eq(webhookEventsTable.source, "bask_questionnaire"),
      eq(webhookEventsTable.externalEventId, input.eventId),
    ));
    expect(audit.rawPayload).toMatchObject({ [key]: link });
    expect(sms).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
  });

  it("supports the direct Bask envelope without a different endpoint", async () => {
    const input = payload();
    const parsed = baskQuestionnaireWebhookRequestSchema.parse(unwrapBaskEnvelope({
      type: "abandonedSession", data: { ...input, magicLink: link },
    }));
    await handleBaskQuestionnaireWebhook(parsed);
    expect((await readEvent(input.externalPersonId)).resumeUrl).toBe(link);
  });

  it("keeps duplicate deliveries as no-ops without scheduling another outreach", async () => {
    const input = baskQuestionnaireWebhookRequestSchema.parse({ ...payload(), magicLink: link });
    await handleBaskQuestionnaireWebhook(input);
    expect(await handleBaskQuestionnaireWebhook(input)).toEqual({ duplicate: true });
    expect(sms).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(1);
    expect((await readEvent(input.externalPersonId)).resumeUrl).toBe(link);
  });

  it.each([undefined, null, "", "{{data.magicLink}}", "javascript:alert(1)"])("does not erase a saved link with an absent/invalid value: %s", async (magicLink) => {
    const input = payload();
    await handleBaskQuestionnaireWebhook(baskQuestionnaireWebhookRequestSchema.parse({ ...input, magicLink: link }));
    await handleBaskQuestionnaireWebhook(baskQuestionnaireWebhookRequestSchema.parse({
      ...input, eventId: crypto.randomUUID(), magicLink,
    }));
    expect((await readEvent(input.externalPersonId)).resumeUrl).toBe(link);
  });

  it.each(["started", "submitted"])("does not capture a magic link or schedule outreach for %s", async (status) => {
    const input = payload();
    await handleBaskQuestionnaireWebhook(baskQuestionnaireWebhookRequestSchema.parse({ ...input, status, magicLink: link }));
    expect((await readEvent(input.externalPersonId)).resumeUrl).toBeNull();
    expect(sms).not.toHaveBeenCalled();
    expect(email).not.toHaveBeenCalled();
  });

  it("keeps the dedicated abandoned endpoint working", async () => {
    const input = payload();
    await handleBaskQuestionnaireAbandonedWebhook(baskQuestionnaireAbandonedWebhookRequestSchema.parse({ ...input, magicLink: link }));
    expect((await readEvent(input.externalPersonId)).resumeUrl).toBe(link);
  });
});
