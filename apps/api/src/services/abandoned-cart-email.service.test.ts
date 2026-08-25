import { describe, expect, it, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, questionnaireEventsTable, purchasesTable, abandonedCartEmailTriggersTable, metaLeadEmailTriggersTable } from "@luma/db";
import { setCustomerEmailDnd } from "./dnd.service.js";

beforeAll(() => {
  process.env.EMAIL_PROVIDER = "google_workspace";
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
});

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Alexis at Ark Health" }) };
});

const { scheduleAbandonedCartEmailSequence, sweepAbandonedCartEmailTriggers } = await import("./abandoned-cart-email.service.js");
const { scheduleMetaLeadEmailSequence } = await import("./meta-lead-email.service.js");
const { getOrCreateEmailConversation, listEmailMessages } = await import("./email-conversations.service.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Cart", lastName: "Email", email: `cart-email-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
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

async function backdateAllSteps(personId: string) {
  await db.update(abandonedCartEmailTriggersTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(abandonedCartEmailTriggersTable.personId, personId));
}

async function rows(personId: string) {
  return db.select().from(abandonedCartEmailTriggersTable).where(eq(abandonedCartEmailTriggersTable.personId, personId));
}

describe("scheduleAbandonedCartEmailSequence", () => {
  it("schedules all 4 steps, each due at the right offset from now", async () => {
    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);

    const triggers = await rows(personId);
    expect(triggers).toHaveLength(4);
    expect(triggers.map((t) => t.step).sort()).toEqual(["educational", "opener", "plan_comparison", "urgency"]);

    const byStep = Object.fromEntries(triggers.map((t) => [t.step, t]));
    const now = Date.now();

    const dueInMs = (step: string) => new Date(byStep[step].dueAt).getTime() - now;
    expect(dueInMs("opener")).toBeGreaterThan(10 * 60 * 1000 - 10_000);
    expect(dueInMs("opener")).toBeLessThan(10 * 60 * 1000 + 10_000);
    expect(dueInMs("urgency")).toBeGreaterThan(24 * 60 * 60 * 1000 - 10_000);
    expect(dueInMs("urgency")).toBeLessThan(24 * 60 * 60 * 1000 + 10_000);
    expect(dueInMs("educational")).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 10_000);
    expect(dueInMs("educational")).toBeLessThan(7 * 24 * 60 * 60 * 1000 + 10_000);
    expect(dueInMs("plan_comparison")).toBeGreaterThan(10 * 24 * 60 * 60 * 1000 - 10_000);
    expect(dueInMs("plan_comparison")).toBeLessThan(10 * 24 * 60 * 60 * 1000 + 10_000);

    for (const t of triggers) expect(t.status).toBe("pending");
  });

  it("is idempotent per (questionnaireEventId, step) — a duplicate call does not create extra rows", async () => {
    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);

    const triggers = await rows(personId);
    expect(triggers).toHaveLength(4);
  });

  it("does not arm a second overlapping sequence for a distinct questionnaire event on the same person", async () => {
    // Simulates a restarted/resubmitted questionnaire attempt getting a new
    // Bask questionnaireId — a genuinely different questionnaireEventId, so
    // the (questionnaireEventId, step) unique index alone wouldn't catch
    // this. This is the real bug: without the person-level guard, the
    // customer would end up with 8 pending rows (two full sequences) instead
    // of 4, and the same step from each could fire minutes apart — reading
    // as the same email sent twice.
    const personId = await seedCustomer();
    const firstEventId = await seedAbandonedQuestionnaire(personId);
    const secondEventId = await seedAbandonedQuestionnaire(personId);

    await scheduleAbandonedCartEmailSequence(personId, firstEventId);
    await scheduleAbandonedCartEmailSequence(personId, secondEventId);

    const triggers = await rows(personId);
    expect(triggers).toHaveLength(4);
    expect(triggers.every((t) => t.questionnaireEventId === firstEventId)).toBe(true);
  });

  it("does not enroll a person who already has an active meta-lead-email sequence", async () => {
    // The reverse of the same real scenario: a customer already came in as a
    // GHL/Meta lead (armed the identical-template meta-lead-email sequence),
    // then separately abandons the Bask questionnaire — shouldn't get
    // enrolled a second time in the same content on a different schedule.
    const personId = await seedCustomer();
    await scheduleMetaLeadEmailSequence(personId);

    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);

    const abandonedCartTriggers = await rows(personId);
    expect(abandonedCartTriggers).toHaveLength(0);
    const metaTriggers = await db.select().from(metaLeadEmailTriggersTable).where(eq(metaLeadEmailTriggersTable.personId, personId));
    expect(metaTriggers).toHaveLength(4);
  });

  it("does start a fresh sequence once the person's previous one has fully finished", async () => {
    const personId = await seedCustomer();
    const firstEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, firstEventId);

    // All 4 steps reach a terminal state (simulating the first sequence
    // having fully run its course, sent or cancelled).
    await db.update(abandonedCartEmailTriggersTable).set({ status: "sent" }).where(eq(abandonedCartEmailTriggersTable.personId, personId));

    const secondEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, secondEventId);

    const triggers = await rows(personId);
    expect(triggers).toHaveLength(8);
    expect(triggers.filter((t) => t.questionnaireEventId === secondEventId && t.status === "pending")).toHaveLength(4);
  });
});

describe("sweepAbandonedCartEmailTriggers", () => {
  it("sends a due step, mints a real per-lead CTA link, and logs it to the email conversation", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValue({ messageId: "<opener@example.com>" });

    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);
    await backdateAllSteps(personId);

    const result = await sweepAbandonedCartEmailTriggers();
    expect(result.sentCount).toBe(4);

    expect(sendEmailMock).toHaveBeenCalledTimes(4);
    for (const call of sendEmailMock.mock.calls) {
      const html: string = call[2];
      expect(html).toContain("http://localhost:3000/go/");
    }

    const triggers = await rows(personId);
    for (const t of triggers) {
      expect(t.status).toBe("sent");
      expect(t.messageId).not.toBeNull();
    }

    const conversation = await getOrCreateEmailConversation(personId);
    const messages = await listEmailMessages(conversation.id);
    expect(messages).toHaveLength(4);
    expect(conversation.promoOffered).toBe(true);
  });

  it("cancels all remaining due steps once the lead has purchased", async () => {
    sendEmailMock.mockClear();

    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);
    await backdateAllSteps(personId);

    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    const result = await sweepAbandonedCartEmailTriggers();
    expect(result.cancelledCount).toBe(4);
    expect(sendEmailMock).not.toHaveBeenCalled();

    const triggers = await rows(personId);
    for (const t of triggers) {
      expect(t.status).toBe("cancelled");
      expect(t.cancelledReason).toBe("already_purchased");
    }
  });

  it("cancels all remaining due steps once the customer is email do-not-disturb", async () => {
    sendEmailMock.mockClear();

    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);
    await backdateAllSteps(personId);
    await setCustomerEmailDnd(personId, true);

    const result = await sweepAbandonedCartEmailTriggers();
    expect(result.cancelledCount).toBe(4);
    expect(sendEmailMock).not.toHaveBeenCalled();

    const triggers = await rows(personId);
    for (const t of triggers) expect(t.cancelledReason).toBe("opted_out");
  });

  it("cancels once the questionnaire is no longer abandoned (e.g. submitted)", async () => {
    sendEmailMock.mockClear();

    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);
    await backdateAllSteps(personId);
    await db.update(questionnaireEventsTable).set({ status: "submitted" }).where(eq(questionnaireEventsTable.id, questionnaireEventId));

    const result = await sweepAbandonedCartEmailTriggers();
    expect(result.cancelledCount).toBe(4);
    const triggers = await rows(personId);
    for (const t of triggers) expect(t.cancelledReason).toBe("no_longer_abandoned");
  });

  it("leaves not-yet-due steps untouched", async () => {
    sendEmailMock.mockClear();

    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);

    const result = await sweepAbandonedCartEmailTriggers();
    expect(result.sentCount).toBe(0);
    expect(result.cancelledCount).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();

    const triggers = await rows(personId);
    for (const t of triggers) expect(t.status).toBe("pending");
  });

  it("sends the correct template per step (opener vs plan_comparison have different subjects)", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValue({ messageId: "<step@example.com>" });

    const personId = await seedCustomer();
    const questionnaireEventId = await seedAbandonedQuestionnaire(personId);
    await scheduleAbandonedCartEmailSequence(personId, questionnaireEventId);
    await backdateAllSteps(personId);

    await sweepAbandonedCartEmailTriggers();

    const subjects = sendEmailMock.mock.calls.map((call) => call[1]);
    expect(new Set(subjects).size).toBe(4);
    expect(subjects).toContain("Your Ark Health visit is waiting — don't lose your spot");
    expect(subjects).toContain("Which Ark Health plan is right for you?");
  });
});
