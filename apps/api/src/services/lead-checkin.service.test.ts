import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, purchasesTable, leadCheckinTriggersTable } from "@luma/db";
import { setCustomerSmsDnd } from "./dnd.service.js";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const appendMessageMock = vi.fn();
vi.mock("./conversations.service.js", async () => {
  const actual = await vi.importActual<typeof import("./conversations.service.js")>("./conversations.service.js");
  appendMessageMock.mockImplementation(actual.appendMessage);
  return { ...actual, appendMessage: appendMessageMock };
});

const { scheduleLeadCheckin, sweepLeadCheckinTriggers } = await import("./lead-checkin.service.js");
const { getOrCreateConversation, listMessages, updateConversationState } = await import("./conversations.service.js");

async function seedCustomer(opts: { phone?: string | null; firstName?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: opts.firstName ?? "Checkin",
      lastName: "Test",
      email: `checkin-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15557770000" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

async function backdateTrigger(personId: string) {
  await db.update(leadCheckinTriggersTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(leadCheckinTriggersTable.personId, personId));
}

describe("scheduleLeadCheckin", () => {
  it("schedules a pending trigger due about 6 days out", async () => {
    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);

    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
    const dueInMs = new Date(trigger.dueAt).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000 - 10_000);
    expect(dueInMs).toBeLessThan(6 * 24 * 60 * 60 * 1000 + 10_000);
  });

  it("is idempotent per person — a duplicate call does not create a second trigger", async () => {
    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);
    await scheduleLeadCheckin(personId);

    const triggers = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(triggers.length).toBe(1);
  });
});

describe("sweepLeadCheckinTriggers", () => {
  it("asks the currently-taking question when the lead has never answered it", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ask" });

    const personId = await seedCustomer({ firstName: "Jordan" });
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);

    const result = await sweepLeadCheckinTriggers();
    expect(result.sentCount).toBe(1);
    // Wording is randomized (see renderCurrentlyTakingCheckin's variants) —
    // "semaglutide or tirzepatide" is the substring common to all of them.
    expect(sendMessageMock).toHaveBeenCalledWith("+15557770000", expect.stringContaining("semaglutide or tirzepatide"));

    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");
    expect(trigger.variant).toBe("currently_taking");

    const messages = await listMessages((await getOrCreateConversation(personId)).id);
    expect(messages[0].body).toContain("Jordan");
  });

  it("asks the re-engagement question when the lead already answered currently-taking (yes)", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_reengage_yes" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await updateConversationState(conversation.id, { currentlyTaking: "yes" });
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);

    await sweepLeadCheckinTriggers();

    expect(sendMessageMock).toHaveBeenCalledWith("+15557770000", expect.stringContaining("holding you back"));
    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.variant).toBe("reengagement");
  });

  it("asks the re-engagement question when the lead already answered currently-taking (no)", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_reengage_no" });

    const personId = await seedCustomer();
    const conversation = await getOrCreateConversation(personId);
    await updateConversationState(conversation.id, { currentlyTaking: "no" });
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);

    await sweepLeadCheckinTriggers();

    expect(sendMessageMock).toHaveBeenCalledWith("+15557770000", expect.stringContaining("holding you back"));
    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.variant).toBe("reengagement");
  });

  it("cancels when the person already purchased by the time it's due", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);

    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    const result = await sweepLeadCheckinTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("cancelled");
    expect(trigger.cancelledReason).toBe("already_purchased");
  });

  it("cancels when the person is do-not-disturb by the time it's due", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);
    await setCustomerSmsDnd(personId, true);

    const result = await sweepLeadCheckinTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("cancelled");
    expect(trigger.cancelledReason).toBe("opted_out");
  });

  it("marks failed with NO_PHONE_NUMBER and does not call the provider when there's no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);

    const result = await sweepLeadCheckinTriggers();
    expect(result.failedCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("failed");
    expect(trigger.failureReason).toBe("NO_PHONE_NUMBER");
  });

  it("leaves not-yet-due triggers untouched", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);

    const result = await sweepLeadCheckinTriggers();
    expect(result.sentCount).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
  });

  it("retries a failed trigger once it cools down, and succeeds on the retry", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("SMS_PROVIDER_TIMEOUT"));

    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);

    const first = await sweepLeadCheckinTriggers();
    expect(first.failedCount).toBe(1);

    sendMessageMock.mockClear();
    const tooSoon = await sweepLeadCheckinTriggers();
    expect(tooSoon.sentCount).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();

    await db.update(leadCheckinTriggersTable).set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(leadCheckinTriggersTable.personId, personId));

    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_retry_success" });
    const retry = await sweepLeadCheckinTriggers();
    expect(retry.sentCount).toBe(1);

    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");
    expect(trigger.attemptCount).toBe(2);
  });

  it("marks the trigger sent — not failed/retried — when the real text send succeeds but logging it into the conversation throws", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_logging_blip" });
    appendMessageMock.mockRejectedValueOnce(new Error("transient db blip"));

    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);

    const result = await sweepLeadCheckinTriggers();
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");
    expect(trigger.attemptCount).toBe(1);

    // A later sweep must not re-send the real text just because the
    // conversation-log write failed the first time.
    sendMessageMock.mockClear();
    await db.update(leadCheckinTriggersTable).set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(leadCheckinTriggersTable.personId, personId));
    await sweepLeadCheckinTriggers();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("stops retrying once the attempt cap is reached, leaving it permanently failed", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);
    await db
      .update(leadCheckinTriggersTable)
      .set({ status: "failed", failureReason: "SMS_PROVIDER_TIMEOUT", attemptCount: 3, updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(leadCheckinTriggersTable.personId, personId));

    const result = await sweepLeadCheckinTriggers();
    expect(result.sentCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends exactly once when a second sweep starts while the first is still mid-send for the same trigger", async () => {
    sendMessageMock.mockClear();
    let callCount = 0;
    sendMessageMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          callCount += 1;
          const providerMessageId = callCount === 1 ? "msg_first" : "msg_second";
          setTimeout(() => resolve({ providerMessageId }), callCount === 1 ? 60 : 0);
        }),
    );

    const personId = await seedCustomer();
    await scheduleLeadCheckin(personId);
    await backdateTrigger(personId);

    const first = sweepLeadCheckinTriggers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = sweepLeadCheckinTriggers();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.sentCount + r2.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [trigger] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");
  });
});
