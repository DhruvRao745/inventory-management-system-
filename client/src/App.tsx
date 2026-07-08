/**
 * Root component. For now it does one meaningful thing:
 * calls the backend's /api/health endpoint and shows the result.
 *
 * WHY: this proves the whole chain works — React → Vite proxy → Express.
 * If you see "ok" on screen, your full-stack setup is wired correctly.
 */
import { useEffect, useState } from "react";

type HealthResponse = {
  status: string;
  service: string;
  time: string;
};

export default function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`API responded ${res.status}`);
        return res.json();
      })
      .then(setHealth)
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow-md p-8 max-w-md w-full">
        <h1 className="text-2xl font-bold text-slate-800">Inventory</h1>
        <p className="text-slate-500 mt-1">Multi-tenant inventory management</p>

        <div className="mt-6 border-t pt-4">
          <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
            API connection
          </h2>
          {health && (
            <p className="mt-2 text-green-600">
              ● {health.service} — {health.status}
            </p>
          )}
          {error && (
            <p className="mt-2 text-red-600">
              ● Cannot reach API: {error}
              <span className="block text-sm text-slate-500 mt-1">
                Is the server running? Try: npm run dev:server
              </span>
            </p>
          )}
          {!health && !error && (
            <p className="mt-2 text-slate-400">Checking…</p>
          )}
        </div>
      </div>
    </main>
  );
}
