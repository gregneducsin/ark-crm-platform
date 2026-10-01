import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NeedsAttentionPage } from "./NeedsAttentionPage";

const state = vi.hoisted(() => ({ channel: "sms", mutate: vi.fn(), messages: [] as any[] }));
vi.mock("../hooks/useNeedsAttention", () => ({
  useNeedsAttentionList: () => ({ data: { items: [{ conversationId: "synthetic-thread", personId: "synthetic-person", firstName: "Synthetic", lastName: "Example", persona: "alexis", channel: state.channel, lastMessageAt: null, lastMessagePreview: "Preview", reason: "Review" }] } }),
  useNeedsAttentionMessages: () => ({ data: { messages: state.messages } }),
  useClearNeedsAttentionItem: () => ({ mutate: state.mutate, isPending: false }),
}));

beforeEach(() => { cleanup(); state.channel = "sms"; state.mutate.mockClear(); state.messages = []; });
function open() {
  render(<NeedsAttentionPage />);
  fireEvent.click(screen.getByRole("button", { name: /Synthetic Example/ }));
}

describe("Needs Attention delivery preview", () => {
  it("shows staff names, confirmed send time, and uncertain delivery without inventing success", () => {
    state.messages = ["queued", "sent", "delivered", "read", "failed", null].map((status, i) => ({
      id: String(i), direction: "outbound", subject: null, body: "Synthetic " + i,
      createdAt: "2026-09-30T10:00:00Z", sentAt: status === "sent" ? "2026-09-30T10:03:00Z" : null,
      deliveryStatus: status, sentBy: "staff", sentByStaffName: "Synthetic Agent", sentByStaffEmail: "agent@example.com",
    }));
    open();
    expect(screen.getAllByText("Staff · Synthetic Agent")).toHaveLength(6);
    for (const label of ["Queued — send not confirmed", "Sent — delivery not confirmed", "Delivered", "Read", "Failed", "Delivery unknown — check provider before retrying"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(/Recorded.*Sent/)).toBeInTheDocument();
    expect(state.mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/does not resend messages or turn off the overall sales pause/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed & release SMS hold" }));
    expect(state.mutate).toHaveBeenCalledWith({ channel: "sms", persona: "alexis", conversationId: "synthetic-thread" });
  });

  it("labels mail server acceptance and explains email review without promising delivery", () => {
    state.channel = "email";
    state.messages = [{ id: "mail", direction: "outbound", body: "Synthetic email", subject: "Synthetic", createdAt: "2026-09-30T10:00:00Z", sentAt: "2026-09-30T10:03:00Z", deliveryStatus: "sent", sentBy: null }];
    open();
    expect(screen.getByText("Accepted by mail server — delivery not confirmed")).toBeInTheDocument();
    expect(screen.getByText("Sender not recorded")).toBeInTheDocument();
    expect(screen.getByText(/does not send or retry an email/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /release SMS/ })).not.toBeInTheDocument();
  });
});
