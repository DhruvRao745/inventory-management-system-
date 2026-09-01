/**
 * Move stock between conditions (P2-2 UI).
 *
 * Quarantine cleared, goods found broken, expired stock written off.
 *
 * THE THING THIS SCREEN HAS TO MAKE CLEAR: nothing physically moves. The units
 * stay exactly where they are and the company still owns every one of them —
 * what changes is whether they may be sold. Someone expecting stock to
 * *disappear* when they mark it damaged will otherwise think the action failed
 * and do it again.
 *
 * The second thing: this writes TWO ledger entries, not an edit. Stock records
 * are never rewritten (that is the rule the whole ledger rests on), so a
 * reclassification is recorded as an event with a name and a time against it,
 * exactly like a sale or a delivery.
 */
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  type StockStatus,
  type StockLevel,
  STOCK_STATUS_LABELS,
} from "../lib/types";
import { formatQty, qtyNum } from "../lib/format";
import { Button, Input, Select, Field, ErrorAlert } from "./ui";
import { Modal } from "./Modal";
import { STATUS_COLORS } from "./StockStatusBar";

const ALL: StockStatus[] = ["AVAILABLE", "QUARANTINE", "DAMAGED", "EXPIRED"];

/** Plain-language description of what each move actually means. */
const MOVE_HELP: Record<string, string> = {
  "QUARANTINE→AVAILABLE": "Inspection passed — these go back on sale.",
  "AVAILABLE→QUARANTINE": "Held back pending inspection. They can't be sold until released.",
  "AVAILABLE→DAMAGED": "Written off as unsellable. Still owned and still counted, but never sold.",
  "QUARANTINE→DAMAGED": "Inspection failed — written off as unsellable.",
  "AVAILABLE→EXPIRED": "Past its date. Written off, but still on the shelf until disposed of.",
  "QUARANTINE→EXPIRED": "Expired while held.",
  "DAMAGED→AVAILABLE": "Repaired or re-graded — putting these back on sale.",
  "EXPIRED→AVAILABLE": "Reversing a write-off. Double-check the expiry date first.",
};

export function ReclassifyModal({
  level,
  productUnit,
  onClose,
  onDone,
}: {
  /** The shelf being adjusted — carries the current per-status quantities. */
  level: StockLevel;
  productUnit: string;
  onClose: () => void;
  onDone: () => void;
}) {
  // Default to the move people actually make: marking good stock as damaged.
  //
  // This opened on QUARANTINE → AVAILABLE at first, which reads sensibly but
  // is wrong in practice — most shelves hold nothing in quarantine, so the
  // dialog opened saying "0 pcs here / up to 0" and could do nothing until the
  // dropdown was changed. Defaulting to a state the user must fix before they
  // can act makes the feature look broken on first contact.
  const [fromStatus, setFromStatus] = useState<StockStatus>("AVAILABLE");
  const [toStatus, setToStatus] = useState<StockStatus>("DAMAGED");
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** How much sits in the bucket being drained. */
  const inBucket = qtyNum(
    fromStatus === "AVAILABLE"
      ? level.sellable
      : fromStatus === "DAMAGED"
        ? level.damaged
        : fromStatus === "QUARANTINE"
          ? level.quarantine
          : level.expired
  );

  // Moving stock OUT of AVAILABLE competes with reservations: goods already
  // promised to a customer can't be quarantined without breaking that promise.
  // The server enforces this; showing it here means the user finds out before
  // typing a number rather than after submitting it.
  const reserved = qtyNum(level.reserved);
  const movable =
    fromStatus === "AVAILABLE" ? Math.max(0, inBucket - reserved) : inBucket;

  const help = MOVE_HELP[`${fromStatus}→${toStatus}`];

  async function submit() {
    setError(null);
    const qty = Number(quantity);
    if (!(qty > 0)) {
      setError("Enter how much to move");
      return;
    }
    if (fromStatus === toStatus) {
      setError("Pick a different condition to move it to");
      return;
    }

    setSaving(true);
    try {
      await api("/stock/reclassify", {
        method: "POST",
        body: {
          productId: level.product.id,
          locationId: level.location.id,
          quantity: qty,
          fromStatus,
          toStatus,
          note: note.trim() || undefined,
        },
      });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not move the stock");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Change stock condition" onClose={onClose}>
      <div className="space-y-4">
        {error && <ErrorAlert>{error}</ErrorAlert>}

        <p className="text-sm font-semibold text-[var(--muted)]">
          {level.product.name} at <strong>{level.location.name}</strong>
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From" hint={`${formatQty(inBucket, productUnit)} here`}>
            <Select
              value={fromStatus}
              onChange={(e) => setFromStatus(e.target.value as StockStatus)}
            >
              {ALL.map((s) => (
                <option key={s} value={s}>
                  {STOCK_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="To">
            <Select
              value={toStatus}
              onChange={(e) => setToStatus(e.target.value as StockStatus)}
            >
              {ALL.filter((s) => s !== fromStatus).map((s) => (
                <option key={s} value={s}>
                  {STOCK_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {help && (
          <p
            className="rounded-[5px] border-2 border-[var(--line)] px-3 py-2 text-sm font-semibold"
            style={{
              background: `${STATUS_COLORS[toStatus]}18`,
              color: "var(--text)",
            }}
          >
            {help}
          </p>
        )}

        <Field
          label="Quantity"
          hint={
            fromStatus === "AVAILABLE" && reserved > 0
              ? `${formatQty(movable)} free — ${formatQty(reserved)} is reserved`
              : `up to ${formatQty(movable)}`
          }
        >
          <Input
            type="number"
            min="0"
            max={movable}
            step="any"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="0"
          />
        </Field>

        {fromStatus === "AVAILABLE" && reserved > 0 && (
          <p className="text-xs font-semibold text-[var(--muted)]">
            Reserved stock is already promised to a draft invoice, so it can't
            be moved out of Available without breaking that promise.
          </p>
        )}

        <Field label="Reason" hint="recommended">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Crushed in transit, inspection passed…"
          />
        </Field>

        <p className="text-xs font-semibold text-[var(--muted)]">
          Nothing physically moves — the goods stay where they are and you still
          own them. This records <strong>two ledger entries</strong> (out of one
          condition, into the other) with your name and the time against them,
          because stock records are never rewritten.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || movable <= 0}>
            {saving ? "Moving…" : "Move stock"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
