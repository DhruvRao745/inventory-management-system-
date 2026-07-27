/**
 * Products page — neubrutalist edition. Same logic as before;
 * presentation rebuilt on the token system.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Product, StockLevel, Supplier } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { Modal } from "../components/Modal";
import { ConfirmModal } from "../components/ConfirmModal";
import { hashColor } from "../lib/colors";
import {
  Button,
  Input,
  Select,
  Field,
  ErrorAlert,
  cardClass,
} from "../components/ui";

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void>;
};

const emptyForm = {
  sku: "",
  name: "",
  description: "",
  categoryId: "",
  preferredSupplierId: "",
  unit: "pcs",
  costPrice: "0",
  sellingPrice: "0",
  lowStockThreshold: "0",
  tracksBatch: false,
};
type ProductForm = typeof emptyForm;

type CategoryWithCount = { id: string; name: string; productCount: number };
type ProductsResponse = {
  items: Product[];
  total: number;
  take: number;
  skip: number;
};

const PAGE_SIZE = 25;

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

export function ProductsPage() {
  const { user } = useAuth();
  const canWrite = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [products, setProducts] = useState<Product[]>([]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // stock-on-hand per product (summed over locations) + low-stock flags
  const [onHand, setOnHand] = useState<Map<string, number>>(new Map());
  const [lowIds, setLowIds] = useState<Set<string>>(new Set());
  const [categories, setCategories] = useState<CategoryWithCount[]>([]);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  const [catModalOpen, setCatModalOpen] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [catError, setCatError] = useState<string | null>(null);

  const [modal, setModal] = useState<"closed" | "add" | "edit">("closed");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProductForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(searchTerm = "", catId = "", skipVal = 0) {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (searchTerm) params.set("search", searchTerm);
      if (catId) params.set("categoryId", catId);
      params.set("take", String(PAGE_SIZE));
      params.set("skip", String(skipVal));
      const data = await api<ProductsResponse>(`/products?${params}`);
      setProducts(data.items);
      setTotal(data.total);
      setSkip(data.skip);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  async function loadCategories() {
    setCategories(await api<CategoryWithCount[]>("/categories"));
  }

  async function loadLevels() {
    const levels = await api<StockLevel[]>("/stock/levels");
    const sums = new Map<string, number>();
    const low = new Set<string>();
    for (const l of levels) {
      sums.set(l.product.id, (sums.get(l.product.id) ?? 0) + l.quantity);
      if (l.lowStock) low.add(l.product.id);
    }
    setOnHand(sums);
    setLowIds(low);
  }

  useEffect(() => {
    load();
    loadCategories();
    loadLevels();
    api<Supplier[]>("/suppliers").then(setSuppliers).catch(() => {});
  }, []);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    load(search, categoryFilter, 0); // new search → back to page 1
  }

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
      preferredSupplierId: p.preferredSupplierId ?? "",
      unit: p.unit,
      costPrice: p.costPrice,
      sellingPrice: p.sellingPrice,
      lowStockThreshold: String(p.lowStockThreshold),
      tracksBatch: p.tracksBatch,
    });
    setFormError(null);
    setModal("edit");
  }

  function setField(field: keyof ProductForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    const body = {
      sku: form.sku,
      name: form.name,
      description: form.description || undefined,
      categoryId: form.categoryId,
      preferredSupplierId: form.preferredSupplierId,
      unit: form.unit,
      costPrice: Number(form.costPrice),
      sellingPrice: Number(form.sellingPrice),
      lowStockThreshold: Number(form.lowStockThreshold),
      tracksBatch: form.tracksBatch,
    };
    try {
      if (modal === "add") {
        await api("/products", { method: "POST", body });
      } else {
        await api(`/products/${editingId}`, { method: "PATCH", body });
      }
      setModal("closed");
      await load(search, categoryFilter, skip);
      await loadCategories();
      await loadLevels();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function handleRetire(p: Product) {
    setConfirm({
      title: `Retire "${p.name}"?`,
      message:
        "It will disappear from active lists. Its history and stock records stay intact — you can't undo this from here.",
      confirmLabel: "Retire",
      danger: true,
      action: async () => {
        await api(`/products/${p.id}`, { method: "DELETE" });
        await load(search, categoryFilter, skip);
        await loadLevels();
      },
    });
  }

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

  function deleteCategory(c: CategoryWithCount) {
    setConfirm({
      title: `Delete "${c.name}"?`,
      message:
        c.productCount > 0
          ? `Its ${c.productCount} product(s) will become uncategorized.`
          : "This category will be removed.",
      confirmLabel: "Delete",
      danger: true,
      action: async () => {
        await api(`/categories/${c.id}`, { method: "DELETE" });
        await loadCategories();
        await load(search, categoryFilter, skip);
      },
    });
  }

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <form onSubmit={handleSearch} className="flex flex-wrap items-center gap-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or SKU…"
            className="w-64"
          />
          <Select
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              load(search, e.target.value, 0);
            }}
            className="w-48"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.productCount})
              </option>
            ))}
          </Select>
          <Button variant="secondary" type="submit">
            Search
          </Button>
        </form>
        {canWrite && (
          <>
            <button
              type="button"
              onClick={() => {
                setCatError(null);
                setCatModalOpen(true);
              }}
              className="text-sm font-bold text-[var(--muted)] underline hover:text-[var(--text)]"
            >
              Manage categories
            </button>
            <div className="ml-auto">
              <Button onClick={openAdd}>+ Add product</Button>
            </div>
          </>
        )}
      </div>

      {/* States */}
      {loading && (
        <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>
      )}
      {error && <ErrorAlert>{error}</ErrorAlert>}
      {!loading && !error && products.length === 0 && (
        <div className={`${cardClass} p-8 text-center`}>
          <div className="text-lg font-black text-[var(--text)]">
            No products yet
          </div>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            {canWrite
              ? "Add your first product to start tracking stock."
              : "Nothing here yet."}
          </p>
          {canWrite && (
            <div className="mt-4">
              <Button onClick={openAdd}>+ Add product</Button>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      {!loading && !error && products.length > 0 && (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                <th className={th}>SKU</th>
                <th className={th}>Name</th>
                <th className={th}>Category</th>
                <th className={th}>Unit</th>
                <th className={`${th} text-right`}>On hand</th>
                <th className={`${th} text-right`}>Cost</th>
                <th className={`${th} text-right`}>Price</th>
                <th className={`${th} text-right`}>Alert below</th>
                {canWrite && <th className={th} />}
              </tr>
            </thead>
            <tbody className="divide-y-2 divide-[var(--line)]/20">
              {products.map((p) => (
                <tr
                  key={p.id}
                  className="hover:bg-[var(--hover)]"
                  style={
                    lowIds.has(p.id)
                      ? { background: "rgba(239, 68, 68, 0.07)" }
                      : undefined
                  }
                >
                  <td className={`${td} font-mono text-xs text-[var(--muted)]`}>
                    {p.sku}
                  </td>
                  <td className={td}>
                    <Link
                      to={`/products/${p.id}`}
                      className="font-bold text-[var(--text)] hover:underline"
                    >
                      {p.name}
                    </Link>
                    {lowIds.has(p.id) && (
                      <span
                        className="ml-2 text-xs font-black text-red-500"
                        title="Low stock at one or more locations"
                      >
                        ⚠ low
                      </span>
                    )}
                  </td>
                  <td className={td}>
                    {p.category ? (
                      <span
                        className="rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-xs font-black text-white"
                        style={{ background: hashColor(p.category.name) }}
                      >
                        {p.category.name}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--muted)]/50">—</span>
                    )}
                  </td>
                  <td className={`${td} font-semibold text-[var(--muted)]`}>
                    {p.unit}
                  </td>
                  <td
                    className={`${td} text-right font-black ${
                      lowIds.has(p.id) ? "text-red-500" : "text-[var(--text)]"
                    }`}
                  >
                    {onHand.get(p.id) ?? 0}
                  </td>
                  <td
                    className={`${td} text-right font-semibold text-[var(--muted)]`}
                  >
                    {Number(p.costPrice).toFixed(2)}
                  </td>
                  <td className={`${td} text-right font-bold text-[var(--text)]`}>
                    {Number(p.sellingPrice).toFixed(2)}
                  </td>
                  <td
                    className={`${td} text-right font-semibold text-[var(--muted)]`}
                  >
                    {p.lowStockThreshold}
                  </td>
                  {canWrite && (
                    <td className={`${td} whitespace-nowrap text-right`}>
                      <button
                        onClick={() => openEdit(p)}
                        className="font-bold text-[var(--muted)] hover:text-[var(--accent)]"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleRetire(p)}
                        className="ml-4 font-bold text-[var(--muted)]/60 hover:text-red-500"
                      >
                        Retire
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t-2 border-[var(--line)] bg-[var(--panel)] px-4 py-2.5">
            <span className="text-xs font-bold text-[var(--muted)]">
              Showing {total === 0 ? 0 : skip + 1}–{skip + products.length} of{" "}
              {total}
            </span>
            {total > PAGE_SIZE && (
              <div className="flex items-center gap-2">
                <button
                  disabled={skip === 0}
                  onClick={() =>
                    load(search, categoryFilter, Math.max(0, skip - PAGE_SIZE))
                  }
                  className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--card)] px-2 py-0.5 text-xs font-black text-[var(--text)] disabled:opacity-40"
                >
                  ‹
                </button>
                <span className="text-xs font-bold text-[var(--muted)]">
                  {Math.floor(skip / PAGE_SIZE) + 1} /{" "}
                  {Math.ceil(total / PAGE_SIZE)}
                </span>
                <button
                  disabled={skip + PAGE_SIZE >= total}
                  onClick={() =>
                    load(search, categoryFilter, skip + PAGE_SIZE)
                  }
                  className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--card)] px-2 py-0.5 text-xs font-black text-[var(--text)] disabled:opacity-40"
                >
                  ›
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add / Edit modal */}
      {modal !== "closed" && (
        <Modal
          title={modal === "add" ? "Add product" : "Edit product"}
          onClose={() => setModal("closed")}
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="SKU">
                <Input
                  required
                  value={form.sku}
                  onChange={(e) => setField("sku", e.target.value)}
                />
              </Field>
              <Field label="Unit">
                <Input
                  required
                  value={form.unit}
                  onChange={(e) => setField("unit", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Name">
              <Input
                required
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
              />
            </Field>
            <Field label="Description" hint="optional">
              <Input
                value={form.description}
                onChange={(e) => setField("description", e.target.value)}
              />
            </Field>
            <Field label="Category" hint="optional">
              <Select
                value={form.categoryId}
                onChange={(e) => setField("categoryId", e.target.value)}
              >
                <option value="">— none —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Preferred supplier" hint="optional">
              <Select
                value={form.preferredSupplierId}
                onChange={(e) =>
                  setField("preferredSupplierId", e.target.value)
                }
              >
                <option value="">— none —</option>
                {suppliers
                  .filter(
                    (s) => s.isActive || s.id === form.preferredSupplierId
                  )
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {!s.isActive ? " (inactive)" : ""}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-4">
              <Field label="Cost">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={form.costPrice}
                  onChange={(e) => setField("costPrice", e.target.value)}
                />
              </Field>
              <Field label="Price">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={form.sellingPrice}
                  onChange={(e) => setField("sellingPrice", e.target.value)}
                />
              </Field>
              <Field label="Alert below">
                <Input
                  type="number"
                  min="0"
                  step="1"
                  required
                  value={form.lowStockThreshold}
                  onChange={(e) =>
                    setField("lowStockThreshold", e.target.value)
                  }
                />
              </Field>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-sm font-bold text-[var(--text)]">
              <input
                type="checkbox"
                checked={form.tracksBatch}
                onChange={(e) =>
                  setForm((f) => ({ ...f, tracksBatch: e.target.checked }))
                }
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Track batch &amp; expiry (for perishables)
            </label>

            {formError && <ErrorAlert>{formError}</ErrorAlert>}

            <div className="flex justify-end gap-3 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setModal("closed")}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Manage categories modal */}
      {catModalOpen && (
        <Modal title="Categories" onClose={() => setCatModalOpen(false)}>
          <form onSubmit={addCategory} className="flex gap-3">
            <Input
              required
              minLength={2}
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="New category name…"
            />
            <Button type="submit" className="whitespace-nowrap">
              Add
            </Button>
          </form>
          {catError && (
            <div className="mt-3">
              <ErrorAlert>{catError}</ErrorAlert>
            </div>
          )}
          <div className="mt-4 divide-y-2 divide-[var(--line)]/20">
            {categories.length === 0 && (
              <p className="text-sm font-semibold text-[var(--muted)]">
                No categories yet.
              </p>
            )}
            {categories.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between py-2.5"
              >
                <span className="text-sm font-bold text-[var(--text)]">
                  {c.name}
                  <span className="ml-2 text-xs font-semibold text-[var(--muted)]">
                    {c.productCount} product{c.productCount === 1 ? "" : "s"}
                  </span>
                </span>
                <button
                  onClick={() => deleteCategory(c)}
                  className="text-xs font-bold text-[var(--muted)]/60 hover:text-red-500"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </Modal>
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.action}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
