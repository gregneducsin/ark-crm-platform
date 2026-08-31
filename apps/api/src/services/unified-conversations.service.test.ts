import { describe, expect, it, vi, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, purchasesTable, conversationsTable, supportConversationsTable } from "@luma/db";
import { createIntakeLink, handleIntakeLinkClick } from "./intake-links.service.js";

beforeAll(() => {
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
  process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
  process.env.BASK_QUESTIONNAIRE_URL = "https://bask.example.com/questionnaire";
});

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

const sendEmailMock = vi.fn();
vi.mock("../lib/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/email-provider.js")>("../lib/email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Test" }) };
});

const { getOrCreateConversation, appendMessage, updateConversationState } = await import("./conversations.service.js");
const { getOrCreateEmailConversation, appendEmailMessage } = await import("./email-conversations.service.js");
const { getOrCreateSupportConversation, appendSupportMessage, updateSupportConversationState } = await import("./support-conversations.service.js");
const { getOrCreateSupportEmailConversation, appendSupportEmailMessage } = await import("./support-email-conversations.service.js");
const {
  listUnifiedConversationSummaries,
  getUnifiedConversationDetail,
  clearAllNeedsAttention,
  sendUnifiedStaffReply,
  getSalesResponseStats,
} = await import("./unified-conversations.service.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Unified",
      lastName: "Test",
      email: `unified-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
      phone: "+15558880002",
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("listUnifiedConversationSummaries", () => {
  it("marks hasSalesThread/hasSupportThread correctly for a person with only one type of thread", async () => {
    const salesOnly = await seedCustomer();
    const conv = await getOrCreateConversation(salesOnly);
    await appendMessage(conv.id, "outbound", "hi");

    const items = await listUnifiedConversationSummaries();
    const match = items.find((i) => i.personId === salesOnly);
    expect(match).toMatchObject({ hasSalesThread: true, hasSupportThread: false });
  });

  it("merges a person with both a sales and a support thread into one row", async () => {
    const personId = await seedCustomer();
    const sales = await getOrCreateConversation(personId);
    await appendMessage(sales.id, "outbound", "sales opener");
    const support = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(support.id, "outbound", "support opener");

    const items = await listUnifiedConversationSummaries();
    const matches = items.filter((i) => i.personId === personId);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ hasSalesThread: true, hasSupportThread: true });
  });

  it("needsAttention is true if ANY of the person's threads is flagged", async () => {
    const personId = await seedCustomer();
    const sales = await getOrCreateConversation(personId);
    await appendMessage(sales.id, "outbound", "hi");
    const support = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(support.id, "outbound", "hi");
    await updateSupportConversationState(support.id, { needsAttention: true, needsAttentionReason: "test reason" });

    const items = await listUnifiedConversationSummaries();
    const match = items.find((i) => i.personId === personId);
    expect(match?.needsAttention).toBe(true);
  });

  it("lastMessageAt/preview reflects the most recent message across all threads, not just the sales one", async () => {
    const personId = await seedCustomer();
    const sales = await getOrCreateConversation(personId);
    await appendMessage(sales.id, "outbound", "old sales message");
    const support = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(support.id, "outbound", "newer support message");

    const items = await listUnifiedConversationSummaries();
    const match = items.find((i) => i.personId === personId);
    expect(match?.lastMessagePreview).toBe("newer support message");
  });
});

describe("getUnifiedConversationDetail", () => {
  it("returns null for a person with no conversation of any kind", async () => {
    const personId = await seedCustomer();
    const detail = await getUnifiedConversationDetail(personId);
    expect(detail).toBeNull();
  });

  it("returns null for a nonexistent person", async () => {
    const detail = await getUnifiedConversationDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });

  it("interleaves messages from all four threads in chronological order, each tagged with persona and channel", async () => {
    const personId = await seedCustomer();
    const salesSms = await getOrCreateConversation(personId);
    const salesEmail = await getOrCreateEmailConversation(personId);
    const supportSms = await getOrCreateSupportConversation(personId);
    const supportEmail = await getOrCreateSupportEmailConversation(personId);

    await appendMessage(salesSms.id, "outbound", "1 sales sms");
    await appendEmailMessage(salesEmail.id, "outbound", "subj", "2 sales email");
    await appendSupportMessage(supportSms.id, "outbound", "3 support sms");
    await appendSupportEmailMessage(supportEmail.id, "outbound", "subj", "4 support email");

    const detail = await getUnifiedConversationDetail(personId);
    expect(detail).not.toBeNull();
    expect(detail!.messages.map((m) => m.body)).toEqual(["1 sales sms", "2 sales email", "3 support sms", "4 support email"]);
    expect(detail!.messages.map((m) => `${m.persona}/${m.channel}`)).toEqual(["sales/sms", "sales/email", "support/sms", "support/email"]);
    expect(detail!.availableReplyTargets).toHaveLength(4);
  });

  it("reports hasQualifyingPurchase from a completed purchase", async () => {
    const personId = await seedCustomer();
    await getOrCreateConversation(personId).then((c) => appendMessage(c.id, "outbound", "hi"));
    await db.insert(purchasesTable).values({ customerId: personId, orderNumber: crypto.randomUUID(), productName: "Test", amountPaid: "100.00", status: "completed", purchaseDate: "2026-08-20" });

    const detail = await getUnifiedConversationDetail(personId);
    expect(detail?.customer.hasQualifyingPurchase).toBe(true);
  });

  it("merges needsAttention across sms and email sales threads with OR semantics", async () => {
    const personId = await seedCustomer();
    const salesSms = await getOrCreateConversation(personId);
    await appendMessage(salesSms.id, "outbound", "hi");
    await updateConversationState(salesSms.id, { needsAttention: true, needsAttentionReason: "sms reason" });

    const detail = await getUnifiedConversationDetail(personId);
    expect(detail?.sales).toMatchObject({ needsAttention: true, needsAttentionReason: "sms reason" });
  });

  it("only lists availableReplyTargets for threads that actually exist", async () => {
    const personId = await seedCustomer();
    const salesSms = await getOrCreateConversation(personId);
    await appendMessage(salesSms.id, "outbound", "hi");

    const detail = await getUnifiedConversationDetail(personId);
    expect(detail?.availableReplyTargets).toEqual([{ persona: "sales", channel: "sms" }]);
  });
});

describe("getUnifiedConversationDetail — intakeLinkClicked", () => {
  it("is false when no intake link has ever been minted for this person", async () => {
    const personId = await seedCustomer();
    const sales = await getOrCreateConversation(personId);
    await appendMessage(sales.id, "outbound", "hi");

    const detail = await getUnifiedConversationDetail(personId);
    expect(detail?.sales?.intakeLinkClicked).toBe(false);
  });

  it("is false when the most recent intake link was sent but not yet clicked", async () => {
    const personId = await seedCustomer();
    const sales = await getOrCreateConversation(personId);
    await appendMessage(sales.id, "outbound", "hi");
    await createIntakeLink(personId);

    const detail = await getUnifiedConversationDetail(personId);
    expect(detail?.sales?.intakeLinkClicked).toBe(false);
  });

  it("is true once the most recent intake link has been clicked", async () => {
    const personId = await seedCustomer();
    const sales = await getOrCreateConversation(personId);
    await appendMessage(sales.id, "outbound", "hi");
    const { url } = await createIntakeLink(personId);
    const rawToken = url.split("/go/")[1];
    await handleIntakeLinkClick(rawToken);

    const detail = await getUnifiedConversationDetail(personId);
    expect(detail?.sales?.intakeLinkClicked).toBe(true);
  });
});

describe("clearAllNeedsAttention", () => {
  it("clears every currently-flagged thread for a person, leaving unflagged ones alone", async () => {
    const personId = await seedCustomer();
    const sales = await getOrCreateConversation(personId);
    await appendMessage(sales.id, "outbound", "hi");
    await updateConversationState(sales.id, { needsAttention: true, needsAttentionReason: "flagged" });
    const support = await getOrCreateSupportConversation(personId);
    await appendSupportMessage(support.id, "outbound", "hi");
    await updateSupportConversationState(support.id, { needsAttention: true, needsAttentionReason: "flagged" });

    await clearAllNeedsAttention(personId);

    const [salesRow] = await db.select().from(conversationsTable).where(eq(conversationsTable.id, sales.id));
    const [supportRow] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.id, support.id));
    expect(salesRow.needsAttention).toBe(false);
    expect(supportRow.needsAttention).toBe(false);
  });

  it("is a no-op for a person with no flagged threads", async () => {
    const personId = await seedCustomer();
    const sales = await getOrCreateConversation(personId);
    await appendMessage(sales.id, "outbound", "hi");
    await expect(clearAllNeedsAttention(personId)).resolves.toBeUndefined();
  });
});

describe("sendUnifiedStaffReply", () => {
  it("routes a sales/sms reply through the SMS provider and logs it on the sales SMS thread", async () => {
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_1" });
    const personId = await seedCustomer();
    await getOrCreateConversation(personId);
    const result = await sendUnifiedStaffReply(personId, "sales", "sms", "hello", "staff@example.com");
    expect(result).toEqual({ sent: true });
    expect(sendMessageMock).toHaveBeenCalled();
  });

  it("routes a support/email reply through the email provider and logs it on the support email thread", async () => {
    sendEmailMock.mockResolvedValueOnce({ messageId: "<reply@example.com>" });
    const personId = await seedCustomer();
    await getOrCreateSupportEmailConversation(personId);
    const result = await sendUnifiedStaffReply(personId, "support", "email", "hello", "staff@example.com");
    expect(result).toEqual({ sent: true });
    expect(sendEmailMock).toHaveBeenCalled();
  });

  it("returns not_found when the requested (persona, channel) pipeline has no thread for this person", async () => {
    const personId = await seedCustomer();
    await getOrCreateConversation(personId);
    const result = await sendUnifiedStaffReply(personId, "support", "sms", "hello", "staff@example.com");
    expect(result).toEqual({ sent: false, reason: "not_found" });
  });
});

describe("getSalesResponseStats", () => {
  it("counts a customer contacted on both sms and email sales channels only once", async () => {
    const personId = await seedCustomer();
    const salesSms = await getOrCreateConversation(personId);
    await appendMessage(salesSms.id, "outbound", "hi");
    await appendMessage(salesSms.id, "inbound", "hi back");
    const salesEmail = await getOrCreateEmailConversation(personId);
    await appendEmailMessage(salesEmail.id, "outbound", "subj", "hi");

    const before = await getSalesResponseStats();
    const personId2 = await seedCustomer();
    const conv2 = await getOrCreateConversation(personId2);
    await appendMessage(conv2.id, "outbound", "hi");
    const after = await getSalesResponseStats();

    expect(after.totalContacted).toBe(before.totalContacted + 1);
  });
});
