import { describe, expect, it } from "vitest";
import { db, customersTable, conversationsTable, conversationMessagesTable, supportConversationsTable, supportConversationMessagesTable } from "@luma/db";
import { eq } from "drizzle-orm";
import { isClosingReply, listMissedSmsResponses, reviewMissedSmsResponse } from "./missed-response.service.js";
import { listNeedsAttention, clearNeedsAttentionItem } from "./needs-attention.service.js";

const now = new Date("2030-01-02T12:00:00Z");
const old = new Date("2026-01-01T12:00:00Z");
async function seed(persona: "alexis" | "sophie" = "alexis", body = "What are the prices?", createdAt = old) {
  const [person] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Review", email: `${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-01-01" }).returning();
  const c = persona === "alexis" ? conversationsTable : supportConversationsTable;
  const m = persona === "alexis" ? conversationMessagesTable : supportConversationMessagesTable;
  const [conversation] = await db.insert(c).values({ personId: person.id }).returning();
  const [inbound] = await db.insert(m).values({ conversationId: conversation.id, direction: "inbound", body, createdAt }).returning();
  return { person, conversation, inbound, c, m, persona };
}

describe("missed SMS response review", () => {
  it("surfaces historical sales/support requests without setting bot flags", async () => {
    for (const persona of ["alexis", "sophie"] as const) {
      const s = await seed(persona);
      expect((await listNeedsAttention()).find(i => i.conversationId === s.conversation.id)).toMatchObject({ missedInboundId: s.inbound.id, persona, channel: "sms" });
      const [unchanged] = await db.select().from(s.c).where(eq(s.c.id, s.conversation.id));
      expect(unchanged.needsAttention).toBe(false);
    }
  });
  it("allows the grace period and excludes closed conversations", async () => {
    const recent = await seed("alexis", "One month", new Date(now.getTime() - 14 * 60_000));
    const closed = await seed();
    await db.update(closed.c).set({ status: "closed" }).where(eq(closed.c.id, closed.conversation.id));
    const rows = await listMissedSmsResponses(now);
    expect(rows.some(i => i.conversationId === recent.conversation.id || i.conversationId === closed.conversation.id)).toBe(false);
    expect((await listMissedSmsResponses(new Date(now.getTime() + 2 * 60_000))).some(i => i.conversationId === recent.conversation.id)).toBe(true);
  });
  it.each(["sent", "delivered", "read", "failed", "queued", "unknown", null] as const)("requires confirmed sends, status=%s", async deliveryStatus => {
    const s = await seed();
    await db.insert(s.m).values({ conversationId: s.conversation.id, direction: "outbound", body: "Here is the answer.", deliveryStatus, createdAt: new Date(old.getTime() + 60_000) });
    expect((await listMissedSmsResponses(now)).some(i => i.conversationId === s.conversation.id)).toBe(!["sent", "delivered", "read"].includes(deliveryStatus ?? ""));
  });
  it("does not count an older prepared message sent late as a response", async () => {
    const s = await seed();
    await db.insert(s.m).values({ conversationId: s.conversation.id, direction: "outbound", body: "Earlier question?", deliveryStatus: "sent", createdAt: new Date(old.getTime() - 60_000), sentAt: new Date(old.getTime() + 60_000) });
    expect((await listMissedSmsResponses(now)).some(i => i.conversationId === s.conversation.id)).toBe(true);
  });
  it("allows a fresh queued reply time to send, but does not hide a stuck queue indefinitely", async () => {
    const s = await seed();
    await db.insert(s.m).values({ conversationId: s.conversation.id, direction: "outbound", body: "Reply queued.", deliveryStatus: "queued", createdAt: new Date(now.getTime() - 60_000) });
    expect((await listMissedSmsResponses(now)).some(i => i.conversationId === s.conversation.id)).toBe(false);
    expect((await listMissedSmsResponses(new Date(now.getTime() + 16 * 60_000))).some(i => i.conversationId === s.conversation.id)).toBe(true);
  });
  it("excludes a successful staff response in the other SMS persona", async () => {
    const s = await seed();
    const [support] = await db.insert(supportConversationsTable).values({ personId: s.person.id }).returning();
    await db.insert(supportConversationMessagesTable).values({ conversationId: support.id, direction: "outbound", body: "Staff has answered.", sentBy: "staff", deliveryStatus: "sent", createdAt: new Date(old.getTime() + 60_000) });
    expect((await listMissedSmsResponses(now)).some(i => i.conversationId === s.conversation.id)).toBe(false);
  });
  it("does not let thanks hide an earlier unanswered question", async () => {
    const s = await seed();
    await db.insert(s.m).values({ conversationId: s.conversation.id, direction: "inbound", body: "Thanks", createdAt: new Date(old.getTime() + 60_000) });
    const closed = await seed("alexis", "Thanks");
    const rows = await listMissedSmsResponses(now);
    expect(rows.some(i => i.conversationId === s.conversation.id)).toBe(true);
    expect(rows.some(i => i.conversationId === closed.conversation.id)).toBe(false);
  });
  it("dismisses exactly the reviewed inbound, keeping newer messages visible", async () => {
    const s = await seed();
    await clearNeedsAttentionItem("sms", "alexis", s.conversation.id, s.inbound.id);
    await reviewMissedSmsResponse("alexis", s.conversation.id, s.inbound.id);
    expect((await listMissedSmsResponses(now)).some(i => i.conversationId === s.conversation.id)).toBe(false);
    const [next] = await db.insert(s.m).values({ conversationId: s.conversation.id, direction: "inbound", body: "Can someone help?", createdAt: new Date(old.getTime() + 60_000) }).returning();
    await clearNeedsAttentionItem("sms", "alexis", s.conversation.id, s.inbound.id);
    expect((await listMissedSmsResponses(now)).find(i => i.conversationId === s.conversation.id)?.missedInboundId).toBe(next.id);
  });
  it("preserves a separate safety flag and rejects cross-thread dismissal", async () => {
    const s = await seed();
    const other = await seed();
    await reviewMissedSmsResponse("alexis", s.conversation.id, other.inbound.id);
    expect((await listMissedSmsResponses(now)).some(i => i.conversationId === s.conversation.id)).toBe(true);
    await db.update(s.c).set({ needsAttention: true, needsAttentionReason: "Existing safety flag" }).where(eq(s.c.id, s.conversation.id));
    await clearNeedsAttentionItem("sms", "alexis", s.conversation.id, s.inbound.id);
    expect((await listNeedsAttention()).filter(i => i.conversationId === s.conversation.id)).toMatchObject([{ reason: "Existing safety flag" }]);
  });
  it("does not reopen a reviewed question merely because a customer later says thanks", async () => {
    const s = await seed();
    await reviewMissedSmsResponse("alexis", s.conversation.id, s.inbound.id);
    await db.insert(s.m).values({ conversationId: s.conversation.id, direction: "inbound", body: "Thanks", createdAt: new Date(old.getTime() + 60_000) });
    expect((await listMissedSmsResponses(now)).some(i => i.conversationId === s.conversation.id)).toBe(false);
  });
});
describe("closing reply classification", () => {
  it("distinguishes negative eligibility answers from completed exchanges", () => {
    expect(isClosingReply("No", "Are you taking medication?")).toBe(false);
    expect(isClosingReply("No", "Any questions about the form?")).toBe(true);
    expect(isClosingReply("A friend", "How did you hear about us?")).toBe(true);
    expect(isClosingReply("One month", "Which plan?")).toBe(false);
    expect(isClosingReply("Thanks, but what is the cost?", "")).toBe(false);
    expect(isClosingReply("STOP", "")).toBe(true);
  });
});
