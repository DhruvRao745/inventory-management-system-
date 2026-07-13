/**
 * Product detail — one product's full story.
 *
 * The URL is /products/:id — useParams() reads the id from the
 * address bar, so this ONE component serves every product.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Product, StockLevel, StockMovement } from "../lib/types";

type MovementsResponse = { items: StockMovement[]; total: number };

export function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();

  const [product, setProduct] = useState<Product | null>(null);
  const [levels, setLevels] = useState<StockLevel[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      api<Product>(`/products/${id}`),
      api<StockLevel[]>(`/stock/levels?productId=${id}`),
      api<MovementsResponse>(`/stock/movements?productId=${id}&take=50`),
    ])
      .then(([p, lvls, movs]) => {
        setProduct(p);
        setLevels(lvls);
        setMovements(movs.items);
        setTotal(movs.total);
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [id]); // re-run if the id in the URL changes

  if (loading) return <p className="text-slate-400 text-sm">Loading…</p>;
  if (error || !product)
    return (
      <div>
        <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 inline-block">
          {error ?? "Product not found"}
        </p>
        <p className="mt-3">
          <Link to="/products" className="text-sm text-slate-500 underline">
            ← Back to products
          </Link>
        </p>
      </div>
    );

  const totalUnits = levels.reduce((sum, l) => sum + l.quantity, 0);

  return (
    <div>
      <Link to="/products" className="text-sm text-slate-500 underline">
        ← Back to products
      </Link>

      {/* Product info */}
      <div className="mt-3 bg-white rounded-xl shadow-sm p-6 max-w-3xl">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-800">
              {product.name}
              {!product.isActive && (
                <span className="ml-2 text-sm font-normal text-slate-400">
                  (retired)
                </span>
              )}
            </h1>
            <div className="mt-1 text-sm text-slate-500">
              <span className="font-mono text-xs">{product.sku}</span>
              {product.category && <span> · {product.category.name}</span>}
              {product.description && <span> · {product.description}</span>}
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-slate-800">
              {totalUnits}{" "}
              <span className="text-sm font-normal text-slate-400">
                {product.unit}
              </span>
            </div>
            <div className="text-xs text-slate-400">total on hand</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
          <div>
            <div className="text-slate-400 text-xs">Cost price</div>
            <div className="text-slate-800">
              ₹{Number(product.costPrice).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-slate-400 text-xs">Selling price</div>
            <div className="text-slate-800">
              ₹{Number(product.sellingPrice).toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-slate-400 text-xs">Low-stock alert below</div>
            <div className="text-slate-800">{product.lowStockThreshold}</div>
          </div>
        </div>
      </div>

      {/* Per-location stock */}
      <div className="mt-6 max-w-3xl">
        <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
          Stock by location
        </h2>
        {levels.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No stock recorded yet.</p>
        ) : (
          <div className="mt-3 bg-white rounded-xl shadow-sm divide-y divide-slate-100">
            {levels.map((l) => (
              <div
                key={l.location.id}
                className="px-4 py-3 flex items-center justify-between"
              >
                <span className="text-sm text-slate-800">
                  {l.location.name}
                </span>
                <span
                  className={`text-sm font-bold ${
                    l.lowStock ? "text-red-600" : "text-slate-800"
                  }`}
                >
                  {l.quantity} {product.unit}
                  {l.lowStock && (
                    <span className="ml-2 text-xs font-normal">low!</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* History for this product */}
      <div className="mt-6 max-w-3xl">
        <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
          History{" "}
          <span className="text-slate-400 font-normal">({total} movements)</span>
        </h2>
        {movements.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No movements yet.</p>
        ) : (
          <div className="mt-3 bg-white rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Location</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium text-right">Qty</th>
                  <th className="px-4 py-3 font-medium">By</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                      {new Date(m.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {m.location.name}
                    </td>
                    <td className="px-4 py-3 text-slate-500">{m.type}</td>
                    <td
                      className={`px-4 py-3 text-right font-medium ${
                        m.quantity > 0 ? "text-green-700" : "text-red-600"
                      }`}
                    >
                      {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {m.createdBy.name}
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
