/**
 * Reports page — valuation (now) + movement summary (date range),
 * each with a CSV download for Excel/accountants.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { downloadCsv } from "../lib/csv";

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

// default range: the current month so far
function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export function ReportsPage() {
  // --- valuation ---
  const [valuation, setValuation] = useState<Valuation | null>(null);
  const [valError, setValError] = useState<string | null>(null);

  // --- summary ---
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
      // TIMEZONE RULE: only the browser knows the user's timezone.
      // new Date("2026-07-09T00:00:00") = midnight IN LOCAL TIME;
      // toISOString() converts that instant to universal (UTC) form
      // the server can use without guessing.
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

  const inputClass =
    "rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-800">Reports</h1>

      {/* ---------- Valuation ---------- */}
      <div className="mt-6 max-w-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
            Stock valuation (now)
          </h2>
          <button
            onClick={exportValuation}
            disabled={!valuation || valuation.rows.length === 0}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            ⬇ Download CSV
          </button>
        </div>

        {valError && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            {valError}
          </p>
        )}
        {valuation && valuation.rows.length === 0 && (
          <p className="mt-3 text-sm text-slate-400">No stock yet.</p>
        )}
        {valuation && valuation.rows.length > 0 && (
          <div className="mt-3 bg-white rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-4 py-3 font-medium">SKU</th>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium text-right">Qty</th>
                  <th className="px-4 py-3 font-medium text-right">
                    Cost value
                  </th>
                  <th className="px-4 py-3 font-medium text-right">
                    Retail value
                  </th>
                </tr>
              </thead>
              <tbody>
                {valuation.rows.map((r) => (
                  <tr key={r.productId} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {r.sku}
                    </td>
                    <td className="px-4 py-3 text-slate-800">
                      {r.name}
                      {!r.isActive && (
                        <span className="ml-2 text-xs text-slate-400">
                          (retired)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {r.quantity} {r.unit}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      ₹{r.costValue.toLocaleString("en-IN")}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-800">
                      ₹{r.retailValue.toLocaleString("en-IN")}
                    </td>
                  </tr>
                ))}
                {/* totals row */}
                <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                  <td className="px-4 py-3" colSpan={2}>
                    Total
                  </td>
                  <td className="px-4 py-3 text-right">
                    {valuation.totals.quantity}
                  </td>
                  <td className="px-4 py-3 text-right">
                    ₹{valuation.totals.costValue.toLocaleString("en-IN")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    ₹{valuation.totals.retailValue.toLocaleString("en-IN")}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------- Movement summary ---------- */}
      <div className="mt-8 max-w-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
            Movement summary
          </h2>
          <button
            onClick={exportSummary}
            disabled={!summary || summary.length === 0}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100 disabled:opacity-40"
          >
            ⬇ Download CSV
          </button>
        </div>

        <form onSubmit={handleRange} className="mt-3 flex items-center gap-2">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputClass}
          />
          <span className="text-slate-400 text-sm">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputClass}
          />
          <button className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
            Apply
          </button>
        </form>

        {sumError && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            {sumError}
          </p>
        )}
        {summary && summary.length === 0 && (
          <p className="mt-3 text-sm text-slate-400">
            No movements in this period.
          </p>
        )}
        {summary && summary.length > 0 && (
          <div className="mt-3 bg-white rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium text-right">
                    Movements
                  </th>
                  <th className="px-4 py-3 font-medium text-right">
                    Net quantity
                  </th>
                </tr>
              </thead>
              <tbody>
                {summary.map((s) => (
                  <tr key={s.type} className="border-t border-slate-100">
                    <td className="px-4 py-3 text-slate-800">{s.type}</td>
                    <td className="px-4 py-3 text-right text-slate-600">
                      {s.movements}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-medium ${
                        s.netQuantity > 0
                          ? "text-green-700"
                          : s.netQuantity < 0
                            ? "text-red-600"
                            : "text-slate-600"
                      }`}
                    >
                      {s.netQuantity > 0
                        ? `+${s.netQuantity}`
                        : s.netQuantity}
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
