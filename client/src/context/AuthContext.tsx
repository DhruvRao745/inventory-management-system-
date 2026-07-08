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
import { api, getToken, setToken } from "../lib/api";

export type User = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "STAFF";
  companyId: string;
};
export type Company = { id: string; name: string };

type AuthResponse = { token: string; user: User; company: Company };
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
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [company, setCompany] = useState<Company | null>(null);
  const [loading, setLoading] = useState(true);

  // On app start: if a token is stored, try to restore the session
  useEffect(() => {
    if (!getToken()) {
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
    setUser(data.user);
    setCompany(data.company);
  }

  function logout() {
    setToken(null);
    setUser(null);
    setCompany(null);
  }

  return (
    <AuthContext.Provider
      value={{ user, company, loading, login, register, logout }}
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
