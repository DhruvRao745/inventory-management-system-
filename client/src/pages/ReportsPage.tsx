/**
 * Reports page — neubrutalist edition. Logic unchanged (including the
 * timezone-safe range conversion); presentation on tokens.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { downloadCsv } from "../lib/csv";
import { formatMoney } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Input,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";

type ValuationRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  isActive: boolean;
  quantity: number;
  costValue: number;
  retailValue: number;
};
type Valuation = {
  rows: ValuationRow[];
  totals: { quantity: number; costValue: number; retailValue: number };
};
type SummaryRow = { type: string; movements: number; netQuantity: number };
type SalesPoint = { date: string; unitsSold: number };
type ExpiringRow = {
  movementId: string;
  product: { id: string; name: string; sku: string; unit: string };
  location: string;
  batchNumber: string | null;
  expiryDate: string;
  quantity: number;
  daysLeft: number;
};
type ReorderRow = {
  productId: string;
  name: string;
  sku: string;
  unit: string;
  onHand: number;
  threshold: number;
  suggestedQty: number;
  costPrice: string;
  preferredSupplier: { id: string; name: string } | null;
};
type SalesReport = {
  totals: { revenue: number; invoices: number };
  byProduct: {
    productId: string;
    name: string;
    unit: string;
    units: number;
    revenue: number;
  }[];
  byCustomer: { name: string; invoices: number; revenue: number }[];
};
type PurchasingReport = {
  totals: { orders: number; committedCost: number; receivedValue: number };
  byStatus: Record<string, number>;
  bySupplier: {
    supplierId: string;
    name: string;
    orders: number;
    totalCost: number;
  }[];
};

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

/**
 * Sales trend — a hand-drawn SVG line/area chart (no chart library, so it
 * inherits our neubrutalist tokens exactly). We draw into a fixed 720x240
 * "canvas" and let the SVG scale to the card width via viewBox.
 */
function SalesChart({ points }: { points: SalesPoint[] }) {
  const W = 720;
  const H = 240;
  const padL = 12;
  const padR = 12;
  const padT = 18;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const n = points.length;
  const max = Math.max(1, ...points.map((p) => p.unitsSold));

  // x: spread points evenly; a single day sits in the middle.
  const x = (i: number) => (n <= 1 ? W / 2 : padL + (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const baseY = padT + innerH;

  const line = points.map((p, i) => `${x(i)},${y(p.unitsSold)}`).join(" ");
  // area = the line, then drop down to the baseline and back — a closed shape.
  const area =
    n <= 1
      ? ""
      : `M ${x(0)},${baseY} L ${line.replaceAll(" ", " L ")} L ${x(n - 1)},${baseY} Z`;

  const fmtDay = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Units sold per day"
    >
      {/* y-axis reference lines + labels at 0, half, max */}
      {[0, max / 2, max].map((v, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={W - padR}
            y1={y(v)}
            y2={y(v)}
            stroke="var(--line)"
            strokeWidth={1}
            strokeDasharray={i === 0 ? "0" : "3 3"}
            opacity={i === 0 ? 0.6 : 0.3}
          />
          <text
            x={padL}
            y={y(v) - 4}
            className="fill-[var(--muted)]"
            fontSize={11}
            fontWeight={700}
          >
            {Math.round(v)}
          </text>
        </g>
      ))}

      {area && <path d={area} fill="var(--accent)" opacity={0.15} />}

      {n > 1 && (
        <polyline
          points={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={3}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}

      {/* dots — bigger on the last point so "today" stands out */}
      {points.map((p, i) => (
        <circle
          key={p.date}
          cx={x(i)}
          cy={y(p.unitsSold)}
          r={i === n - 1 ? 5 : 3}
          fill="var(--accent)"
          stroke="var(--card)"
          strokeWidth={2}
        >
          <title>{`${fmtDay(p.date)}: ${p.unitsSold} sold`}</title>
        </circle>
      ))}

      {/* x-axis: first / middle / last date so it never crowds */}
      {n > 0 &&
        [0, Math.floor((n - 1) / 2), n - 1]
          .filter((v, idx, arr) => arr.indexOf(v) === idx)
          .map((i) => (
            <text
              key={i}
              x={x(i)}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              className="fill-[var(--muted)]"
              fontSize={11}
              fontWeight={700}
            >
              {fmtDay(points[i].date)}
            </text>
          ))}
    </svg>
  );
}

export function ReportsPage() {
  const { company, user } = useAuth();
  const currency = company?.currency;
  const canOrder = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [valError, setValError] = useState<string | null>(null);

  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [sumError, setSumError] = useState<string | null>(null);

  const [series, setSeries] = useState<SalesPoint[] | null>(null);
  const [serError, setSerError] = useState<string | null>(null);

  const [purchasing, setPurchasing] = useState<PurchasingReport | null>(null);
  const [purError, setPurError] = useState<string | null>(null);

  const [expiring, setExpiring] = useState<ExpiringRow[] | null>(null);

  const [sales, setSales] = useState<SalesReport | null>(null);
  const [salesError, setSalesError] = useState<string | null>(null);

  const navigate = useNavigate();
  const [reorder, setReorder] = useState<ReorderRow[] | null>(null);
  const [draftingId, setDraftingId] = useState<string | null>(null);

  async function draftPO(r: ReorderRow) {
    if (!r.preferredSupplier) return;
    setDraftingId(r.productId);
    try {
      const created = await api<{ id: string }>("/purchase-orders", {
        method: "POST",
        body: {
          supplierId: r.preferredSupplier.id,
          lines: [
            {
              productId: r.productId,
              quantity: r.suggestedQty,
              unitCost: Number(r.costPrice),
            },
          ],
        },
      });
      navigate(`/purchase-orders/${created.id}`);
    } catch {
      setDraftingId(null);
    }
  }

  useEffect(() => {
    api<Valuation>("/reports/valuation")
      .then(setValuation)
      .catch((err) =>
        setValError(err instanceof ApiError ? err.message : "Failed to load")
      );
    loadSummary(firstOfMonth(), today());
    loadSeries(firstOfMonth(), today());
    loadPurchasing(firstOfMonth(), today());
    loadSales(firstOfMonth(), today());
    // Expiring soon is not tied to the date range — always "next 30 days".
    api<ExpiringRow[]>("/reports/expiring?days=30")
      .then(setExpiring)
      .catch(() => setExpiring([]));
    api<ReorderRow[]>("/reports/reorder")
      .then(setReorder)
      .catch(() => setReorder([]));
  }, []);

  // Same timezone-safe conversion the summary uses: the browser turns the
  // picked local dates into universal instants before sending them.
  function rangeToIso(f: string, t: string) {
    return {
      fromIso: new Date(`${f}T00:00:00`).toISOString(),
      toIso: new Date(`${t}T23:59:59.999`).toISOString(),
    };
  }

  async function loadSummary(f: string, t: string) {
    setSumError(null);
    try {
      const { fromIso, toIso } = rangeToIso(f, t);
      setSummary(
        await api<SummaryRow[]>(
          `/reports/summary?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
        )
      );
    } catch (err) {
      setSumError(err instanceof ApiError ? err.message : "Failed to load");
    }
  }

  async function loadSeries(f: string, t: string) {
    setSerError(null);
    try {
      const { fromIso, toIso } = rangeToIso(f, t);
      // tzOffset lets the server bucket each sale on the user's local day.
      const tzOffset = new Date().getTimezoneOffset();
      setSeries(
        await api<SalesPoint[]>(
          `/reports/sales-over-time?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&tzOffset=${tzOffset}`
        )
      );
    } catch (err) {
      setSerError(err instanceof ApiError ? err.message : "Failed to load");
    }
  }

  async function loadPurchasing(f: string, t: string) {
    setPurError(null);
    try {
      const { fromIso, toIso } = rangeToIso(f, t);
      setPurchasing(
        await api<PurchasingReport>(
          `/reports/purchasing?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
        )
      );
    } catch (err) {
      setPurError(err instanceof ApiError ? err.message : "Failed to load");
    }
  }

  async function loadSales(f: string, t: string) {
    setSalesError(null);
    try {
      const { fromIso, toIso } = rangeToIso(f, t);
      setSales(
        await api<SalesReport>(
          `/reports/sales?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
        )
      );
    } catch (err) {
      setSalesError(err instanceof ApiError ? err.message : "Failed to load");
    }
  }

  function handleRange(e: FormEvent) {
    e.preventDefault();
    loadSummary(from, to);
    loadSeries(from, to);
    loadPurchasing(from, to);
    loadSales(from, to);
  }

  function exportValuation() {
    if (!valuation) return;
    downloadCsv(
      `valuation-${today()}.csv`,
      ["SKU", "Product", "Unit", "Quantity", "Cost value", "Retail value"],
      valuation.rows.map((r) => [
        r.sku,
        r.name,
        r.unit,
        r.quantity,
        r.costValue,
        r.retailValue,
      ])
    );
  }

  function exportSummary() {
    if (!summary) return;
    downloadCsv(
      `movement-summary-${from}-to-${to}.csv`,
      ["Type", "Movements", "Net quantity"],
      summary.map((s) => [s.type, s.movements, s.netQuantity])
    );
  }

  return (
    <div className="max-w-4xl space-y-10">
      {/* ---------- Valuation ---------- */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionTitle>Stock valuation (now)</SectionTitle>
          <Button
            variant="secondary"
            onClick={exportValuation}
            disabled={!valuation || valuation.rows.length === 0}
          >
            ⬇ Download CSV
          </Button>
        </div>

        {valError && <ErrorAlert>{valError}</ErrorAlert>}
        {valuation && valuation.rows.length === 0 && (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No stock yet.
          </div>
        )}
        {valuation && valuation.rows.length > 0 && (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className={th}>SKU</th>
                  <th className={th}>Product</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={`${th} text-right`}>Cost value</th>
                  <th className={`${th} text-right`}>Retail value</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {valuation.rows.map((r) => (
                  <tr key={r.productId} className="hover:bg-[var(--hover)]">
                    <td className={`${td} font-mono text-xs text-[var(--muted)]`}>
                      {r.sku}
                    </td>
                    <td className={`${td} font-bold text-[var(--text)]`}>
                      {r.name}
                      {!r.isActive && (
                        <span className="ml-2 text-xs font-semibold text-[var(--muted)]/60">
                          (retired)
                        </span>
                      )}
                    </td>
                    <td
                      className={`${td} text-right font-semibold text-[var(--muted)]`}
                    >
                      {r.quantity} {r.unit}
                    </td>
                    <td
                      className={`${td} text-right font-semibold text-[var(--muted)]`}
                    >
                      {formatMoney(r.costValue, currency)}
                    </td>
                    <td className={`${td} text-right font-bold text-[var(--text)]`}>
                      {formatMoney(r.retailValue, currency)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-[var(--line)] bg-[var(--panel)]">
                  <td className={`${td} font-black text-[var(--text)]`} colSpan={2}>
                    TOTALS
                  </td>
                  <td className={`${td} text-right font-black text-[var(--text)]`}>
                    {valuation.totals.quantity}
                  </td>
                  <td className={`${td} text-right font-black text-[var(--accent)]`}>
                    {formatMoney(valuation.totals.costValue, currency)}
                  </td>
                  <td className={`${td} text-right font-black text-[var(--accent)]`}>
                    {formatMoney(valuation.totals.retailValue, currency)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------- Movement summary ---------- */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionTitle>Movement summary</SectionTitle>
          <Button
            variant="secondary"
            onClick={exportSummary}
            disabled={!summary || summary.length === 0}
          >
            ⬇ Download CSV
          </Button>
        </div>

        <form
          onSubmit={handleRange}
          className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}
        >
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-44"
          />
          <span className="text-sm font-bold text-[var(--muted)]">to</span>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-44"
          />
          <Button type="submit">Apply</Button>
        </form>

        {/* ---------- Sales over time (units sold per day) ---------- */}
        {serError && <ErrorAlert>{serError}</ErrorAlert>}
        {series && (
          <div className={`${cardClass} p-4`}>
            <div className="mb-3 flex items-baseline justify-between">
              <span className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                Sales over time · units sold
              </span>
              <span className="text-sm font-black text-[var(--text)]">
                {series.reduce((sum, p) => sum + p.unitsSold, 0)} sold
              </span>
            </div>
            {series.every((p) => p.unitsSold === 0) ? (
              <div className="py-8 text-center text-sm font-bold text-[var(--muted)]">
                No sales in this period.
              </div>
            ) : (
              <SalesChart points={series} />
            )}
          </div>
        )}

        {sumError && <ErrorAlert>{sumError}</ErrorAlert>}
        {summary && summary.length === 0 && (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No movements in this period.
          </div>
        )}
        {summary && summary.length > 0 && (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className={th}>Type</th>
                  <th className={`${th} text-right`}>Movements</th>
                  <th className={`${th} text-right`}>Net quantity</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {summary.map((s) => (
                  <tr key={s.type} className="hover:bg-[var(--hover)]">
                    <td className={`${td} font-bold text-[var(--text)]`}>
                      {s.type}
                    </td>
                    <td
                      className={`${td} text-right font-semibold text-[var(--muted)]`}
                    >
                      {s.movements}
                    </td>
                    <td
                      className={`${td} text-right font-black ${
                        s.netQuantity > 0
                          ? "text-emerald-500"
                          : s.netQuantity < 0
                            ? "text-red-500"
                            : "text-[var(--muted)]"
                      }`}
                    >
                      {s.netQuantity > 0 ? `+${s.netQuantity}` : s.netQuantity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------- Reorder suggestions ---------- */}
      <div className="space-y-3">
        <SectionTitle>
          Reorder suggestions{" "}
          {reorder && reorder.length > 0 && (
            <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
              ({reorder.length})
            </span>
          )}
        </SectionTitle>
        {reorder && reorder.length === 0 && (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            Nothing needs reordering — all stock is above its threshold. 🎉
          </div>
        )}
        {reorder && reorder.length > 0 && (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className={th}>Product</th>
                  <th className={`${th} text-right`}>On hand</th>
                  <th className={`${th} text-right`}>Suggest</th>
                  <th className={th}>Supplier</th>
                  {canOrder && <th className={th} />}
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {reorder.map((r) => (
                  <tr key={r.productId} className="hover:bg-[var(--hover)]">
                    <td className={`${td} font-bold text-[var(--text)]`}>
                      {r.name}
                      <span className="ml-2 font-mono text-xs text-[var(--muted)]">
                        {r.sku}
                      </span>
                    </td>
                    <td className={`${td} text-right font-black text-red-500`}>
                      {r.onHand.toLocaleString()}
                    </td>
                    <td className={`${td} text-right font-semibold text-[var(--muted)]`}>
                      {r.suggestedQty.toLocaleString()} {r.unit}
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]`}>
                      {r.preferredSupplier?.name ?? "— none set —"}
                    </td>
                    {canOrder && (
                      <td className={`${td} text-right`}>
                        <button
                          type="button"
                          onClick={() => draftPO(r)}
                          disabled={!r.preferredSupplier || draftingId === r.productId}
                          className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] px-3 py-1 text-xs font-bold text-[var(--text)] shadow-[2px_2px_0px_var(--shadow)] hover:bg-[var(--hover)] disabled:opacity-40"
                          title={
                            r.preferredSupplier
                              ? "Create a draft PO to the preferred supplier"
                              : "Set a preferred supplier on this product first"
                          }
                        >
                          {draftingId === r.productId ? "…" : "Draft PO"}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------- Sales ---------- */}
      <div className="space-y-3">
        <SectionTitle>Sales</SectionTitle>
        {salesError && <ErrorAlert>{salesError}</ErrorAlert>}
        {sales && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className={`${cardClass} p-4`}>
                <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                  Revenue
                </div>
                <div className="mt-1 text-2xl font-black tracking-tight text-[var(--accent)]">
                  {formatMoney(sales.totals.revenue, currency, 0)}
                </div>
              </div>
              <div className={`${cardClass} p-4`}>
                <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                  Invoices
                </div>
                <div className="mt-1 text-2xl font-black tracking-tight text-[var(--text)]">
                  {sales.totals.invoices.toLocaleString()}
                </div>
              </div>
            </div>

            {sales.byProduct.length === 0 ? (
              <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
                No sales in this period.
              </div>
            ) : (
              <div className={`${cardClass} overflow-x-auto`}>
                <table className="w-full">
                  <thead>
                    <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                      <th className={th}>Top products</th>
                      <th className={`${th} text-right`}>Units</th>
                      <th className={`${th} text-right`}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y-2 divide-[var(--line)]/20">
                    {sales.byProduct.slice(0, 10).map((p) => (
                      <tr key={p.productId} className="hover:bg-[var(--hover)]">
                        <td className={`${td} font-bold text-[var(--text)]`}>
                          {p.name}
                        </td>
                        <td className={`${td} text-right font-semibold text-[var(--muted)]`}>
                          {p.units.toLocaleString()} {p.unit}
                        </td>
                        <td className={`${td} text-right font-black text-[var(--text)]`}>
                          {formatMoney(p.revenue, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {sales.byCustomer.length > 0 && (
              <div className={`${cardClass} overflow-x-auto`}>
                <table className="w-full">
                  <thead>
                    <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                      <th className={th}>Top customers</th>
                      <th className={`${th} text-right`}>Invoices</th>
                      <th className={`${th} text-right`}>Revenue</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y-2 divide-[var(--line)]/20">
                    {sales.byCustomer.slice(0, 10).map((c) => (
                      <tr key={c.name} className="hover:bg-[var(--hover)]">
                        <td className={`${td} font-bold text-[var(--text)]`}>
                          {c.name}
                        </td>
                        <td className={`${td} text-right font-semibold text-[var(--muted)]`}>
                          {c.invoices.toLocaleString()}
                        </td>
                        <td className={`${td} text-right font-black text-[var(--text)]`}>
                          {formatMoney(c.revenue, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------- Purchasing ---------- */}
      <div className="space-y-3">
        <SectionTitle>Purchasing</SectionTitle>
        {purError && <ErrorAlert>{purError}</ErrorAlert>}
        {purchasing && (
          <>
            <div className="grid grid-cols-3 gap-4">
              <div className={`${cardClass} p-4`}>
                <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                  Orders
                </div>
                <div className="mt-1 text-2xl font-black tracking-tight text-[var(--text)]">
                  {purchasing.totals.orders.toLocaleString()}
                </div>
              </div>
              <div className={`${cardClass} p-4`}>
                <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                  Committed spend
                </div>
                <div className="mt-1 text-2xl font-black tracking-tight text-[var(--text)]">
                  {formatMoney(purchasing.totals.committedCost, currency, 0)}
                </div>
              </div>
              <div className={`${cardClass} p-4`}>
                <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                  Received value
                </div>
                <div className="mt-1 text-2xl font-black tracking-tight text-[var(--accent)]">
                  {formatMoney(purchasing.totals.receivedValue, currency, 0)}
                </div>
              </div>
            </div>

            {purchasing.bySupplier.length === 0 ? (
              <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
                No purchase orders in this period.
              </div>
            ) : (
              <div className={`${cardClass} overflow-x-auto`}>
                <table className="w-full">
                  <thead>
                    <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                      <th className={th}>Supplier</th>
                      <th className={`${th} text-right`}>Orders</th>
                      <th className={`${th} text-right`}>Spend</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y-2 divide-[var(--line)]/20">
                    {purchasing.bySupplier.map((s) => (
                      <tr key={s.supplierId} className="hover:bg-[var(--hover)]">
                        <td className={`${td} font-bold text-[var(--text)]`}>
                          {s.name}
                        </td>
                        <td className={`${td} text-right font-semibold text-[var(--muted)]`}>
                          {s.orders.toLocaleString()}
                        </td>
                        <td className={`${td} text-right font-black text-[var(--text)]`}>
                          {formatMoney(s.totalCost, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* ---------- Expiring soon ---------- */}
      <div className="space-y-3">
        <SectionTitle>
          Expiring soon{" "}
          <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
            (next 30 days)
          </span>
        </SectionTitle>
        {expiring && expiring.length === 0 && (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            Nothing expiring in the next 30 days.
          </div>
        )}
        {expiring && expiring.length > 0 && (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className={th}>Product</th>
                  <th className={th}>Batch</th>
                  <th className={th}>Location</th>
                  <th className={th}>Expiry</th>
                  <th className={`${th} text-right`}>Days left</th>
                  <th className={`${th} text-right`}>Qty</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {expiring.map((r) => (
                  <tr key={r.movementId} className="hover:bg-[var(--hover)]">
                    <td className={`${td} font-bold text-[var(--text)]`}>
                      {r.product.name}
                      <span className="ml-2 font-mono text-xs text-[var(--muted)]">
                        {r.product.sku}
                      </span>
                    </td>
                    <td className={`${td} font-mono text-xs text-[var(--muted)]`}>
                      {r.batchNumber ?? "—"}
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]`}>
                      {r.location}
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]`}>
                      {new Date(r.expiryDate).toLocaleDateString()}
                    </td>
                    <td
                      className={`${td} text-right font-black ${
                        r.daysLeft <= 0
                          ? "text-red-500"
                          : r.daysLeft <= 7
                            ? "text-amber-500"
                            : "text-[var(--muted)]"
                      }`}
                    >
                      {r.daysLeft <= 0 ? "expired" : `${r.daysLeft}d`}
                    </td>
                    <td className={`${td} text-right font-semibold text-[var(--muted)]`}>
                      {r.quantity.toLocaleString()} {r.product.unit}
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
