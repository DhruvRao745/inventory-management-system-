/**
 * Login — adapted split layout (see AuthLayout). Logic unchanged.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { Button, Input, ErrorAlert } from "../components/ui";
import { AuthLayout, NotchField } from "../components/AuthLayout";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your company workspace"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        <NotchField label="Email">
          <Input
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </NotchField>
        <NotchField label="Password">
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              required
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="pr-10"
            />
            {/* the visibility eye — kindness for phone keyboards */}
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              title={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--muted)] hover:text-[var(--text)]"
            >
              {showPassword ? "🙈" : "👁"}
            </button>
          </div>
        </NotchField>

        {error && <ErrorAlert>{error}</ErrorAlert>}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in →"}
        </Button>

        {/* Demo box — one click fills the form (adapted from the HRMS ref) */}
        <button
          type="button"
          onClick={() => {
            setEmail("demo@demo.com");
            setPassword("demo1234");
          }}
          className="w-full rounded-[5px] border-2 border-dashed border-[var(--line)] bg-[var(--accent)]/8 px-4 py-3 text-left transition-colors hover:bg-[var(--accent)]/15"
        >
          <div className="text-[10px] font-black uppercase tracking-wide text-[var(--muted)]">
            Just exploring?
          </div>
          <div className="mt-0.5 text-sm font-bold text-[var(--text)]">
            Try the demo shop{" "}
            <span className="font-semibold text-[var(--muted)]">
              — click to fill, then sign in
            </span>
          </div>
        </button>
      </form>
    </AuthLayout>
  );
}
