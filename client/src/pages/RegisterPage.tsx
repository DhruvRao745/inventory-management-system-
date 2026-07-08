/**
 * Company signup — same pattern as LoginPage, four fields instead of two.
 */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";

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

  const inputClass =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-slate-800">Create your company</h1>
        <p className="text-slate-500 mt-1 text-sm">
          You'll be the admin of this workspace
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              Company name
            </label>
            <input
              required
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              Your name
            </label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              Password
            </label>
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-slate-900 text-white py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create company"}
          </button>
        </form>

        <p className="mt-4 text-sm text-slate-500">
          Already registered?{" "}
          <Link to="/login" className="text-slate-900 font-medium underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
