/**
 * Purchase Orders — list of what we're buying. Phase 2 of Suppliers & POs.
 * Rows link to the detail/edit view; ADMIN/MANAGER can start a new one.
 */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { type PurchaseOrderRow, type POStatus, poNumber } from "../lib/types";
import { formatMoney } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Select,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";

type ListResponse = {
  items: PurchaseOrderRow[];
  total: number;
};

// Status → neubrutalist pill colors (shared shape with the detail page).
export const PO_STATUS_COLORS: Record<POStatus, string> = {
  DRAFT: "#9a9ba3",
  ORDERED: "#3b82f6",
  PARTIAL: "#f59e0b",
  RECEIVED: "#10b981",
  CANCELLED: "#ef4444",
};

export function StatusPill({ status }: { status: POStatus }) {
  return (
    <span
      className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
      style={{ background: PO_STATUS_COLORS[status] }}
    >
      {status}
    </span>
  );
}

const STATUS_FILTERS: (POStatus | "")[] = [
  "",
  "DRAFT",
  "ORDERED",
  "PARTIAL",
  "RECEIVED",
  "CANCELLED",
];

export function PurchaseOrdersPage() {
  const { user: me, company } = useAuth();
  const canEdit = me?.role === "ADMIN" || me?.role === "MANAGER";
  const currency = company?.currency;

  const [rows, setRows] = useState<PurchaseOrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<POStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A PO-reference link elsewhere (e.g. stock history) lands here as ?number=N.
  const [searchParams, setSearchParams] = useSearchParams();
  const numberFilter = searchParams.get("number");

  async function load(s: POStatus | "") {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (s) params.set("status", s);
      if (numberFilter) params.set("number", numberFilter);
      const qs = params.toString();
      const data = await api<ListResponse>(
        `/purchase-orders${qs ? `?${qs}` : ""}`
      );
      setRows(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, numberFilter]);

  function clearNumberFilter() {
    const next = new URLSearchParams(searchParams);
    next.delete("number");
    setSearchParams(next);
  }

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>
          Purchase orders{" "}
          <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
            ({total})
          </span>
        </SectionTitle>
        <div className="flex items-center gap-3">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as POStatus | "")}
            className="w-40"
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s || "all"} value={s}>
                {s || "All statuses"}
              </option>
            ))}
          </Select>
          {canEdit && (
            <Link
              to="/purchase-orders/new"
              className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--btn)] px-4 py-2 text-sm font-semibold text-[var(--btn-text)] shadow-[4px_4px_0px_var(--shadow)] transition-all duration-100 hover:brightness-90 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
            >
              + New PO
            </Link>
          )}
        </div>
      </div>

      {numberFilter && (
        <div className="flex items-center gap-2 text-sm font-bold text-[var(--muted)]">
          Showing PO-{numberFilter.padStart(4, "0")}
          <button
            onClick={clearNumberFilter}
            className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-xs font-black text-[var(--muted)] hover:text-[var(--accent)]"
          >
            clear ✕
          </button>
        </div>
      )}

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>
      ) : rows.length === 0 ? (
        <div className={`${cardClass} p-8 text-center`}>
          <div className="text-lg font-black text-[var(--text)]">
            {status ? `No ${status.toLowerCase()} orders` : "No purchase orders yet"}
          </div>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            {canEdit
              ? "Create one to start tracking what you've ordered from suppliers."
              : "Ask an admin or manager to create one."}
          </p>
        </div>
      ) : (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                <th className="px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                  PO
                </th>
                <th className="px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                  Supplier
                </th>
                <th className="px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                  Status
                </th>
                <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                  Items
                </th>
                <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                  Total
                </th>
                <th className="px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y-2 divide-[var(--line)]/20">
              {rows.map((po) => (
                <tr
                  key={po.id}
                  className="cursor-pointer hover:bg-[var(--hover)]"
                >
                  <td className="px-4 py-3 text-sm font-black text-[var(--text)]">
                    <Link to={`/purchase-orders/${po.id}`} className="block">
                      {poNumber(po.number)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm font-bold text-[var(--text)]">
                    <Link to={`/purchase-orders/${po.id}`} className="block">
                      {po.supplier.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusPill status={po.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--muted)]">
                    {po.itemCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-black text-[var(--text)]">
                    {formatMoney(po.totalCost, currency)}
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-[var(--muted)]">
                    {new Date(po.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
