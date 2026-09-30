import { describe, it, expect, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useUnifiedConversationsList } from "./useUnifiedConversations";
import { api } from "../lib/apiClient";
vi.mock("../lib/apiClient", () => ({ api: { get: vi.fn() } }));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
describe("incremental inbox polling", () => {
  it("keeps unchanged pages and follows fresh cursors when rows move", async () => {
    const get = vi.mocked(api.get);
    get.mockReset()
      .mockResolvedValueOnce({ conversations: [{ personId: "a" }], nextCursor: "old", version: "v1" })
      .mockResolvedValueOnce({ conversations: [{ personId: "b" }], nextCursor: null, version: "v2" });
    const { result, unmount } = renderHook(() => {
      const query = useUnifiedConversationsList({ search: "Test" });
      // Read data during render, as the inbox does, to subscribe to data changes.
      void query.data;
      return query;
    }, { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => { await result.current.fetchNextPage(); });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    get.mockResolvedValueOnce({ unchanged: true, version: "v1" }).mockResolvedValueOnce({ unchanged: true, version: "v2" });
    await act(async () => { await result.current.refetch(); });
    await waitFor(() => expect(result.current.data?.pages.flatMap(p => p.conversations).map(p => p.personId)).toEqual(["a", "b"]));
    expect(get.mock.calls[2][1]).toMatchObject({ version: "v1" });
    get.mockResolvedValueOnce({ conversations: [{ personId: "b" }], nextCursor: "new", version: "v3" })
      .mockResolvedValueOnce({ conversations: [{ personId: "a" }], nextCursor: null, version: "v4" });
    await act(async () => { await result.current.refetch(); });
    expect(get.mock.calls[5][1]).toMatchObject({ cursor: "new", version: undefined });
    await waitFor(() => expect(result.current.data?.pages.flatMap(p => p.conversations).map(p => p.personId)).toEqual(["b", "a"]));
    unmount();
  });
  it("starts fresh when search filters change", async () => {
    const get = vi.mocked(api.get);
    get.mockReset().mockResolvedValue({ conversations: [], nextCursor: null, version: "v1" });
    const { result, rerender, unmount } = renderHook(({ search }) => useUnifiedConversationsList({ search }), {
      initialProps: { search: "First" }, wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    rerender({ search: "Second" });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith("/api/app/conversations/pages", expect.objectContaining({ search: "Second", cursor: undefined, version: undefined })));
    unmount();
  });
});
