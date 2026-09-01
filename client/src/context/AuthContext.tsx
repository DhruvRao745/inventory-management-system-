/**
 * The shared pocket: who is logged in?
 *
 * Wrap the whole app in <AuthProvider>, then any component can call
 * useAuth() to read the user or trigger login/logout.
 *
 * On page refresh the React state is wiped, but the token survives in
 * localStorage — so on mount we ask the server "who am I?" (/auth/me)
 * to restore the session.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  getToken,
  setToken,
  setRefreshToken,
  getRefreshToken,
} from "../lib/api";

export type User = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "STAFF";
  companyId: string;
};
export type Company = {
  id: string;
  name: string;
  currency: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  pan: string | null;
  /** GST state code (P2-3). Decides CGST+SGST vs IGST on every invoice. */
  stateCode: string | null;
  sealText: string | null;
  invoiceTerms: string | null;
};

type AuthResponse = {
  token: string;
  refreshToken: string;
  user: User;
  company: Company;
};
type MeResponse = { user: User; company: Company };

type AuthContextValue = {
  user: User | null;
  company: Company | null;
  loading: boolean; // true while we check the stored token on startup
  login: (email: string, password: string) => Promise<void>;
  register: (input: {
    companyName: string;
    name: string;
    email: string;
    password: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-fetch user+company after settings change (e.g. rename, currency) */
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  // On app start: if any token is stored, try to restore the session
  // (api() will quietly renew the day pass if it has expired)
  useEffect(() => {
    if (!getToken() && !getRefreshToken()) {
      setLoading(false);
      return;
    }
    api<MeResponse>("/auth/me")
      .then((data) => {
        setUser(data.user);
        setCompany(data.company);
      })
      .catch(() => setToken(null)) // stale/expired token — forget it
      .finally(() => setLoading(false));
  }, []);

  async function login(email: string, password: string) {
    const data = await api<AuthResponse>("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    setToken(data.token);
    setRefreshToken(data.refreshToken);
    setUser(data.user);
    setCompany(data.company);
  }

  async function register(input: {
    companyName: string;
    name: string;
    email: string;
    password: string;
  }) {
    const data = await api<AuthResponse>("/auth/register", {
      method: "POST",
      body: input,
    });
    setToken(data.token);
    setRefreshToken(data.refreshToken);
    setUser(data.user);
    setCompany(data.company);
  }

  /**
   * Log out — server-side since P2-5.
   *
   * Clearing localStorage alone was never a logout. It removed OUR copy of the
   * refresh token and left the token itself valid for thirty days, so anyone
   * holding another copy could keep minting access tokens. Telling the server
   * is what actually ends the session.
   *
   * The local state is cleared regardless of whether that call succeeds. If
   * the network is down, the least useful outcome would be refusing to log the
   * person out of the screen in front of them — the session still expires on
   * its own, and they can revoke it later from the device list.
   */
  async function logout() {
    const refresh = getRefreshToken();
    if (refresh) {
      try {
        await api("/auth/logout", {
          method: "POST",
          body: { refreshToken: refresh },
        });
      } catch {
        /* best effort — never block the user from leaving */
      }
    }
    setToken(null);
    setRefreshToken(null);
    setUser(null);
    setCompany(null);
  }

  async function refreshMe() {
    const data = await api<MeResponse>("/auth/me");
    setUser(data.user);
    setCompany(data.company);
  }

  return (
    <AuthContext.Provider
      value={{ user, company, loading, login, register, logout, refreshMe }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
