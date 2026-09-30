import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ConversationsPage } from "./ConversationsPage";
import { useUnifiedConversationDetail } from "../hooks/useUnifiedConversations";

vi.mock("wouter", () => ({ useSearch: () => "personId=outside-loaded-page" }));
vi.mock("../components/UpcomingTriggerBanner", () => ({ UpcomingTriggerBanner: () => null }));
vi.mock("../components/CustomerNotesCard", () => ({ CollapsibleCustomerNotes: () => null }));
vi.mock("../hooks/useUnifiedConversations", () => ({
  useUnifiedConversationsList: () => ({ data: { pages: [{ conversations: [], nextCursor: null }] }, isLoading: false }),
  useUnifiedConversationStats: () => ({ data: { attentionCount: 0, salesStats: { totalContacted: 0, totalResponded: 0, responseRate: 0 } } }),
  useClearAllNeedsAttention: () => ({ mutate: vi.fn(), isPending: false }),
  useSendUnifiedStaffReply: () => ({ mutate: vi.fn(), isPending: false }),
  useUnifiedConversationDetail: vi.fn((id: string | null) => ({ isLoading: false, data: id ? {
    customer: { id, firstName: "Synthetic", lastName: "DeepLink", phone: null, email: null, leadType: null, hasQualifyingPurchase: false },
    sales: null, support: null, messages: [], availableReplyTargets: [{ persona: "sales", channel: "sms" }],
  } : undefined })),
}));

describe("inbox deep links", () => {
  it("opens the requested customer independently of loaded list pages", async () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    render(<ConversationsPage />);
    await waitFor(() => expect(screen.getByText("Synthetic DeepLink")).toBeInTheDocument());
    expect(useUnifiedConversationDetail).toHaveBeenCalledWith("outside-loaded-page");
    expect(screen.queryByText("Select a conversation to view it.")).not.toBeInTheDocument();
  });
});
