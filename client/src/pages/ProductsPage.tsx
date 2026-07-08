/**
 * Products page — the item register on screen.
 *
 * The rhythm of every data page:
 *   1. state for the data + loading + error
 *   2. a load() function that calls the API
 *   3. useEffect(load, []) — fetch when the page opens
 *   4. after any change (create/edit/retire) → load() again
 *
 * We re-fetch after changes instead of hand-editing local state —
 * slightly more traffic, much harder to get wrong. Start simple.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { Product } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { Modal } from "../components/Modal";

// One object holds the form; empty strings for a fresh form
const emptyForm = {
  sku: "",
  name: "",
  description: "",
  unit: "pcs",
  costPrice: "0",
  sellingPrice: "0",
  lowStockThreshold: "0",
};
type ProductForm = typeof emptyForm;

export function ProductsPage() {
  const { user } = useAuth();
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  // --- state ---
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // modal state: closed | adding | editing a specific product
  const [modal, setModal] = useState<"closed" | "add" | "edit">("closed");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProductForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- data loading ---
  async function load(searchTerm = "") {
    setLoading(true);
    setError(null);
    try {
      const query = searchTerm
        ? `?search=${encodeURIComponent(searchTerm)}`
        : "";
      setProducts(await api<Product[]>(`/products${query}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    load(search);
  }

  // --- modal helpers ---
  function openAdd() {
    setForm(emptyForm);
    setFormError(null);
    setModal("add");
  }

  function openEdit(p: Product) {
    setEditingId(p.id);
    setForm({
      sku: p.sku,
      name: p.name,
      description: p.description ?? "",
      unit: p.unit,
      costPrice: p.costPrice,
      sellingPrice: p.sellingPrice,
      lowStockThreshold: String(p.lowStockThreshold),
    });
    setFormError(null);
    setModal("edit");
  }

  function setField(field: keyof ProductForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  // --- actions ---
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);

    // The form keeps everything as strings (inputs are text);
    // the API wants real numbers — convert at the boundary.
    const body = {
      sku: form.sku,
      name: form.name,
      description: form.description || undefined,
      unit: form.unit,
      costPrice: Number(form.costPrice),
      sellingPrice: Number(form.sellingPrice),
      lowStockThreshold: Number(form.lowStockThreshold),
    };

    try {
      if (modal === "add") {
        await api("/products", { method: "POST", body });
      } else {
        await api(`/products/${editingId}`, { method: "PATCH", body });
      }
      setModal("closed");
      await load(search);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function handleRetire(p: Product) {
    if (!window.confirm(`Retire "${p.name}"? It will disappear from lists.`))
      return;
    try {
      await api(`/products/${p.id}`, { method: "DELETE" });
      await load(search);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Failed to retire");
    }
  }

  const inputClass =
    "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";

  // --- render ---
  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-800">Products</h1>
        {canWrite && (
          <button
            onClick={openAdd}
            className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-700"
          >
            + Add product
          </button>
        )}
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="mt-4 flex gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or SKU…"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <button className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
          Search
        </button>
      </form>

      {/* The three states of every data page */}
      {loading && <p className="mt-6 text-slate-400 text-sm">Loading…</p>}
      {error && (
        <p className="mt-6 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
          {error}
        </p>
      )}
      {!loading && !error && products.length === 0 && (
        <p className="mt-6 text-slate-400 text-sm">
          No products yet. {canWrite && "Add your first one!"}
        </p>
      )}

      {!loading && !error && products.length > 0 && (
        <div className="mt-4 bg-white rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-left text-slate-500">
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Unit</th>
                <th className="px-4 py-3 font-medium text-right">Cost</th>
                <th className="px-4 py-3 font-medium text-right">Price</th>
                <th className="px-4 py-3 font-medium text-right">Alert below</th>
                {canWrite && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {p.sku}
                  </td>
                  <td className="px-4 py-3 text-slate-800">{p.name}</td>
                  <td className="px-4 py-3 text-slate-500">{p.unit}</td>
                  <td className="px-4 py-3 text-right text-slate-500">
                    {Number(p.costPrice).toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-800">
                    {Number(p.sellingPrice).toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-500">
                    {p.lowStockThreshold}
                  </td>
                  {canWrite && (
                    <td className="px-4 py-3 text-right space-x-3 whitespace-nowrap">
                      <button
                        onClick={() => openEdit(p)}
                        className="text-slate-500 hover:text-slate-900"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleRetire(p)}
                        className="text-slate-400 hover:text-red-600"
                      >
                        Retire
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add / Edit modal — one form, two jobs */}
      {modal !== "closed" && (
        <Modal
          title={modal === "add" ? "Add product" : "Edit product"}
          onClose={() => setModal("closed")}
        >
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-600 mb-1">SKU</label>
                <input
                  required
                  value={form.sku}
                  onChange={(e) => setField("sku", e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-600 mb-1">Unit</label>
                <input
                  required
                  value={form.unit}
                  onChange={(e) => setField("unit", e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">Name</label>
              <input
                required
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Description (optional)
              </label>
              <input
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm text-slate-600 mb-1">Cost</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={form.costPrice}
                  onChange={(e) => setField("costPrice", e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-600 mb-1">Price</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={form.sellingPrice}
                  onChange={(e) => setField("sellingPrice", e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-600 mb-1">
                  Alert below
                </label>
                <input
                  type="number"
                  min="0"
                  step="1"
                  required
                  value={form.lowStockThreshold}
                  onChange={(e) =>
                    setField("lowStockThreshold", e.target.value)
                  }
                  className={inputClass}
                />
              </div>
            </div>

            {formError && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {formError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setModal("closed")}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
