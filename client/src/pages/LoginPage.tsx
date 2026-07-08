/**
 * Login form. The React pattern to learn here:
 * - each input's value lives in state (useState)
 * - submit calls the API via our auth context
 * - errors from the server are shown to the human, not the console
 */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ApiError } from "../lib/api";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); // stop the browser's old-school full page reload
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      navigate("/"); // success → go to dashboard
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-slate-800">Inventory</h1>
        <p className="text-slate-500 mt-1 text-sm">Sign in to your company</p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
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
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="mt-4 text-sm text-slate-500">
          New company?{" "}
          <Link to="/register" className="text-slate-900 font-medium underline">
            Register here
          </Link>
        </p>
      </div>
    </div>
  );
}
