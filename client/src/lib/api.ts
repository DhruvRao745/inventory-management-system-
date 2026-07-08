/**
 * The one messenger between React and our Express API.
 *
 * Every request goes through here, so in ONE place we:
 * - prefix "/api" (Vite proxies it to the server)
 * - attach the badge (token) if we have one
 * - turn error responses into a proper ApiError with the server's message
 */

const TOKEN_KEY = "inventory_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const token = getToken();

  const res = await fetch(`/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // 204 = "done, nothing to say" (e.g. DELETE) — no JSON to parse
  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? "Something went wrong");
  }

  return data as T;
}
