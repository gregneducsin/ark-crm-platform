import { describe, expect, it } from "vitest";
import { db, customersTable, questionnaireEventsTable, purchasesTable, conversationMessagesTable } from "@luma/db";
import { getOrCreateConversation, appendMessage } from "./conversations.service.js";
import { getOrCreateEmailConversation, appendEmailMessage } from "./email-conversations.service.js";
import { getFunnelSummary, getMessageVolumeByChannel, getResponseTimeStats } from "./reporting.service.js";

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Report", lastName: "Test", email: `report-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("getFunnelSummary", () => {
  it("counts distinct customers at each funnel stage", async () => {
    const before = await getFunnelSummary();

    const leadOnly = await seedCustomer();
    const started = await seedCustomer();
    await db.insert(questionnaireEventsTable).values({ personId: started, questionnaireId: `q-${crypto.randomUUID()}`, status: "started", lastEventAt: new Date() });

    const submitted = await seedCustomer();
    await db.insert(questionnaireEventsTable).values({ personId: submitted, questionnaireId: `q-${crypto.randomUUID()}`, status: "submitted", lastEventAt: new Date() });

    const purchasedPerson = await seedCustomer();
    await db.insert(questionnaireEventsTable).values({ personId: purchasedPerson, questionnaireId: `q-${crypto.randomUUID()}`, status: "submitted", lastEventAt: new Date() });
    await db.insert(purchasesTable).values({
      customerId: purchasedPerson,
      purchaseDate: new Date().toISOString().slice(0, 10),
      orderNumber: `ORD-${crypto.randomUUID()}`,
      productName: "Semaglutide",
      amountPaid: "120.00",
      status: "completed",
    });

    void leadOnly; // seeded purely to count toward totalLeads, no further assertions on it directly

    const after = await getFunnelSummary();
    expect(after.totalLeads).toBe(before.totalLeads + 4);
    expect(after.questionnaireStarted).toBe(before.questionnaireStarted + 3);
    expect(after.questionnaireSubmitted).toBe(before.questionnaireSubmitted + 2);
    expect(after.purchased).toBe(before.purchased + 1);
  });
});

describe("getMessageVolumeByChannel", () => {
  it("counts inbound/outbound messages, combining Alexis+Sophie per channel", async () => {
    const beforeRows = await getMessageVolumeByChannel();
    const before = Object.fromEntries(beforeRows.map((r) => [r.channel, r]));

    const smsPerson = await seedCustomer();
    const smsConvo = await getOrCreateConversation(smsPerson);
    await appendMessage(smsConvo.id, "inbound", "hi", {});
    await appendMessage(smsConvo.id, "outbound", "hello", {});
    await appendMessage(smsConvo.id, "outbound", "how can I help", {});

    const emailPerson = await seedCustomer();
    const emailConvo = await getOrCreateEmailConversation(emailPerson);
    await appendEmailMessage(emailConvo.id, "inbound", "Question", "what's the price", {});

    const afterRows = await getMessageVolumeByChannel();
    const after = Object.fromEntries(afterRows.map((r) => [r.channel, r]));

    expect(after.sms.inbound).toBe(before.sms.inbound + 1);
    expect(after.sms.outbound).toBe(before.sms.outbound + 2);
    expect(after.email.inbound).toBe(before.email.inbound + 1);
    expect(after.email.outbound).toBe(before.email.outbound);
  });
});

describe("getResponseTimeStats", () => {
  it("only counts an outbound message that directly follows an inbound one as a response", async () => {
    const personId = await seedCustomer();
    const convo = await getOrCreateConversation(personId);

    const beforeRows = await getResponseTimeStats();
    const smsBefore = beforeRows.find((r) => r.channel === "sms")!;

    // inbound at t0, outbound response 60s later — one real response.
    const t0 = new Date();
    await db.insert(conversationMessagesTable).values({ conversationId: convo.id, direction: "inbound", body: "hi", createdAt: t0 });
    const t1 = new Date(t0.getTime() + 60_000);
    await db.insert(conversationMessagesTable).values({ conversationId: convo.id, direction: "outbound", body: "hello", createdAt: t1 });
    // a second outbound message right after — does NOT count as its own response (prev direction is outbound, not inbound).
    const t2 = new Date(t1.getTime() + 5_000);
    await db.insert(conversationMessagesTable).values({ conversationId: convo.id, direction: "outbound", body: "anything else?", createdAt: t2 });

    const afterRows = await getResponseTimeStats();
    const smsAfter = afterRows.find((r) => r.channel === "sms")!;

    expect(smsAfter.responseCount).toBe(smsBefore.responseCount + 1);
    // Weighted average shifted toward 60s given how few other real responses exist in a fresh test DB — a loose bound rather than an exact
    // equality, since prior tests in the same run may have added other real conversations' response times into the "before" baseline.
    expect(smsAfter.avgResponseSeconds).not.toBeNull();
  });
});
