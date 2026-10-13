import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, emailConversationsTable, supportEmailConversationsTable, emailConversationMessagesTable, supportEmailConversationMessagesTable } from "@luma/db";
const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../lib/email-provider.js", () => ({ getEmailProvider: () => ({ provider: { sendEmail: mocks.send }, fromName: "Synthetic" }) }));
vi.mock("../lib/email/unsubscribe.js", () => ({ buildUnsubscribeUrl: () => "https://example.com/unsubscribe" }));
import { flagEmailForReview, sendTrackedEmail, sweepEmailDeliveryTimeouts } from "./email-delivery.service.js";

describe.each(["alexis", "sophie"] as const)("%s preserves email review reasons", persona => {
  const table = persona === "alexis" ? emailConversationsTable : supportEmailConversationsTable;
  const messages = persona === "alexis" ? emailConversationMessagesTable : supportEmailConversationMessagesTable;
  async function seed(reason: string | null) {
    const [person] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Review", email: `${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-10-12" }).returning();
    const [thread] = await db.insert(table).values({ personId: person.id, needsAttention: true, needsAttentionReason: reason }).returning();
    return { person, thread };
  }
  it("preserves clinical and identity reasons when transport is uncertain", async () => {
    const { person, thread } = await seed("Clinical review required. Identity verification pending.");
    mocks.send.mockReset().mockRejectedValue(new Error("transport uncertain"));
    expect(await sendTrackedEmail({ persona, personId: person.id, conversationId: thread.id, email: person.email, subject: "Synthetic", body: "Synthetic", render: () => "Synthetic", transactional: true })).toEqual({ status: "unknown" });
    const [after] = await db.select().from(table).where(eq(table.id, thread.id));
    expect(after.needsAttentionReason).toContain(thread.needsAttentionReason);
    expect(after.needsAttentionReason).toContain("Email delivery failed or is unconfirmed"); expect(after.needsAttention).toBe(true);
  });
  it("appends concurrent distinct reasons once without losing billing context", async () => {
    const { thread } = await seed("Billing review pending.");
    await Promise.all([flagEmailForReview(persona, thread.id, "Delivery issue."), flagEmailForReview(persona, thread.id, "Processing interrupted."), flagEmailForReview(persona, thread.id, "Delivery issue.")]);
    const [after] = await db.select().from(table).where(eq(table.id, thread.id));
    expect(after.needsAttentionReason).toContain("Billing review pending.");
    expect(after.needsAttentionReason).toContain("Processing interrupted.");
    expect(after.needsAttentionReason!.split("Delivery issue.")).toHaveLength(2);
  });
  it("preserves a hold when a queued email times out, without duplicate reasons", async () => {
    const { thread } = await seed("Staff requested review.");
    await db.insert(messages).values({ conversationId: thread.id, direction: "outbound", subject: "Synthetic", body: "Synthetic", deliveryStatus: "queued", createdAt: new Date(Date.now()-6*60_000) });
    await sweepEmailDeliveryTimeouts(); await flagEmailForReview(persona, thread.id);
    const [after] = await db.select().from(table).where(eq(table.id, thread.id));
    expect(after.needsAttentionReason).toContain("Staff requested review.");
    expect(after.needsAttentionReason!.split("Email delivery failed or is unconfirmed")).toHaveLength(2);
  });
  it.each([null, "", "   "])("initializes an empty reason (%s)", async reason => {
    const { thread } = await seed(reason); await flagEmailForReview(persona, thread.id, "Delivery issue.");
    const [after] = await db.select().from(table).where(eq(table.id, thread.id));
    expect(after.needsAttentionReason).toBe("Delivery issue.");
  });
});
