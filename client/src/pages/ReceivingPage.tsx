/**
 * Receiving — the two sides of the supplier relationship (P1-7).
 *
 * DELIVERIES (goods receipts) are read-only here on purpose. A receipt is
 * created by receiving against a purchase order, never on its own, because a
 * delivery only means anything in the context of the order it fulfils. Letting
 * someone type one in freehand would be a way to invent stock from nothing.
 *
 * The column that matters on a delivery is ACCEPTED, not "arrived". Only
 * accepted goods entered stock; rejected goods are recorded so you can chase
 * the supplier, but they were never inventory. And the cost that moved the
 * weighted average is the price we were ACTUALLY charged, which is not always
 * the price that was quoted on the order.
 *
 * RETURNS TO SUPPLIER go the other way. The thing this screen has to make
 * unmissable: stock leaves on SEND, not on draft. A draft is paperwork; sending
 * is the moment the goods physically go, and that's when the ledger moves.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  type GoodsReceipt,
  type SupplierReturn,
  type SupplierReturnStatus,
  grnNumber,
  srtNumber,
  poNumber,
} from "../lib/types";
import { formatMoney, formatQty, qtyNum } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Input,
  Select,
  Field,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";
import { Modal } from "../components/Modal";

type Tab = "deliveries" | "returns";

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

const SR_STATUS_COLORS: Record<SupplierReturnStatus, string> = {
  DRAFT: "#9a9ba3",
  SENT: "#f59e0b",
  COMPLETED: "#10b981",
  CANCELLED: "#ef4444",
};

function SupplierReturnPill({ status }: { status: SupplierReturnStatus }) {
  return (
    <span
      className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
      style={{ background: SR_STATUS_COLORS[status] }}
    >
      {status}
    </span>
  );
}

function ActionButton({
  children,
  onClick,
  busy,
  danger,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={title}
      className={`rounded-[4px] border-2 border-[var(--line)] px-2 py-1 text-xs font-bold disabled:opacity-40 ${
        danger
          ? "bg-[var(--card)] text-red-500 hover:bg-red-500 hover:text-white"
          : "bg-[var(--card)] text-[var(--text)] hover:bg-[var(--hover)]"
      }`}
    >
      {busy ? "…" : children}
    </button>
  );
}

export function ReceivingPage() {
  const [tab, setTab] = useState<Tab>("deliveries");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Receiving</SectionTitle>
        <div className="flex gap-2">
          <TabButton active={tab === "deliveries"} onClick={() => setTab("deliveries")}>
            Deliveries
          </TabButton>
          <TabButton active={tab === "returns"} onClick={() => setTab("returns")}>
            Returns to supplier
          </TabButton>
        </div>
      </div>

      {tab === "deliveries" ? <DeliveriesTab /> : <SupplierReturnsTab />}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-[5px] border-2 border-[var(--line)] px-3 py-1.5 text-sm font-bold shadow-[4px_4px_0px_var(--shadow)] transition-all duration-100 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none ${
        active
          ? "bg-[var(--btn)] text-[var(--btn-text)]"
          : "bg-[var(--card)] text-[var(--text)] hover:bg-[var(--hover)]"
      }`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Deliveries — read-only                                              */
/* ------------------------------------------------------------------ */

function DeliveriesTab() {
  const { company } = useAuth();
  const currency = company?.currency;

  const [rows, setRows] = useState<GoodsReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    api<{ items: GoodsReceipt[] }>("/supplier-returns/receipts")
      .then((d) => setRows(d.items))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <p className="text-sm font-semibold text-[var(--muted)]">
        Deliveries are created by receiving against a purchase order — they
        can't be raised here. Only the <strong>accepted</strong> quantity ever
        entered stock.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          No deliveries recorded yet. Receive against a purchase order to create
          one.
        </div>
      ) : (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                <th className={th}>Delivery</th>
                <th className={th}>Order</th>
                <th className={th}>Supplier</th>
                <th className={th}>Location</th>
                <th className={`${th} text-right`}>Accepted</th>
                <th className={`${th} text-right`}>Rejected</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const accepted = r.lines.reduce(
                  (s, l) => s + qtyNum(l.acceptedQty),
                  0
                );
                const rejected = r.lines.reduce(
                  (s, l) => s + qtyNum(l.rejectedQty),
                  0
                );
                const isOpen = openId === r.id;
                return (
                  // The key belongs on the OUTERMOST element the map returns —
                  // a row can expand into two <tr>s, so the fragment carries it.
                  <Fragment key={r.id}>
                    <tr className="border-b border-[var(--line)] last:border-0">
                      <td className={`${td} font-black text-[var(--text)]`}>
                        {grnNumber(r.number)}
                      </td>
                      <td className={`${td} font-semibold text-[var(--muted)]`}>
                        {poNumber(r.purchaseOrder.number)}
                      </td>
                      <td className={`${td} font-bold text-[var(--text)]`}>
                        {r.purchaseOrder.supplier.name}
                      </td>
                      <td className={`${td} font-semibold text-[var(--muted)]`}>
                        {r.location.name}
                      </td>
                      <td className={`${td} text-right font-black text-emerald-600`}>
                        {formatQty(accepted)}
                      </td>
                      <td
                        className={`${td} text-right font-black ${
                          rejected > 0 ? "text-red-600" : "text-[var(--muted)]"
                        }`}
                      >
                        {rejected > 0 ? formatQty(rejected) : "—"}
                      </td>
                      <td className={`${td} text-right`}>
                        <ActionButton onClick={() => setOpenId(isOpen ? null : r.id)}>
                          {isOpen ? "Hide" : "Lines"}
                        </ActionButton>
                      </td>
                    </tr>

                    {isOpen && (
                      <tr className="bg-[var(--panel)]">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="space-y-2">
                            {r.lines.map((l) => (
                              <div
                                key={l.id}
                                className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--line)] pb-2 last:border-0 last:pb-0"
                              >
                                <div>
                                  <span className="font-bold text-[var(--text)]">
                                    {l.product.name}
                                  </span>
                                  <span className="ml-2 text-xs font-semibold text-[var(--muted)]">
                                    {l.product.sku}
                                    {l.batchNumber && ` · batch ${l.batchNumber}`}
                                  </span>
                                  {l.rejectReason && (
                                    <div className="text-xs font-semibold text-red-600">
                                      Rejected: {l.rejectReason}
                                    </div>
                                  )}
                                </div>
                                <div className="flex gap-4 text-sm font-semibold">
                                  <span className="text-emerald-600">
                                    {formatQty(l.acceptedQty, l.product.unit)}{" "}
                                    accepted
                                  </span>
                                  {qtyNum(l.rejectedQty) > 0 && (
                                    <span className="text-red-600">
                                      {formatQty(l.rejectedQty, l.product.unit)}{" "}
                                      rejected
                                    </span>
                                  )}
                                  <span
                                    className="text-[var(--muted)]"
                                    title="What we were actually charged — this is what moved the average cost"
                                  >
                                    @{" "}
                                    {formatMoney(
                                      Number(l.actualUnitCost),
                                      currency
                                    )}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Returns to supplier                                                 */
/* ------------------------------------------------------------------ */

const SR_STATUS_FILTERS: (SupplierReturnStatus | "")[] = [
  "",
  "DRAFT",
  "SENT",
  "COMPLETED",
  "CANCELLED",
];

/** One editable row in the "return to supplier" form. */
type DraftLine = { quantity: string; notes: string };

function SupplierReturnsTab() {
  const { user: me } = useAuth();
  const canDecide = me?.role === "ADMIN" || me?.role === "MANAGER";

  const [rows, setRows] = useState<SupplierReturn[]>([]);
  const [status, setStatus] = useState<SupplierReturnStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // --- create modal ---
  const [creating, setCreating] = useState(false);
  const [receipts, setReceipts] = useState<GoodsReceipt[]>([]);
  const [receiptId, setReceiptId] = useState("");
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = status ? `?status=${status}` : "";
    api<{ items: SupplierReturn[] }>(`/supplier-returns${qs}`)
      .then((d) => setRows(d.items))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [status]);

  useEffect(load, [load]);

  async function advance(id: string, action: string) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/supplier-returns/${id}/${action}`, { method: "POST" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function openCreate() {
    setCreating(true);
    setFormError(null);
    setReceiptId("");
    setDraft({});
    setReason("");
    try {
      const d = await api<{ items: GoodsReceipt[] }>(
        "/supplier-returns/receipts"
      );
      setReceipts(d.items);
    } catch {
      setFormError("Could not load deliveries");
    }
  }

  const receipt = receipts.find((r) => r.id === receiptId) ?? null;

  async function submit() {
    setFormError(null);
    if (!receipt) {
      setFormError("Choose the delivery these goods came in on");
      return;
    }

    const lines = receipt.lines
      .filter((l) => Number(draft[l.id]?.quantity) > 0)
      .map((l) => ({
        productId: l.productId,
        quantity: Number(draft[l.id]!.quantity),
        goodsReceiptLineId: l.id,
        notes: draft[l.id]!.notes.trim() || undefined,
      }));

    if (lines.length === 0) {
      setFormError("Enter a quantity for at least one item");
      return;
    }

    setSaving(true);
    try {
      await api("/supplier-returns", {
        method: "POST",
        body: {
          supplierId: receipt.purchaseOrder.supplier.id,
          locationId: receipt.location.id,
          goodsReceiptId: receipt.id,
          reason: reason.trim() || undefined,
          lines,
        },
      });
      setCreating(false);
      load();
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not raise the return"
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Select
          value={status}
          onChange={(e) =>
            setStatus(e.target.value as SupplierReturnStatus | "")
          }
        >
          {SR_STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>
              {s || "All statuses"}
            </option>
          ))}
        </Select>
        {canDecide && <Button onClick={openCreate}>Return to supplier</Button>}
      </div>

      <p className="text-sm font-semibold text-[var(--muted)]">
        A draft is just paperwork. Stock leaves the moment you press{" "}
        <strong>Send</strong> — that's when the goods physically go back and the
        ledger moves.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          No supplier returns yet.
        </div>
      ) : (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                <th className={th}>Return</th>
                <th className={th}>Supplier</th>
                <th className={th}>Location</th>
                <th className={th}>Items</th>
                <th className={th}>Reason</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-[var(--line)] last:border-0"
                >
                  <td className={`${td} font-black text-[var(--text)]`}>
                    {srtNumber(r.number)}
                  </td>
                  <td className={`${td} font-bold text-[var(--text)]`}>
                    {r.supplier.name}
                  </td>
                  <td className={`${td} font-semibold text-[var(--muted)]`}>
                    {r.location.name}
                  </td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      {r.lines.map((l) => (
                        <span
                          key={l.id}
                          title={l.product.name}
                          className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-black text-[var(--text)]"
                        >
                          {formatQty(l.quantity)} {l.product.unit}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className={`${td} font-semibold text-[var(--muted)]`}>
                    {r.reason ?? "—"}
                  </td>
                  <td className={td}>
                    <SupplierReturnPill status={r.status} />
                  </td>
                  <td className={`${td} text-right`}>
                    {canDecide && (
                      <div className="flex justify-end gap-1">
                        {r.status === "DRAFT" && (
                          <>
                            <ActionButton
                              busy={busyId === r.id}
                              onClick={() => advance(r.id, "send")}
                              title="Goods leave now — stock decreases"
                            >
                              Send
                            </ActionButton>
                            <ActionButton
                              busy={busyId === r.id}
                              danger
                              onClick={() => advance(r.id, "cancel")}
                            >
                              Cancel
                            </ActionButton>
                          </>
                        )}
                        {r.status === "SENT" && (
                          <ActionButton
                            busy={busyId === r.id}
                            onClick={() => advance(r.id, "complete")}
                            title="Supplier has credited or replaced the goods"
                          >
                            Complete
                          </ActionButton>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <Modal title="Return to supplier" onClose={() => setCreating(false)}>
          <div className="space-y-4">
            {formError && <ErrorAlert>{formError}</ErrorAlert>}

            <Field
              label="From delivery"
              hint="links the return to how it arrived"
            >
              <Select
                value={receiptId}
                onChange={(e) => {
                  setReceiptId(e.target.value);
                  setDraft({});
                }}
              >
                <option value="">Choose a delivery…</option>
                {receipts.map((r) => (
                  <option key={r.id} value={r.id}>
                    {grnNumber(r.number)} — {r.purchaseOrder.supplier.name}
                  </option>
                ))}
              </Select>
            </Field>

            {receipt && (
              <div className="space-y-3">
                {receipt.lines.map((l) => {
                  const d = draft[l.id];
                  const max = qtyNum(l.acceptedQty);
                  return (
                    <div
                      key={l.id}
                      className={`rounded-[5px] border-2 border-[var(--line)] p-3 ${
                        max <= 0 ? "opacity-50" : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-bold text-[var(--text)]">
                          {l.product.name}
                        </span>
                        <span className="text-xs font-semibold text-[var(--muted)]">
                          {formatQty(max, l.product.unit)} accepted
                          {l.batchNumber && ` · batch ${l.batchNumber}`}
                        </span>
                      </div>

                      {max > 0 && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <Field label="Quantity to return">
                            <Input
                              type="number"
                              min="0"
                              max={max}
                              step="any"
                              value={d?.quantity ?? ""}
                              onChange={(e) =>
                                setDraft((s) => ({
                                  ...s,
                                  [l.id]: {
                                    quantity: e.target.value,
                                    notes: s[l.id]?.notes ?? "",
                                  },
                                }))
                              }
                            />
                          </Field>
                          <Field label="Note" hint="optional">
                            <Input
                              value={d?.notes ?? ""}
                              placeholder="Damaged, wrong item…"
                              onChange={(e) =>
                                setDraft((s) => ({
                                  ...s,
                                  [l.id]: {
                                    quantity: s[l.id]?.quantity ?? "",
                                    notes: e.target.value,
                                  },
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
            )}

            <Field label="Reason" hint="optional">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Short-dated, damaged in transit…"
              />
            </Field>

            <p className="text-xs font-semibold text-[var(--muted)]">
              This creates a <strong>draft</strong>. Nothing leaves stock until
              you send it.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={saving || !receiptId}>
                {saving ? "Saving…" : "Create draft"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
