import { describe, expect, it, vi } from "vitest";

const notifySlackMock = vi.fn();
vi.mock("../lib/slack.js", () => ({ notifySlack: (...args: unknown[]) => notifySlackMock(...args) }));

const { recordWebhookEventIfNew, markWebhookEventFailed } = await import("./webhooks.service.js");

describe("markWebhookEventFailed", () => {
  it("alerts Slack with the event's source and the error message", async () => {
    notifySlackMock.mockClear();
    const recorded = await recordWebhookEventIfNew("bask_order", `evt-${crypto.randomUUID()}`, { foo: "bar" });

    await markWebhookEventFailed(recorded!.id, "something went wrong");

    expect(notifySlackMock).toHaveBeenCalledTimes(1);
    const [message] = notifySlackMock.mock.calls[0];
    expect(message).toContain("bask_order");
    expect(message).toContain("something went wrong");
  });

  it("tags the alert with whichever source actually failed", async () => {
    notifySlackMock.mockClear();
    const recorded = await recordWebhookEventIfNew("ghl_lead", `evt-${crypto.randomUUID()}`, { foo: "bar" });

    await markWebhookEventFailed(recorded!.id, "boom");

    expect(notifySlackMock.mock.calls[0][0]).toContain("ghl_lead");
  });
});
