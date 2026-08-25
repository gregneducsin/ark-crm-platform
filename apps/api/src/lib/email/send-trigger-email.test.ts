import { describe, expect, it, vi, beforeAll } from "vitest";
import { db, customersTable } from "@luma/db";
import { setCustomerEmailDnd } from "../../services/dnd.service.js";

beforeAll(() => {
  process.env.EMAIL_PROVIDER = "google_workspace";
  process.env.GOOGLE_WORKSPACE_SMTP_USER = "bot@example.com";
  process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD = "app-password";
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
});

const sendEmailMock = vi.fn();
vi.mock("../email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../email-provider.js")>("../email-provider.js");
  return { ...actual, getEmailProvider: () => ({ provider: { sendEmail: sendEmailMock }, fromName: "Alexis at Ark Health" }) };
});

const { sendTriggerEmail } = await import("./send-trigger-email.js");

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName: "Trigger", lastName: "Test", email: `trigger-email-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("sendTriggerEmail", () => {
  it("renders with a working unsubscribe URL, sends, and logs the plain-text body with the returned messageId", async () => {
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValueOnce({ messageId: "<trigger-1@example.com>" });
    const appendMessage = vi.fn().mockResolvedValue(undefined);

    const personId = await seedCustomer();
    const result = await sendTriggerEmail({
      persona: "alexis",
      personId,
      conversationId: "conv-1",
      email: "customer@example.com",
      render: (unsubscribeUrl) => ({ subject: "Hello", html: `<p>Hi there</p><a href="${unsubscribeUrl}">unsub</a>` }),
      appendMessage,
      logLabel: "test-trigger",
    });

    expect(result).toEqual({ status: "sent", messageId: "<trigger-1@example.com>" });
    expect(sendEmailMock).toHaveBeenCalledWith("customer@example.com", "Hello", expect.stringContaining("Hi there"), {
      fromName: "Alexis at Ark Health",
      unsubscribeUrl: expect.stringContaining("/unsubscribe/"),
    });
    expect(appendMessage).toHaveBeenCalledWith("conv-1", "outbound", "Hello", expect.stringContaining("Hi there"), { messageId: "<trigger-1@example.com>" });
  });

  it("does not call the provider or append anything when the customer is do-not-disturb", async () => {
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    sendEmailMock.mockClear();
    const appendMessage = vi.fn();
    const render = vi.fn();

    const personId = await seedCustomer();
    await setCustomerEmailDnd(personId, true);

    const result = await sendTriggerEmail({
      persona: "alexis",
      personId,
      conversationId: "conv-2",
      email: "customer@example.com",
      render,
      appendMessage,
      logLabel: "test-trigger",
    });

    expect(result).toEqual({ status: "dnd" });
    expect(render).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
  });

  it("fails soft (no throw, no append) when rendering itself fails — e.g. INTAKE_LINK_BASE_URL unset", async () => {
    const saved = process.env.INTAKE_LINK_BASE_URL;
    delete process.env.INTAKE_LINK_BASE_URL;
    sendEmailMock.mockClear();
    const appendMessage = vi.fn();

    const personId = await seedCustomer();
    await expect(
      sendTriggerEmail({
        persona: "alexis",
        personId,
        conversationId: "conv-3",
        email: "customer@example.com",
        render: () => ({ subject: "Hello", html: "<p>hi</p>" }),
        appendMessage,
        logLabel: "test-trigger",
      }),
    ).resolves.toEqual({ status: "render_failed" });

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(appendMessage).not.toHaveBeenCalled();
    process.env.INTAKE_LINK_BASE_URL = saved;
  });

  it("still logs the outbound message (with a null messageId) when the send itself fails", async () => {
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    sendEmailMock.mockClear();
    sendEmailMock.mockRejectedValueOnce(new Error("SMTP down"));
    const appendMessage = vi.fn().mockResolvedValue(undefined);

    const personId = await seedCustomer();
    const result = await sendTriggerEmail({
      persona: "alexis",
      personId,
      conversationId: "conv-4",
      email: "customer@example.com",
      render: (unsubscribeUrl) => ({ subject: "Hello", html: `<p>hi ${unsubscribeUrl}</p>` }),
      appendMessage,
      logLabel: "test-trigger",
    });

    expect(result).toEqual({ status: "send_failed" });
    expect(appendMessage).toHaveBeenCalledWith("conv-4", "outbound", "Hello", expect.any(String), { messageId: null });
  });
});
