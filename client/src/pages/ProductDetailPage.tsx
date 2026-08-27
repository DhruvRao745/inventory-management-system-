/**
 * Product detail — neubrutalist edition. One product's full story.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Product, StockLevel, StockMovement } from "../lib/types";
import { formatMoney, qtyNum, formatQty } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { ErrorAlert, cardClass, SectionTitle } from "../components/ui";
import { PoRefLink } from "../components/PoRefLink";
import { BarcodeView } from "../components/BarcodeView";
import { TYPE_COLORS } from "../lib/colors";

type MovementsResponse = { items: StockMovement[]; total: number };

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

export function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { company } = useAuth();

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
  }, [id]);

  if (loading)
    return <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>;
  if (error || !product)
    return (
      <div className="space-y-4">
        <ErrorAlert>{error ?? "Product not found"}</ErrorAlert>
        <Link
          to="/products"
          className="text-sm font-bold text-[var(--accent)] underline"
        >
          ← Back to products
        </Link>
      </div>
    );

  const totalUnits = levels.reduce((sum, l) => sum + qtyNum(l.quantity), 0);

  // Gross margin: profit per unit, and that profit as a % of the selling
  // price. Guard against a zero selling price (no meaningful %).
  const cost = Number(product.costPrice);
  const selling = Number(product.sellingPrice);
  const marginAmount = selling - cost;
  const marginPct =
    selling > 0 ? Math.round((marginAmount / selling) * 100) : null;

  // Print a single label for THIS product (QR + Code128) in a new window.
  function printBarcode() {
    if (!product?.barcode) return;
    const code = JSON.stringify(product.barcode);
    const html = `<!doctype html><html><head><title>${product.sku}</title>
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
      <style>
        body{font-family:Arial,sans-serif;text-align:center;padding:24px}
        .name{font-weight:bold;font-size:16px;margin-bottom:8px}
        .sku{color:#666;font-size:12px;margin-top:6px}
      </style></head><body>
      <div class="name">${product.name}</div>
      <svg id="bc"></svg>
      <div class="sku">${product.sku}</div>
      <script>window.onload=function(){
        try{JsBarcode('#bc', ${code}, {format:'CODE128',height:60,fontSize:14,margin:6});}catch(e){}
        setTimeout(function(){window.print();},400);
      };<\/script></body></html>`;
    const w = window.open("", "_blank", "width=480,height=520");
    if (!w) return;
    w.document.write(html);
    w.document.close();
  }

  return (
    <div className="max-w-3xl space-y-8">
      <Link
        to="/products"
        className="text-sm font-bold text-[var(--muted)] underline hover:text-[var(--text)]"
      >
        ← Back to products
      </Link>

      {/* Product info */}
      <div className={`${cardClass} p-6`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-black tracking-tight text-[var(--text)]">
              {product.name}
              {!product.isActive && (
                <span className="ml-2 text-sm font-semibold text-[var(--muted)]/60">
                  (retired)
                </span>
              )}
            </h1>
            <div className="mt-1 text-sm font-semibold text-[var(--muted)]">
              <span className="font-mono text-xs">{product.sku}</span>
              {product.barcode && (
                <span className="font-mono text-xs"> · ▮▏ {product.barcode}</span>
              )}
              {product.category && <span> · {product.category.name}</span>}
              {product.description && <span> · {product.description}</span>}
            </div>
            {product.preferredSupplier && (
              <div className="mt-1 text-xs font-bold text-[var(--muted)]">
                Preferred supplier:{" "}
                <Link
                  to={`/suppliers/${product.preferredSupplier.id}`}
                  className="text-[var(--accent)] hover:underline"
                >
                  {product.preferredSupplier.name}
                </Link>
              </div>
            )}
          </div>
          <div className="shrink-0 text-right">
            <div className="text-3xl font-black tracking-tight text-[var(--text)]">
              {totalUnits.toLocaleString()}
              <span className="ml-1 text-sm font-semibold text-[var(--muted)]">
                {product.unit}
              </span>
            </div>
            <div className="text-xs font-bold text-[var(--muted)]">
              total on hand
            </div>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-4 border-t-2 border-[var(--line)]/20 pt-4 text-sm md:grid-cols-4">
          <div>
            <div className="text-xs font-bold text-[var(--muted)]">
              Cost price
            </div>
            <div className="font-black text-[var(--text)]">
              {formatMoney(cost, company?.currency)}
            </div>
          </div>
          <div>
            <div className="text-xs font-bold text-[var(--muted)]">
              Selling price
            </div>
            <div className="font-black text-[var(--text)]">
              {formatMoney(selling, company?.currency)}
            </div>
          </div>
          <div>
            <div className="text-xs font-bold text-[var(--muted)]">Margin</div>
            <div
              className={`font-black ${
                marginAmount >= 0 ? "text-[var(--text)]" : "text-red-500"
              }`}
            >
              {formatMoney(marginAmount, company?.currency)}
              {marginPct !== null && (
                <span className="ml-1 text-xs font-bold text-[var(--muted)]">
                  ({marginPct}%)
                </span>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs font-bold text-[var(--muted)]">
              Alert below
            </div>
            <div className="font-black text-[var(--text)]">
              {product.lowStockThreshold.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Barcode */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionTitle>Barcode</SectionTitle>
          {product.barcode && (
            <button
              type="button"
              onClick={printBarcode}
              className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] px-3 py-1 text-xs font-bold text-[var(--text)] shadow-[2px_2px_0px_var(--shadow)] hover:bg-[var(--hover)]"
            >
              🖨 Print label
            </button>
          )}
        </div>
        {product.barcode ? (
          <div className={`${cardClass} p-5`}>
            <BarcodeView value={product.barcode} />
          </div>
        ) : (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No barcode yet — add or generate one by editing this product.
          </div>
        )}
      </div>

      {/* Per-location stock */}
      <div className="space-y-3">
        <SectionTitle>Stock by location</SectionTitle>
        {levels.length === 0 ? (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No stock recorded yet.
          </div>
        ) : (
          <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
            {levels.map((l) => (
              <div
                key={l.location.id}
                className="flex items-center justify-between px-4 py-3"
              >
                <span className="text-sm font-bold text-[var(--text)]">
                  {l.location.name}
                </span>
                <span
                  className={`rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-sm font-black ${
                    l.lowStock
                      ? "bg-red-500 text-white"
                      : "bg-[var(--panel)] text-[var(--text)]"
                  }`}
                >
                  {l.quantity.toLocaleString()} {product.unit}
                  {l.lowStock && " · low!"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <div className="space-y-3">
        <SectionTitle>
          History{" "}
          <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
            ({total} movements)
          </span>
        </SectionTitle>
        {movements.length === 0 ? (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No movements yet.
          </div>
        ) : (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className={th}>When</th>
                  <th className={th}>Location</th>
                  <th className={th}>Type</th>
                  <th className={`${th} text-right`}>Qty</th>
                  <th className={th}>By</th>
                  <th className={th}>Ref</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {movements.map((m) => (
                  <tr key={m.id} className="hover:bg-[var(--hover)]">
                    <td
                      className={`${td} whitespace-nowrap font-semibold text-[var(--muted)]`}
                    >
                      {new Date(m.createdAt).toLocaleString()}
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]`}>
                      {m.location.name}
                    </td>
                    <td className={td}>
                      <span
                        className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
                        style={{ background: TYPE_COLORS[m.type] ?? "#666" }}
                      >
                        {m.type}
                      </span>
                    </td>
                    <td className={`${td} text-right`}>
                      <span
                        className={`rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-xs font-black text-white ${
                          qtyNum(m.quantity) > 0
                            ? "bg-emerald-500"
                            : "bg-red-500"
                        }`}
                      >
                        {qtyNum(m.quantity) > 0
                          ? `+${formatQty(m.quantity)}`
                          : formatQty(m.quantity)}
                      </span>
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]`}>
                      {m.createdBy.name}
                    </td>
                    <td
                      className={`${td} font-mono text-xs text-[var(--muted)]`}
                    >
                      <PoRefLink reference={m.reference} />
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
