/**
 * Batches — which physical lots are on the shelf, and when they expire (P1-1).
 *
 * The ledger says "200 units". This says "100 expiring in September and 100 in
 * December", which is the difference between knowing your stock and knowing
 * what's about to become worthless.
 *
 * Rows are ordered by expiry, nearest first — the same order FEFO consumes
 * them in, so the top of this list is literally what goes out next.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { InventoryBatch, Product, Location } from "../lib/types";
import { formatMoney, formatQty } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { Select, ErrorAlert, cardClass, SectionTitle } from "../components/ui";

type ListResponse = { items: InventoryBatch[]; total: number };

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

/** How many days until a date — negative if it's already gone. */
function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.floor(ms / 86_400_000);
}

/**
 * Colour by urgency, not by an arbitrary scale: already expired is a loss
 * that's happened; a week out is something you can still act on.
 */
function expiryTone(days: number): { bg: string; label: string } {
  if (days < 0) return { bg: "#ef4444", label: `Expired ${-days}d ago` };
  if (days <= 7) return { bg: "#f97316", label: `${days}d left` };
  if (days <= 30) return { bg: "#f59e0b", label: `${days}d left` };
  return { bg: "#10b981", label: `${days}d left` };
}

const WINDOWS = [
  { value: "", label: "All batches" },
  { value: "7", label: "Expiring in 7 days" },
  { value: "30", label: "Expiring in 30 days" },
  { value: "90", label: "Expiring in 90 days" },
];

export function BatchesPage() {
  const { company } = useAuth();
  const currency = company?.currency;

  const [rows, setRows] = useState<InventoryBatch[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [productId, setProductId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [expiringInDays, setExpiringInDays] = useState("");
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only batch-tracked products can have lots, so don't offer the rest.
    api<{ items: Product[] }>("/products?take=100")
      .then((d) => setProducts(d.items.filter((p) => p.tracksBatch)))
      .catch(() => setProducts([]));
    api<Location[]>("/locations")
      .then(setLocations)
      .catch(() => setLocations([]));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = new URLSearchParams();
    if (productId) qs.set("productId", productId);
    if (locationId) qs.set("locationId", locationId);
    if (expiringInDays) qs.set("expiringInDays", expiringInDays);
    if (includeEmpty) qs.set("includeEmpty", "true");

    api<ListResponse>(`/stock/batches?${qs.toString()}`)
      .then((d) => setRows(d.items))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [productId, locationId, expiringInDays, includeEmpty]);

  useEffect(load, [load]);

  const totalValue = rows.reduce(
    (s, b) => s + Number(b.remainingQuantity) * Number(b.unitCost),
    0
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Batches</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value="">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
          <Select
            value={expiringInDays}
            onChange={(e) => setExpiringInDays(e.target.value)}
          >
            {WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
            <input
              type="checkbox"
              checked={includeEmpty}
              onChange={(e) => setIncludeEmpty(e.target.checked)}
            />
            Show used-up lots
          </label>
        </div>
      </div>

      <p className="text-sm font-semibold text-[var(--muted)]">
        Nearest expiry first — the same order stock is consumed in, so the top
        of this list is what goes out next.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {products.length === 0 && !loading && (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          No products are batch-tracked yet. Turn on{" "}
          <span className="text-[var(--text)]">Track batches</span> on a product
          to start recording lots and expiry dates.
        </div>
      )}

      {loading ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        products.length > 0 && (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No batches match those filters.
          </div>
        )
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className={`${cardClass} p-4`}>
              <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                Lots
              </div>
              <div className="mt-1 text-2xl font-black text-[var(--text)]">
                {rows.length}
              </div>
            </div>
            <div className={`${cardClass} p-4`}>
              <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                Expiring in 30 days
              </div>
              <div className="mt-1 text-2xl font-black text-amber-500">
                {
                  rows.filter(
                    (b) => b.expiryDate && daysUntil(b.expiryDate) <= 30
                  ).length
                }
              </div>
            </div>
            <div className={`${cardClass} p-4`}>
              <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                Value at cost
              </div>
              <div className="mt-1 text-2xl font-black text-[var(--accent)]">
                {formatMoney(totalValue, currency, 0)}
              </div>
            </div>
          </div>

          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className={th}>Product</th>
                  <th className={th}>Batch</th>
                  <th className={th}>Location</th>
                  <th className={th}>Expiry</th>
                  <th className={`${th} text-right`}>Remaining</th>
                  <th className={`${th} text-right`}>Received</th>
                  <th className={`${th} text-right`}>Unit cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => {
                  const days = b.expiryDate ? daysUntil(b.expiryDate) : null;
                  const tone = days === null ? null : expiryTone(days);
                  return (
                    <tr
                      key={b.id}
                      className="border-b border-[var(--line)] last:border-0"
                    >
                      <td className={`${td} font-bold text-[var(--text)]`}>
                        <Link
                          to={`/products/${b.product.id}`}
                          className="hover:text-[var(--accent)]"
                        >
                          {b.product.name}
                        </Link>
                        <span className="ml-2 text-xs font-semibold text-[var(--muted)]">
                          {b.product.sku}
                        </span>
                      </td>
                      <td className={`${td} font-black text-[var(--text)]`}>
                        {b.batchNumber}
                      </td>
                      <td className={`${td} font-semibold text-[var(--muted)]`}>
                        {b.location.name}
                      </td>
                      <td className={td}>
                        {b.expiryDate && tone ? (
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-[var(--text)]">
                              {new Date(b.expiryDate).toLocaleDateString()}
                            </span>
                            <span
                              className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black text-white"
                              style={{ background: tone.bg }}
                            >
                              {tone.label}
                            </span>
                          </div>
                        ) : (
                          <span className="font-semibold text-[var(--muted)]">
                            Doesn&rsquo;t expire
                          </span>
                        )}
                      </td>
                      <td
                        className={`${td} text-right font-black ${
                          Number(b.remainingQuantity) === 0
                            ? "text-[var(--muted)]"
                            : "text-[var(--text)]"
                        }`}
                      >
                        {formatQty(b.remainingQuantity, b.product.unit)}
                      </td>
                      <td className={`${td} text-right font-semibold text-[var(--muted)]`}>
                        {formatQty(b.receivedQuantity)}
                      </td>
                      <td className={`${td} text-right font-semibold text-[var(--muted)]`}>
                        {formatMoney(Number(b.unitCost), currency)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
