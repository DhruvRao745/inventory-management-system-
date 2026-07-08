/**
 * Stock page — the diary counter, on screen.
 *
 * Three parts:
 *   1. "Record movement" form (the everyday tool)
 *   2. "Transfer" modal (goods walking between locations)
 *   3. The diary — movement history, newest first
 *
 * New pattern: the product/location dropdowns are fed by the API.
 * The ids you copied by hand in Postman? The <select> now carries
 * them invisibly — pick a name, the id rides along.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { Product, Location, StockMovement } from "../lib/types";
import { Modal } from "../components/Modal";

const MOVEMENT_TYPES = [
  { value: "PURCHASE", label: "Purchase (stock in)" },
  { value: "SALE", label: "Sale (stock out)" },
  { value: "RETURN_IN", label: "Customer return (in)" },
  { value: "RETURN_OUT", label: "Return to supplier (out)" },
  { value: "ADJUSTMENT", label: "Adjustment (+/−)" },
] as const;

type MovementsResponse = {
  items: StockMovement[];
  total: number;
  take: number;
  skip: number;
};

export function StockPage() {
  // --- reference data for dropdowns ---
  const [products, setProducts] = useState<Product[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

  // --- movement form ---
  const [productId, setProductId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [type, setType] =
    useState<(typeof MOVEMENT_TYPES)[number]["value"]>("PURCHASE");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- transfer modal ---
  const [transferOpen, setTransferOpen] = useState(false);
  const [tProductId, setTProductId] = useState("");
  const [tFrom, setTFrom] = useState("");
  const [tTo, setTTo] = useState("");
  const [tQuantity, setTQuantity] = useState("");
  const [tError, setTError] = useState<string | null>(null);

  // --- history ---
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function loadHistory() {
    setLoading(true);
    setError(null);
    try {
      const data = await api<MovementsResponse>("/stock/movements");
      setMovements(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  // On arrival: dropdown data + history, all in parallel
  useEffect(() => {
    Promise.all([
      api<Product[]>("/products"),
      api<Location[]>("/locations"),
    ]).then(([prods, locs]) => {
      setProducts(prods);
      setLocations(locs);
      // preselect sensible defaults so the form is one keystroke away
      if (prods.length > 0) setProductId(prods[0].id);
      if (locs.length > 0) setLocationId(locs[0].id);
    });
    loadHistory();
  }, []);

  async function submitMovement(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormOk(null);
    setBusy(true);
    try {
      await api("/stock/movements", {
        method: "POST",
        body: {
          productId,
          locationId,
          type,
          quantity: Number(quantity),
          unitCost: unitCost ? Number(unitCost) : undefined,
          reference: reference || undefined,
          note: note || undefined,
        },
      });
      setQuantity("");
      setUnitCost("");
      setReference("");
      setNote("");
      setFormOk("Recorded ✓");
      await loadHistory();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to record");
    } finally {
      setBusy(false);
    }
  }

  async function submitTransfer(e: FormEvent) {
    e.preventDefault();
    setTError(null);
    try {
      await api("/stock/transfer", {
        method: "POST",
        body: {
          productId: tProductId,
          fromLocationId: tFrom,
          toLocationId: tTo,
          quantity: Number(tQuantity),
        },
      });
      setTransferOpen(false);
      setTQuantity("");
      await loadHistory();
    } catch (err) {
      setTError(err instanceof ApiError ? err.message : "Transfer failed");
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";
  const isIncoming = type === "PURCHASE" || type === "RETURN_IN";

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">Stock</h1>
        <button
          onClick={() => {
            setTProductId(products[0]?.id ?? "");
            setTFrom(locations[0]?.id ?? "");
            setTTo(locations[1]?.id ?? "");
            setTError(null);
            setTransferOpen(true);
          }}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
        >
          ⇄ Transfer between locations
        </button>
      </div>

      {/* Record movement */}
      <div className="mt-4 bg-white rounded-xl shadow-sm p-5 max-w-2xl">
        <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
          Record movement
        </h2>
        <form onSubmit={submitMovement} className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Product
              </label>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className={inputClass}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Location
              </label>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className={inputClass}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">Type</label>
              <select
                value={type}
                onChange={(e) =>
                  setType(e.target.value as typeof type)
                }
                className={inputClass}
              >
                {MOVEMENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Quantity{" "}
                {type === "ADJUSTMENT" && (
                  <span className="text-slate-400">(use − for losses)</span>
                )}
              </label>
              <input
                type="number"
                required
                step="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                className={inputClass}
              />
            </div>
          </div>

          {/* Purchase-only fields — the form adapts to the story */}
          {isIncoming && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-600 mb-1">
                  Unit cost (optional)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={unitCost}
                  onChange={(e) => setUnitCost(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-600 mb-1">
                  Reference / invoice (optional)
                </label>
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm text-slate-600 mb-1">
              Note (optional)
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={inputClass}
            />
          </div>

          {formError && (
            <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {formError}
            </p>
          )}
          {formOk && (
            <p className="text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2">
              {formOk}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || products.length === 0}
            className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
          >
            {busy ? "Recording…" : "Record"}
          </button>
        </form>
      </div>

      {/* History */}
      <div className="mt-6">
        <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
          History{" "}
          <span className="text-slate-400 font-normal">
            ({total} movements)
          </span>
        </h2>

        {loading && <p className="mt-3 text-slate-400 text-sm">Loading…</p>}
        {error && (
          <p className="mt-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        {!loading && !error && movements.length === 0 && (
          <p className="mt-3 text-slate-400 text-sm">No movements yet.</p>
        )}

        {!loading && !error && movements.length > 0 && (
          <div className="mt-3 bg-white rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-slate-500">
                  <th className="px-4 py-3 font-medium">When</th>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium">Location</th>
                  <th className="px-4 py-3 font-medium">Type</th>
                  <th className="px-4 py-3 font-medium text-right">Qty</th>
                  <th className="px-4 py-3 font-medium">By</th>
                  <th className="px-4 py-3 font-medium">Ref</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((m) => (
                  <tr key={m.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                      {new Date(m.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-slate-800">
                      {m.product.name}
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
                    <td className="px-4 py-3 text-slate-400">
                      {m.reference ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Transfer modal */}
      {transferOpen && (
        <Modal title="Transfer stock" onClose={() => setTransferOpen(false)}>
          <form onSubmit={submitTransfer} className="space-y-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Product
              </label>
              <select
                value={tProductId}
                onChange={(e) => setTProductId(e.target.value)}
                className={inputClass}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-600 mb-1">From</label>
                <select
                  value={tFrom}
                  onChange={(e) => setTFrom(e.target.value)}
                  className={inputClass}
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-slate-600 mb-1">To</label>
                <select
                  value={tTo}
                  onChange={(e) => setTTo(e.target.value)}
                  className={inputClass}
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Quantity
              </label>
              <input
                type="number"
                required
                min="1"
                step="1"
                value={tQuantity}
                onChange={(e) => setTQuantity(e.target.value)}
                className={inputClass}
              />
            </div>

            {tError && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {tError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setTransferOpen(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-700"
              >
                Transfer
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
