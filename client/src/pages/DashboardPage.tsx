/**
 * Dashboard v2 — analytics edition (layout ideas adapted from the
 * Invendor reference, rendered in our tokens).
 *
 * Rows: stat cards with month-over-month trends → three analytics
 * panels (top sellers, movement breakdown, stock by location) →
 * low-stock alerts + recent activity.
 *
 * All trends are HONEST: computed from the movement ledger by
 * comparing this month's summary with last month's.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { StockLevel, StockMovement } from "../lib/types";
import { formatMoney } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { ErrorAlert, cardClass, SectionTitle } from "../components/ui";
import { TYPE_COLORS, PALETTE, hashColor } from "../lib/colors";

type MovementsResponse = { items: StockMovement[]; total: number };
type SummaryRow = { type: string; movements: number; netQuantity: number };
type TopProduct = {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  unitsSold: number;
};

/* month boundaries as timezone-correct ISO instants */
function monthRange(offset: 0 | -1): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const end =
    offset === 0
      ? now
      : new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  return [start.toISOString(), end.toISOString()];
}

const q = (from: string, to: string) =>
  `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

export function DashboardPage() {
  const { company } = useAuth();
  const [productsTotal, setProductsTotal] = useState(0);
  const [stockValue, setStockValue] = useState(0);
  const [levels, setLevels] = useState<StockLevel[]>([]);
  const [recent, setRecent] = useState<StockMovement[]>([]);
  const [sumThis, setSumThis] = useState<SummaryRow[]>([]);
  const [sumLast, setSumLast] = useState<SummaryRow[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const [thisFrom, thisTo] = monthRange(0);
    const [lastFrom, lastTo] = monthRange(-1);
    Promise.all([
      api<{ total: number }>("/products?take=1"), // only the count
      api<{ totals: { costValue: number } }>("/reports/valuation"),
      api<StockLevel[]>("/stock/levels"),
      api<MovementsResponse>("/stock/movements?take=8"),
      api<SummaryRow[]>(`/reports/summary?${q(thisFrom, thisTo)}`),
      api<SummaryRow[]>(`/reports/summary?${q(lastFrom, lastTo)}`),
      api<TopProduct[]>(`/reports/top-products?${q(thisFrom, thisTo)}`),
    ])
      .then(([prods, valuation, lvls, movs, sThis, sLast, top]) => {
        setProductsTotal(prods.total);
        setStockValue(valuation.totals.costValue);
        setLevels(lvls);
        setRecent(movs.items);
        setSumThis(sThis);
        setSumLast(sLast);
        setTopProducts(top);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <p className="text-sm font-bold text-[var(--muted)]">Loading dashboard…</p>
    );
  if (error) return <ErrorAlert>{error}</ErrorAlert>;

  /* ---------- derived numbers ---------- */
  const totalUnits = levels.reduce((s, l) => s + l.quantity, 0);
  const lowStockRows = levels.filter((l) => l.lowStock);

  const soldOf = (rows: SummaryRow[]) =>
    Math.abs(rows.find((r) => r.type === "SALE")?.netQuantity ?? 0);
  const soldThis = soldOf(sumThis);
  const soldLast = soldOf(sumLast);
  const soldPct =
    soldLast > 0 ? Math.round(((soldThis - soldLast) / soldLast) * 100) : null;
  const netThis = sumThis.reduce((s, r) => s + r.netQuantity, 0);

  /* stock by location */
  const byLocation = new Map<string, number>();
  for (const l of levels)
    byLocation.set(
      l.location.name,
      (byLocation.get(l.location.name) ?? 0) + l.quantity
    );
  const locEntries = [...byLocation.entries()].filter(([, v]) => v > 0);
  const locTotal = locEntries.reduce((s, [, v]) => s + v, 0);

  const maxSold = Math.max(...topProducts.map((t) => t.unitsSold), 1);
  const maxTypeCount = Math.max(...sumThis.map((r) => r.movements), 1);

  const trendChip = (text: string, positive: boolean) => (
    <span
      className={`rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black text-white ${
        positive ? "bg-emerald-500" : "bg-red-500"
      }`}
    >
      {text}
    </span>
  );

  /* ---------- donut geometry ---------- */
  const R = 40;
  const C = 2 * Math.PI * R;
  let acc = 0;

  return (
    <div className="space-y-8">
      {/* CTA row */}
      <div className="flex items-center justify-between">
        <SectionTitle>This month at {company?.name}</SectionTitle>
        <div className="flex gap-3">
          <Link
            to="/stock"
            className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--btn)] px-4 py-2 text-sm font-semibold text-[var(--btn-text)] shadow-[4px_4px_0px_var(--shadow)] transition-all duration-100 hover:brightness-90 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none"
          >
            + Record movement
          </Link>
        </div>
      </div>

      {/* Stat cards with honest trends */}
      <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
        <div className={`${cardClass} overflow-hidden p-4`}>
          <div className="-mx-4 -mt-4 mb-3 h-1.5 bg-[#a855f7]" />
          <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
            Products
          </div>
          <div className="mt-2 text-3xl font-black tracking-tight">
            {productsTotal}
          </div>
          <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
            in catalog
          </div>
        </div>

        <div className={`${cardClass} overflow-hidden p-4`}>
          <div className="-mx-4 -mt-4 mb-3 h-1.5 bg-[#3b82f6]" />
          <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
            Units in stock
          </div>
          <div className="mt-2 text-3xl font-black tracking-tight">
            {totalUnits}
          </div>
          <div className="mt-1.5">
            {trendChip(
              `${netThis >= 0 ? "+" : ""}${netThis} this month`,
              netThis >= 0
            )}
          </div>
        </div>

        <div className={`${cardClass} overflow-hidden p-4`}>
          <div className="-mx-4 -mt-4 mb-3 h-1.5 bg-[#10b981]" />
          <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
            Stock value (cost)
          </div>
          <div className="mt-2 text-3xl font-black tracking-tight">
            {formatMoney(stockValue, company?.currency, 0)}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--muted)]">
              sold {soldThis} units
            </span>
            {soldPct !== null &&
              trendChip(
                `${soldPct >= 0 ? "↑" : "↓"} ${Math.abs(soldPct)}% vs last month`,
                soldPct >= 0
              )}
          </div>
        </div>

        <div className={`${cardClass} overflow-hidden p-4`}>
          <div
            className="-mx-4 -mt-4 mb-3 h-1.5"
            style={{
              background: lowStockRows.length > 0 ? "#ef4444" : "#9a9ba3",
            }}
          />
          <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
            Low stock items
          </div>
          <div
            className="mt-2 text-3xl font-black tracking-tight"
            style={{
              color: lowStockRows.length > 0 ? "#ef4444" : undefined,
            }}
          >
            {lowStockRows.length}
          </div>
          {lowStockRows.length > 0 && (
            <div className="mt-1 text-xs font-bold text-red-500">
              needs attention ↓
            </div>
          )}
        </div>
      </div>

      {/* Analytics row */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Top sellers */}
        <div className={`${cardClass} p-5`}>
          <SectionTitle>Top sellers · this month</SectionTitle>
          {topProducts.length === 0 ? (
            <p className="mt-4 text-sm font-bold text-[var(--muted)]">
              No sales recorded yet this month.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {topProducts.map((t, i) => (
                <Link
                  key={t.productId}
                  to={`/products/${t.productId}`}
                  className="block"
                >
                  <div className="flex items-baseline justify-between text-xs font-bold">
                    <span className="text-[var(--text)] hover:underline">
                      {t.name}
                    </span>
                    <span className="text-[var(--muted)]">
                      {t.unitsSold} {t.unit}
                    </span>
                  </div>
                  <div className="mt-1 h-3 rounded-[3px] border-2 border-[var(--line)] bg-[var(--panel)]">
                    <div
                      className="h-full"
                      style={{
                        width: `${(t.unitsSold / maxSold) * 100}%`,
                        background: PALETTE[i % PALETTE.length],
                      }}
                    />
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Movements by type */}
        <div className={`${cardClass} p-5`}>
          <SectionTitle>Movements · this month</SectionTitle>
          {sumThis.length === 0 ? (
            <p className="mt-4 text-sm font-bold text-[var(--muted)]">
              Nothing recorded yet this month.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {sumThis.map((r) => (
                <div key={r.type}>
                  <div className="flex items-baseline justify-between text-xs font-bold">
                    <span style={{ color: TYPE_COLORS[r.type] ?? "inherit" }}>
                      {r.type}
                    </span>
                    <span className="text-[var(--muted)]">
                      {r.movements}× ·{" "}
                      {r.netQuantity > 0 ? `+${r.netQuantity}` : r.netQuantity}
                    </span>
                  </div>
                  <div className="mt-1 h-3 rounded-[3px] border-2 border-[var(--line)] bg-[var(--panel)]">
                    <div
                      className="h-full"
                      style={{
                        width: `${(r.movements / maxTypeCount) * 100}%`,
                        background: TYPE_COLORS[r.type] ?? "#666",
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stock by location donut */}
        <div className={`${cardClass} p-5`}>
          <SectionTitle>Stock by location</SectionTitle>
          {locEntries.length === 0 ? (
            <p className="mt-4 text-sm font-bold text-[var(--muted)]">
              No stock on hand yet.
            </p>
          ) : (
            <div className="mt-4 flex items-center gap-5">
              <svg width="120" height="120" viewBox="0 0 100 100">
                {locEntries.map(([name, value]) => {
                  const frac = value / locTotal;
                  const dash = frac * C;
                  const offset = -acc * C;
                  acc += frac;
                  return (
                    <circle
                      key={name}
                      cx="50"
                      cy="50"
                      r={R}
                      fill="none"
                      stroke={hashColor(name)}
                      strokeWidth="14"
                      strokeDasharray={`${dash} ${C - dash}`}
                      strokeDashoffset={offset}
                      transform="rotate(-90 50 50)"
                    />
                  );
                })}
                <text
                  x="50"
                  y="48"
                  textAnchor="middle"
                  className="fill-[var(--text)]"
                  fontSize="16"
                  fontWeight="900"
                >
                  {locTotal}
                </text>
                <text
                  x="50"
                  y="62"
                  textAnchor="middle"
                  className="fill-[var(--muted)]"
                  fontSize="8"
                  fontWeight="700"
                >
                  units
                </text>
              </svg>
              <div className="space-y-2">
                {locEntries.map(([name, value]) => (
                  <div
                    key={name}
                    className="flex items-center gap-2 text-xs font-bold"
                  >
                    <span
                      className="h-3 w-3 rounded-[3px] border-2 border-[var(--line)]"
                      style={{ background: hashColor(name) }}
                    />
                    <span className="text-[var(--text)]">{name}</span>
                    <span className="text-[var(--muted)]">
                      {Math.round((value / locTotal) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Alerts + activity */}
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-3">
          <SectionTitle>Low stock alerts</SectionTitle>
          {lowStockRows.length === 0 ? (
            <div className={`${cardClass} p-5 text-sm font-bold text-[var(--muted)]`}>
              All good — nothing running low. 🎉
            </div>
          ) : (
            <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
              {lowStockRows.map((l) => (
                <Link
                  key={`${l.product.id}-${l.location.id}`}
                  to={`/products/${l.product.id}`}
                  className="flex items-center justify-between px-4 py-3 transition-colors hover:bg-[var(--hover)]"
                >
                  <div>
                    <div className="text-sm font-bold text-[var(--text)]">
                      {l.product.name}
                    </div>
                    <div className="text-xs font-semibold text-[var(--muted)]">
                      {l.location.name}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="rounded-[4px] border-2 border-[var(--line)] bg-red-500 px-2 py-0.5 text-sm font-black text-white">
                      {l.quantity}
                    </span>
                    <span className="ml-2 text-xs font-semibold text-[var(--muted)]">
                      alert at {l.product.lowStockThreshold}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <SectionTitle>Recent activity</SectionTitle>
            <Link
              to="/stock"
              className="text-xs font-bold text-[var(--accent)] underline"
            >
              See all →
            </Link>
          </div>
          {recent.length === 0 ? (
            <div className={`${cardClass} p-5 text-sm font-bold text-[var(--muted)]`}>
              No movements yet.
            </div>
          ) : (
            <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
              {recent.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-[var(--text)]">
                      {m.product.name}
                      <span
                        className="ml-2 text-[10px] font-black tracking-wide"
                        style={{ color: TYPE_COLORS[m.type] ?? "inherit" }}
                      >
                        {m.type}
                      </span>
                      <span className="ml-1 text-xs font-semibold text-[var(--muted)]">
                        · {m.location.name}
                      </span>
                    </div>
                    <div className="text-xs font-semibold text-[var(--muted)]">
                      {new Date(m.createdAt).toLocaleString()} · {m.createdBy.name}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-sm font-black text-white ${
                      m.quantity > 0 ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  >
                    {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
