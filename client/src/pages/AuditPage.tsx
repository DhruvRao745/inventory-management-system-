/**
 * Activity log — a read-only, company-wide feed of what happened, merged
 * from the stock ledger, PO creations, and new records. Filter by kind and
 * date range.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import {
  Button,
  Input,
  Select,
  Field,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";
import { AuditLogPanel } from "../components/AuditLogPanel";

type AuditEvent = {
  id: string;
  at: string;
  actor: string | null;
  kind: string;
  action: string;
  detail: string;
  link: string | null;
};
type AuditResponse = { items: AuditEvent[]; total: number };

const KIND_LABELS: Record<string, string> = {
  movement: "Movement",
  purchase_order: "Purchase order",
  product: "Product",
  supplier: "Supplier",
  user: "Team",
};
const KIND_COLORS: Record<string, string> = {
  movement: "#f59e0b",
  purchase_order: "#6366f1",
  product: "#a855f7",
  supplier: "#14b8a6",
  user: "#ec4899",
};

export function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (kind) params.set("kind", kind);
      if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
      const qs = params.toString();
      const data = await api<AuditResponse>(`/audit${qs ? `?${qs}` : ""}`);
      setEvents(data.items);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function apply(e: FormEvent) {
    e.preventDefault();
    load();
  }

  return (
    <div className="max-w-4xl space-y-8">
      {/* The RECORDED log (P2-6) sits above the inferred feed — it holds the
          events that leave no trace anywhere else, so it is the one people
          actually come here for. */}
      <AuditLogPanel />

      <SectionTitle>
        Activity{" "}
        <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
          ({total})
        </span>
      </SectionTitle>

      <form
        onSubmit={apply}
        className={`${cardClass} grid grid-cols-2 gap-3 p-3 md:grid-cols-4`}
      >
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All activity</option>
            {Object.entries(KIND_LABELS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Apply</Button>
        </div>
      </form>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>
      ) : events.length === 0 ? (
        <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
          No activity in this range.
        </div>
      ) : (
        <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
          {events.map((e) => (
            <div key={e.id} className="flex items-center gap-3 px-4 py-3">
              <span
                className="shrink-0 rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
                style={{ background: KIND_COLORS[e.kind] ?? "#666" }}
              >
                {e.action}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold text-[var(--text)]">
                  {e.link ? (
                    <Link to={e.link} className="hover:text-[var(--accent)] hover:underline">
                      {e.detail}
                    </Link>
                  ) : (
                    e.detail
                  )}
                </div>
                <div className="text-xs font-semibold text-[var(--muted)]">
                  {new Date(e.at).toLocaleString()}
                  {e.actor ? ` · ${e.actor}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
