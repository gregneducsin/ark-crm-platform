import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, questionnaireEventsTable, purchasesTable, abandonedCartTriggersTable, leadCheckinTriggersTable } from "@luma/db";
import { setCustomerSmsDnd } from "./dnd.service.js";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const { scheduleAbandonedCartOpener, sweepAbandonedCartTriggers } = await import("./abandoned-cart.service.js");
const { getOrCreateConversation, appendMessage, listMessages } = await import("./conversations.service.js");

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Cart",
      lastName: "Test",
      email: `cart-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15559990000" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

async function seedAbandonedQuestionnaire(personId: string): Promise<string> {
  const [row] = await db
    .insert(questionnaireEventsTable)
    .values({ personId, questionnaireId: `q-${crypto.randomUUID()}`, status: "abandoned", lastEventAt: new Date(), abandonedAt: new Date() })
    .returning({ id: questionnaireEventsTable.id });
  return row.id;
}

async function backdateTrigger(personId: string) {
  await db.update(abandonedCartTriggersTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(abandonedCartTriggersTable.personId, personId));
}

describe("scheduleAbandonedCartOpener", () => {
  it("schedules a pending trigger due about 10 minutes out", async () => {
    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);

    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
    const dueInMs = new Date(trigger.dueAt).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(10 * 60 * 1000 - 5000);
    expect(dueInMs).toBeLessThan(10 * 60 * 1000 + 5000);
  });

  it("is idempotent per questionnaire event — a duplicate call does not create a second trigger", async () => {
    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);

    const triggers = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(triggers.length).toBe(1);
  });

  it("does not arm a second opener for a distinct questionnaire event on the same person while one is still pending", async () => {
    // Same bug as the email sequence: a restarted questionnaire attempt gets
    // a new questionnaireEventId, which the per-event unique index alone
    // wouldn't catch — without this guard the person would get two opener
    // texts instead of one.
    const personId = await seedCustomer();
    const firstEventId = await seedAbandonedQuestionnaire(personId);
    const secondEventId = await seedAbandonedQuestionnaire(personId);

    await scheduleAbandonedCartOpener(personId, firstEventId);
    await scheduleAbandonedCartOpener(personId, secondEventId);

    const triggers = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(triggers).toHaveLength(1);
    expect(triggers[0].questionnaireEventId).toBe(firstEventId);
  });
});

describe("sweepAbandonedCartTriggers", () => {
  it("sends the opener, logs it in the conversation, and marks promoOffered true", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_opener" });

    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await backdateTrigger(personId);

    const result = await sweepAbandonedCartTriggers();
    expect(result.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15559990000", expect.stringContaining("$20 off your first month"));

    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");
    expect(trigger.providerMessageId).toBe("msg_opener");

    const conversation = await getOrCreateConversation(personId);
    expect(conversation.promoOffered).toBe(true);
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].direction).toBe("outbound");

    const [checkin] = await db.select().from(leadCheckinTriggersTable).where(eq(leadCheckinTriggersTable.personId, personId));
    expect(checkin).toBeDefined();
    expect(checkin.status).toBe("pending");
  });

  it("skips the duplicate self-introduction when the person already has an active conversation (e.g. a Meta lead who separately abandoned the questionnaire)", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_followup" });

    const personId = await seedCustomer();
    // Simulate the person already being a Meta lead with an active thread —
    // same shape sendMetaLeadOpener creates (getOrCreateConversation with
    // leadSource "meta_form"), before the abandoned-cart opener ever fires.
    const existingConversation = await getOrCreateConversation(personId, "meta_form");
    await appendMessage(existingConversation.id, "outbound", "Hey there, this is Alexis with Ark Health. I wanted to check what state you're in.", {});

    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await backdateTrigger(personId);

    const result = await sweepAbandonedCartTriggers();
    expect(result.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15559990000", expect.stringContaining("$20 off your first month"));
    expect(sendMessageMock).toHaveBeenCalledWith("+15559990000", expect.not.stringContaining("this is Alexis"));

    // Lands in the SAME conversation, not a second one.
    const conversation = await getOrCreateConversation(personId);
    expect(conversation.id).toBe(existingConversation.id);
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(2);
  });

  it("sends exactly once when a second sweep starts while the first is still mid-send for the same trigger", async () => {
    sendMessageMock.mockClear();
    // Delay only the first send so a second, overlapping sweep call has a
    // real window to start (and, on the old select-then-update-at-the-end
    // code, re-claim the same still-"pending" trigger) before the first finishes.
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
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await backdateTrigger(personId);

    const first = sweepAbandonedCartTriggers();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the first sweep's claim UPDATE land before the second starts
    const second = sweepAbandonedCartTriggers();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.sentCount + r2.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");
  });

  it("cancels when the person already purchased", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await backdateTrigger(personId);

    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    const result = await sweepAbandonedCartTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();

    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.status).toBe("cancelled");
    expect(trigger.cancelledReason).toBe("already_purchased");
  });

  it("cancels when the questionnaire is no longer abandoned (e.g. they went on to submit it)", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await backdateTrigger(personId);

    await db.update(questionnaireEventsTable).set({ status: "submitted" }).where(eq(questionnaireEventsTable.id, questionnaireEventId));

    const result = await sweepAbandonedCartTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();

    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.cancelledReason).toBe("no_longer_abandoned");
  });

  it("cancels when the customer is do-not-disturb by the time it's due", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await backdateTrigger(personId);
    await setCustomerSmsDnd(personId, true);

    const result = await sweepAbandonedCartTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();

    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.cancelledReason).toBe("opted_out");
  });

  it("marks failed with NO_PHONE_NUMBER and does not call the provider when there's no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await backdateTrigger(personId);

    const result = await sweepAbandonedCartTriggers();
    expect(result.failedCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();

    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.status).toBe("failed");
    expect(trigger.failureReason).toBe("NO_PHONE_NUMBER");
  });

  it("marks failed and still logs the would-be message when the SMS send itself throws", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("SMS_DOWN"));

    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);
    await backdateTrigger(personId);

    const result = await sweepAbandonedCartTriggers();
    expect(result.failedCount).toBe(1);

    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.failureReason).toBe("SMS_DOWN");

    const conversation = await getOrCreateConversation(personId);
    const messages = await listMessages(conversation.id);
    expect(messages.length).toBe(1);
    expect(messages[0].providerMessageId).toBeNull();
  });

  it("leaves not-yet-due triggers untouched", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartOpener(personId, questionnaireEventId);

    const result = await sweepAbandonedCartTriggers();
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
    // Sanity: sweeping doesn't touch other pending, not-yet-due rows from other tests.
    expect(result).toBeDefined();
  });
});
