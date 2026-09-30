import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, purchasesTable, objectionReengagementTriggersTable, conversationsTable } from "@luma/db";
import { setCustomerSmsDnd } from "./dnd.service.js";

let receiptPrefix = "";
beforeEach(async () => {
  // Sweeps intentionally scan every due job. Isolate this suite's synthetic
  // jobs from fixtures left by other service suites in the shared test schema.
  await db.delete(objectionReengagementTriggersTable);
  receiptPrefix = crypto.randomUUID();
});

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: async (...args: unknown[]) => {
      const result = await sendMessageMock(...args);
      // Successful fixtures include the provider's sent receipt, even if it
      // arrives before the HTTP response. Timing tests delay receipts explicitly.
      if (result?.providerMessageId) {
        const { recordSmsDeliveryReceipt } = await import("./sms-delivery.service.js");
        await recordSmsDeliveryReceipt(result.providerMessageId, "sent", new Date());
      }
      return result;
    } }) };
});

const { scheduleObjectionReengagement, sweepObjectionReengagementTriggers } = await import("./objection-reengagement.service.js");
const { listMessages } = await import("./conversations.service.js");

async function seedCustomer(opts: { phone?: string | null; firstName?: string } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: opts.firstName ?? "Reengage",
      lastName: "Test",
      email: `reengage-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15558880000" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

async function backdateTrigger(personId: string) {
  await db.update(objectionReengagementTriggersTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(objectionReengagementTriggersTable.personId, personId));
}

describe("scheduleObjectionReengagement", () => {
  it("schedules a pending trigger due about 2 weeks out, defaulting leadSource to abandoned_cart", async () => {
    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId);

    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
    expect(trigger.leadSource).toBe("abandoned_cart");
    const dueInMs = new Date(trigger.dueAt).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(14 * 24 * 60 * 60 * 1000 - 10_000);
    expect(dueInMs).toBeLessThan(14 * 24 * 60 * 60 * 1000 + 10_000);
  });

  it("stores the given leadSource", async () => {
    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId, "meta_form");
    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger.leadSource).toBe("meta_form");
  });

  it("is idempotent per person — a duplicate call does not create a second trigger", async () => {
    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId);
    await scheduleObjectionReengagement(personId);

    const triggers = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(triggers.length).toBe(1);
  });
});

describe("sweepObjectionReengagementTriggers", () => {
  it("sends the re-engagement text and logs it in the conversation", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: `${receiptPrefix}-msg_reengage` });

    const personId = await seedCustomer({ firstName: "Taylor" });
    await scheduleObjectionReengagement(personId);
    await backdateTrigger(personId);

    const result = await sweepObjectionReengagementTriggers();
    expect(result.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledWith("+15558880000", expect.stringContaining("holding you back"), { scheduled: true });

    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");

    const [conversation] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
    const messages = await listMessages(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain("Taylor");
  });

  it("keeps a confirmed send terminal across later sweeps", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: `${receiptPrefix}-msg_logging_blip` });

    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId);
    await backdateTrigger(personId);

    const result = await sweepObjectionReengagementTriggers();
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(0);

    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger.status).toBe("sent");

    // A confirmed attempt remains terminal across later sweeps.
    sendMessageMock.mockClear();
    await db.update(objectionReengagementTriggersTable).set({ updatedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(objectionReengagementTriggersTable.personId, personId));
    await sweepObjectionReengagementTriggers();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("creates the conversation with the trigger's stored leadSource when none exists yet", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: `${receiptPrefix}-msg_reengage_meta` });

    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId, "meta_form");
    await backdateTrigger(personId);

    await sweepObjectionReengagementTriggers();

    const [conversation] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
    expect(conversation.leadSource).toBe("meta_form");
  });

  it("cancels when the person already purchased by the time it's due", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId);
    await backdateTrigger(personId);

    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    const result = await sweepObjectionReengagementTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger.cancelledReason).toBe("already_purchased");
  });

  it("cancels when the person is do-not-disturb by the time it's due", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId);
    await backdateTrigger(personId);
    await setCustomerSmsDnd(personId, true);

    const result = await sweepObjectionReengagementTriggers();
    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger.cancelledReason).toBe("opted_out");
  });

  it("marks failed with NO_PHONE_NUMBER and does not call the provider when there's no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    await scheduleObjectionReengagement(personId);
    await backdateTrigger(personId);

    const result = await sweepObjectionReengagementTriggers();
    expect(result.failedCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger.failureReason).toBe("NO_PHONE_NUMBER");
  });

  it("leaves not-yet-due triggers untouched", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId);

    const result = await sweepObjectionReengagementTriggers();
    expect(result.sentCount).toBe(0);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
    expect(trigger.status).toBe("pending");
  });

  it("sends exactly once when a second sweep starts while the first is still mid-send for the same trigger", async () => {
    sendMessageMock.mockClear();
    let callCount = 0;
    sendMessageMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          callCount += 1;
          const providerMessageId = callCount === 1 ? `${receiptPrefix}-msg_first` : `${receiptPrefix}-msg_second`;
          setTimeout(() => resolve({ providerMessageId }), callCount === 1 ? 60 : 0);
        }),
    );

    const personId = await seedCustomer();
    await scheduleObjectionReengagement(personId);
    await backdateTrigger(personId);

    const first = sweepObjectionReengagementTriggers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = sweepObjectionReengagementTriggers();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.sentCount + r2.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });

  it("while sales SMS is paused, claims nothing and leaves due triggers pending for the next sweep after resume", async () => {
    sendMessageMock.mockClear();
    const originalEnv = process.env.SALES_SMS_ENABLED;
    process.env.SALES_SMS_ENABLED = "false";
    try {
      const personId = await seedCustomer();
      await scheduleObjectionReengagement(personId);
      await backdateTrigger(personId);

      const result = await sweepObjectionReengagementTriggers();
      expect(result).toEqual({ sentCount: 0, cancelledCount: 0, failedCount: 0 });
      expect(sendMessageMock).not.toHaveBeenCalled();

      const [trigger] = await db.select().from(objectionReengagementTriggersTable).where(eq(objectionReengagementTriggersTable.personId, personId));
      expect(trigger.status).toBe("pending");
    } finally {
      if (originalEnv === undefined) delete process.env.SALES_SMS_ENABLED;
      else process.env.SALES_SMS_ENABLED = originalEnv;
    }
  });
});

// Business-flow fixtures run during allowed hours; quiet-hours boundaries
// and overnight deferral are exercised in scheduled-sms-quiet-hours.service.test.ts.
vi.mock("../lib/send-window.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/send-window.js")>();
  return { ...actual, isScheduledSmsTime: () => true, assertScheduledSmsTime: () => {} };
});
