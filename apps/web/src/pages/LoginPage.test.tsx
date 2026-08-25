import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LoginPage } from "./LoginPage";

// Full Playwright browser verification (login -> customers -> purchases ->
// payroll lifecycle -> logout, against the real API and Postgres) was run
// manually for this phase — see the phase commit message. This is a fast,
// no-DB, no-server component-level smoke test that runs in CI, checking
// the login form actually calls the API and reacts to the response.
describe("LoginPage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("submits credentials to the login endpoint and shows an error on failure", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes("csrf-token")) {
        return new Response(JSON.stringify({ csrfToken: "test-csrf" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/auth/me")) {
        return new Response(JSON.stringify({ user: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/auth/login")) {
        return new Response(JSON.stringify({ error: "Invalid email or password." }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <LoginPage />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/email/i), "wrong@example.com");
    await user.type(screen.getByLabelText(/password/i), "wrong-password");
    await user.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(screen.getByText("Invalid email or password.")).toBeInTheDocument());

    const loginCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/auth/login"));
    expect(loginCall).toBeTruthy();
    const [, options] = loginCall!;
    expect(options?.headers).toMatchObject({ "x-csrf-token": "test-csrf" });
    expect(JSON.parse(options!.body as string)).toEqual({ email: "wrong@example.com", password: "wrong-password" });
  });
});
