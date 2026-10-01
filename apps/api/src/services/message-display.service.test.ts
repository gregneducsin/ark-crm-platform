import { describe, expect, it } from "vitest";
import { db, appUsersTable, customersTable, conversationsTable, conversationMessagesTable, supportConversationsTable, supportConversationMessagesTable, emailConversationsTable, emailConversationMessagesTable, supportEmailConversationsTable, supportEmailConversationMessagesTable } from "@luma/db";
import { getNeedsAttentionMessages } from "./needs-attention.service.js";
import { withStaffNames } from "./message-authorship.service.js";

describe("review preview delivery and authorship", () => {
  it.each(["sales SMS", "support SMS", "sales email", "support email"] as const)("preserves actual send time and staff identity for %s", async (kind) => {
    const email = `display-${crypto.randomUUID()}@example.com`;
    await db.insert(appUsersTable).values({ email, normalizedEmail: email, firstName: "Synthetic", lastName: "Reviewer" });
    const [customer] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Display", email: `customer-${email}`, leadReceivedDate: "2026-09-30" }).returning();
    const recorded = new Date("2026-09-30T10:00:00Z");
    const sent = new Date("2026-09-30T10:03:00Z");
    const base = { direction: "outbound" as const, body: "Synthetic staff message", sentBy: "staff" as const, sentByStaffEmail: email, createdAt: recorded, sentAt: sent, deliveryStatus: "sent" as const };
    let conversationId: string;
    if (kind === "sales SMS") {
      const [c] = await db.insert(conversationsTable).values({ personId: customer.id }).returning();
      conversationId = c.id;
      await db.insert(conversationMessagesTable).values({ ...base, conversationId });
    } else if (kind === "support SMS") {
      const [c] = await db.insert(supportConversationsTable).values({ personId: customer.id }).returning();
      conversationId = c.id;
      await db.insert(supportConversationMessagesTable).values({ ...base, conversationId });
    } else if (kind === "sales email") {
      const [c] = await db.insert(emailConversationsTable).values({ personId: customer.id }).returning();
      conversationId = c.id;
      await db.insert(emailConversationMessagesTable).values({ ...base, conversationId, subject: "Synthetic" });
    } else {
      const [c] = await db.insert(supportEmailConversationsTable).values({ personId: customer.id }).returning();
      conversationId = c.id;
      await db.insert(supportEmailConversationMessagesTable).values({ ...base, conversationId, subject: "Synthetic" });
    }
    const messages = await getNeedsAttentionMessages(kind.endsWith("SMS") ? "sms" : "email", kind.startsWith("sales") ? "alexis" : "sophie", conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ createdAt: recorded.toISOString(), sentAt: sent.toISOString(), deliveryStatus: "sent", sentBy: "staff", sentByStaffName: "Synthetic Reviewer" });
  });

  it("does not invent names for missing or historical staff accounts", async () => {
    expect(await withStaffNames([{ sentByStaffEmail: null }, { sentByStaffEmail: "missing@example.com" }])).toEqual([
      { sentByStaffEmail: null, sentByStaffName: null },
      { sentByStaffEmail: "missing@example.com", sentByStaffName: null },
    ]);
  });
});
