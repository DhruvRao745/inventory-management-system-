/**
 * Purchase order — create (/new), edit a draft, and view a placed/cancelled
 * order. One component, three modes, gated by status + role:
 *   - /new                 → create a draft
 *   - /:id  (DRAFT, admin)  → edit + place/cancel
 *   - /:id  (other)         → read-only
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type {
  PurchaseOrder,
  Supplier,
  Product,
  Location,
} from "../lib/types";
import { poNumber } from "../lib/types";
import { formatMoney, qtyNum, formatQty } from "../lib/format";
import { precisionError, stepFor } from "../lib/quantity";
import { useAuth } from "../context/AuthContext";
import { ConfirmModal } from "../components/ConfirmModal";
import { Modal } from "../components/Modal";
import { ProductPicker } from "../components/ProductPicker";
import { StatusPill } from "./PurchaseOrdersPage";
import {
  Button,
  Input,
  Select,
  Field,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";

type LineDraft = { productId: string; quantity: string; unitCost: string };

const emptyLine: LineDraft = { productId: "", quantity: "1", unitCost: "" };

export function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const { user: me, company } = useAuth();
  const currency = company?.currency;
  const canEdit = me?.role === "ADMIN" || me?.role === "MANAGER";

  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // receive modal state
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [receiveLocationId, setReceiveLocationId] = useState("");
  const [receiveQtys, setReceiveQtys] = useState<Record<string, string>>({});
  // Batch numbers, keyed by PO line id. Only batch-tracked lines use these;
  // the field isn't rendered for anything else, so the map stays sparse.
  const [receiveBatches, setReceiveBatches] = useState<Record<string, string>>(
    {}
  );
  // What the supplier ACTUALLY charged, per line. Seeded from the PO price;
  // the weighted average follows this number, not what was quoted.
  const [receiveCosts, setReceiveCosts] = useState<Record<string, string>>({});
  const [receiveError, setReceiveError] = useState<string | null>(null);
  const [receiveBusy, setReceiveBusy] = useState(false);

  // form state
  const [supplierId, setSupplierId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ ...emptyLine }]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    async function loadAll() {
      setLoading(true);
      setError(null);
      try {
        const [sup, prod, locs] = await Promise.all([
          api<Supplier[]>("/suppliers"),
          api<{ items: Product[] }>("/products?take=500"),
          api<Location[]>("/locations"),
        ]);
        setSuppliers(sup);
        setProducts(prod.items);
        setLocations(locs);
        setReceiveLocationId(locs.find((l) => l.isDefault)?.id ?? locs[0]?.id ?? "");

        if (!isNew) {
          const loaded = await api<PurchaseOrder>(`/purchase-orders/${id}`);
          setPo(loaded);
          setSupplierId(loaded.supplier.id);
          setExpectedDate(loaded.expectedDate?.slice(0, 10) ?? "");
          setNotes(loaded.notes ?? "");
          setLines(
            loaded.lines.map((l) => ({
              productId: l.productId,
              quantity: String(l.quantity),
              unitCost: l.unitCost,
            }))
          );
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const editable = isNew || (po?.status === "DRAFT" && canEdit);

  // running total from whatever's currently in the editor/view
  const total = useMemo(() => {
    if (!editable && po) {
      return po.lines.reduce(
        (s, l) => s + Number(l.unitCost) * qtyNum(l.quantity),
        0
      );
    }
    return lines.reduce(
      (s, l) => s + (Number(l.unitCost) || 0) * (Number(l.quantity) || 0),
      0
    );
  }, [editable, po, lines]);

  function setLine(i: number, patch: Partial<LineDraft>) {
    setLines((cur) => cur.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((cur) => [...cur, { ...emptyLine }]);
  }
  function removeLine(i: number) {
    setLines((cur) => (cur.length === 1 ? cur : cur.filter((_, idx) => idx !== i)));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!supplierId) return setFormError("Pick a supplier.");
    const clean = lines
      .filter((l) => l.productId)
      .map((l) => ({
        productId: l.productId,
        quantity: Number(l.quantity),
        unitCost: Number(l.unitCost || 0),
      }));
    if (clean.length === 0) return setFormError("Add at least one line.");
    if (clean.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1))
      return setFormError("Every line needs a whole quantity of 1 or more.");

    const body = {
      supplierId,
      notes: notes || undefined,
      expectedDate: expectedDate
        ? new Date(`${expectedDate}T00:00:00`).toISOString()
        : undefined,
      lines: clean,
    };

    setSaving(true);
    try {
      if (isNew) {
        const created = await api<PurchaseOrder>("/purchase-orders", {
          method: "POST",
          body,
        });
        navigate(`/purchase-orders/${created.id}`);
      } else {
        const updated = await api<PurchaseOrder>(`/purchase-orders/${id}`, {
          method: "PATCH",
          body,
        });
        setPo(updated);
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function placeOrder() {
    setFormError(null);
    try {
      const updated = await api<PurchaseOrder>(
        `/purchase-orders/${id}/status`,
        { method: "PATCH", body: { status: "ORDERED" } }
      );
      setPo(updated);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to place");
    }
  }

  function openReceive() {
    // Pre-fill each line's "receive now" with whatever's still outstanding.
    const seed: Record<string, string> = {};
    po?.lines.forEach((l) => {
      seed[l.id] = String(
        Math.max(0, qtyNum(l.quantity) - qtyNum(l.receivedQty))
      );
    });
    setReceiveQtys(seed);
    // Default the actual cost to what was ordered — the common case is that
    // the supplier charged the agreed price, and pre-filling it means the
    // operator only touches the field when something changed.
    const costs: Record<string, string> = {};
    po?.lines.forEach((l) => {
      costs[l.id] = String(Number(l.unitCost));
    });
    setReceiveCosts(costs);
    // Never carry a batch number over from a previous delivery — each
    // physical consignment has its own, and a stale one would silently
    // merge two lots into the wrong batch.
    setReceiveBatches({});
    setReceiveError(null);
    setReceiveOpen(true);
  }

  async function submitReceive(e: FormEvent) {
    e.preventDefault();
    setReceiveError(null);
    if (!receiveLocationId) return setReceiveError("Pick a location.");

    const incoming = (po?.lines ?? []).filter(
      (l) => Number(receiveQtys[l.id] || 0) > 0
    );
    if (incoming.length === 0)
      return setReceiveError("Enter a quantity for at least one item.");

    // Same rule the server enforces, checked here so the user is told BEFORE
    // the round trip — and told next to the field they have to fill in.
    // The server still checks: this is feedback, not the guard.
    const missing = incoming.find(
      (l) => l.product.tracksBatch && !receiveBatches[l.id]?.trim()
    );
    if (missing)
      return setReceiveError(
        `${missing.product.name} is batch-tracked — enter the batch number shown on the goods.`
      );

    // Same precision rule the server enforces, checked here so a legal
    // quantity is never rejected after the round trip and an illegal one is
    // explained beside the field (BUG-8).
    for (const l of incoming) {
      const problem = precisionError(receiveQtys[l.id] ?? "", l.product);
      if (problem) return setReceiveError(problem);
    }

    const linesToReceive = incoming.map((l) => {
      const typed = receiveCosts[l.id];
      const actual = typed === undefined || typed.trim() === "" ? null : Number(typed);
      const quoted = Number(l.unitCost);
      return {
        lineId: l.id,
        quantity: Number(receiveQtys[l.id]),
        // Only send it when the product actually tracks batches. Sending an
        // empty string for the rest would fail the server's min(1) check.
        ...(l.product.tracksBatch
          ? { batchNumber: receiveBatches[l.id]!.trim() }
          : {}),
        // Send the actual cost only when it DIFFERS from the quoted price.
        // Sending it always would be harmless but noisy; sending it only on
        // a change keeps "we were charged what we agreed" the silent default.
        ...(actual !== null && Number.isFinite(actual) && actual !== quoted
          ? { actualUnitCost: actual }
          : {}),
      };
    });

    setReceiveBusy(true);
    try {
      const updated = await api<PurchaseOrder>(
        `/purchase-orders/${id}/receive`,
        { method: "POST", body: { locationId: receiveLocationId, lines: linesToReceive } }
      );
      setPo(updated);
      setReceiveOpen(false);
    } catch (err) {
      setReceiveError(err instanceof ApiError ? err.message : "Receive failed");
    } finally {
      setReceiveBusy(false);
    }
  }

  if (loading)
    return <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>;
  if (error)
    return (
      <div className="space-y-4">
        <ErrorAlert>{error}</ErrorAlert>
        <Link
          to="/purchase-orders"
          className="text-sm font-bold text-[var(--accent)] underline"
        >
          ← Back to purchase orders
        </Link>
      </div>
    );
  // We have an id but the PO hasn't arrived yet (e.g. just after creating +
  // navigating). Show loading instead of crashing on null.
  if (!isNew && !po)
    return <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>;

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        to="/purchase-orders"
        className="text-sm font-bold text-[var(--muted)] underline hover:text-[var(--text)]"
      >
        ← Back to purchase orders
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <SectionTitle>
            {isNew ? "New purchase order" : poNumber(po!.number)}
          </SectionTitle>
          {po && <StatusPill status={po.status} />}
        </div>
        {/* status actions for an existing PO */}
        {po && canEdit && (
          <div className="flex gap-3">
            {po.status === "DRAFT" && (
              <Button variant="secondary" onClick={placeOrder}>
                Place order
              </Button>
            )}
            {(po.status === "ORDERED" || po.status === "PARTIAL") && (
              <Button variant="secondary" onClick={openReceive}>
                Receive items
              </Button>
            )}
            {(po.status === "DRAFT" || po.status === "ORDERED") && (
              <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                Cancel PO
              </Button>
            )}
          </div>
        )}
      </div>

      {editable ? (
        /* ---------- editable form ---------- */
        <form onSubmit={save} className={`${cardClass} space-y-5 p-5`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Supplier">
              <Select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
              >
                <option value="">Select a supplier…</option>
                {suppliers
                  .filter((s) => s.isActive || s.id === supplierId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {!s.isActive ? " (inactive)" : ""}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Expected date" hint="optional">
              <Input
                type="date"
                value={expectedDate}
                onChange={(e) => setExpectedDate(e.target.value)}
              />
            </Field>
          </div>

          {/* line editor */}
          <div className="space-y-2">
            <div className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
              Items
            </div>
            {lines.map((l, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <ProductPicker
                    products={products.filter(
                      (p) => p.isActive || p.id === l.productId
                    )}
                    value={l.productId}
                    onChange={(pid) => setLine(i, { productId: pid })}
                  />
                </div>
                <div className="w-20">
                  <Input
                    type="number"
                    min="1"
                    step="any"
                    placeholder="Qty"
                    value={l.quantity}
                    onChange={(e) => setLine(i, { quantity: e.target.value })}
                  />
                </div>
                <div className="w-28">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Unit cost"
                    value={l.unitCost}
                    onChange={(e) => setLine(i, { unitCost: e.target.value })}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  disabled={lines.length === 1}
                  className="px-2 pb-2 text-lg font-black text-[var(--muted)] hover:text-red-500 disabled:opacity-30"
                  aria-label="Remove line"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addLine}
              className="text-sm font-bold text-[var(--accent)] hover:underline"
            >
              + Add item
            </button>
          </div>

          <Field label="Notes" hint="optional">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <div className="flex items-center justify-between border-t-2 border-[var(--line)]/20 pt-4">
            <span className="text-sm font-black text-[var(--text)]">
              Total: {formatMoney(total, currency)}
            </span>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : isNew ? "Create draft" : "Save changes"}
            </Button>
          </div>

          {formError && <ErrorAlert>{formError}</ErrorAlert>}
        </form>
      ) : (
        /* ---------- read-only view ---------- */
        <>
          {formError && <ErrorAlert>{formError}</ErrorAlert>}
          <div className={`${cardClass} p-5`}>
            <div className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs font-bold text-[var(--muted)]">
                  Supplier
                </div>
                <div className="font-black text-[var(--text)]">
                  {po!.supplier.name}
                </div>
              </div>
              <div>
                <div className="text-xs font-bold text-[var(--muted)]">
                  Expected date
                </div>
                <div className="font-black text-[var(--text)]">
                  {po!.expectedDate
                    ? new Date(po!.expectedDate).toLocaleDateString()
                    : "—"}
                </div>
              </div>
              <div>
                <div className="text-xs font-bold text-[var(--muted)]">
                  Created by
                </div>
                <div className="font-black text-[var(--text)]">
                  {po!.createdBy.name}
                </div>
              </div>
            </div>
            {po!.notes && (
              <div className="mt-4 border-t-2 border-[var(--line)]/20 pt-3 text-sm font-medium italic text-[var(--muted)]">
                {po!.notes}
              </div>
            )}
          </div>

          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className="px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Product
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Ordered
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Received
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Unit cost
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Line total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {po!.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-3 text-sm font-bold text-[var(--text)]">
                      {l.product.name}
                      <span className="ml-2 font-mono text-xs text-[var(--muted)]">
                        {l.product.sku}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--muted)]">
                      {l.quantity.toLocaleString()} {l.product.unit}
                    </td>
                    <td
                      className={`px-4 py-3 text-right text-sm font-black ${
                        qtyNum(l.receivedQty) >= qtyNum(l.quantity)
                          ? "text-emerald-500"
                          : qtyNum(l.receivedQty) > 0
                            ? "text-amber-500"
                            : "text-[var(--muted)]"
                      }`}
                    >
                      {formatQty(l.receivedQty)} / {formatQty(l.quantity)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--muted)]">
                      {formatMoney(Number(l.unitCost), currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-black text-[var(--text)]">
                      {formatMoney(Number(l.unitCost) * qtyNum(l.quantity), currency)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-[var(--line)] bg-[var(--panel)]">
                  <td
                    className="px-4 py-3 text-sm font-black text-[var(--text)]"
                    colSpan={4}
                  >
                    TOTAL
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-black text-[var(--accent)]">
                    {formatMoney(total, currency)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {confirmCancel && (
        <ConfirmModal
          title={`Cancel ${po ? poNumber(po.number) : "this PO"}?`}
          message="This marks the order cancelled. It stays on record but can't be edited or placed."
          confirmLabel="Cancel PO"
          danger
          onConfirm={async () => {
            const updated = await api<PurchaseOrder>(
              `/purchase-orders/${id}/status`,
              { method: "PATCH", body: { status: "CANCELLED" } }
            );
            setPo(updated);
          }}
          onClose={() => setConfirmCancel(false)}
        />
      )}

      {receiveOpen && po && (
        <Modal title={`Receive ${poNumber(po.number)}`} onClose={() => setReceiveOpen(false)}>
          <form onSubmit={submitReceive} className="space-y-4">
            <Field label="Receive into location">
              <Select
                value={receiveLocationId}
                onChange={(e) => setReceiveLocationId(e.target.value)}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_auto_auto] gap-2 text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                <span>Item</span>
                <span className="text-right">Remaining</span>
                <span className="text-right">Receive now</span>
              </div>
              {po.lines.map((l) => {
                const remaining = Math.max(
                  0,
                  qtyNum(l.quantity) - qtyNum(l.receivedQty)
                );
                // The batch field only earns its space when the product tracks
                // batches AND something is actually coming in on this receipt.
                const receivingNow =
                  remaining > 0 && Number(receiveQtys[l.id] || 0) > 0;
                const needsBatch = l.product.tracksBatch && receivingNow;
                const qtyProblem = precisionError(
                  receiveQtys[l.id] ?? "",
                  l.product
                );
                return (
                  <div key={l.id} className="space-y-1">
                    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2">
                      <span className="text-sm font-bold text-[var(--text)]">
                        {l.product.name}
                        {l.product.tracksBatch && (
                          <span className="ml-2 rounded-[4px] border-2 border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-black uppercase tracking-wide text-[var(--muted)]">
                            Batch
                          </span>
                        )}
                      </span>
                      <span className="text-right text-sm font-semibold text-[var(--muted)]">
                        {remaining.toLocaleString()}
                      </span>
                      <div className="w-24">
                        <Input
                          type="number"
                          min="0"
                          // The product's own rule, not a blanket "any".
                          step={stepFor(l.product.precision)}
                          max={remaining}
                          disabled={remaining === 0}
                          value={receiveQtys[l.id] ?? ""}
                          onChange={(e) =>
                            setReceiveQtys((cur) => ({
                              ...cur,
                              [l.id]: e.target.value,
                            }))
                          }
                        />
                      </div>
                    </div>

                    {qtyProblem && (
                      <div className="pl-1 text-[10px] font-bold text-red-500">
                        {qtyProblem}
                      </div>
                    )}

                    {receivingNow && (
                      <div className="pl-1">
                        <Field
                          label="Actual unit cost"
                          hint={`ordered at ${formatMoney(Number(l.unitCost), currency)} — change it if the supplier charged something else`}
                        >
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={receiveCosts[l.id] ?? ""}
                            onChange={(e) =>
                              setReceiveCosts((cur) => ({
                                ...cur,
                                [l.id]: e.target.value,
                              }))
                            }
                          />
                        </Field>
                      </div>
                    )}

                    {needsBatch && (
                      <div className="pl-1">
                        <Field
                          label="Batch number"
                          hint="printed on the carton — this consignment only"
                        >
                          <Input
                            value={receiveBatches[l.id] ?? ""}
                            placeholder="e.g. WH-2026-04"
                            maxLength={60}
                            onChange={(e) =>
                              setReceiveBatches((cur) => ({
                                ...cur,
                                [l.id]: e.target.value,
                              }))
                            }
                          />
                        </Field>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p className="text-xs font-semibold text-[var(--muted)]">
              Receiving adds these quantities to stock at the chosen location and
              updates the order's progress.
            </p>

            {receiveError && <ErrorAlert>{receiveError}</ErrorAlert>}
            <div className="flex justify-end gap-3 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setReceiveOpen(false)}
                disabled={receiveBusy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={receiveBusy}>
                {receiveBusy ? "Receiving…" : "Receive"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
