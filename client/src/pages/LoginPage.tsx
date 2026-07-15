/**
 * Login — neubrutalist card, straight from the user's chosen design:
 * lightgrey panel, hard borders, offset shadows, press-down button.
 */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";
import { Button, Input, ErrorAlert, Logo } from "../components/ui";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    // dot-grid background: the classic neubrutalist "graph paper" stage
    <div className="min-h-screen bg-[#f4f4f4] bg-[radial-gradient(#32323226_1.5px,transparent_1.5px)] bg-[size:18px_18px]">
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-10 p-6 lg:flex-row lg:gap-20">
        {/* Brand side — big type and sticker chips fill the stage */}
        <div className="flex max-w-md flex-col items-start gap-6">
          <div className="flex items-center gap-3">
            <Logo size={44} />
            <span className="text-3xl font-black tracking-tight text-[#323232]">
              StockPilot
            </span>
          </div>

          <h1 className="text-4xl font-black leading-tight text-[#323232]">
            Every unit,
            <br />
            <span className="bg-[#2d8cf0] px-2 text-white shadow-[4px_4px_0px_#323232]">
              accounted for.
            </span>
          </h1>

          <p className="font-semibold text-[#666]">
            Track stock across locations with a tamper-proof record of every
            movement — who, what, when.
          </p>

          {/* sticker chips */}
          <div className="flex flex-wrap gap-3">
            {["📦 Multi-location", "🧾 Audit trail", "👥 Team roles"].map(
              (chip) => (
                <span
                  key={chip}
                  className="rounded-[5px] border-2 border-[#323232] bg-white px-3 py-1.5 text-sm font-bold text-[#323232] shadow-[4px_4px_0px_#323232]"
                >
                  {chip}
                </span>
              )
            )}
          </div>
        </div>

        <form
        onSubmit={handleSubmit}
        className="flex w-full max-w-xs flex-col gap-5 rounded-[5px] border-2 border-[#323232] bg-[#d3d3d3] p-6 shadow-[4px_4px_0px_#323232]"
      >
        <div className="mb-2">
          <div className="text-xl font-black text-[#323232]">Welcome,</div>
          <div className="text-base font-semibold text-[#666]">
            sign in to continue
          </div>
        </div>

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
          autoComplete="current-password"
          placeholder="Password"
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
            {busy ? "Signing in…" : "Let's go →"}
          </Button>

          <p className="text-center text-sm font-semibold text-[#666]">
            New company?{" "}
            <Link to="/register" className="text-[#2d8cf0] underline">
              Create a workspace
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
