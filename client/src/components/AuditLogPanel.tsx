/**
 * The RECORDED audit log (P2-6 UI).
 *
 * Distinct from the activity feed it sits beside, and the difference is the
 * point. That feed INFERS history from tables that carry timestamps — it works
 * retroactively, but it can only see what still exists, in its current state.
 * It will show you a product priced at ₹500. It cannot tell you the price was
 * ₹50 last Tuesday, who changed it, or that anything changed at all.
 *
 * This log records events as they happen, including the ones that leave no
 * trace anywhere else: sign-ins, FAILED sign-ins, permission changes, price
 * edits, cancellations. A failed sign-in alters no row in the system — which
 * is exactly why a burst of them, the clearest sign of an attack in progress,
 * used to be invisible.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Select, ErrorAlert, cardClass, SectionTitle } from "./ui";

type AuditEntry = {
  id: string;
  at: string;
  action: string;
  entity: string;
  entityId: string | null;
  summary: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ipAddress: string | null;
  actor: { id: string | null; name: string; email: string } | null;
};
type LogResponse = { items: AuditEntry[]; total: number };

/** Plain-language labels — "user.role_change" is not for reading. */
const ACTION_LABELS: Record<string, string> = {
  login: "Signed in",
  "login.failed": "Failed sign-in",
  logout: "Signed out",
  "password.change": "Password changed",
  "session.revoke": "Session ended",
  "user.create": "Member added",
  "user.role_change": "Role changed",
  "user.deactivate": "Member deactivated",
  "user.reactivate": "Member reactivated",
  "product.create": "Product created",
  "product.update": "Product changed",
  "product.deactivate": "Product retired",
  "supplier.update": "Supplier changed",
  "customer.update": "Customer changed",
  "company.update": "Company settings changed",
  "invoice.issue": "Invoice issued",
  "invoice.cancel": "Invoice cancelled",
  "payment.record": "Payment recorded",
  "return.approve": "Return approved",
  "return.refund": "Refund recorded",
  "po.receive": "Goods received",
  "supplier_return.send": "Returned to supplier",
  "stock.reclassify": "Stock condition changed",
  "stock_count.complete": "Stock count applied",
};

/** Red for the security events; the rest by area. */
const ACTION_COLOR = (action: string): string => {
  if (action === "login.failed") return "#ef4444";
  if (action.startsWith("login") || action.startsWith("password") || action.startsWith("session"))
    return "#0ea5e9";
  if (action.startsWith("user.")) return "#ec4899";
  if (action.startsWith("invoice") || action.startsWith("payment")) return "#eab308";
  if (action.startsWith("stock")) return "#f59e0b";
  return "#64748b";
};

const FILTERS: { value: string; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "login.failed", label: "Failed sign-ins" },
  { value: "login", label: "Sign-ins" },
  { value: "user.role_change", label: "Role changes" },
  { value: "product.update", label: "Product changes" },
  { value: "payment.record", label: "Payments" },
  { value: "invoice.cancel", label: "Cancellations" },
  { value: "stock.reclassify", label: "Stock conditions" },
];

/** "sellingPrice" → "selling price" */
function humanField(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (c) => c.toUpperCase())
    .toLowerCase();
}

/**
 * Render the change itself.
 *
 * Only the fields that actually differ are stored, so this is short by
 * construction — "selling price: 20 → 500" rather than a wall of unchanged
 * columns for a reader to diff by eye.
 */
function ChangeDetail({ entry }: { entry: AuditEntry }) {
  const after = entry.after ?? {};
  const before = entry.before ?? {};
  const keys = Object.keys(after);
  if (keys.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
      {keys.map((k) => (
        <span key={k} className="text-xs font-semibold">
          <span className="text-[var(--muted)]">{humanField(k)}: </span>
          {k in before && before[k] !== null && (
            <>
              <span className="text-red-500 line-through">
                {String(before[k])}
              </span>
              <span className="text-[var(--muted)]"> → </span>
            </>
          )}
          <span className="text-emerald-600">{String(after[k])}</span>
        </span>
      ))}
    </div>
  );
}

export function AuditLogPanel() {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = action ? `?action=${encodeURIComponent(action)}` : "";
    api<LogResponse>(`/audit/log${qs}`)
      .then((d) => {
        setItems(d.items);
        setTotal(d.total);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [action]);

  useEffect(load, [load]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>
          Recorded actions{" "}
          <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
            ({total})
          </span>
        </SectionTitle>
        <Select value={action} onChange={(e) => setAction(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </Select>
      </div>

      <p className="text-sm font-semibold text-[var(--muted)]">
        Actions recorded as they happen, with the old and new values where a
        change makes that meaningful. The activity feed below is different —
        it's reconstructed from existing records, so it reaches further back but
        can't show what something used to be.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          Loading…
        </div>
      ) : items.length === 0 ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          Nothing recorded yet.
        </div>
      ) : (
        <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
          {items.map((e) => (
            <div key={e.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
                  style={{ background: ACTION_COLOR(e.action) }}
                >
                  {ACTION_LABELS[e.action] ?? e.action}
                </span>
                <span className="text-sm font-bold text-[var(--text)]">
                  {e.summary ?? e.entity}
                </span>
              </div>

              <ChangeDetail entry={e} />

              <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
                {/* A failed sign-in has no user — the attempted email is shown
                    instead, or the row records that somebody failed, which
                    helps nobody. */}
                {e.actor?.name ?? "unknown"}
                {e.ipAddress ? ` · ${e.ipAddress}` : ""}
                {" · "}
                {new Date(e.at).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
