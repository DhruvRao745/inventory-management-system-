/**
 * Dashboard — "how's my shop doing right now?"
 *
 * Fetches three things IN PARALLEL (Promise.all — one wait, not three)
 * and computes the headline numbers in the browser:
 *   products  → how many items we manage + their cost prices
 *   levels    → current quantity everywhere + low-stock flags
 *   movements → the latest diary lines
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Product, StockLevel, StockMovement } from "../lib/types";
import { formatMoney } from "../lib/format";
import { useAuth } from "../context/AuthContext";

type MovementsResponse = { items: StockMovement[]; total: number };

export function DashboardPage() {
  const { company } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [levels, setLevels] = useState<StockLevel[]>([]);
  const [recent, setRecent] = useState<StockMovement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<Product[]>("/products"),
      api<StockLevel[]>("/stock/levels"),
      api<MovementsResponse>("/stock/movements?take=6"),
    ])
      .then(([prods, lvls, movs]) => {
        setProducts(prods);
        setLevels(lvls);
        setRecent(movs.items);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading)
    return <p className="text-slate-400 text-sm">Loading dashboard…</p>;
  if (error)
    return (
      <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 inline-block">
        {error}
      </p>
    );

  // --- the headline numbers ---
  const totalUnits = levels.reduce((sum, l) => sum + l.quantity, 0);

  // stock value = each product's quantity × its cost price
  const costById = new Map(products.map((p) => [p.id, Number(p.costPrice)]));
  const stockValue = levels.reduce(
    (sum, l) => sum + l.quantity * (costById.get(l.product.id) ?? 0),
    0
  );

  const lowStockRows = levels.filter((l) => l.lowStock);

  const stats = [
    { label: "Products", value: products.length },
    { label: "Units in stock", value: totalUnits },
    {
      label: "Stock value (cost)",
      value: formatMoney(stockValue, company?.currency, 0),
    },
    {
      label: "Low stock items",
      value: lowStockRows.length,
      alert: lowStockRows.length > 0,
    },
  ];

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-800">Dashboard</h1>

      {/* Stat cards */}
      <div className="mt-4 grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-white rounded-xl shadow-sm p-5">
            <div className="text-sm text-slate-500">{s.label}</div>
            <div
              className={`mt-1 text-2xl font-bold ${
                s.alert ? "text-red-600" : "text-slate-800"
              }`}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 grid lg:grid-cols-2 gap-6">
        {/* Low stock alerts */}
        <div>
          <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
            Low stock alerts
          </h2>
          {lowStockRows.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">
              All good — nothing running low. 🎉
            </p>
          ) : (
            <div className="mt-3 bg-white rounded-xl shadow-sm divide-y divide-slate-100">
              {lowStockRows.map((l) => (
                <div
                  key={`${l.product.id}-${l.location.id}`}
                  className="px-4 py-3 flex items-center justify-between"
                >
                  <div>
                    <div className="text-sm text-slate-800">
                      {l.product.name}
                    </div>
                    <div className="text-xs text-slate-400">
                      {l.location.name}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-red-600 font-bold">
                      {l.quantity}
                    </span>
                    <span className="text-xs text-slate-400">
                      {" "}
                      / alert at {l.product.lowStockThreshold}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent activity */}
        <div>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
              Recent activity
            </h2>
            <Link
              to="/stock"
              className="text-xs text-slate-500 underline hover:text-slate-800"
            >
              See all
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No movements yet.</p>
          ) : (
            <div className="mt-3 bg-white rounded-xl shadow-sm divide-y divide-slate-100">
              {recent.map((m) => (
                <div
                  key={m.id}
                  className="px-4 py-3 flex items-center justify-between"
                >
                  <div>
                    <div className="text-sm text-slate-800">
                      {m.product.name}
                      <span className="ml-2 text-xs text-slate-400">
                        {m.type} · {m.location.name}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400">
                      {new Date(m.createdAt).toLocaleString()} · {m.createdBy.name}
                    </div>
                  </div>
                  <span
                    className={`font-bold text-sm ${
                      m.quantity > 0 ? "text-green-700" : "text-red-600"
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
