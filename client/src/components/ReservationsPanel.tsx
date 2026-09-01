/**
 * Stock held by draft invoices (P2-1 UI).
 *
 * WHY THIS NEEDS A SCREEN AT ALL
 *
 * Reservations are invisible by design — the goods never move. So when a sale
 * is refused for a shelf that visibly holds 50 units, the only explanation is
 * "8 are reserved", and until now there was nowhere to go and see by whom.
 * A rule nobody can inspect looks like a bug.
 *
 * Every hold here belongs to a draft invoice. There is deliberately no way to
 * create one by hand: a free-floating "reserve 5 of these" with nothing behind
 * it is a hold nobody remembers to release, and stock that quietly stops being
 * sellable for no recorded reason is worse than no reservations at all.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { invNumber } from "../lib/types";
import { formatQty } from "../lib/format";
import { ErrorAlert, cardClass, SectionTitle } from "./ui";

type Reservation = {
  id: string;
  quantity: string;
  status: "ACTIVE" | "CONSUMED" | "RELEASED";
  createdAt: string;
  expiresAt: string | null;
  product: { id: string; sku: string; name: string; unit: string };
  location: { id: string; name: string };
  createdBy: { id: string; name: string };
  /** The invoice holding it — null if the source can't be resolved. */
  source: {
    id: string;
    number: number;
    customerName: string;
    status: string;
  } | null;
};
type ListResponse = { items: Reservation[]; total: number };

export function ReservationsPanel() {
  const [items, setItems] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    // ACTIVE only — the question people ask is "what is being held right now",
    // not "everything ever held".
    api<ListResponse>("/reservations")
      .then((d) => setItems(d.items))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  // Nothing held is the normal state — a permanently empty card would just be
  // furniture, so the whole section hides itself.
  if (!loading && !error && items.length === 0) return null;

  return (
    <div className="space-y-3">
      <SectionTitle>
        Stock held by drafts{" "}
        <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
          ({items.length})
        </span>
      </SectionTitle>

      <p className="text-sm font-semibold text-[var(--muted)]">
        These units are still on the shelf and still yours — they're just
        already promised to a draft invoice, so they can't be sold to anyone
        else. Issuing the invoice takes them; cancelling it releases them.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          Loading…
        </div>
      ) : (
        <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
          {items.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <div className="min-w-0">
                <div className="text-sm font-bold text-[var(--text)]">
                  {r.product.name}
                  <span className="ml-2 text-xs font-semibold text-[var(--muted)]">
                    {r.product.sku} · {r.location.name}
                  </span>
                </div>
                <div className="text-xs font-semibold text-[var(--muted)]">
                  {/* Naming the holder is the entire point — "5 units are
                      reserved" without saying by what is a mystery, not an
                      explanation. */}
                  {r.source ? (
                    <>
                      Held by{" "}
                      <Link
                        to={`/invoices/${r.source.id}`}
                        className="text-[var(--accent)] hover:underline"
                      >
                        {invNumber(r.source.number)}
                      </Link>{" "}
                      · {r.source.customerName}
                    </>
                  ) : (
                    "Held by a removed document"
                  )}
                  {" · since "}
                  {new Date(r.createdAt).toLocaleDateString()}
                </div>
              </div>

              <span className="rounded-[4px] border-2 border-[var(--line)] bg-[#3b82f6] px-2 py-0.5 text-sm font-black text-white">
                {formatQty(r.quantity, r.product.unit)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
