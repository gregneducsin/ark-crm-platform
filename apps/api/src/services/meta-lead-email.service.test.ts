import { describe, expect, it, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, purchasesTable, metaLeadEmailTriggersTable, abandonedCartEmailTriggersTable, questionnaireEventsTable } from "@luma/db";
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

const { scheduleMetaLeadEmailSequence, sweepMetaLeadEmailTriggers } = await import("./meta-lead-email.service.js");
const { scheduleAbandonedCartEmailSequence } = await import("./abandoned-cart-email.service.js");
const { getOrCreateEmailConversation, listEmailMessages } = await import("./email-conversations.service.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Meta", lastName: "Email", email: `meta-email-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

async function backdateAllSteps(personId: string) {
  await db.update(metaLeadEmailTriggersTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(eq(metaLeadEmailTriggersTable.personId, personId));
}

async function rows(personId: string) {
  return db.select().from(metaLeadEmailTriggersTable).where(eq(metaLeadEmailTriggersTable.personId, personId));
}

describe("scheduleMetaLeadEmailSequence", () => {
  it("schedules all 4 steps, each due at the right offset from now", async () => {
    const personId = await seedCustomer();
    await scheduleMetaLeadEmailSequence(personId);

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

  it("is idempotent per (personId, step) — a duplicate call does not create extra rows", async () => {
    const personId = await seedCustomer();
    await scheduleMetaLeadEmailSequence(personId);
    await scheduleMetaLeadEmailSequence(personId);

    const triggers = await rows(personId);
    expect(triggers).toHaveLength(4);
  });

  it("does not enroll a person who already has an active abandoned-cart-email sequence", async () => {
    // Real scenario this fixes: a customer abandons the Bask questionnaire
    // AND separately comes in as a GHL/Meta lead — both entry points arm the
    // identical 4-step template sequence, so without this cross-check
    // they'd get every email twice on two independent schedules.
    const personId = await seedCustomer();
    const [event] = await db
      .insert(questionnaireEventsTable)
      .values({ personId, questionnaireId: `q-${crypto.randomUUID()}`, status: "abandoned", lastEventAt: new Date(), abandonedAt: new Date() })
      .returning({ id: questionnaireEventsTable.id });
    await scheduleAbandonedCartEmailSequence(personId, event!.id);

    await scheduleMetaLeadEmailSequence(personId);

    const metaTriggers = await rows(personId);
    expect(metaTriggers).toHaveLength(0);
    const abandonedCartTriggers = await db.select().from(abandonedCartEmailTriggersTable).where(eq(abandonedCartEmailTriggersTable.personId, personId));
    expect(abandonedCartTriggers).toHaveLength(4);
  });
});

describe("sweepMetaLeadEmailTriggers", () => {
  it("sends a due step, mints a real per-lead CTA link, and logs it to the email conversation", async () => {
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValue({ messageId: "<opener@example.com>" });

    const personId = await seedCustomer();
    await scheduleMetaLeadEmailSequence(personId);
    await backdateAllSteps(personId);

    const result = await sweepMetaLeadEmailTriggers();
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
    await scheduleMetaLeadEmailSequence(personId);
    await backdateAllSteps(personId);

    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    const result = await sweepMetaLeadEmailTriggers();
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
    await scheduleMetaLeadEmailSequence(personId);
    await backdateAllSteps(personId);
    await setCustomerEmailDnd(personId, true);

    const result = await sweepMetaLeadEmailTriggers();
    expect(result.cancelledCount).toBe(4);
    expect(sendEmailMock).not.toHaveBeenCalled();

    const triggers = await rows(personId);
    for (const t of triggers) expect(t.cancelledReason).toBe("opted_out");
  });

  it("leaves not-yet-due steps untouched", async () => {
    sendEmailMock.mockClear();

    const personId = await seedCustomer();
    await scheduleMetaLeadEmailSequence(personId);

    const result = await sweepMetaLeadEmailTriggers();
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
    await scheduleMetaLeadEmailSequence(personId);
    await backdateAllSteps(personId);

    await sweepMetaLeadEmailTriggers();

    const subjects = sendEmailMock.mock.calls.map((call) => call[1]);
    expect(new Set(subjects).size).toBe(4);
    expect(subjects).toContain("Your Ark Health visit is waiting — don't lose your spot");
    expect(subjects).toContain("Which Ark Health plan is right for you?");
  });
});
