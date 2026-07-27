/**
 * Supplier detail — one vendor's contact card plus every purchase order
 * we've raised with them. Reuses the PO list endpoint filtered by supplier.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { type Supplier, type PurchaseOrderRow, poNumber } from "../lib/types";
import { formatMoney } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { StatusPill } from "./PurchaseOrdersPage";
import { ErrorAlert, cardClass, SectionTitle } from "../components/ui";

export function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { company } = useAuth();
  const currency = company?.currency;

  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [orders, setOrders] = useState<PurchaseOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      api<Supplier>(`/suppliers/${id}`),
      api<{ items: PurchaseOrderRow[] }>(`/purchase-orders?supplierId=${id}`),
    ])
      .then(([s, pos]) => {
        setSupplier(s);
        setOrders(pos.items);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [id]);

  if (loading)
    return <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>;
  if (error || !supplier)
    return (
      <div className="space-y-4">
        <ErrorAlert>{error ?? "Supplier not found"}</ErrorAlert>
        <Link
          to="/suppliers"
          className="text-sm font-bold text-[var(--accent)] underline"
        >
          ← Back to suppliers
        </Link>
      </div>
    );

  const totalSpend = orders
    .filter((o) => o.status !== "CANCELLED")
    .reduce((s, o) => s + o.totalCost, 0);

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        to="/suppliers"
        className="text-sm font-bold text-[var(--muted)] underline hover:text-[var(--text)]"
      >
        ← Back to suppliers
      </Link>

      {/* Contact card */}
      <div className={`${cardClass} p-6`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-black tracking-tight text-[var(--text)]">
              {supplier.name}
              {!supplier.isActive && (
                <span className="ml-2 rounded-[4px] border-2 border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 align-middle text-[10px] font-black tracking-wide text-[var(--muted)]">
                  INACTIVE
                </span>
              )}
            </h1>
            <div className="mt-1 text-sm font-semibold text-[var(--muted)]">
              {[supplier.email, supplier.phone].filter(Boolean).join(" · ") ||
                "No contact details"}
            </div>
            {supplier.address && (
              <div className="text-sm font-semibold text-[var(--muted)]/80">
                {supplier.address}
              </div>
            )}
          </div>
          <div className="shrink-0 text-right">
            <div className="text-2xl font-black tracking-tight text-[var(--text)]">
              {formatMoney(totalSpend, currency)}
            </div>
            <div className="text-xs font-bold text-[var(--muted)]">
              across {orders.length} order{orders.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>
        {supplier.notes && (
          <div className="mt-4 border-t-2 border-[var(--line)]/20 pt-3 text-sm font-medium italic text-[var(--muted)]">
            {supplier.notes}
          </div>
        )}
      </div>

      {/* Their purchase orders */}
      <div className="space-y-3">
        <SectionTitle>Purchase orders</SectionTitle>
        {orders.length === 0 ? (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No purchase orders with this supplier yet.
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
                {orders.map((po) => (
                  <tr key={po.id} className="hover:bg-[var(--hover)]">
                    <td className="px-4 py-3 text-sm font-black text-[var(--text)]">
                      <Link to={`/purchase-orders/${po.id}`} className="block">
                        {poNumber(po.number)}
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
    </div>
  );
}
