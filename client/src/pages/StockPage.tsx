/**
 * Stock page — neubrutalist edition, layout informed by the Stitch
 * design: movement form + transfer card side by side, history below
 * with an Export CSV (new — exports the loaded history).
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { Product, Location, StockMovement } from "../lib/types";
import { Modal } from "../components/Modal";
import { downloadCsv } from "../lib/csv";
import { TYPE_COLORS } from "../lib/colors";
import {
  Button,
  Input,
  Select,
  Field,
  ErrorAlert,
  SuccessAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";

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

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

export function StockPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);

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

  const [transferOpen, setTransferOpen] = useState(false);
  const [tProductId, setTProductId] = useState("");
  const [tFrom, setTFrom] = useState("");
  const [tTo, setTTo] = useState("");
  const [tQuantity, setTQuantity] = useState("");
  const [tError, setTError] = useState<string | null>(null);

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

  useEffect(() => {
    Promise.all([
      // dropdowns need the catalog — 500 covers any realistic shop;
      // beyond that, these selects become searchable pickers (V2)
      api<{ items: Product[] }>("/products?take=500"),
      api<Location[]>("/locations"),
    ]).then(([prods, locs]) => {
      setProducts(prods.items);
      setLocations(locs);
      if (prods.items.length > 0) setProductId(prods.items[0].id);
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

  function exportHistory() {
    downloadCsv(
      `stock-history-${new Date().toISOString().slice(0, 10)}.csv`,
      ["When", "Product", "SKU", "Location", "Type", "Qty", "By", "Reference"],
      movements.map((m) => [
        new Date(m.createdAt).toLocaleString(),
        m.product.name,
        m.product.sku,
        m.location.name,
        m.type,
        m.quantity,
        m.createdBy.name,
        m.reference ?? "",
      ])
    );
  }

  const isIncoming = type === "PURCHASE" || type === "RETURN_IN";

  return (
    <div className="space-y-8">
      <div className="grid gap-6 xl:grid-cols-3">
        {/* Record movement */}
        <div className={`${cardClass} p-5 xl:col-span-2`}>
          <SectionTitle>Record movement</SectionTitle>
          <form onSubmit={submitMovement} className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Product">
                <Select
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.sku})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Location">
                <Select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Type">
                <Select
                  value={type}
                  onChange={(e) => setType(e.target.value as typeof type)}
                >
                  {MOVEMENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Quantity"
                hint={type === "ADJUSTMENT" ? "use − for losses" : undefined}
              >
                <Input
                  type="number"
                  required
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </Field>
            </div>

            {isIncoming && (
              <div className="grid grid-cols-2 gap-4">
                <Field label="Unit cost" hint="optional">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={unitCost}
                    onChange={(e) => setUnitCost(e.target.value)}
                  />
                </Field>
                <Field label="Reference / invoice" hint="optional">
                  <Input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="e.g. INV-2026-042"
                  />
                </Field>
              </div>
            )}

            <Field label="Note" hint="optional">
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>

            {formError && <ErrorAlert>{formError}</ErrorAlert>}
            {formOk && <SuccessAlert>{formOk}</SuccessAlert>}

            <Button type="submit" disabled={busy || products.length === 0}>
              {busy ? "Recording…" : "Record movement"}
            </Button>
          </form>
        </div>

        {/* Transfer card */}
        <div className={`${cardClass} flex flex-col items-center justify-center gap-4 p-6 text-center`}>
          <div className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--panel)] p-3 shadow-[3px_3px_0px_var(--shadow)]">
            <svg
              width="28"
              height="28"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3l4 4-4 4" />
              <path d="M21 7H7" />
              <path d="M7 21l-4-4 4-4" />
              <path d="M3 17h14" />
            </svg>
          </div>
          <div>
            <div className="text-base font-black text-[var(--text)]">
              Transfer between locations
            </div>
            <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
              Move goods from one place to another — both entries are written
              together, so the books always balance.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setTProductId(products[0]?.id ?? "");
              setTFrom(locations[0]?.id ?? "");
              setTTo(locations[1]?.id ?? "");
              setTError(null);
              setTransferOpen(true);
            }}
            disabled={locations.length < 2}
          >
            ⇄ Transfer
          </Button>
          {locations.length < 2 && (
            <p className="text-xs font-semibold text-[var(--muted)]/70">
              Add a second location in Settings to enable transfers.
            </p>
          )}
        </div>
      </div>

      {/* History */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionTitle>
            History{" "}
            <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
              ({total} movements)
            </span>
          </SectionTitle>
          <Button
            variant="secondary"
            onClick={exportHistory}
            disabled={movements.length === 0}
          >
            ⬇ Export CSV
          </Button>
        </div>

        {loading && (
          <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>
        )}
        {error && <ErrorAlert>{error}</ErrorAlert>}
        {!loading && !error && movements.length === 0 && (
          <div className={`${cardClass} p-8 text-center`}>
            <div className="text-lg font-black text-[var(--text)]">
              No movements yet
            </div>
            <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
              Record your first purchase above — the diary starts here.
            </p>
          </div>
        )}

        {!loading && !error && movements.length > 0 && (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className={th}>When</th>
                  <th className={th}>Product</th>
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
                    <td className={`${td} font-bold text-[var(--text)]`}>
                      {m.product.name}
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
                          m.quantity > 0 ? "bg-emerald-500" : "bg-red-500"
                        }`}
                      >
                        {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                      </span>
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]`}>
                      {m.createdBy.name}
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]/60`}>
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
          <form onSubmit={submitTransfer} className="space-y-4">
            <Field label="Product">
              <Select
                value={tProductId}
                onChange={(e) => setTProductId(e.target.value)}
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="From">
                <Select value={tFrom} onChange={(e) => setTFrom(e.target.value)}>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="To">
                <Select value={tTo} onChange={(e) => setTTo(e.target.value)}>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Quantity">
              <Input
                type="number"
                required
                min="1"
                step="1"
                value={tQuantity}
                onChange={(e) => setTQuantity(e.target.value)}
              />
            </Field>

            {tError && <ErrorAlert>{tError}</ErrorAlert>}

            <div className="flex justify-end gap-3 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setTransferOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Transfer</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
