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
  categoryId: "", // "" = no category
  unit: "pcs",
  costPrice: "0",
  sellingPrice: "0",
  lowStockThreshold: "0",
};
type ProductForm = typeof emptyForm;

type CategoryWithCount = { id: string; name: string; productCount: number };

export function ProductsPage() {
  const { user } = useAuth();
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  // --- state ---
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<CategoryWithCount[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");

  // manage-categories modal
  const [catModalOpen, setCatModalOpen] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [catError, setCatError] = useState<string | null>(null);

  // modal state: closed | adding | editing a specific product
  const [modal, setModal] = useState<"closed" | "add" | "edit">("closed");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProductForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- data loading ---
  async function load(searchTerm = "", catId = "") {
    setLoading(true);
    setError(null);
    try {
      // URLSearchParams builds "?search=pen&categoryId=..." safely
      const params = new URLSearchParams();
      if (searchTerm) params.set("search", searchTerm);
      if (catId) params.set("categoryId", catId);
      const query = params.toString() ? `?${params.toString()}` : "";
      setProducts(await api<Product[]>(`/products${query}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function loadCategories() {
    setCategories(await api<CategoryWithCount[]>("/categories"));
  }

  useEffect(() => {
    load();
    loadCategories();
  }, []);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    load(search, categoryFilter);
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
      categoryId: p.categoryId ?? "",
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
      categoryId: form.categoryId, // "" means "no category" — server stores null
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
      await load(search, categoryFilter);
      await loadCategories(); // product counts may have changed
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
      await load(search, categoryFilter);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Failed to retire");
    }
  }

  // --- category management ---
  async function addCategory(e: FormEvent) {
    e.preventDefault();
    setCatError(null);
    try {
      await api("/categories", { method: "POST", body: { name: newCatName } });
      setNewCatName("");
      await loadCategories();
    } catch (err) {
      setCatError(err instanceof ApiError ? err.message : "Failed to add");
    }
  }

  async function deleteCategory(c: CategoryWithCount) {
    const warning =
      c.productCount > 0
        ? `Delete "${c.name}"? Its ${c.productCount} product(s) will become uncategorized.`
        : `Delete "${c.name}"?`;
    if (!window.confirm(warning)) return;
    try {
      await api(`/categories/${c.id}`, { method: "DELETE" });
      await loadCategories();
      await load(search, categoryFilter);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Failed to delete");
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

      {/* Search + category filter */}
      <form onSubmit={handleSearch} className="mt-4 flex gap-2 items-center">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or SKU…"
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <select
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value);
            load(search, e.target.value); // filter applies immediately
          }}
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} ({c.productCount})
            </option>
          ))}
        </select>
        <button className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">
          Search
        </button>
        {canWrite && (
          <button
            type="button"
            onClick={() => {
              setCatError(null);
              setCatModalOpen(true);
            }}
            className="text-sm text-slate-500 underline hover:text-slate-800 ml-2"
          >
            Manage categories
          </button>
        )}
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
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Category (optional)
              </label>
              <select
                value={form.categoryId}
                onChange={(e) => setField("categoryId", e.target.value)}
                className={inputClass}
              >
                <option value="">— none —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
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

      {/* Manage categories modal */}
      {catModalOpen && (
        <Modal title="Categories" onClose={() => setCatModalOpen(false)}>
          <form onSubmit={addCategory} className="flex gap-2">
            <input
              required
              minLength={2}
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="New category name…"
              className={inputClass}
            />
            <button className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-700 whitespace-nowrap">
              Add
            </button>
          </form>
          {catError && (
            <p className="mt-2 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {catError}
            </p>
          )}
          <div className="mt-4 divide-y divide-slate-100">
            {categories.length === 0 && (
              <p className="text-sm text-slate-400">No categories yet.</p>
            )}
            {categories.map((c) => (
              <div
                key={c.id}
                className="py-2 flex items-center justify-between"
              >
                <span className="text-sm text-slate-800">
                  {c.name}
                  <span className="ml-2 text-xs text-slate-400">
                    {c.productCount} product{c.productCount === 1 ? "" : "s"}
                  </span>
                </span>
                <button
                  onClick={() => deleteCategory(c)}
                  className="text-xs text-slate-400 hover:text-red-600"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
