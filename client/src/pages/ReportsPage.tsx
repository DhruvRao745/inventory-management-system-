/**
 * Reports page — neubrutalist edition. Logic unchanged (including the
 * timezone-safe range conversion); presentation on tokens.
 */
import { useEffect, useState, type FormEvent } from "react";
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

export function ReportsPage() {
  const { company } = useAuth();
  const currency = company?.currency;

  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [valError, setValError] = useState<string | null>(null);

  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [sumError, setSumError] = useState<string | null>(null);

  useEffect(() => {
    api<Valuation>("/reports/valuation")
      .then(setValuation)
      .catch((err) =>
        setValError(err instanceof ApiError ? err.message : "Failed to load")
      );
    loadSummary(firstOfMonth(), today());
  }, []);

  async function loadSummary(f: string, t: string) {
    setSumError(null);
    try {
      // only the browser knows the user's timezone — convert here
      const fromIso = new Date(`${f}T00:00:00`).toISOString();
      const toIso = new Date(`${t}T23:59:59.999`).toISOString();
      setSummary(
        await api<SummaryRow[]>(
          `/reports/summary?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`
        )
      );
    } catch (err) {
      setSumError(err instanceof ApiError ? err.message : "Failed to load");
    }
  }

  function handleRange(e: FormEvent) {
    e.preventDefault();
    loadSummary(from, to);
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
    </div>
  );
}
