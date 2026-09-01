/**
 * Showing what stock is ACTUALLY sellable (P2-2 UI).
 *
 * The problem this solves on screen: "150 units" used to be one number that
 * answered every question. Since P2-2 it answers none of them precisely —
 * 150 might be 90 sellable, 40 damaged, 20 reserved for a draft invoice. A
 * shelf can look healthy and be unable to fill a single order.
 *
 * So anywhere a quantity is shown, it has to be obvious which quantity it is.
 * The colours are the same ones used for return conditions elsewhere, so
 * "red = damaged" means the same thing everywhere in the app.
 */
import type { StockStatus } from "../lib/types";
import { formatQty, qtyNum } from "../lib/format";

export const STATUS_COLORS: Record<StockStatus | "RESERVED", string> = {
  AVAILABLE: "#10b981", // green — sellable
  RESERVED: "#3b82f6", // blue — promised, not gone
  QUARANTINE: "#f59e0b", // amber — undecided
  DAMAGED: "#ef4444", // red — never sellable
  EXPIRED: "#7c3aed", // purple — written off by date
};

export type Breakdown = {
  sellable: string | number;
  reserved: string | number;
  quarantine: string | number;
  damaged: string | number;
  expired: string | number;
};

/**
 * A proportional bar of the conditions on one shelf.
 *
 * Reserved is drawn as a slice of SELLABLE, not alongside it — reserved stock
 * IS good stock, it is just already promised. Showing it as a separate
 * category would imply the units are unusable, when in fact they are about to
 * be used by whoever reserved them.
 */
export function StockStatusBar({
  breakdown,
  unit,
  className = "",
}: {
  breakdown: Breakdown;
  unit?: string;
  className?: string;
}) {
  const sellable = qtyNum(breakdown.sellable);
  const reserved = Math.min(qtyNum(breakdown.reserved), sellable);
  const free = Math.max(0, sellable - reserved);
  const quarantine = qtyNum(breakdown.quarantine);
  const damaged = qtyNum(breakdown.damaged);
  const expired = qtyNum(breakdown.expired);

  const total = free + reserved + quarantine + damaged + expired;
  if (total <= 0) return null;

  const segments: { key: string; value: number; color: string; label: string }[] =
    [
      { key: "free", value: free, color: STATUS_COLORS.AVAILABLE, label: "Available" },
      { key: "res", value: reserved, color: STATUS_COLORS.RESERVED, label: "Reserved" },
      { key: "qua", value: quarantine, color: STATUS_COLORS.QUARANTINE, label: "Quarantine" },
      { key: "dam", value: damaged, color: STATUS_COLORS.DAMAGED, label: "Damaged" },
      { key: "exp", value: expired, color: STATUS_COLORS.EXPIRED, label: "Expired" },
    ].filter((s) => s.value > 0);

  return (
    <div className={className}>
      <div className="flex h-3 overflow-hidden rounded-[3px] border-2 border-[var(--line)]">
        {segments.map((s) => (
          <div
            key={s.key}
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
            title={`${s.label}: ${formatQty(s.value, unit)}`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {segments.map((s) => (
          <span
            key={s.key}
            className="flex items-center gap-1 text-[11px] font-bold text-[var(--muted)]"
          >
            <span
              className="inline-block h-2 w-2 rounded-[1px]"
              style={{ background: s.color }}
            />
            {s.label} {formatQty(s.value)}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * The one-line version: what can actually be sold, with the caveat attached.
 *
 * Deliberately leads with AVAILABLE rather than on hand. "150 on hand" is the
 * number that gets someone to promise stock they haven't got; "90 available"
 * is the number they can act on.
 */
export function AvailabilitySummary({
  quantity,
  available,
  unit,
  className = "",
}: {
  quantity: string | number;
  available: string | number;
  unit?: string;
  className?: string;
}) {
  const onHand = qtyNum(quantity);
  const free = qtyNum(available);
  const blocked = onHand - free;

  return (
    <span className={`text-sm font-black text-[var(--text)] ${className}`}>
      {formatQty(free, unit)} available
      {blocked > 0 && (
        <span className="ml-1.5 text-xs font-bold text-[var(--muted)]">
          of {formatQty(onHand)} on hand
        </span>
      )}
    </span>
  );
}
