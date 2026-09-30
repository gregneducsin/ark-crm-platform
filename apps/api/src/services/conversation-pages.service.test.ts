import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, customersTable, conversationMessagesTable } from "@luma/db";
import { getOrCreateConversation, appendMessage, updateConversationState } from "./conversations.service.js";
import { getOrCreateEmailConversation, appendEmailMessage } from "./email-conversations.service.js";
import { getOrCreateSupportConversation, appendSupportMessage, updateSupportConversationState } from "./support-conversations.service.js";
import { getOrCreateSupportEmailConversation, appendSupportEmailMessage } from "./support-email-conversations.service.js";
import { listUnifiedConversationPage, countUnifiedAttention } from "./conversation-pages.service.js";
import { listUnifiedConversationSummaries } from "./unified-conversations.service.js";

async function seed(prefix: string, name: string) {
  const [customer] = await db.insert(customersTable).values({
    firstName: prefix, lastName: name, email: `${prefix + name}@example.com`,
    leadReceivedDate: "2026-08-15", leadType: "Caterpillar",
  }).returning();
  return customer.id;
}

describe("paged unified inbox", () => {
  it("pages through equal timestamps and empty threads exactly once", async () => {
    const search = "Page" + crypto.randomUUID();
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      const id = await seed(search, String(n)); ids.push(id);
      const thread = await getOrCreateConversation(id);
      if (n < 3) {
        await appendMessage(thread.id, "inbound", "Synthetic message");
        await db.update(conversationMessagesTable).set({ createdAt: new Date("2026-01-01T00:00:00Z") })
          .where(eq(conversationMessagesTable.conversationId, thread.id));
      }
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listUnifiedConversationPage({ search, limit: 2, cursor });
      expect(page.conversations.length).toBeLessThanOrEqual(2);
      seen.push(...page.conversations.map(c => c.personId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([...ids.slice(0, 3).sort(), ...ids.slice(3).sort()]);
    expect(new Set(seen).size).toBe(5);
  });

  it("preserves merged previews, sentiment, source and attention across all four channels", async () => {
    const search = "Merge" + crypto.randomUUID();
    const id = await seed(search, "All");
    const sales = await getOrCreateConversation(id, "meta_form");
    await appendMessage(sales.id, "inbound", "SMS");
    const email = await getOrCreateEmailConversation(id, "meta_form");
    await appendEmailMessage(email.id, "inbound", "Subject", "Email");
    const support = await getOrCreateSupportConversation(id);
    await appendSupportMessage(support.id, "inbound", "Support");
    const supportEmail = await getOrCreateSupportEmailConversation(id);
    await appendSupportEmailMessage(supportEmail.id, "inbound", "Subject", "Support email");
    await updateSupportConversationState(support.id, { needsAttention: true, needsAttentionReason: "test" });
    const page = await listUnifiedConversationPage({ search });
    const old = (await listUnifiedConversationSummaries()).find(c => c.personId === id)!;
    expect(page.conversations).toHaveLength(1);
    const row = page.conversations[0];
    expect({ ...row, lastMessageAt: null }).toEqual({ ...old, lastMessageAt: null });
    expect(new Date(row.lastMessageAt!).getTime()).toBe(new Date(old.lastMessageAt!).getTime());
    expect(row).toMatchObject({ hasSalesThread: true, hasSupportThread: true, needsAttention: true });
  });

  it("filters the full inventory and changes the version for edits without a new message", async () => {
    const search = "Filter" + crypto.randomUUID();
    const id = await seed(search, "Target");
    const thread = await getOrCreateConversation(id, "meta_form");
    await appendMessage(thread.id, "inbound", "Test");
    const first = await listUnifiedConversationPage({ search });
    expect((await listUnifiedConversationPage({ search })).version).toBe(first.version);
    await updateConversationState(thread.id, { needsAttention: true, needsAttentionReason: "test" });
    const changed = await listUnifiedConversationPage({ search });
    expect(changed.version).not.toBe(first.version);
    expect((await listUnifiedConversationPage({ search: search.toLowerCase(), onlyNeedsAttention: true, leadSource: "meta_form" })).conversations.map(c => c.personId)).toEqual([id]);
    expect((await listUnifiedConversationPage({ search, leadSource: "abandoned_cart" })).conversations).toEqual([]);
    expect(await countUnifiedAttention()).toBeGreaterThan(0);
    await db.update(customersTable).set({ lastName: "Renamed" }).where(eq(customersTable.id, id));
    expect((await listUnifiedConversationPage({ search })).version).not.toBe(changed.version);
  });

  it("refreshes the first page when an older customer becomes active", async () => {
    const search = "Move" + crypto.randomUUID();
    const older = await seed(search, "Older");
    const oldThread = await getOrCreateConversation(older);
    await appendMessage(oldThread.id, "inbound", "Old");
    await db.update(conversationMessagesTable).set({ createdAt: new Date("2026-01-01Z") })
      .where(eq(conversationMessagesTable.conversationId, oldThread.id));
    const newer = await seed(search, "Newer");
    await appendMessage((await getOrCreateConversation(newer)).id, "inbound", "New");
    const first = await listUnifiedConversationPage({ search, limit: 1 });
    expect(first.conversations[0].personId).toBe(newer);
    await appendMessage(oldThread.id, "inbound", "Latest");
    const refreshed = await listUnifiedConversationPage({ search, limit: 1 });
    expect(refreshed.conversations[0].personId).toBe(older);
    expect((await listUnifiedConversationPage({ search, limit: 1, cursor: refreshed.nextCursor! })).conversations[0].personId).toBe(newer);
  });

  it("rejects malformed or filter-mismatched cursors and treats search punctuation literally", async () => {
    await expect(listUnifiedConversationPage({ cursor: "bad" })).rejects.toThrow("Invalid conversation cursor");
    const search = "Cursor" + crypto.randomUUID();
    for (const name of ["One", "Two"]) await getOrCreateConversation(await seed(search, name));
    const page = await listUnifiedConversationPage({ search, limit: 1 });
    await expect(listUnifiedConversationPage({ search: "different", cursor: page.nextCursor! })).rejects.toThrow("Invalid conversation cursor");
    expect((await listUnifiedConversationPage({ search: "%_' OR 1=1 --" })).conversations).toEqual([]);
  });
});
