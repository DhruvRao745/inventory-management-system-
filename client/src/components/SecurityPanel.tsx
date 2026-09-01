/**
 * Sessions and password — the security section of Settings (P2-5 UI).
 *
 * WHY THIS SCREEN MATTERS MORE THAN IT LOOKS
 *
 * Until P2-5 a "session" was a signed token nobody kept track of. Logging out
 * cleared the browser's copy and left the token itself valid for thirty days,
 * so anyone holding another copy — from a shared machine, a browser backup, a
 * proxy log — could carry on. There was no list to look at and nothing to
 * revoke.
 *
 * This is the screen that makes that fix usable: see where you are signed in,
 * end any of it, and change a password knowing it actually locks other people
 * out rather than just changing what you type next time.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, getRefreshToken } from "../lib/api";
import {
  Button,
  Input,
  Field,
  ErrorAlert,
  SuccessAlert,
  cardClass,
  SectionTitle,
} from "./ui";
import { ConfirmModal } from "./ConfirmModal";

type Session = {
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** True for the device you're reading this on. */
  current: boolean;
};

/**
 * Turn a User-Agent into something a person recognises.
 *
 * Best-effort and deliberately shallow: a User-Agent is set by the client and
 * can say anything, so this is a memory aid ("was that me on Chrome?"), never
 * evidence. Nothing here is used for a security decision.
 */
function describeDevice(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : /Firefox\//.test(ua) ? "Firefox"
    : "Browser";
  const os =
    /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Mac OS X/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "";
  return os ? `${browser} on ${os}` : browser;
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function SecurityPanel() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  // --- password change ---
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwOk, setPwOk] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // The refresh token lets the server mark which row is THIS device.
    // Without it every row looks alike and there's no way to tell which one
    // is safe to end.
    const token = getRefreshToken();
    const qs = token ? `?refreshToken=${encodeURIComponent(token)}` : "";
    api<Session[]>(`/auth/sessions${qs}`)
      .then(setSessions)
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function endSession(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/auth/sessions/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not end session");
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    setBusy("all");
    setError(null);
    try {
      await api("/auth/sessions/revoke-others", {
        method: "POST",
        // Sent so the server keeps THIS session alive. Signing yourself out
        // while pressing "sign out other devices" would be a strange result.
        body: { refreshToken: getRefreshToken() ?? undefined },
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign out");
    } finally {
      setBusy(null);
      setConfirmRevokeAll(false);
    }
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwOk(null);

    if (newPassword !== confirmPassword) {
      setPwError("The two new passwords don't match");
      return;
    }
    if (newPassword.length < 8) {
      setPwError("Use at least 8 characters");
      return;
    }

    setPwBusy(true);
    try {
      const res = await api<{ revokedSessions: number }>(
        "/auth/change-password",
        {
          method: "POST",
          body: {
            currentPassword,
            newPassword,
            // Keeps this device signed in; every other one is ended.
            refreshToken: getRefreshToken() ?? undefined,
          },
        }
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPwOk(
        res.revokedSessions > 0
          ? `Password changed. ${res.revokedSessions} other device${
              res.revokedSessions === 1 ? " was" : "s were"
            } signed out.`
          : "Password changed."
      );
      load();
    } catch (err) {
      setPwError(err instanceof ApiError ? err.message : "Could not change it");
    } finally {
      setPwBusy(false);
    }
  }

  const others = sessions.filter((s) => !s.current).length;

  return (
    <div className="space-y-8">
      {/* ---------- Devices ---------- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionTitle>Signed-in devices</SectionTitle>
          {others > 0 && (
            <Button
              variant="danger"
              onClick={() => setConfirmRevokeAll(true)}
              disabled={busy === "all"}
            >
              Sign out {others} other device{others === 1 ? "" : "s"}
            </Button>
          )}
        </div>

        <p className="text-sm font-semibold text-[var(--muted)]">
          Signing out here ends the session <strong>on the server</strong>, so
          the device can't renew itself and is locked out for good.
        </p>
        {/* Said plainly, because the alternative is someone signing out a
            device, watching it keep working for a few minutes, and concluding
            the button is broken. It isn't — the sign-out kills the RENEWAL
            token, and the device's current pass simply runs out on its own. */}
        <p className="text-xs font-semibold text-[var(--muted)]">
          It can take up to <strong>15 minutes</strong> to take effect on the
          other device. Sessions renew every 15 minutes; ending one stops the
          next renewal rather than cutting the current one off mid-request.
        </p>

        {error && <ErrorAlert>{error}</ErrorAlert>}

        {loading ? (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No active sessions.
          </div>
        ) : (
          <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
            {sessions.map((s) => (
              <div
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-[var(--text)]">
                      {describeDevice(s.userAgent)}
                    </span>
                    {s.current && (
                      <span className="rounded-[4px] border-2 border-[var(--line)] bg-emerald-500 px-1.5 py-0.5 text-[10px] font-black text-white">
                        THIS DEVICE
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-semibold text-[var(--muted)]">
                    {s.ipAddress ?? "unknown IP"} · last used {timeAgo(s.lastUsedAt)}
                    {" · signed in "}
                    {new Date(s.createdAt).toLocaleDateString()}
                  </div>
                </div>

                {!s.current && (
                  <button
                    type="button"
                    onClick={() => endSession(s.id)}
                    disabled={busy === s.id}
                    className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--card)] px-2 py-1 text-xs font-bold text-red-500 hover:bg-red-500 hover:text-white disabled:opacity-40"
                  >
                    {busy === s.id ? "…" : "Sign out"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- Password ---------- */}
      <div className="space-y-3">
        <SectionTitle>Change password</SectionTitle>
        <form onSubmit={changePassword} className={`${cardClass} space-y-4 p-5`}>
          {pwError && <ErrorAlert>{pwError}</ErrorAlert>}
          {pwOk && <SuccessAlert>{pwOk}</SuccessAlert>}

          <Field label="Current password">
            <Input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="New password" hint="at least 8 characters">
              <Input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
            <Field label="Repeat new password">
              <Input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </Field>
          </div>

          <p className="text-xs font-semibold text-[var(--muted)]">
            Every other device is signed out when you do this. That's the point
            rather than a side effect — people usually change a password because
            they think someone else has access, and leaving that someone signed
            in would defeat the exercise.
          </p>

          <div className="flex justify-end">
            <Button type="submit" disabled={pwBusy || !currentPassword}>
              {pwBusy ? "Changing…" : "Change password"}
            </Button>
          </div>
        </form>
      </div>

      {confirmRevokeAll && (
        <ConfirmModal
          title="Sign out other devices?"
          message={`This ends ${others} other session${
            others === 1 ? "" : "s"
          }. Anyone using them will have to sign in again. You'll stay signed in here.`}
          confirmLabel="Sign them out"
          danger
          onConfirm={revokeOthers}
          onClose={() => setConfirmRevokeAll(false)}
        />
      )}
    </div>
  );
}
