/**
 * Hand-written fetch wrapper — no generated client (see ARCHITECTURE.md).
 * Handles credentials, JSON, and the CSRF double-submit header
 * automatically so callers never have to think about it.
 */

let cachedCsrfToken: string | null = null;

async function fetchCsrfToken(): Promise<string> {
  const res = await fetch("/api/app/auth/csrf-token", { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, "Failed to obtain CSRF token.");
  const body = (await res.json()) as { csrfToken: string };
  cachedCsrfToken = body.csrfToken;
  return cachedCsrfToken;
}

export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

async function request<T>(path: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
  const method = options.method ?? "GET";
  const url = new URL(path, window.location.origin);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (MUTATING_METHODS.has(method)) {
    headers["x-csrf-token"] = cachedCsrfToken ?? (await fetchCsrfToken());
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    credentials: "include",
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // A stale/missing CSRF cookie (e.g. first load, or cookie expired) — fetch
  // a fresh token once and retry exactly once, not in a loop.
  if (res.status === 403 && MUTATING_METHODS.has(method) && !isRetry) {
    cachedCsrfToken = null;
    return request<T>(path, options, true);
  }

  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await res.json() : undefined;

  if (!res.ok) {
    throw new ApiError(res.status, (payload as { error?: string })?.error ?? res.statusText, (payload as { details?: unknown })?.details);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions["query"]) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
};
