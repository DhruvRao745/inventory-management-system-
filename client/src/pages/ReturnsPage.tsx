/**
 * Sales returns — list + the workflow that moves them along (P1-6).
 *
 * The one thing this screen has to make obvious: stock only comes back when
 * the goods are RECEIVED, and only the SELLABLE part of them. Damaged goods
 * are recorded but never re-enter available stock, and the UI has to show that
 * plainly or someone will assume a received return means stock is back.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  type SalesReturn,
  type SalesReturnStatus,
  type ReturnCondition,
  type ReturnableLine,
  type InvoiceRow,
  retNumber,
  invNumber,
  RETURN_CONDITION_LABELS,
} from "../lib/types";
import { formatMoney, formatQty } from "../lib/format";
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

type ListResponse = { items: SalesReturn[]; total: number };

const RETURN_STATUS_COLORS: Record<SalesReturnStatus, string> = {
  REQUESTED: "#9a9ba3",
  APPROVED: "#3b82f6",
  RECEIVED: "#f59e0b",
  REFUNDED: "#10b981",
  CANCELLED: "#ef4444",
};

export function ReturnStatusPill({ status }: { status: SalesReturnStatus }) {
  return (
    <span
      className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
      style={{ background: RETURN_STATUS_COLORS[status] }}
    >
      {status}
    </span>
  );
}

const CONDITION_COLORS: Record<ReturnCondition, string> = {
  SELLABLE: "#10b981",
  DAMAGED: "#ef4444",
  QUARANTINE: "#f59e0b",
};

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

const STATUS_FILTERS: (SalesReturnStatus | "")[] = [
  "",
  "REQUESTED",
  "APPROVED",
  "RECEIVED",
  "REFUNDED",
  "CANCELLED",
];

/** One editable row in the "raise a return" form. */
type DraftLine = {
  invoiceLineId: string;
  quantity: string;
  condition: ReturnCondition;
  restock: boolean;
};

export function ReturnsPage() {
  const { user: me, company } = useAuth();
  const canDecide = me?.role === "ADMIN" || me?.role === "MANAGER";
  const currency = company?.currency;

  const [rows, setRows] = useState<SalesReturn[]>([]);
  const [status, setStatus] = useState<SalesReturnStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // --- raise-a-return modal ---
  const [creating, setCreating] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [invoiceId, setInvoiceId] = useState("");
  const [returnable, setReturnable] = useState<ReturnableLine[] | null>(null);
  const [draft, setDraft] = useState<Record<string, DraftLine>>({});
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = status ? `?status=${status}` : "";
    api<ListResponse>(`/returns${qs}`)
      .then((d) => setRows(d.items))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [status]);

  useEffect(load, [load]);

  /** Move a return along its workflow. */
  async function advance(id: string, action: string, body?: unknown) {
    setBusyId(id);
    setError(null);
    try {
      await api(`/returns/${id}/${action}`, {
        method: "POST",
        // api() serialises the body itself — pass the plain object.
        ...(body ? { body } : {}),
      });
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
    setInvoiceId("");
    setReturnable(null);
    setDraft({});
    setReason("");
    try {
      // Only issued/paid invoices can be returned against.
      const [issued, paid] = await Promise.all([
        api<{ items: InvoiceRow[] }>("/invoices?status=ISSUED"),
        api<{ items: InvoiceRow[] }>("/invoices?status=PAID"),
      ]);
      setInvoices(
        [...issued.items, ...paid.items].sort((a, b) => b.number - a.number)
      );
    } catch {
      setFormError("Could not load invoices");
    }
  }

  /** Ask the server what's still returnable — it knows about earlier returns. */
  async function pickInvoice(id: string) {
    setInvoiceId(id);
    setReturnable(null);
    setDraft({});
    if (!id) return;
    try {
      const lines = await api<ReturnableLine[]>(`/returns/returnable/${id}`);
      setReturnable(lines);
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not load invoice lines"
      );
    }
  }

  function setLine(lineId: string, patch: Partial<DraftLine>) {
    setDraft((d) => {
      const current: DraftLine = d[lineId] ?? {
        invoiceLineId: lineId,
        quantity: "",
        condition: "SELLABLE",
        restock: true,
      };
      const next = { ...current, ...patch };
      // The rule, enforced in the UI too: only sellable goods can be
      // restocked. Switching to damaged flips restock off and locks it, so
      // nobody submits a combination the server will reject.
      if (next.condition !== "SELLABLE") next.restock = false;
      return { ...d, [lineId]: next };
    });
  }

  async function submit() {
    setFormError(null);
    const lines = Object.values(draft)
      .filter((l) => Number(l.quantity) > 0)
      .map((l) => ({
        invoiceLineId: l.invoiceLineId,
        quantity: Number(l.quantity),
        condition: l.condition,
        restock: l.restock,
      }));

    if (lines.length === 0) {
      setFormError("Enter a quantity for at least one item");
      return;
    }

    setSaving(true);
    try {
      await api("/returns", {
        method: "POST",
        body: {
          invoiceId,
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
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Sales returns</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as SalesReturnStatus | "")}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s || "All statuses"}
              </option>
            ))}
          </Select>
          <Button onClick={openCreate}>Raise a return</Button>
        </div>
      </div>

      <p className="text-sm font-semibold text-[var(--muted)]">
        Stock only comes back when goods are marked <strong>received</strong> —
        and only the part marked sellable. Damaged and quarantined goods are
        recorded here but never re-enter available stock.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          No returns yet.
        </div>
      ) : (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                <th className={th}>Return</th>
                <th className={th}>Invoice</th>
                <th className={th}>Customer</th>
                <th className={th}>Items</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Refund</th>
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
                    {retNumber(r.number)}
                  </td>
                  <td className={`${td} font-semibold text-[var(--muted)]`}>
                    {invNumber(r.invoice.number)}
                  </td>
                  <td className={`${td} font-bold text-[var(--text)]`}>
                    {r.invoice.customerName}
                  </td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      {r.lines.map((l) => (
                        <span
                          key={l.id}
                          className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black text-white"
                          style={{ background: CONDITION_COLORS[l.condition] }}
                          title={`${l.product.name} — ${RETURN_CONDITION_LABELS[l.condition]}${
                            l.restock ? " (restocked)" : " (not restocked)"
                          }`}
                        >
                          {formatQty(l.quantity)} {l.product.unit}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className={td}>
                    <ReturnStatusPill status={r.status} />
                  </td>
                  <td className={`${td} text-right font-semibold text-[var(--text)]`}>
                    {r.refundAmount
                      ? formatMoney(Number(r.refundAmount), currency)
                      : "—"}
                  </td>
                  <td className={`${td} text-right`}>
                    {canDecide && (
                      <div className="flex justify-end gap-1">
                        {r.status === "REQUESTED" && (
                          <>
                            <ActionButton
                              busy={busyId === r.id}
                              onClick={() => advance(r.id, "approve")}
                            >
                              Approve
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
                        {r.status === "APPROVED" && (
                          <ActionButton
                            busy={busyId === r.id}
                            onClick={() => advance(r.id, "receive")}
                            title="Goods have arrived — sellable stock goes back now"
                          >
                            Mark received
                          </ActionButton>
                        )}
                        {r.status === "RECEIVED" && (
                          <ActionButton
                            busy={busyId === r.id}
                            onClick={() => {
                              const amount = window.prompt(
                                "Refund amount",
                                String(r.refundAmount ?? "")
                              );
                              if (amount === null) return;
                              advance(r.id, "refund", {
                                refundAmount: Number(amount),
                              });
                            }}
                          >
                            Record refund
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
        <Modal title="Raise a return" onClose={() => setCreating(false)}>
          <div className="space-y-4">
            {formError && <ErrorAlert>{formError}</ErrorAlert>}

            <Field label="Against invoice">
              <Select
                value={invoiceId}
                onChange={(e) => pickInvoice(e.target.value)}
              >
                <option value="">Choose an invoice…</option>
                {invoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {invNumber(i.number)} — {i.customerName}
                  </option>
                ))}
              </Select>
            </Field>

            {returnable && returnable.length > 0 && (
              <div className="space-y-3">
                {returnable.map((line) => {
                  const d = draft[line.invoiceLineId];
                  const exhausted = line.returnable <= 0;
                  return (
                    <div
                      key={line.invoiceLineId}
                      className={`rounded-[5px] border-2 border-[var(--line)] p-3 ${
                        exhausted ? "opacity-50" : ""
                      }`}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-bold text-[var(--text)]">
                          {line.product.name}
                        </span>
                        <span className="text-xs font-semibold text-[var(--muted)]">
                          {line.returned > 0
                            ? `${line.returnable} of ${line.sold} ${line.product.unit} left to return`
                            : `${line.sold} ${line.product.unit} sold`}
                        </span>
                      </div>

                      {!exhausted && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                          <Field label="Quantity">
                            <Input
                              type="number"
                              min="0"
                              max={line.returnable}
                              step="any"
                              value={d?.quantity ?? ""}
                              onChange={(e) =>
                                setLine(line.invoiceLineId, {
                                  quantity: e.target.value,
                                })
                              }
                            />
                          </Field>
                          <Field label="Condition">
                            <Select
                              value={d?.condition ?? "SELLABLE"}
                              onChange={(e) =>
                                setLine(line.invoiceLineId, {
                                  condition: e.target.value as ReturnCondition,
                                })
                              }
                            >
                              {(
                                Object.keys(
                                  RETURN_CONDITION_LABELS
                                ) as ReturnCondition[]
                              ).map((c) => (
                                <option key={c} value={c}>
                                  {RETURN_CONDITION_LABELS[c]}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <label className="flex items-end gap-2 pb-2 text-sm font-bold text-[var(--text)]">
                            <input
                              type="checkbox"
                              checked={d?.restock ?? true}
                              disabled={(d?.condition ?? "SELLABLE") !== "SELLABLE"}
                              onChange={(e) =>
                                setLine(line.invoiceLineId, {
                                  restock: e.target.checked,
                                })
                              }
                            />
                            <span
                              title={
                                (d?.condition ?? "SELLABLE") !== "SELLABLE"
                                  ? "Only sellable goods can go back into stock"
                                  : undefined
                              }
                            >
                              Restock
                            </span>
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {returnable && returnable.every((l) => l.returnable <= 0) && (
              <p className="text-sm font-bold text-[var(--muted)]">
                Everything on this invoice has already been returned.
              </p>
            )}

            <Field label="Reason" hint="optional">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Wrong size, damaged in transit…"
              />
            </Field>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={saving || !invoiceId}>
                {saving ? "Saving…" : "Raise return"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
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
