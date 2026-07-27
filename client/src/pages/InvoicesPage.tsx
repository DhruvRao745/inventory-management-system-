/**
 * Invoices — list of customer sales. Issuing an invoice deducts stock, so
 * these are real sales. Rows link to detail; ADMIN/MANAGER can start a new one.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { type InvoiceRow, type InvoiceStatus, invNumber } from "../lib/types";
import { formatMoney } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { Select, ErrorAlert, cardClass, SectionTitle } from "../components/ui";

type ListResponse = { items: InvoiceRow[]; total: number };

export const INVOICE_STATUS_COLORS: Record<InvoiceStatus, string> = {
  DRAFT: "#9a9ba3",
  ISSUED: "#3b82f6",
  PAID: "#10b981",
  CANCELLED: "#ef4444",
};

export function InvoiceStatusPill({ status }: { status: InvoiceStatus }) {
  return (
    <span
      className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
      style={{ background: INVOICE_STATUS_COLORS[status] }}
    >
      {status}
    </span>
  );
}

const STATUS_FILTERS: (InvoiceStatus | "")[] = [
  "",
  "DRAFT",
  "ISSUED",
  "PAID",
  "CANCELLED",
];

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";

export function InvoicesPage() {
  const { user: me, company } = useAuth();
  const canEdit = me?.role === "ADMIN" || me?.role === "MANAGER";
  const currency = company?.currency;

  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const qs = status ? `?status=${status}` : "";
    api<ListResponse>(`/invoices${qs}`)
      .then((data) => {
        setRows(data.items);
        setTotal(data.total);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [status]);

  return (
    <div className="max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>
          Invoices{" "}
          <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
            ({total})
          </span>
        </SectionTitle>
        <div className="flex items-center gap-3">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as InvoiceStatus | "")}
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
              to="/invoices/new"
              className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--btn)] px-4 py-2 text-sm font-semibold text-[var(--btn-text)] shadow-[4px_4px_0px_var(--shadow)] transition-all duration-100 hover:brightness-90 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
            >
              + New invoice
            </Link>
          )}
        </div>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>
      ) : rows.length === 0 ? (
        <div className={`${cardClass} p-8 text-center`}>
          <div className="text-lg font-black text-[var(--text)]">
            {status ? `No ${status.toLowerCase()} invoices` : "No invoices yet"}
          </div>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            {canEdit
              ? "Create one to bill a customer — issuing it deducts stock."
              : "Ask an admin or manager to create one."}
          </p>
        </div>
      ) : (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                <th className={th}>Invoice</th>
                <th className={th}>Customer</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Items</th>
                <th className={`${th} text-right`}>Total</th>
                <th className={th}>Created</th>
              </tr>
            </thead>
            <tbody className="divide-y-2 divide-[var(--line)]/20">
              {rows.map((inv) => (
                <tr key={inv.id} className="cursor-pointer hover:bg-[var(--hover)]">
                  <td className="px-4 py-3 text-sm font-black text-[var(--text)]">
                    <Link to={`/invoices/${inv.id}`} className="block">
                      {invNumber(inv.number)}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm font-bold text-[var(--text)]">
                    <Link to={`/invoices/${inv.id}`} className="block">
                      {inv.customerName}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <InvoiceStatusPill status={inv.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--muted)]">
                    {inv.itemCount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-black text-[var(--text)]">
                    {formatMoney(inv.total, currency)}
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-[var(--muted)]">
                    {new Date(inv.createdAt).toLocaleDateString()}
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
