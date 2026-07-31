/**
 * Customer detail — contact card + every invoice raised for them.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { type Customer, type InvoiceRow, invNumber } from "../lib/types";
import { formatMoney } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { InvoiceStatusPill } from "./InvoicesPage";
import { ErrorAlert, cardClass, SectionTitle } from "../components/ui";

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { company } = useAuth();
  const currency = company?.currency;

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      api<Customer>(`/customers/${id}`),
      api<{ items: InvoiceRow[] }>(`/invoices?customerId=${id}`),
    ])
      .then(([c, inv]) => {
        setCustomer(c);
        setInvoices(inv.items);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [id]);

  if (loading)
    return <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>;
  if (error || !customer)
    return (
      <div className="space-y-4">
        <ErrorAlert>{error ?? "Customer not found"}</ErrorAlert>
        <Link to="/customers" className="text-sm font-bold text-[var(--accent)] underline">
          ← Back to customers
        </Link>
      </div>
    );

  const totalBilled = invoices
    .filter((i) => i.status !== "CANCELLED")
    .reduce((s, i) => s + i.total, 0);

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        to="/customers"
        className="text-sm font-bold text-[var(--muted)] underline hover:text-[var(--text)]"
      >
        ← Back to customers
      </Link>

      <div className={`${cardClass} p-6`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-black tracking-tight text-[var(--text)]">
              {customer.name}
              {!customer.isActive && (
                <span className="ml-2 rounded-[4px] border-2 border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 align-middle text-[10px] font-black tracking-wide text-[var(--muted)]">
                  INACTIVE
                </span>
              )}
            </h1>
            <div className="mt-1 text-sm font-semibold text-[var(--muted)]">
              {[customer.email, customer.phone].filter(Boolean).join(" · ") ||
                "No contact details"}
            </div>
            {customer.address && (
              <div className="text-sm font-semibold text-[var(--muted)]/80">
                {customer.address}
              </div>
            )}
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xl font-black tracking-tight text-[var(--text)]">
              {formatMoney(totalBilled, currency)}
            </div>
            <div className="text-xs font-bold text-[var(--muted)]">
              across {invoices.length} invoice{invoices.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
        {customer.notes && (
          <div className="mt-4 border-t-2 border-[var(--line)]/20 pt-3 text-sm font-medium italic text-[var(--muted)]">
            {customer.notes}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <SectionTitle>Invoices</SectionTitle>
        {invoices.length === 0 ? (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No invoices for this customer yet.
          </div>
        ) : (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className="px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Invoice
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Status
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
                {invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-[var(--hover)]">
                    <td className="px-4 py-3 text-sm font-black text-[var(--text)]">
                      <Link to={`/invoices/${inv.id}`} className="block">
                        {invNumber(inv.number)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <InvoiceStatusPill status={inv.status} />
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
    </div>
  );
}
