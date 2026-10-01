import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UnmatchedContactsPage } from "./UnmatchedContactsPage";

const state = vi.hoisted(() => ({
  channel: "sms", status: "replied", sent: true, smsSend: vi.fn(), emailSend: vi.fn(), dismiss: vi.fn(),
}));
const thread = () => ({
  id: "synthetic-thread", fromPhone: "+19995550111", fromAddress: "synthetic@example.com",
  fromName: "Synthetic Contact", collectedEmail: null, suggestedReply: "Old suggested reply",
  status: state.status, createdAt: "2026-09-30T10:00:00Z", repliedAt: "2026-09-30T10:01:00Z",
  lastMessageAt: "2026-09-30T10:01:00Z", lastMessagePreview: "Synthetic preview",
});
const mutation = (mutate: ReturnType<typeof vi.fn>) => ({ mutate, isPending: false, isSuccess: false, isError: false });
vi.mock("../hooks/useUnmatchedSms", () => ({
  useUnmatchedSmsList: () => ({ data: { items: state.channel === "sms" ? [thread()] : [] } }),
  useUnmatchedSmsThread: () => ({ data: { messages: [] } }),
  useSendUnmatchedSmsReply: () => mutation(state.smsSend),
  useDismissUnmatchedSms: () => mutation(state.dismiss),
}));
vi.mock("../hooks/useUnmatchedEmails", () => ({
  useUnmatchedEmailsList: () => ({ data: { items: state.channel === "email" ? [thread()] : [] } }),
  useUnmatchedEmailThread: () => ({ data: { messages: [] } }),
  useSendUnmatchedEmailReply: () => mutation(state.emailSend),
  useDismissUnmatchedEmail: () => mutation(state.dismiss),
}));

beforeEach(() => {
  cleanup(); state.channel = "sms"; state.status = "replied"; state.sent = true;
  state.dismiss.mockReset();
  for (const send of [state.smsSend, state.emailSend]) send.mockReset().mockImplementation((_input, options) => options?.onSuccess({ sent: state.sent }));
});
function expand() {
  render(<UnmatchedContactsPage />);
  fireEvent.click(screen.getByRole("button", { name: /Synthetic Contact/ }));
}

describe("continued replies", () => {
  it.each([["sms", "replied"], ["sms", "dismissed"], ["email", "replied"], ["email", "dismissed"]])("allows %s replies from %s without reopening", (channel, status) => {
    state.channel = channel; state.status = status;
    expand();
    const draft = screen.getByRole("textbox", { name: "Reply message" });
    expect(draft).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    fireEvent.change(draft, { target: { value: "New staff reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(channel === "sms" ? state.smsSend : state.emailSend).toHaveBeenCalledWith({ id: "synthetic-thread", body: "New staff reply" }, expect.any(Object));
    expect(channel === "sms" ? state.emailSend : state.smsSend).not.toHaveBeenCalled();
    expect(state.dismiss).not.toHaveBeenCalled();
    expect(draft).toHaveValue("");
  });

  it("keeps the typed draft when sending fails", () => {
    state.sent = false; expand();
    const draft = screen.getByRole("textbox", { name: "Reply message" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));
    expect(draft).toHaveValue("Keep this draft");
  });

  it("still offers suggested replies and dismiss for items awaiting review", () => {
    state.status = "needs_review"; expand();
    expect(screen.getByRole("textbox", { name: "Reply message" })).toHaveValue("Old suggested reply");
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });
});
