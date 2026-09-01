/**
 * The one messenger between React and our Express API.
 *
 * Every request goes through here, so in ONE place we:
 * - prefix "/api" (Vite proxies it to the server)
 * - attach the badge (token) if we have one
 * - turn error responses into a proper ApiError with the server's message
 */

const TOKEN_KEY = "inventory_token";
const REFRESH_KEY = "inventory_refresh_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY);
}

export function setRefreshToken(token: string | null) {
  if (token) localStorage.setItem(REFRESH_KEY, token);
  else localStorage.removeItem(REFRESH_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function rawRequest(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const token = getToken();
  return fetch(`/api${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

/**
 * The quiet renewal: trade the renewal card for a fresh day pass.
 * If several requests hit 401 at once, they all wait on the SAME
 * renewal (the `refreshing` promise) instead of racing five renewals.
 */
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = (async () => {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return false;
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        setToken(data.token);

        // CRITICAL since P2-5: refresh tokens ROTATE. The server retires the
        // token we just sent and returns a successor. If we don't store it,
        // the next refresh presents a retired token — which the server reads
        // as a replay, revokes the whole session family, and logs the user out
        // for no reason they could possibly understand.
        if (data.refreshToken) setRefreshToken(data.refreshToken);
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  let res = await rawRequest(path, options);

  // Day pass expired? Renew quietly and retry ONCE.
  // (Never for auth paths themselves — that way lies an infinite loop.)
  if (res.status === 401 && !path.startsWith("/auth/")) {
    const renewed = await tryRefresh();
    if (renewed) {
      res = await rawRequest(path, options);
    } else {
      // renewal card dead too — clean logout
      setToken(null);
      setRefreshToken(null);
      window.location.href = "/login";
    }
  }

  // 204 = "done, nothing to say" (e.g. DELETE) — no JSON to parse
  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? "Something went wrong");
  }

  return data as T;
}
