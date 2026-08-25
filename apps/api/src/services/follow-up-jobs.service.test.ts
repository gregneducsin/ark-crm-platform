import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, intakeLinkTokensTable, followUpJobsTable, questionnaireEventsTable, purchasesTable, conversationsTable, conversationMessagesTable } from "@luma/db";
import { hashToken } from "../lib/crypto.js";
import { setCustomerSmsDnd } from "./dnd.service.js";

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return {
    ...actual,
    getSmsProvider: () => ({ sendMessage: sendMessageMock }),
  };
});

const { sweepFollowUpJobs } = await import("./follow-up-jobs.service.js");

async function seedCustomer(opts: { phone?: string | null } = {}): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Test",
      lastName: "Lead",
      email: `lead-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: opts.phone === undefined ? "+15551234567" : opts.phone,
    })
    .returning({ id: customersTable.id });
  return row.id;
}

/** Seeds a clicked token + a pending job due at `dueAt`, clicked at `clickedAt`. */
async function seedPendingJob(
  personId: string,
  clickedAt: Date,
  dueAt: Date,
  messageStep: "provider_check_in" | "intake_questions_check_in" = "provider_check_in",
  leadSource: "abandoned_cart" | "meta_form" = "abandoned_cart",
) {
  const [token] = await db
    .insert(intakeLinkTokensTable)
    .values({
      personId,
      tokenHash: hashToken(`token-${crypto.randomUUID()}`),
      expiresAt: new Date(clickedAt.getTime() + 24 * 60 * 60 * 1000),
      clickedAt,
      leadSource,
    })
    .returning({ id: intakeLinkTokensTable.id });

  const [job] = await db
    .insert(followUpJobsTable)
    .values({ personId, intakeLinkTokenId: token.id, messageStep, dueAt })
    .returning({ id: followUpJobsTable.id });

  return { jobId: job.id, tokenId: token.id };
}

describe("sweepFollowUpJobs", () => {
  it("leaves not-yet-due jobs untouched", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const { jobId } = await seedPendingJob(personId, new Date(Date.now() - 60_000), new Date(Date.now() + 60 * 60 * 1000));

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("pending");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("sends the provider_check_in message and schedules intake_questions_check_in 1 hour later on success", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_123" });
    const personId = await seedCustomer({ phone: "+15559876543" });
    const { jobId, tokenId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    const result = await sweepFollowUpJobs();

    expect(result.sentCount).toBe(1);
    // Wording is randomized (see provider_check_in's variants) — "completed
    // questionnaire" is the substring common to all of them.
    expect(sendMessageMock).toHaveBeenCalledWith("+15559876543", expect.stringContaining("completed questionnaire"));

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("sent");
    expect(job.sentAt).not.toBeNull();
    expect(job.providerMessageId).toBe("msg_123");

    const nextJobs = await db
      .select()
      .from(followUpJobsTable)
      .where(eq(followUpJobsTable.intakeLinkTokenId, tokenId));
    const step2 = nextJobs.find((j) => j.messageStep === "intake_questions_check_in");
    expect(step2).toBeDefined();
    expect(step2!.status).toBe("pending");
    const dueInMs = new Date(step2!.dueAt).getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(60 * 60 * 1000 - 5000);
    expect(dueInMs).toBeLessThan(60 * 60 * 1000 + 5000);
  });

  it("does not schedule a third message after intake_questions_check_in sends", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_456" });
    const personId = await seedCustomer();
    const { tokenId } = await seedPendingJob(
      personId,
      new Date(Date.now() - 4 * 60 * 60 * 1000),
      new Date(Date.now() - 60_000),
      "intake_questions_check_in",
    );

    await sweepFollowUpJobs();

    const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.intakeLinkTokenId, tokenId));
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe("sent");
  });

  it("cancels a due job when the person submitted the questionnaire after clicking", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { jobId } = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await db.insert(questionnaireEventsTable).values({
      personId,
      questionnaireId: "q-1",
      status: "submitted",
      lastEventAt: new Date(clickedAt.getTime() + 30 * 60 * 1000),
    });

    const result = await sweepFollowUpJobs();

    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("cancelled");
    expect(job.cancelledReason).toBe("completed_before_followup");
  });

  it("cancels a due job when the person completed a purchase after clicking", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const { jobId } = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("cancelled");
  });

  it("ignores a purchase whose row was actually created before the click, even if its purchaseDate is the same calendar day", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_same_day" });
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);

    // Recorded well before the click, but purchaseDate (a date-only, no
    // time-of-day column) happens to fall on the same calendar day as
    // clickedAt — a date-only comparison would wrongly treat this as
    // "completed since click".
    await db.insert(purchasesTable).values({
      customerId: personId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
      createdAt: new Date(clickedAt.getTime() - 60 * 60 * 1000),
    });

    const { jobId } = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("sent");
  });

  it("ignores a questionnaire submission that happened before the link was clicked", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_789" });
    const personId = await seedCustomer();
    const clickedAt = new Date(Date.now() - 3 * 60 * 60 * 1000);

    await db.insert(questionnaireEventsTable).values({
      personId,
      questionnaireId: "q-old",
      status: "submitted",
      lastEventAt: new Date(clickedAt.getTime() - 24 * 60 * 60 * 1000),
    });

    const { jobId } = await seedPendingJob(personId, clickedAt, new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();

    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("sent");
  });

  it("cancels a due job when the person is do-not-disturb by the time it's due, instead of texting an opted-out customer", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer();
    const { jobId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));
    await setCustomerSmsDnd(personId, true);

    const result = await sweepFollowUpJobs();

    expect(result.cancelledCount).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("cancelled");
    expect(job.cancelledReason).toBe("opted_out");
  });

  it("marks a job failed with NO_PHONE_NUMBER when the customer has no phone on file", async () => {
    sendMessageMock.mockClear();
    const personId = await seedCustomer({ phone: null });
    const { jobId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();

    expect(sendMessageMock).not.toHaveBeenCalled();
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("failed");
    expect(job.failureReason).toBe("NO_PHONE_NUMBER");
  });

  it("marks a job failed and does not schedule step 2 when the send itself throws", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("SMS_PROVIDER_UNAVAILABLE"));
    const personId = await seedCustomer();
    const { jobId, tokenId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    const result = await sweepFollowUpJobs();

    expect(result.failedCount).toBe(1);
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("failed");
    expect(job.failureReason).toBe("SMS_PROVIDER_UNAVAILABLE");

    const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.intakeLinkTokenId, tokenId));
    expect(jobs.length).toBe(1);
  });

  it("sends exactly once when a second sweep starts while the first is still mid-send for the same job", async () => {
    sendMessageMock.mockClear();
    // Delay only the first send so a second, overlapping sweep call has a
    // real window to start (and, on the old select-then-update-at-the-end
    // code, re-claim the same still-"pending" job) before the first finishes.
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
    const { jobId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    const first = sweepFollowUpJobs();
    await new Promise((resolve) => setTimeout(resolve, 20)); // let the first sweep's claim UPDATE land before the second starts
    const second = sweepFollowUpJobs();
    const [r1, r2] = await Promise.all([first, second]);

    expect(r1.sentCount + r2.sentCount).toBe(1);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(job.status).toBe("sent");
  });

  it("logs a successfully-sent follow-up into the person's conversation history, same as any other proactive SMS", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_logged" });
    const personId = await seedCustomer({ phone: "+15551112222" });
    await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();

    const [conversation] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
    expect(conversation).toBeDefined();

    const messages = await db.select().from(conversationMessagesTable).where(eq(conversationMessagesTable.conversationId, conversation.id));
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe("outbound");
    expect(messages[0].providerMessageId).toBe("msg_logged");
    expect(messages[0].body).toContain("completed questionnaire");
  });

  it("creates the conversation with the intake link's leadSource, not the default, when this is the first message a Meta lead ever gets", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_meta_lead" });
    const personId = await seedCustomer({ phone: "+15553334444" });
    // A Meta lead who only had email on file when the SMS opener would have
    // fired, then got a phone added before their emailed link's follow-up
    // came due — no SMS conversation exists yet, so getOrCreateConversation
    // is about to create one for the first time here.
    await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000), "provider_check_in", "meta_form");

    await sweepFollowUpJobs();

    const [conversation] = await db.select().from(conversationsTable).where(eq(conversationsTable.personId, personId));
    expect(conversation.leadSource).toBe("meta_form");
  });

  it("does not reprocess a job that already resolved", async () => {
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_first" });
    const personId = await seedCustomer();
    const { jobId } = await seedPendingJob(personId, new Date(Date.now() - 3 * 60 * 60 * 1000), new Date(Date.now() - 60_000));

    await sweepFollowUpJobs();
    const [afterFirst] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, jobId));
    expect(afterFirst.status).toBe("sent");

    await sweepFollowUpJobs();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});
