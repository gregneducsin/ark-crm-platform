import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable } from "@luma/db";

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SMS_PROVIDER = "iblusend";
  process.env.IBLUSEND_API_KEY = "iblu_test_abc123";
});

const createMock = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

const sendMessageMock = vi.fn();
vi.mock("../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/sms-provider.js")>("../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: async (...args: unknown[]) => {
    const result = await sendMessageMock(...args);
    // Normal provider fixture confirms acceptance via a receipt. Timing
    // regressions below use a separate fixture with explicitly delayed receipts.
    if (result?.providerMessageId) {
      const { recordSmsDeliveryReceipt } = await import("./sms-delivery.service.js");
      await recordSmsDeliveryReceipt(result.providerMessageId, "sent", new Date());
    }
    return result;
  } }) };
});

const notifySlackMock = vi.fn();
vi.mock("../lib/slack.js", () => ({ notifySlack: (...args: unknown[]) => notifySlackMock(...args) }));

// Assert atomic history transfer and Alexis resumption here; Alexis's model,
// guardrails and sending are covered by alexis-dispatch.service.test.ts.
const resumeAlexisSmsMock = vi.fn();
vi.mock("./alexis-dispatch.service.js", async () => {
  const actual = await vi.importActual<typeof import("./alexis-dispatch.service.js")>("./alexis-dispatch.service.js");
  return { ...actual, resumeAlexisSms: (...args: unknown[]) => resumeAlexisSmsMock(...args) };
});

const processInboundSupportMessageMock = vi.fn();
vi.mock("./sophie-dispatch.service.js", async () => {
  const actual = await vi.importActual<typeof import("./sophie-dispatch.service.js")>("./sophie-dispatch.service.js");
  return { ...actual, processInboundSupportMessage: (...args: unknown[]) => processInboundSupportMessageMock(...args) };
});

const {
  recordAndClassifyUnmatchedSms,
  listUnmatchedSmsThreads,
  getUnmatchedSmsThread,
  getUnmatchedSmsThreadDetail,
  dismissUnmatchedSmsThread,
  sendUnmatchedInboundSmsReply,
} = await import("./unmatched-inbound-sms.service.js");

function toolResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", name: "classify_unmatched_sms", input }] };
}

function classification(overrides: Record<string, unknown> = {}) {
  return {
    intent: "other",
    summary: "Unclear intent.",
    suggestedReply: "Could you tell us more?",
    senderName: null,
    senderEmail: null,
    matchCandidateIndex: null,
    matchConfidence: null,
    needsHumanReview: false,
    confirmsExistingCustomer: false,
    productCategoryMentioned: "none",
    ...overrides,
  };
}

async function seedCustomer(firstName: string, lastName: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName, lastName, email: `${firstName}-${crypto.randomUUID()}@example.com`.toLowerCase(), leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `+1555${String(2000000 + phoneCounter).padStart(7, "0")}`;
}

beforeEach(() => {
  createMock.mockReset();
  sendMessageMock.mockReset().mockImplementation(async () => ({ providerMessageId: `test-${crypto.randomUUID()}` }));
  resumeAlexisSmsMock.mockClear();
  processInboundSupportMessageMock.mockClear();
  notifySlackMock.mockClear();
});

describe("recordAndClassifyUnmatchedSms", () => {
  it("records the text with the classification and drafted reply attached", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", summary: "Asking about weight loss programs.", suggestedReply: "Could you share your name?" })),
    );

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "Do you offer weight loss programs?");

    expect(thread.status).toBe("needs_review");
    expect(thread.aiIntent).toBe("new_lead_interest");
    expect(thread.aiSummary).toBe("Asking about weight loss programs.");
    expect(thread.suggestedReply).toBe("Could you share your name?");
    expect(thread.suggestedMatchCustomerId).toBeNull();
    // No name known yet, so no lead should have been auto-created.
    expect(thread.linkedCustomerId).toBeNull();
  });

  it("grounds the triage model in what Ark actually sells, so it can't invent services when asked what the business offers", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    await recordAndClassifyUnmatchedSms(uniquePhone(), "what does ark health offer?");

    const systemPromptArg = createMock.mock.calls[0][0].system as string;
    expect(systemPromptArg).toContain("semaglutide");
    expect(systemPromptArg).toContain("tirzepatide");
    expect(systemPromptArg).toContain("Never invent services, product categories, or business");
  });

  it("normalizes the phone number to E.164 before storing/looking up the thread", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms("5559991234", "hi");
    expect(thread.fromPhone).toBe("+15559991234");
  });

  it("joins the same thread when a second text arrives from the same number, instead of creating a duplicate", async () => {
    const phone = uniquePhone();

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First message." })));
    const first = await recordAndClassifyUnmatchedSms(phone, "Question one.");

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Second message, same thread." })));
    const second = await recordAndClassifyUnmatchedSms(phone, "Question two.");

    expect(second.id).toBe(first.id);
    const detail = await getUnmatchedSmsThreadDetail(first.id);
    expect(detail?.messages.filter((m) => m.direction === "inbound").map((m) => m.body)).toEqual(["Question one.", "Question two."]);

    const secondCallUserContent = createMock.mock.calls[1][0].messages[0].content as string;
    expect(secondCallUserContent).toContain("Question one.");
    expect(secondCallUserContent).toContain("Question two.");
  });

  it("alerts Slack on the first message from a new unmatched number, but not on a second message in the same thread", async () => {
    const phone = uniquePhone();

    createMock.mockResolvedValueOnce(toolResponse(classification()));
    await recordAndClassifyUnmatchedSms(phone, "hi");
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0][0]).toMatch(/New unmatched SMS/);

    notifySlackMock.mockClear();
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    await recordAndClassifyUnmatchedSms(phone, "second message");
    expect(notifySlackMock).not.toHaveBeenCalled();
  });

  it("resurfaces a dismissed thread (resets status to needs_review) when a new message arrives", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms(phone, "hello");
    await dismissUnmatchedSmsThread(thread.id);
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("dismissed");

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "They wrote again.", needsHumanReview: true })));
    await recordAndClassifyUnmatchedSms(phone, "following up");

    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("needs_review");
  });

  it("asks for the sender's name when unknown, per the suggested reply Claude drafts", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", suggestedReply: "Could you share your name?" })));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hi");
    expect(thread.suggestedReply).toContain("name");
  });

  it("asks for the sender's email once the name is known but the email isn't", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "new_lead_interest", senderName: "Taylor", suggestedReply: "Could you share your email?" })));
    const thread = await recordAndClassifyUnmatchedSms(phone, "It's Taylor");

    expect(thread.fromName).toBe("Taylor");
    expect(thread.collectedEmail).toBeNull();
    // Not enough to create a lead yet — email is still missing.
    expect(thread.linkedCustomerId).toBeNull();
    expect((await getUnmatchedSmsThreadDetail(thread.id))?.messages.at(-1)?.body).toContain("email");
  });

  it("creates a new lead once both name and email are known and Claude classifies genuine new-lead interest", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Wants to start a program.",
          suggestedReply: "A team member will follow up.",
          senderName: "Taylor Morgan",
          senderEmail: "taylor.morgan@example.com",
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "I'd like to learn more, I'm Taylor Morgan, taylor.morgan@example.com");

    expect(thread.linkedCustomerId).not.toBeNull();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.firstName).toBe("Taylor");
    expect(customer.lastName).toBe("Morgan");
    expect(customer.email).toBe("taylor.morgan@example.com");
    expect(customer.phone).toBe(thread.fromPhone);
    expect(customer.leadType).toBe("SMS Inquiry");

    // Handed off as a Meta-lead-style conversation, not abandoned_cart — see
    // recordAndClassifyUnmatchedSms's comment on the leadResult branch.
    expect(resumeAlexisSmsMock).toHaveBeenCalledWith(thread.linkedCustomerId);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(thread.status).toBe("replied");
    expect(thread.suggestedReply).toBeNull();
    expect(thread.repliedAt).not.toBeNull();
  });

  it("stores mediaUrls on the inbound row and passes them through to the lead handoff when the triggering text included a picture", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          summary: "Sent a photo of their current medication.",
          suggestedReply: "A team member will follow up.",
          senderName: "Casey Rivera",
          senderEmail: "casey.rivera@example.com",
        }),
      ),
    );
    const mediaUrls = ["https://cdn.iblusend.example/media/xyz789.jpg"];
    const message = "I'm Casey Rivera, casey.rivera@example.com, here's what I'm currently on";
    const thread = await recordAndClassifyUnmatchedSms(phone, message, mediaUrls);

    expect(thread.linkedCustomerId).not.toBeNull();
    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    const lastMessage = detail!.messages[detail!.messages.length - 1];
    expect(lastMessage.mediaUrls).toEqual(mediaUrls);
    expect(resumeAlexisSmsMock).toHaveBeenCalledWith(thread.linkedCustomerId);
  });

  it("still creates the lead once name and email are both already known, even when this turn's own intent classifies as 'other' — a real production case where a bare email address, then a plain 'thanks', both got classified as 'other' and the lead never got created", async () => {
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_example" });
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "Hi"); // consumes the fixed ack

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", senderName: "Example" })));
    await recordAndClassifyUnmatchedSms(phone, "Example");

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", senderName: "Example" })));
    await recordAndClassifyUnmatchedSms(phone, "Weight loss");

    // The turn where the email itself arrives, classified "other" — this is
    // exactly the turn that silently failed to create a lead in production.
    sendMessageMock.mockClear();
    resumeAlexisSmsMock.mockClear();
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "other", senderName: "Example", senderEmail: "example@example.com" })));
    const thread = await recordAndClassifyUnmatchedSms(phone, "example@example.com");

    expect(thread.linkedCustomerId).not.toBeNull();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.firstName).toBe("Example");
    expect(customer.email).toBe("example@example.com");
    expect(resumeAlexisSmsMock).toHaveBeenCalledWith(thread.linkedCustomerId);
    expect(thread.status).toBe("replied");
  });

  it("seeds the new Alexis conversation with everything said before the triggering message, not just that one message", async () => {
    const phone = uniquePhone();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_seed" });
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    const originalAt = new Date("2026-09-22T01:40:00Z");
    await recordAndClassifyUnmatchedSms(phone, "hi", undefined, { providerMessageId: "synthetic-inbound-seed", createdAt: originalAt }); // consumes the fixed ack — this + the ack become "prior history"

    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "new_lead_interest",
          senderName: "Taylor Morgan",
          senderEmail: "taylor.morgan-seed@example.com",
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "I'm Taylor Morgan, taylor.morgan-seed@example.com");

    const { getOrCreateConversation, listMessages } = await import("./conversations.service.js");
    const conversation = await getOrCreateConversation(thread.linkedCustomerId as string);
    const seeded = await listMessages(conversation.id);
    // History and the triggering message are committed before Alexis resumes.
    expect(seeded.map((m) => m.body)).toEqual(["hi", expect.stringContaining("name"), "I'm Taylor Morgan, taylor.morgan-seed@example.com"]);
    expect(seeded[0].createdAt).toEqual(originalAt);
    expect(seeded[0].providerMessageId).toBe("synthetic-inbound-seed");
    expect(seeded[1].providerMessageId).toBe("msg_ack_seed");
    expect(seeded[1].deliveryStatus).toBe("sent");
  });

  it("does not create a lead when the extracted email doesn't look like a real email address", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Taylor", senderEmail: "not an email" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hi");
    expect(thread.linkedCustomerId).toBeNull();
  });

  it.each([false, true])("holds matching name/email for staff on the first text, even with confirmation=%s", async (confirmsExistingCustomer) => {
    const existingEmail = `verify-${crypto.randomUUID()}@example.com`;
    const savedPhone = "+15550001111";
    const [existing] = await db.insert(customersTable).values({
      firstName: "Review", lastName: "Fixture", email: existingEmail,
      phone: savedPhone, leadReceivedDate: "2026-08-15",
    }).returning({ id: customersTable.id });
    createMock.mockResolvedValueOnce(toolResponse(classification({
      intent: "new_lead_interest", senderName: "Review Fixture", senderEmail: existingEmail,
      matchCandidateIndex: 0, matchConfidence: "high", confirmsExistingCustomer,
    })));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), `Review Fixture here, ${existingEmail}`);
    expect(thread.status).toBe("needs_review");
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedMatchCustomerId).toBe(existing.id);
    expect(thread.suggestedReply).toBeNull();
    expect(thread.aiSummary).toContain("Identity verification required.");
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(resumeAlexisSmsMock).not.toHaveBeenCalled();
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, existing.id));
    expect(customer.phone).toBe(savedPhone);
    expect(await db.select().from(customersTable).where(eq(customersTable.email, existingEmail))).toHaveLength(1);
    expect(notifySlackMock.mock.calls.some((call) => call[0].includes("verify account ownership"))).toBe(true);
  });

  it("keeps an email-only match in human review after the sender says yes or is reclassified as spam", async () => {
    const existingEmail = `email-review-${crypto.randomUUID()}@example.com`;
    const [existing] = await db.insert(customersTable).values({
      firstName: "Account", lastName: "Fixture", email: existingEmail,
      phone: "+15550002222", leadReceivedDate: "2026-08-15",
    }).returning({ id: customersTable.id });
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({
      intent: "new_lead_interest", senderName: "Different Person", senderEmail: existingEmail,
    })));
    let thread = await recordAndClassifyUnmatchedSms(phone, existingEmail);
    expect(thread.status).toBe("needs_review");
    for (const intent of ["new_lead_interest", "spam_or_irrelevant"]) {
      createMock.mockResolvedValueOnce(toolResponse(classification({ intent, confirmsExistingCustomer: true })));
      thread = await recordAndClassifyUnmatchedSms(phone, "Yes, that's me");
      expect(thread.status).toBe("needs_review");
      expect(thread.linkedCustomerId).toBeNull();
      expect(thread.suggestedReply).toBeNull();
    }
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(resumeAlexisSmsMock).not.toHaveBeenCalled();
    expect(processInboundSupportMessageMock).not.toHaveBeenCalled();
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, existing.id));
    expect(customer.phone).toBe("+15550002222");
    expect(notifySlackMock.mock.calls.filter((call) => call[0].includes("verify account ownership"))).toHaveLength(1);
  });

  it("does not auto-connect, create a lead, or reveal a match when the collected email belongs to more than one existing customer", async () => {
    const sharedEmail = `shared-${crypto.randomUUID()}@example.com`;
    await db.insert(customersTable).values([
      { firstName: "First", lastName: "Owner", email: sharedEmail, leadReceivedDate: "2026-08-15" },
      { firstName: "Second", lastName: "Owner", email: sharedEmail, leadReceivedDate: "2026-08-15" },
    ]);

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi");

    sendMessageMock.mockClear();
    resumeAlexisSmsMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: "Ambiguous Person", senderEmail: sharedEmail })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, `it's ${sharedEmail}`);

    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedMatchCustomerId).toBeNull(); // can't safely point at either one
    expect(thread.status).toBe("needs_review");
    expect(resumeAlexisSmsMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled(); // no auto-sent confirmation question either — we don't know who to ask about

    const stillTwo = await db.select().from(customersTable).where(eq(customersTable.email, sharedEmail));
    expect(stillTwo).toHaveLength(2); // no third (duplicate lead) record created
  });

  it("does NOT auto-connect on a name match alone, without an agreeing email match — stays human-gated", async () => {
    const lastName = `Alone${crypto.randomUUID().slice(0, 6)}`;
    await db.insert(customersTable).values({ firstName: "Morgan", lastName, email: `morgan-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" });

    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi");

    sendMessageMock.mockClear();
    resumeAlexisSmsMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "new_lead_interest", senderName: `Morgan ${lastName}`, senderEmail: null, matchCandidateIndex: 0, matchConfidence: "medium" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, `I'm Morgan ${lastName}`);

    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.status).toBe("needs_review");
    expect(resumeAlexisSmsMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does not create a lead when intent is existing_customer_support, even with a known name and email — and holds the reply for human review instead of auto-sending it", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "existing_customer_support",
          summary: "Asking about an order.",
          suggestedReply: "A team member will look into your order.",
          senderName: "Jordan Lee",
          senderEmail: "jordan@example.com",
          needsHumanReview: false, // forced true anyway by intent, regardless of Claude's own flag
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "Where is my order?");
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.status).toBe("needs_review");
    expect(thread.suggestedReply).toBe("A team member will look into your order.");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("still creates a DTC lead and hands off to Alexis even when Claude ALSO self-reports needsHumanReview:true alongside the mistaken existing_customer_support label", async () => {
    const lastName = `DtcSelfFlag${crypto.randomUUID().slice(0, 6)}`;
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          // Claude's own mistaken label AND its own needsHumanReview flag,
          // both driven by the same misread — no DB match backs this up
          // (matchCandidateIndex stays null). isDtcLead should override both.
          intent: "existing_customer_support",
          summary: "Existing customer asking if they qualify for GLP-1 medication, provided a priority code.",
          suggestedReply: "Thanks! Before I dive into details, what's your email so I can look up your account and priority code?",
          senderName: `Example ${lastName}`,
          senderEmail: `example.${lastName.toLowerCase()}@example.com`,
          needsHumanReview: true,
        }),
      ),
    );
    const message = `Hi Luma - I'd like to check if I qualify for GLP-1. My priority code: TEST002. I'm Example ${lastName}, example.${lastName.toLowerCase()}@example.com`;
    const thread = await recordAndClassifyUnmatchedSms(phone, message);

    expect(thread.linkedCustomerId).not.toBeNull();
    expect(thread.status).toBe("replied");
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, thread.linkedCustomerId as string));
    expect(customer.leadType).toBe("DTC");
    expect(resumeAlexisSmsMock).toHaveBeenCalledWith(thread.linkedCustomerId);
  });

  it("holds the reply for human review when Claude sets needsHumanReview, even for an otherwise-ordinary reply", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "other", suggestedReply: "Not sure I can answer that safely.", needsHumanReview: true })),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "is this safe with my heart condition?");
    expect(thread.status).toBe("needs_review");
    expect(thread.suggestedReply).toBe("Not sure I can answer that safely.");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("holds the reply for human review when Claude self-reports mentioning an out-of-scope business line, even if needsHumanReview itself is false", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "other",
          suggestedReply: "We also help clinics manage their patients.",
          needsHumanReview: false,
          productCategoryMentioned: "other_business_line",
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "what does ark health offer?");
    expect(thread.status).toBe("needs_review");
    expect(thread.suggestedReply).toBe("We also help clinics manage their patients.");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("holds the reply for human review when the drafted text itself names an out-of-scope service, even when Claude's own flags say it's fine", async () => {
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    sendMessageMock.mockClear();
    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "other",
          suggestedReply: "We offer digital health platforms and patient engagement tools.",
          needsHumanReview: false,
          productCategoryMentioned: "none",
        }),
      ),
    );
    const thread = await recordAndClassifyUnmatchedSms(phone, "what does ark health offer?");
    expect(thread.status).toBe("needs_review");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("does not create a lead for spam_or_irrelevant even with a known name and email, and auto-dismisses it out of the review queue", async () => {
    createMock.mockResolvedValueOnce(
      toolResponse(classification({ intent: "spam_or_irrelevant", summary: "Marketing spam.", suggestedReply: null, senderName: "Spam Bot", senderEmail: "spam@example.com" })),
    );
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "click here");
    expect(thread.linkedCustomerId).toBeNull();
    expect(thread.suggestedReply).toBeNull();
    expect(thread.status).toBe("dismissed");
  });

  it("only attaches a suggested match when Claude picks a candidate from the real, DB-verified list — never an invented id, and does not create a duplicate lead", async () => {
    // A collision-free last name — this test suite shares one schema across
    // files for the whole run, and the email version's identical test seeds
    // a plain "Jamie Rivera" too, which would otherwise nondeterministically
    // match this test's own query.
    const lastName = `RiveraSms${crypto.randomUUID().slice(0, 6)}`;
    const candidateId = await seedCustomer("Jamie", lastName);
    const phone = uniquePhone();
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    await recordAndClassifyUnmatchedSms(phone, "hi"); // first message — consumes the fixed ack, unrelated to what's under test

    createMock.mockResolvedValueOnce(
      toolResponse(
        classification({
          intent: "existing_customer_support",
          summary: "Asking about their order status.",
          suggestedReply: "A member of our team will follow up on your order status.",
          matchCandidateIndex: 0,
          matchConfidence: "high",
        }),
      ),
    );

    sendMessageMock.mockClear();
    const thread = await recordAndClassifyUnmatchedSms(phone, `Hi, checking on my order. Thanks, Jamie ${lastName}`);

    expect(thread.suggestedMatchCustomerId).toBe(candidateId);
    expect(thread.suggestedMatchConfidence).toBe("high");
    expect(thread.linkedCustomerId).toBeNull();
    // A plausible existing-customer match is a hard override to needs_review,
    // regardless of Claude's own needsHumanReview flag.
    expect(thread.status).toBe("needs_review");
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("still records the text with everything AI-generated left null when the Claude call fails", async () => {
    createMock.mockRejectedValueOnce(new Error("network error"));

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "Question about your service.");

    expect(thread.status).toBe("needs_review");
    expect(thread.aiIntent).toBeNull();
    expect(thread.aiSummary).toBeNull();
    expect(thread.suggestedReply).toBeNull();
    expect(thread.linkedCustomerId).toBeNull();
  });
});

describe("auto-acknowledgment", () => {
  it("sends a fixed, name-asking acknowledgment on a thread's first message, independent of the classification result", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First contact." })));
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_1" });

    const phone = uniquePhone();
    await recordAndClassifyUnmatchedSms(phone, "Do you offer this?");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [to, body] = sendMessageMock.mock.calls[0];
    expect(to).toBe(phone);
    // Wording is randomized (see ACK_VARIANTS) — "your name" is the
    // substring common to every variant.
    expect(body).toContain("your name");
  });

  it("sends Claude's own drafted reply (not a repeat of the fixed ack) on a second message, since replies are auto-sent by default now", async () => {
    const phone = uniquePhone();

    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "First." })));
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_2" });
    await recordAndClassifyUnmatchedSms(phone, "First message.");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const firstBody = sendMessageMock.mock.calls[0][1];
    expect(firstBody).toContain("your name");

    createMock.mockResolvedValueOnce(
      toolResponse(classification({ summary: "Second.", senderName: "Jordan", suggestedReply: "Thanks Jordan! What's a good email to get you set up?" })),
    );
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_reply_2" });
    const thread = await recordAndClassifyUnmatchedSms(phone, "Second message.");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(phone, "Thanks Jordan! What's a good email to get you set up?");
    expect(thread.status).toBe("replied");
    expect(thread.suggestedReply).toBeNull();
  });

  it("still records the inbound message and runs classification even when the acknowledgment send fails", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ summary: "Ack failed but this still worked." })));
    sendMessageMock.mockClear();
    sendMessageMock.mockRejectedValueOnce(new Error("provider down"));

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    expect(thread.aiSummary).toContain("SMS delivery needs human review");
    expect(thread.onboardingHeld).toBe(true);
    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages.at(-1)?.deliveryStatus).toBe("unknown"); // uncertain sends remain visible and are never retried
    expect(detail?.messages[0].direction).toBe("inbound");
  });

  it("does not send an acknowledgment when Claude classifies the message as spam_or_irrelevant, even on the first message", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "spam_or_irrelevant", summary: "Automated notification.", suggestedReply: null })));
    sendMessageMock.mockClear();

    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "click here for a prize");

    expect(thread.aiIntent).toBe("spam_or_irrelevant");
    expect(thread.status).toBe("dismissed"); // auto-dismissed — an automated notification shouldn't sit in the staff review queue
    expect(sendMessageMock).not.toHaveBeenCalled();
    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.messages).toHaveLength(1); // just the inbound message, no ack logged
  });

  it("still sends the acknowledgment when Claude fails entirely — no way to know it's spam without a classification, so default to acknowledging", async () => {
    createMock.mockRejectedValueOnce(new Error("network error"));
    sendMessageMock.mockClear();
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_ack_fallback" });

    await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe("listUnmatchedSmsThreads / getUnmatchedSmsThread / dismissUnmatchedSmsThread", () => {
  it("lists (with last-message preview), fetches by id, and dismisses", async () => {
    // Classify as spam so this listing fixture has only an inbound message.
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "spam_or_irrelevant", summary: "Unclear intent." })));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    const list = await listUnmatchedSmsThreads();
    const found = list.find((t) => t.id === thread.id);
    expect(found).toBeDefined();
    expect(found?.lastMessagePreview).toBe("hello");

    const fetched = await getUnmatchedSmsThread(thread.id);
    expect(fetched?.fromPhone).toBe(thread.fromPhone);

    const dismissed = await dismissUnmatchedSmsThread(thread.id);
    expect(dismissed).toBe(true);
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("dismissed");
  });

  it("dismissUnmatchedSmsThread returns false for an unknown id", async () => {
    const result = await dismissUnmatchedSmsThread("00000000-0000-0000-0000-000000000000");
    expect(result).toBe(false);
  });
});

describe("sendUnmatchedInboundSmsReply", () => {
  it("sends the staff-approved reply, logs it, and marks the thread replied", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification({ intent: "new_lead_interest", summary: "Asking about pricing." })));
    const phone = uniquePhone();
    const thread = await recordAndClassifyUnmatchedSms(phone, "How much does it cost?");

    sendMessageMock.mockClear(); // the setup call above also triggers the first-message auto-acknowledgment send
    sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_staff_reply" });
    const result = await sendUnmatchedInboundSmsReply(thread.id, "A team member will follow up with pricing details shortly.");

    expect(result).toEqual({ sent: true });
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [to, body] = sendMessageMock.mock.calls[0];
    expect(to).toBe(phone);
    expect(body).toBe("A team member will follow up with pricing details shortly.");

    const detail = await getUnmatchedSmsThreadDetail(thread.id);
    expect(detail?.thread.status).toBe("replied");
    expect(detail?.thread.repliedAt).not.toBeNull();
    expect(detail?.messages.at(-1)).toMatchObject({ direction: "outbound", body: "A team member will follow up with pricing details shortly." });
  });

  it("returns not_found for an unknown id", async () => {
    const result = await sendUnmatchedInboundSmsReply("00000000-0000-0000-0000-000000000000", "hi");
    expect(result).toEqual({ sent: false, reason: "not_found" });
  });

  it("returns send_failed and leaves status as needs_review when the send throws", async () => {
    createMock.mockResolvedValueOnce(toolResponse(classification()));
    const thread = await recordAndClassifyUnmatchedSms(uniquePhone(), "hello");

    sendMessageMock.mockRejectedValueOnce(new Error("boom"));
    const result = await sendUnmatchedInboundSmsReply(thread.id, "reply text");

    expect(result).toEqual({ sent: false, reason: "send_failed" });
    expect((await getUnmatchedSmsThread(thread.id))?.status).toBe("needs_review");
  });
});
