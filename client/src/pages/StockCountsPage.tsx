/**
 * Stock counts — the clipboard screen (P1-9).
 *
 * A stocktake is someone walking the shelves writing down what's actually
 * there. This screen is that clipboard, and it has three jobs the design has
 * to get right or the count is worthless:
 *
 * 1. NEVER SHOW THE ANSWER WHILE COUNTING. The counted box starts empty and
 *    the expected figure is hidden until REVIEW. Show someone "expected: 47"
 *    next to an empty box and a fair number of people will write 47 without
 *    looking at the shelf. Then the count agrees with the system perfectly and
 *    tells you nothing — worse than not counting, because now you trust it.
 *
 * 2. BLANK IS NOT ZERO. An empty box means "nobody has looked yet". A zero
 *    means "I looked, the shelf is empty". Those are completely different
 *    findings, and the server keeps countedQuantity nullable for exactly this
 *    reason. The sheet shows a running "12 of 40 counted" so it's obvious what
 *    is still outstanding, and the server refuses to move to review until
 *    every line has a figure.
 *
 * 3. BE HONEST THAT COMPLETING MOVES STOCK. Completing writes ADJUSTMENT
 *    movements for each variance — a real ledger event, not a quiet edit. The
 *    confirm step says how many lines will move before anyone commits to it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  type StockCount,
  type StockCountStatus,
  type StockCountItem,
  type Location,
  cntNumber,
} from "../lib/types";
import { formatQty, qtyNum } from "../lib/format";
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

type ListResponse = { items: StockCount[]; total: number };

const COUNT_STATUS_COLORS: Record<StockCountStatus, string> = {
  OPEN: "#9a9ba3",
  COUNTING: "#3b82f6",
  REVIEW: "#f59e0b",
  COMPLETED: "#10b981",
  CANCELLED: "#ef4444",
};

export function CountStatusPill({ status }: { status: StockCountStatus }) {
  return (
    <span
      className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
      style={{ background: COUNT_STATUS_COLORS[status] }}
    >
      {status}
    </span>
  );
}

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

const STATUS_FILTERS: (StockCountStatus | "")[] = [
  "",
  "OPEN",
  "COUNTING",
  "REVIEW",
  "COMPLETED",
  "CANCELLED",
];

/** Counted figures are only revealed alongside expected once counting is done. */
function showsVariance(status: StockCountStatus) {
  return status === "REVIEW" || status === "COMPLETED";
}

export function StockCountsPage() {
  const { user: me } = useAuth();
  const canApprove = me?.role === "ADMIN" || me?.role === "MANAGER";

  const [rows, setRows] = useState<StockCount[]>([]);
  const [status, setStatus] = useState<StockCountStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The count sheet currently open, if any.
  const [sheet, setSheet] = useState<StockCount | null>(null);

  // --- start-a-count modal ---
  const [creating, setCreating] = useState(false);
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [includeZeroStock, setIncludeZeroStock] = useState(false);
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const qs = status ? `?status=${status}` : "";
    api<ListResponse>(`/stock-counts${qs}`)
      .then((d) => setRows(d.items))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      )
      .finally(() => setLoading(false));
  }, [status]);

  useEffect(load, [load]);

  /** Move a count along its workflow, then refresh both list and open sheet. */
  async function advance(id: string, action: string) {
    setBusyId(id);
    setError(null);
    try {
      const updated = await api<StockCount>(`/stock-counts/${id}/${action}`, {
        method: "POST",
      });
      if (sheet?.id === id) setSheet(updated);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function openSheet(id: string) {
    setError(null);
    try {
      setSheet(await api<StockCount>(`/stock-counts/${id}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open count");
    }
  }

  async function openCreate() {
    setCreating(true);
    setFormError(null);
    setLocationId("");
    setIncludeZeroStock(false);
    setNotes("");
    try {
      const locs = await api<Location[]>("/locations");
      setLocations(locs);
      setLocationId(locs.find((l) => l.isDefault)?.id ?? locs[0]?.id ?? "");
    } catch {
      setFormError("Could not load locations");
    }
  }

  async function submit() {
    setFormError(null);
    if (!locationId) {
      setFormError("Choose a location to count");
      return;
    }
    setSaving(true);
    try {
      const created = await api<StockCount>("/stock-counts", {
        method: "POST",
        body: {
          locationId,
          includeZeroStock,
          notes: notes.trim() || undefined,
        },
      });
      setCreating(false);
      load();
      setSheet(created); // straight onto the sheet — that's why you started
    } catch (err) {
      setFormError(
        err instanceof ApiError ? err.message : "Could not start the count"
      );
    } finally {
      setSaving(false);
    }
  }

  if (sheet) {
    return (
      <CountSheet
        count={sheet}
        canApprove={canApprove}
        busy={busyId === sheet.id}
        onBack={() => {
          setSheet(null);
          load();
        }}
        onChanged={setSheet}
        onAdvance={(action) => advance(sheet.id, action)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SectionTitle>Stock counts</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as StockCountStatus | "")}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s || "All statuses"}
              </option>
            ))}
          </Select>
          {canApprove && <Button onClick={openCreate}>Start a count</Button>}
        </div>
      </div>

      <p className="text-sm font-semibold text-[var(--muted)]">
        Completing a count doesn't overwrite stock — it records an{" "}
        <strong>adjustment</strong> for the difference, so every correction
        stays in the ledger with a name and a time against it.
      </p>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          No stock counts yet.
        </div>
      ) : (
        <div className={`${cardClass} overflow-x-auto`}>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                <th className={th}>Count</th>
                <th className={th}>Location</th>
                <th className={th}>Started by</th>
                <th className={th}>Progress</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const counted = c.items.filter(
                  (i) => i.countedQuantity !== null
                ).length;
                return (
                  <tr
                    key={c.id}
                    className="border-b border-[var(--line)] last:border-0"
                  >
                    <td className={`${td} font-black text-[var(--text)]`}>
                      {cntNumber(c.number)}
                    </td>
                    <td className={`${td} font-bold text-[var(--text)]`}>
                      {c.location.name}
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]`}>
                      {c.startedBy.name}
                    </td>
                    <td className={`${td} font-semibold text-[var(--muted)]`}>
                      {counted} of {c.items.length} counted
                    </td>
                    <td className={td}>
                      <CountStatusPill status={c.status} />
                    </td>
                    <td className={`${td} text-right`}>
                      <button
                        type="button"
                        onClick={() => openSheet(c.id)}
                        className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--card)] px-2 py-1 text-xs font-bold text-[var(--text)] hover:bg-[var(--hover)]"
                      >
                        Open sheet
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <Modal title="Start a stock count" onClose={() => setCreating(false)}>
          <div className="space-y-4">
            {formError && <ErrorAlert>{formError}</ErrorAlert>}

            <Field label="Location">
              <Select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                <option value="">Choose a location…</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>

            <label className="flex items-start gap-2 text-sm font-bold text-[var(--text)]">
              <input
                type="checkbox"
                className="mt-1"
                checked={includeZeroStock}
                onChange={(e) => setIncludeZeroStock(e.target.checked)}
              />
              <span>
                Include products the system thinks are at zero
                <span className="block text-xs font-medium text-[var(--muted)]">
                  Off by default — otherwise the sheet lists every product you
                  have ever carried, and nobody finishes it.
                </span>
              </span>
            </label>

            <Field label="Notes" hint="optional">
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Quarter-end count, aisle 3 recheck…"
              />
            </Field>

            <p className="text-xs font-semibold text-[var(--muted)]">
              The sheet snapshots what the system believes right now. Stock can
              keep moving while you count — the adjustment is applied as a
              difference, so anything that legitimately happens meanwhile is
              preserved.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={saving || !locationId}>
                {saving ? "Preparing…" : "Prepare sheet"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The count sheet                                                     */
/* ------------------------------------------------------------------ */

function CountSheet({
  count,
  canApprove,
  busy,
  onBack,
  onChanged,
  onAdvance,
}: {
  count: StockCount;
  canApprove: boolean;
  busy: boolean;
  onBack: () => void;
  onChanged: (c: StockCount) => void;
  onAdvance: (action: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

  const counted = count.items.filter((i) => i.countedQuantity !== null).length;
  const outstanding = count.items.length - counted;
  const editable = count.status === "COUNTING";
  const reveal = showsVariance(count.status);

  /** Lines that will actually produce a movement when completed. */
  const discrepancies = useMemo(
    () =>
      count.items.filter(
        (i) => i.variance !== null && qtyNum(i.variance) !== 0
      ),
    [count.items]
  );

  /** Save one line's figure. Blank is left alone — blank means "not looked at". */
  async function record(item: StockCountItem) {
    const raw = drafts[item.id];
    if (raw === undefined || raw.trim() === "") return;
    setSavingId(item.id);
    setError(null);
    try {
      const updated = await api<StockCount>(
        `/stock-counts/${count.id}/record`,
        {
          method: "POST",
          body: { itemId: item.id, countedQuantity: raw.trim() },
        }
      );
      onChanged(updated);
      setDrafts((d) => {
        const next = { ...d };
        delete next[item.id];
        return next;
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--card)] px-2 py-1 text-xs font-bold text-[var(--text)] hover:bg-[var(--hover)]"
          >
            ← All counts
          </button>
          <SectionTitle>
            {cntNumber(count.number)} · {count.location.name}
          </SectionTitle>
          <CountStatusPill status={count.status} />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {count.status === "OPEN" && (
            <Button onClick={() => onAdvance("start")} disabled={busy}>
              {busy ? "…" : "Begin counting"}
            </Button>
          )}
          {count.status === "COUNTING" && (
            <Button
              onClick={() => onAdvance("review")}
              disabled={busy || outstanding > 0}
              title={
                outstanding > 0
                  ? `${outstanding} line${outstanding === 1 ? "" : "s"} still to count`
                  : undefined
              }
            >
              {busy ? "…" : "Submit for review"}
            </Button>
          )}
          {count.status === "REVIEW" && canApprove && (
            <Button onClick={() => setConfirming(true)} disabled={busy}>
              {busy ? "…" : "Apply adjustments"}
            </Button>
          )}
          {canApprove &&
            count.status !== "COMPLETED" &&
            count.status !== "CANCELLED" && (
              <Button
                variant="danger"
                onClick={() => onAdvance("cancel")}
                disabled={busy}
              >
                Cancel count
              </Button>
            )}
        </div>
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {/* Progress + the state-specific instruction. */}
      <div className={`${cardClass} flex flex-wrap items-center gap-4 p-4`}>
        <span className="text-sm font-black text-[var(--text)]">
          {counted} of {count.items.length} counted
        </span>
        <div className="h-2 min-w-[120px] flex-1 rounded-[3px] border-2 border-[var(--line)] bg-[var(--panel)]">
          <div
            className="h-full rounded-[1px] bg-[var(--accent)]"
            style={{
              width: count.items.length
                ? `${(counted / count.items.length) * 100}%`
                : "0%",
            }}
          />
        </div>
        {count.status === "OPEN" && (
          <span className="text-sm font-semibold text-[var(--muted)]">
            Press <strong>Begin counting</strong> to open the sheet for entry.
          </span>
        )}
        {count.status === "COUNTING" && outstanding > 0 && (
          <span className="text-sm font-semibold text-[var(--muted)]">
            {outstanding} still to go — every line needs a figure before review.
          </span>
        )}
        {count.status === "COUNTING" && outstanding === 0 && (
          <span className="text-sm font-semibold text-emerald-600">
            All lines counted — ready for review.
          </span>
        )}
        {count.status === "REVIEW" && (
          <span className="text-sm font-semibold text-[var(--muted)]">
            {discrepancies.length} line
            {discrepancies.length === 1 ? "" : "s"} differ from the system.
          </span>
        )}
      </div>

      {editable && (
        <p className="text-sm font-semibold text-[var(--muted)]">
          Write down what's actually on the shelf. The system's figure stays
          hidden until review, on purpose — if you can see the expected number
          it stops being a count. An empty box means nobody has looked yet;
          enter <strong>0</strong> if the shelf is genuinely empty.
        </p>
      )}

      <div className={`${cardClass} overflow-x-auto`}>
        <table className="w-full">
          <thead>
            <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
              <th className={th}>Product</th>
              <th className={th}>Batch</th>
              {reveal && <th className={`${th} text-right`}>Expected</th>}
              <th className={`${th} text-right`}>Counted</th>
              {reveal && <th className={`${th} text-right`}>Variance</th>}
            </tr>
          </thead>
          <tbody>
            {count.items.map((item) => {
              const isCounted = item.countedQuantity !== null;
              const variance = item.variance === null ? null : qtyNum(item.variance);
              return (
                <tr
                  key={item.id}
                  className={`border-b border-[var(--line)] last:border-0 ${
                    editable && !isCounted ? "bg-amber-500/5" : ""
                  }`}
                >
                  <td className={td}>
                    <div className="font-bold text-[var(--text)]">
                      {item.product.name}
                    </div>
                    <div className="text-xs font-semibold text-[var(--muted)]">
                      {item.product.sku}
                    </div>
                  </td>
                  <td className={`${td} font-semibold text-[var(--muted)]`}>
                    {item.batch?.batchNumber ?? "—"}
                  </td>

                  {reveal && (
                    <td className={`${td} text-right font-semibold text-[var(--muted)]`}>
                      {formatQty(item.expectedQuantity, item.product.unit)}
                    </td>
                  )}

                  <td className={`${td} text-right`}>
                    {editable ? (
                      <div className="flex items-center justify-end gap-2">
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          className="w-28 text-right"
                          placeholder="—"
                          value={
                            drafts[item.id] ??
                            (item.countedQuantity ?? "")
                          }
                          onChange={(e) =>
                            setDrafts((d) => ({
                              ...d,
                              [item.id]: e.target.value,
                            }))
                          }
                          onBlur={() => record(item)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              (e.target as HTMLInputElement).blur();
                            }
                          }}
                        />
                        <span className="w-6 text-xs font-bold text-[var(--muted)]">
                          {savingId === item.id ? "…" : isCounted ? "✓" : ""}
                        </span>
                      </div>
                    ) : (
                      <span className="font-semibold text-[var(--text)]">
                        {isCounted
                          ? formatQty(item.countedQuantity, item.product.unit)
                          : "not counted"}
                      </span>
                    )}
                  </td>

                  {reveal && (
                    <td className={`${td} text-right font-black`}>
                      {variance === null ? (
                        <span className="text-[var(--muted)]">—</span>
                      ) : variance === 0 ? (
                        <span className="text-[var(--muted)]">0</span>
                      ) : (
                        <span
                          className={
                            variance > 0 ? "text-emerald-600" : "text-red-600"
                          }
                        >
                          {variance > 0 ? "+" : ""}
                          {formatQty(variance, item.product.unit)}
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirming && (
        <Modal title="Apply adjustments" onClose={() => setConfirming(false)}>
          <div className="space-y-4">
            <p className="text-sm font-semibold text-[var(--text)]">
              This writes{" "}
              <strong>
                {discrepancies.length} adjustment
                {discrepancies.length === 1 ? "" : "s"}
              </strong>{" "}
              to the stock ledger. Lines that matched produce nothing.
            </p>

            {discrepancies.length > 0 && (
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-[5px] border-2 border-[var(--line)] p-2">
                {discrepancies.map((d) => {
                  const v = qtyNum(d.variance);
                  return (
                    <div
                      key={d.id}
                      className="flex items-baseline justify-between gap-2 text-sm"
                    >
                      <span className="font-bold text-[var(--text)]">
                        {d.product.name}
                      </span>
                      <span
                        className={`font-black ${
                          v > 0 ? "text-emerald-600" : "text-red-600"
                        }`}
                      >
                        {v > 0 ? "+" : ""}
                        {formatQty(v, d.product.unit)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <p className="text-xs font-semibold text-[var(--muted)]">
              Adjustments are applied as a difference, not as a replacement — so
              any sale or delivery that happened while you were counting stays
              intact.
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setConfirming(false);
                  onAdvance("complete");
                }}
                disabled={busy}
              >
                Apply and complete
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
