import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, webhookEventsTable } from "@luma/db";

const mocks = vi.hoisted(() => ({
  search: vi.fn(), fetchOne: vi.fn(), flag: vi.fn(), handle: vi.fn(),
  uidValidity: 100n,
}));
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(function () {
    return {
      on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: mocks.search, fetchOne: mocks.fetchOne, messageFlagsAdd: mocks.flag,
      get mailbox() { return { uidValidity: mocks.uidValidity }; },
      logout: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));
vi.mock("./unmatched-inbound-email.service.js", () => ({
  recordAndClassifyUnmatchedEmail: mocks.handle,
}));
vi.mock("../lib/slack.js", () => ({ notifySlack: vi.fn(), notifySmsSlack: vi.fn() }));

const { sweepInboundEmail } = await import("./email-inbound.service.js");
const { recordWebhookEventIfNew, markWebhookEventFailed, markWebhookEventProcessed } = await import("./webhooks.service.js");

let eventId: string;
let unread: Set<number>;
const originalEnv = { ...process.env };

async function event() {
  const [row] = await db.select().from(webhookEventsTable)
    .where(and(eq(webhookEventsTable.source, "email_inbound"), eq(webhookEventsTable.externalEventId, eventId)));
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.uidValidity++;
  mocks.handle.mockReset().mockResolvedValue(undefined);
  mocks.flag.mockReset();
  eventId = `<retry-${crypto.randomUUID()}@example.com>`;
  unread = new Set([1]);
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "inbox@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "synthetic-test-password";
  delete process.env.EMAIL_INBOUND_EXTRA_MAILBOXES;
  delete process.env.EMAIL_INBOUND_IGNORED_SENDERS;
  mocks.search.mockImplementation(async () => [...unread]);
  mocks.fetchOne.mockImplementation(async (uid: string) => ({
    uid: Number(uid),
    source: Buffer.from([
      "From: Synthetic Sender <synthetic-retry-sender@example.com>",
      "To: inbox@example.com",
      `Message-ID: ${eventId}`,
      "Subject: Synthetic retry test",
      "Content-Type: text/plain; charset=utf-8",
      "", "A synthetic test message.",
    ].join("\r\n")),
  }));
  mocks.flag.mockImplementation(async ({ uid }: { uid: string }) => {
    unread.delete(Number(uid));
  });
});

afterEach(() => { process.env = { ...originalEnv }; });

describe("inbound email acknowledgements", () => {
  function withoutMessageId() {
    mocks.search.mockResolvedValue([1]);
    mocks.fetchOne.mockResolvedValue({ uid: 1, source: Buffer.from("From: synthetic-retry-sender@example.com\r\nSubject: Synthetic without Message-ID\r\n\r\nSynthetic body") });
  }

  it("keeps equal UIDs in distinct mailboxes separate and deduplicates each on retry", async () => {
    withoutMessageId();
    process.env.EMAIL_INBOUND_EXTRA_MAILBOXES = "second-inbox@example.com:synthetic-password";
    expect(await sweepInboundEmail()).toMatchObject({ processedCount: 2, failedCount: 0 });
    expect(mocks.handle).toHaveBeenCalledTimes(2);
    expect(await sweepInboundEmail()).toMatchObject({ processedCount: 0, skippedCount: 2 });
    expect(mocks.handle).toHaveBeenCalledTimes(2);
  });

  it("does not confuse a reused UID after the mailbox UIDVALIDITY changes", async () => {
    withoutMessageId();
    await sweepInboundEmail();
    mocks.uidValidity += 1000n;
    await sweepInboundEmail();
    expect(mocks.handle).toHaveBeenCalledTimes(2);
  });

  it("leaves a message unread when a reliable fallback identity cannot be established", async () => {
    withoutMessageId(); const valid = mocks.uidValidity; mocks.uidValidity = 0n;
    expect(await sweepInboundEmail()).toMatchObject({ failedCount: 1, processedCount: 0 });
    expect(mocks.flag).not.toHaveBeenCalled(); expect(mocks.handle).not.toHaveBeenCalled();
    mocks.uidValidity = valid;
    expect(await sweepInboundEmail()).toMatchObject({ processedCount: 1 });
  });

  it("keeps processing failures unread and retries them successfully on the next poll", async () => {
    mocks.handle.mockRejectedValueOnce(new Error("synthetic transient failure"));
    expect(await sweepInboundEmail()).toMatchObject({ failedCount: 1, processedCount: 0 });
    expect((await event()).status).toBe("failed");
    expect(unread.has(1)).toBe(true);
    expect(mocks.flag).not.toHaveBeenCalled();

    mocks.flag.mockImplementationOnce(async ({ uid }: { uid: string }, flags: string[]) => {
      expect((await event()).status).toBe("processed");
      expect(flags).toEqual(["\\Seen"]);
      unread.delete(Number(uid));
    });
    expect(await sweepInboundEmail()).toMatchObject({ failedCount: 0, processedCount: 1 });
    expect(mocks.handle).toHaveBeenCalledTimes(2);
    expect(unread.size).toBe(0);
    expect((await event()).status).toBe("processed");
    await sweepInboundEmail();
    expect(mocks.handle).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge a delivery another poll is still processing", async () => {
    const claimed = await recordWebhookEventIfNew("email_inbound", eventId, {});
    expect(await sweepInboundEmail()).toMatchObject({ skippedCount: 1, processedCount: 0 });
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.flag).not.toHaveBeenCalled();
    expect(unread.has(1)).toBe(true);

    await markWebhookEventFailed(claimed!.id, "synthetic failure in the other poll");
    expect(await sweepInboundEmail()).toMatchObject({ processedCount: 1, failedCount: 0 });
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(unread.size).toBe(0);
  });

  it("acknowledges an already processed delivery without handling it again", async () => {
    const claimed = await recordWebhookEventIfNew("email_inbound", eventId, {});
    await markWebhookEventProcessed(claimed!.id);
    expect(await sweepInboundEmail()).toMatchObject({ skippedCount: 1, processedCount: 0 });
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(unread.size).toBe(0);
  });

  it("retries a failed Seen update without repeating successful handling", async () => {
    mocks.flag.mockRejectedValueOnce(new Error("synthetic IMAP flag failure"));
    expect(await sweepInboundEmail()).toMatchObject({ processedCount: 1, failedCount: 0 });
    expect((await event()).status).toBe("processed");
    expect(unread.has(1)).toBe(true);
    expect(await sweepInboundEmail()).toMatchObject({ skippedCount: 1, processedCount: 0 });
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(unread.size).toBe(0);
  });

  it("continues to acknowledge explicitly ignored senders without processing them", async () => {
    process.env.EMAIL_INBOUND_IGNORED_SENDERS = "synthetic-retry-sender@example.com";
    expect(await sweepInboundEmail()).toMatchObject({ skippedCount: 1, processedCount: 0 });
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(await event()).toBeUndefined();
    expect(unread.size).toBe(0);
  });

  it("refreshes the retry claim time so an old failed delivery cannot be immediately claimed again", async () => {
    const claimed = await recordWebhookEventIfNew("email_inbound", eventId, {});
    await db.update(webhookEventsTable)
      .set({ status: "failed", receivedAt: sql`now() - interval '10 minutes'` })
      .where(eq(webhookEventsTable.id, claimed!.id));
    expect(await recordWebhookEventIfNew("email_inbound", eventId, {})).toEqual(claimed);
    expect(await recordWebhookEventIfNew("email_inbound", eventId, {})).toBeNull();
    expect((await event()).status).toBe("received");
  });
});
