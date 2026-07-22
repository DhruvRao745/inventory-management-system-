/**
 * Company signup — adapted split layout (see AuthLayout).
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { Button, Input, ErrorAlert } from "../components/ui";
import { AuthLayout, NotchField } from "../components/AuthLayout";

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register({ companyName, name, email, password });
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="You'll be the admin of this company"
    >
      <form onSubmit={handleSubmit} className="space-y-6">
        <NotchField label="Company name">
          <Input
            required
            minLength={2}
            placeholder="Rao Traders"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
          />
        </NotchField>
        <NotchField label="Your name">
          <Input
            required
            minLength={2}
            placeholder="Dhruv Rao"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </NotchField>
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
          <Input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="min. 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </NotchField>

        {error && <ErrorAlert>{error}</ErrorAlert>}

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating…" : "Create workspace →"}
        </Button>
      </form>
    </AuthLayout>
  );
}
