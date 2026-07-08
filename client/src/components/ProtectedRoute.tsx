/**
 * The frontend's badge checker. Wraps pages that need login:
 * - still checking the stored token? → show a quiet loading screen
 * - not logged in? → send them to /login
 * - logged in? → show the page
 *
 * Honest note: this is for good UX, not security. Real security lives
 * on the server (requireAuth) — anyone can bypass frontend checks with
 * dev tools, but without a valid token the API gives them nothing.
 */
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return <>{children}</>;
}
