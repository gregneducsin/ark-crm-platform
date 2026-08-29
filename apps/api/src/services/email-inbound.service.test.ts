import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const notifySlackMock = vi.fn();
vi.mock("../lib/slack.js", () => ({ notifySlack: (...args: unknown[]) => notifySlackMock(...args) }));

const connectMock = vi.fn();
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(function ImapFlowMock() {
    return {
      on: vi.fn(),
      connect: connectMock,
      logout: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

const { stripQuotedReply, parseExtraMailboxes, isIgnoredSender, sweepInboundEmail } = await import("./email-inbound.service.js");

describe("stripQuotedReply", () => {
  it("returns the whole body when there's no quoted history", () => {
    expect(stripQuotedReply("Sounds good, let's do it.")).toBe("Sounds good, let's do it.");
  });

  it("cuts off at a Gmail-style 'On ... wrote:' quote header", () => {
    const body = "Yes please send the link.\n\nOn Tue, Jan 6, 2026 at 3:14 PM Alexis at Ark Health <alexis@tryark.com> wrote:\n> Hi Jamie, want the link?";
    expect(stripQuotedReply(body)).toBe("Yes please send the link.");
  });

  it("cuts off at an Outlook-style 'From:/Sent:' original-message header", () => {
    const body = "No thanks.\n\nFrom: Alexis at Ark Health\nSent: Tuesday, January 6, 2026 3:14 PM\nTo: Jamie\nSubject: Re: enrollment";
    expect(stripQuotedReply(body)).toBe("No thanks.");
  });

  it("cuts off at a run of '> ' quoted lines when no recognized header is present", () => {
    const body = "Still interested, what's the price?\n> previous message text\n> more previous text";
    expect(stripQuotedReply(body)).toBe("Still interested, what's the price?");
  });

  it("trims surrounding whitespace", () => {
    expect(stripQuotedReply("  hello there  \n\n")).toBe("hello there");
  });

  it("cuts off at a quote header even when the display name + address push it past 80 characters", () => {
    // Real-world case that slipped through: a long display name plus a
    // subdomain address ("Sophie at Ark Health <alexism@start.tryark.com>")
    // pushes the "On ... wrote:" header past a too-tight character cap,
    // leaving the whole header line stuck in the visible message.
    const body =
      "okay and then if i wanted to speak to the doctor?\n\n" +
      "On Wed, Aug 19, 2026 at 12:01 AM Sophie at Ark Health <alexism@start.tryark.com> wrote:\n> previous message text";
    expect(stripQuotedReply(body)).toBe("okay and then if i wanted to speak to the doctor?");
  });
});

describe("parseExtraMailboxes", () => {
  it("returns an empty array when unset or blank", () => {
    expect(parseExtraMailboxes(undefined)).toEqual([]);
    expect(parseExtraMailboxes("  ")).toEqual([]);
  });

  it("parses a single user:apppassword entry", () => {
    expect(parseExtraMailboxes("hello@tryark.com:abcdefghijklmnop")).toEqual([
      { host: "imap.gmail.com", user: "hello@tryark.com", pass: "abcdefghijklmnop" },
    ]);
  });

  it("parses multiple comma-separated entries and strips spaces out of the app password", () => {
    expect(parseExtraMailboxes("hello@tryark.com:abcd efgh ijkl mnop, greg@tryark.com:qrst uvwx yzab cdef")).toEqual([
      { host: "imap.gmail.com", user: "hello@tryark.com", pass: "abcdefghijklmnop" },
      { host: "imap.gmail.com", user: "greg@tryark.com", pass: "qrstuvwxyzabcdef" },
    ]);
  });

  it("accepts a space in place of the colon between user and app password — the real-world typo this was written for", () => {
    expect(parseExtraMailboxes("hello@tryark.com ffax ibpx xqzz hwaa")).toEqual([
      { host: "imap.gmail.com", user: "hello@tryark.com", pass: "ffaxibpxxqzzhwaa" },
    ]);
  });

  it("throws on an entry with no separator between user and password at all", () => {
    expect(() => parseExtraMailboxes("hello@tryark.com")).toThrow(/missing the separator/);
  });

  it("throws on an entry with an empty user or password", () => {
    expect(() => parseExtraMailboxes(":abcdefghijklmnop")).toThrow(/empty user or app password/);
    expect(() => parseExtraMailboxes("hello@tryark.com:")).toThrow(/empty user or app password/);
  });
});

describe("sweepInboundEmail", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.GOOGLE_WORKSPACE_SMTP_USER = "help@tryark.com";
    process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "ulzqezghvjvulqfg";
    delete process.env.EMAIL_INBOUND_EXTRA_MAILBOXES;
    notifySlackMock.mockClear();
    connectMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // A revoked app password or connection failure used to only ever hit
  // logger.error — nothing surfaced outside the server logs, so inbound
  // routing for that mailbox could stay silently dead until someone thought
  // to check Railway logs. This locks in that it now alerts the same way
  // every other failure class in this sweep already does.
  it("alerts Slack when a mailbox connection fails, naming the mailbox", async () => {
    connectMock.mockRejectedValue(new Error("Invalid credentials (Failure)"));

    const result = await sweepInboundEmail();

    expect(result.failedCount).toBe(1);
    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    expect(notifySlackMock.mock.calls[0][0]).toMatch(/help@tryark\.com/);
    expect(notifySlackMock.mock.calls[0][0]).toMatch(/Invalid credentials/);
  });
});

describe("isIgnoredSender", () => {
  it("returns false when EMAIL_INBOUND_IGNORED_SENDERS is unset or blank", () => {
    expect(isIgnoredSender("help@example-platform.ai", undefined)).toBe(false);
    expect(isIgnoredSender("help@example-platform.ai", "  ")).toBe(false);
  });

  it("matches an exact address in the comma-separated list, case-insensitively", () => {
    const list = "help@example-platform.ai,support@example-platform.ai";
    expect(isIgnoredSender("help@example-platform.ai", list)).toBe(true);
    expect(isIgnoredSender("HELP@Example-Platform.AI", list)).toBe(true);
    expect(isIgnoredSender("support@example-platform.ai", list)).toBe(true);
  });

  it("does not match an address that isn't in the list", () => {
    expect(isIgnoredSender("real.customer@gmail.com", "help@example-platform.ai")).toBe(false);
  });

  it("does not do a domain/wildcard match — only exact addresses", () => {
    expect(isIgnoredSender("someone-else@example-platform.ai", "help@example-platform.ai")).toBe(false);
  });
});
