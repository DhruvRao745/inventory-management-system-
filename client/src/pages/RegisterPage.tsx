/**
 * Company signup — same neubrutalist card as login, four fields.
 */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { Button, Input, ErrorAlert, Logo } from "../components/ui";

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
    <div className="min-h-screen bg-[#f4f4f4] bg-[radial-gradient(#32323226_1.5px,transparent_1.5px)] bg-[size:18px_18px]">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-10 p-6 lg:flex-row lg:gap-20">
        {/* Brand side */}
        <div className="flex max-w-md flex-col items-start gap-6">
          <div className="flex items-center gap-3">
            <Logo size={44} />
            <span className="text-3xl font-black tracking-tight text-[#323232]">
              StockPilot
            </span>
          </div>

          <h1 className="text-4xl font-black leading-tight text-[#323232]">
            Your shop,
            <br />
            <span className="bg-[#2d8cf0] px-2 text-white shadow-[4px_4px_0px_#323232]">
              set up in minutes.
            </span>
          </h1>

          <ul className="space-y-2 font-semibold text-[#666]">
            <li>✓ Unlimited products &amp; locations</li>
            <li>✓ Team roles — admin, manager, staff</li>
            <li>✓ Complete audit trail, from day one</li>
          </ul>
        </div>

        <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-xs flex-col gap-5 rounded-[5px] border-2 border-[#323232] bg-[#d3d3d3] p-6 shadow-[4px_4px_0px_#323232]"
      >
        <div className="mb-2">
          <div className="text-xl font-black text-[#323232]">Welcome,</div>
          <div className="text-base font-semibold text-[#666]">
            sign up to continue
          </div>
        </div>

        <Input
          required
          minLength={2}
          placeholder="Company name"
          value={companyName}
          onChange={(e) => setCompanyName(e.target.value)}
        />
        <Input
          required
          minLength={2}
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          type="email"
          required
          autoComplete="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="Password (min. 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        {error && <ErrorAlert>{error}</ErrorAlert>}

          <Button
            type="submit"
            variant="secondary"
            disabled={busy}
            className="mx-auto mt-4 w-36"
          >
            {busy ? "Creating…" : "Let's go →"}
          </Button>

          <p className="text-center text-sm font-semibold text-[#666]">
            Already registered?{" "}
            <Link to="/login" className="text-[#2d8cf0] underline">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
