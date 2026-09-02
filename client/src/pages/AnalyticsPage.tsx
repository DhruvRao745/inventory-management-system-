/**
 * Advanced analytics (P3-2) — turnover, dead stock, ABC, trends.
 *
 * A SEPARATE PAGE, NOT MORE OF ReportsPage.
 *
 * Reports answer "what happened": here is your stock, here are your sales,
 * here is what you're owed. Every figure is a fact you could in principle
 * count by hand.
 *
 * These four answer "what does it mean" — and every one of them is an
 * interpretation with a judgement call inside it. Mixing the two would let a
 * reader carry the authority of a bank balance over to a trend line drawn from
 * eleven days of data.
 *
 * Which is why this page shows its workings everywhere. When a figure can't be
 * supported the server returns null, and this page prints WHY rather than
 * falling back to a nice round zero.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import { downloadCsv } from "../lib/csv";
import { formatMoney, formatQty } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import {
  Button,
  Input,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";

/* ------------------------------------------------------------------ *
 * Server shapes                                                       *
 * ------------------------------------------------------------------ */

type Turnover = {
  period: { from: string; to: string; days: number };
  openingValue: number;
  closingValue: number;
  cogs: number;
  averageValue: number;
  /** null when the ratio can't be supported — NOT zero, which reads as bad. */
  ratio: number | null;
  daysOfInventory: number | null;
  salesCount: number;
  /** Sales in the period whose cost was never recorded. COGS is short by these. */
  salesMissingCost: number;
  /**
   * Why the ratio is missing, from the server, in words.
   *
   * This page must NOT work the reason out for itself. It tried that once:
   * seeing COGS of zero it printed "stock held, nothing sold", directly above
   * a chart showing 129 units sold. Zero COGS and zero sales are identical
   * from out here and are entirely different facts — only the server can tell
   * them apart, so only the server says which it is.
   */
  unavailableReason: string | null;
  note: string;
};

type Staleness = "dead" | "stale" | "slow";
type DeadRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  onHand: number;
  lastSaleAt: string | null;
  daysSinceLastSale: number | null;
  staleness: Staleness;
  tiedUpValue: number;
};
type DeadStock = {
  thresholds: { slowAfterDays: number; staleAfterDays: number };
  rows: DeadRow[];
  totals: {
    products: number;
    dead: number;
    tiedUpValue: number;
    /** Products with stock on hand. Zero rows means nothing WITHOUT this. */
    productsHeld: number;
  };
};

type AbcRow = {
  id: string;
  label: string;
  value: number;
  share: number;
  cumulativeShare: number;
  class: "A" | "B" | "C" | null;
};
type Abc = {
  basis: "revenue" | "quantity";
  rows: AbcRow[];
  total: number;
  /** False on a catalogue too small for the bands to mean anything. */
  classified: boolean;
  note: string | null;
};

type Trend = {
  direction: "rising" | "falling" | "steady" | "unknown";
  changePercent: number | null;
  firstHalf: number;
  secondHalf: number;
};
type Trends = {
  period: { from: string; to: string; days: number };
  series: { date: string; units: number; revenue: number }[];
  demandTrend: Trend;
  revenueTrend: Trend;
};

/** Demand forecasting (P3-3). Advisory only — nothing here can be "applied". */
type Confidence = "good" | "fair" | "low";
type ForecastRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  available: number;
  preferredSupplier: { id: string; name: string } | null;
  forecast: {
    predictedDemand: number | null;
    perDay: number | null;
    horizonDays: number;
    confidence: Confidence | null;
    volatilityPercent: number | null;
    basisDays: number;
    daysWithSales: number;
    unavailableReason: string | null;
  };
  suggestion: {
    suggestedQty: number | null;
    bufferUnits: number;
    reason: string;
  };
  /** Days until current stock runs out at the forecast rate. */
  daysOfCover: number | null;
};
type ForecastReport = {
  horizonDays: number;
  historyDays: number;
  generatedAt: string;
  rows: ForecastRow[];
  totals: {
    products: number;
    forecast: number;
    noForecast: number;
    toOrder: number;
  };
  caveats: string[];
};

/* ------------------------------------------------------------------ *
 * Small presentational pieces                                         *
 * ------------------------------------------------------------------ */

const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

/**
 * A headline number that is allowed to be absent.
 *
 * The `unavailable` message is the point of this component. A dash with no
 * explanation looks like a bug; "no stock was held in this period" is an
 * answer.
 */
function Stat({
  label,
  value,
  unavailable,
  tone = "text",
}: {
  label: string;
  value: string | null;
  unavailable?: string;
  tone?: "text" | "accent" | "danger" | "good";
}) {
  const color =
    tone === "accent"
      ? "text-[var(--accent)]"
      : tone === "danger"
        ? "text-red-600"
        : tone === "good"
          ? "text-emerald-500"
          : "text-[var(--text)]";
  return (
    <div className={`${cardClass} p-4`}>
      <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
        {label}
      </div>
      {value === null ? (
        <div className="mt-1 text-sm font-bold leading-tight text-[var(--muted)]">
          <span className="text-2xl font-black">—</span>
          <div className="mt-1">{unavailable ?? "Not enough data."}</div>
        </div>
      ) : (
        <div className={`mt-1 text-2xl font-black tracking-tight ${color}`}>
          {value}
        </div>
      )}
    </div>
  );
}

const TREND_STYLE: Record<
  Trend["direction"],
  { label: string; arrow: string; className: string }
> = {
  rising: { label: "Rising", arrow: "▲", className: "text-emerald-500" },
  falling: { label: "Falling", arrow: "▼", className: "text-red-500" },
  steady: { label: "Steady", arrow: "▬", className: "text-[var(--muted)]" },
  unknown: { label: "Unclear", arrow: "?", className: "text-[var(--muted)]" },
};

/**
 * A trend, stated with its own uncertainty attached.
 *
 * "Steady" prints the reason it is steady rather than the raw percentage,
 * because a reader shown "+7%" next to the word "steady" will believe the
 * number and ignore the word.
 */
function TrendBadge({ trend, what }: { trend: Trend; what: string }) {
  const s = TREND_STYLE[trend.direction];
  return (
    <div className={`${cardClass} p-4`}>
      <div className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
        {what}
      </div>
      <div className={`mt-1 flex items-baseline gap-2 ${s.className}`}>
        <span className="text-2xl font-black tracking-tight">
          {s.arrow} {s.label}
        </span>
        {trend.direction !== "steady" && trend.changePercent !== null && (
          <span className="text-sm font-black">
            {trend.changePercent > 0 ? "+" : ""}
            {trend.changePercent}%
          </span>
        )}
      </div>
      <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
        {trend.direction === "unknown"
          ? "Too few days to call a direction."
          : trend.direction === "steady"
            ? "Movement is within normal week-to-week noise."
            : `Averaged ${trend.firstHalf} then ${trend.secondHalf}.`}
      </div>
    </div>
  );
}

const STALENESS_STYLE: Record<Staleness, { label: string; className: string }> =
  {
    dead: { label: "NEVER SOLD", className: "bg-red-600 text-white" },
    stale: { label: "STALE", className: "bg-amber-500 text-white" },
    slow: { label: "SLOW", className: "bg-[var(--panel)] text-[var(--muted)]" },
  };

const ABC_STYLE: Record<"A" | "B" | "C", string> = {
  A: "bg-emerald-500 text-white",
  B: "bg-amber-500 text-white",
  C: "bg-[var(--panel)] text-[var(--muted)]",
};

/**
 * Confidence, labelled in words rather than as a number.
 *
 * A percentage would invite arithmetic — "72% confident" gets multiplied by
 * something. These are three coarse buckets derived from how steady and how
 * frequent the sales were, and the label says only what it can support.
 */
const CONFIDENCE_STYLE: Record<Confidence, { label: string; className: string }> =
  {
    good: { label: "STEADY HISTORY", className: "bg-emerald-500 text-white" },
    fair: { label: "PATCHY HISTORY", className: "bg-amber-500 text-white" },
    low: { label: "WEAK HISTORY", className: "bg-red-600 text-white" },
  };

/* ------------------------------------------------------------------ *
 * Page                                                                *
 * ------------------------------------------------------------------ */

function monthsAgo(n: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

export function AnalyticsPage() {
  const { company } = useAuth();
  const currency = company?.currency;

  // A THREE-MONTH default, not this month.
  //
  // Reports defaults to the current month because "what have I sold so far"
  // is a question about now. Every figure on this page gets worse the shorter
  // the window: turnover over eleven days is arithmetically fine and
  // practically meaningless, and the trend needs at least six days before it
  // will commit to a direction at all.
  const [from, setFrom] = useState(monthsAgo(3));
  const [to, setTo] = useState(today());

  const [turnover, setTurnover] = useState<Turnover | null>(null);
  const [turnoverError, setTurnoverError] = useState<string | null>(null);

  const [dead, setDead] = useState<DeadStock | null>(null);
  const [deadError, setDeadError] = useState<string | null>(null);

  const [abc, setAbc] = useState<Abc | null>(null);
  const [abcBasis, setAbcBasis] = useState<"revenue" | "quantity">("revenue");
  const [abcError, setAbcError] = useState<string | null>(null);

  const [trends, setTrends] = useState<Trends | null>(null);
  const [trendsError, setTrendsError] = useState<string | null>(null);

  const [forecast, setForecast] = useState<ForecastReport | null>(null);
  const [forecastError, setForecastError] = useState<string | null>(null);
  // Products the forecast couldn't call are hidden by default. They are the
  // majority in a young catalogue, and a screen of "not enough history" buries
  // the handful of rows that do say something.
  const [showUnforecast, setShowUnforecast] = useState(false);

  function rangeToIso(f: string, t: string) {
    return {
      fromIso: new Date(`${f}T00:00:00`).toISOString(),
      toIso: new Date(`${t}T23:59:59.999`).toISOString(),
    };
  }

  async function loadRanged(f: string, t: string, basis = abcBasis) {
    const { fromIso, toIso } = rangeToIso(f, t);
    const range = `from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`;
    const tzOffset = new Date().getTimezoneOffset();

    setTurnoverError(null);
    setAbcError(null);
    setTrendsError(null);

    api<Turnover>(`/reports/turnover?${range}`)
      .then(setTurnover)
      .catch((e) =>
        setTurnoverError(e instanceof ApiError ? e.message : "Failed to load")
      );
    api<Abc>(`/reports/abc?${range}&basis=${basis}`)
      .then(setAbc)
      .catch((e) =>
        setAbcError(e instanceof ApiError ? e.message : "Failed to load")
      );
    api<Trends>(`/reports/trends?${range}&tzOffset=${tzOffset}`)
      .then(setTrends)
      .catch((e) =>
        setTrendsError(e instanceof ApiError ? e.message : "Failed to load")
      );
  }

  useEffect(() => {
    loadRanged(monthsAgo(3), today());
    // Dead stock is deliberately NOT tied to the date range: stock sitting
    // unsold is sitting unsold regardless of which window you happen to be
    // looking at, and "no dead stock in March" would be a meaningless comfort.
    api<DeadStock>("/reports/dead-stock")
      .then(setDead)
      .catch((e) =>
        setDeadError(e instanceof ApiError ? e.message : "Failed to load")
      );
    // Nor is the forecast. It looks at a fixed trailing window and projects a
    // fixed horizon ahead — "what will I sell next month, given a date range
    // in the past" is not a coherent question.
    api<ForecastReport>(
      `/reports/forecast?horizonDays=30&tzOffset=${new Date().getTimezoneOffset()}`
    )
      .then(setForecast)
      .catch((e) =>
        setForecastError(e instanceof ApiError ? e.message : "Failed to load")
      );
  }, []);

  function handleRange(e: FormEvent) {
    e.preventDefault();
    loadRanged(from, to);
  }

  function changeBasis(basis: "revenue" | "quantity") {
    setAbcBasis(basis);
    loadRanged(from, to, basis);
  }

  return (
    <div className="max-w-4xl space-y-10">
      {/* ---------- Date range ---------- */}
      <form
        onSubmit={handleRange}
        className={`${cardClass} flex flex-wrap items-center gap-3 p-4`}
      >
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-44"
        />
        <span className="text-sm font-bold text-[var(--muted)]">to</span>
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-44"
        />
        <Button type="submit">Apply</Button>
        <span className="text-xs font-semibold text-[var(--muted)]">
          Longer ranges give more reliable answers. Dead stock ignores this
          range.
        </span>
      </form>

      {/* ---------- Demand forecast (P3-3) ---------- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionTitle>
            Demand forecast{" "}
            <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
              (next {forecast?.horizonDays ?? 30} days)
            </span>
          </SectionTitle>
          {forecast && forecast.rows.length > 0 && (
            <Button
              variant="secondary"
              onClick={() =>
                downloadCsv(
                  `forecast-${today()}.csv`,
                  [
                    "SKU",
                    "Product",
                    "Available",
                    "Predicted demand",
                    "Per day",
                    "Days of cover",
                    "Suggested order",
                    "Confidence",
                    "Note",
                  ],
                  forecast.rows.map((r) => [
                    r.sku,
                    r.name,
                    r.available,
                    r.forecast.predictedDemand ?? "no forecast",
                    r.forecast.perDay ?? "—",
                    r.daysOfCover ?? "—",
                    r.suggestion.suggestedQty ?? "—",
                    r.forecast.confidence ?? "—",
                    r.forecast.unavailableReason ?? r.suggestion.reason,
                  ])
                )
              }
            >
              ⬇ Download CSV
            </Button>
          )}
        </div>

        {/* The constraint, stated where it cannot be missed. This section is
            the only one on the page describing something that has not
            happened, and it is the one most likely to be mistaken for an
            instruction. */}
        <div
          className={`${cardClass} border-l-8 border-l-[var(--accent)] p-4 text-sm font-bold text-[var(--text)]`}
        >
          Advisory only. Nothing here changes stock or places an order — to buy
          anything you still raise a purchase order yourself.
          <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
            Suggested quantities don&rsquo;t allow for supplier lead time; the
            system doesn&rsquo;t record it. If a supplier takes three weeks,
            order earlier than this suggests.
          </div>
        </div>

        {forecastError && <ErrorAlert>{forecastError}</ErrorAlert>}

        {forecast && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <Stat
                label="Worth ordering soon"
                value={String(forecast.totals.toOrder)}
                tone={forecast.totals.toOrder > 0 ? "accent" : "text"}
              />
              <Stat
                label="Products forecast"
                value={`${forecast.totals.forecast} of ${forecast.totals.products}`}
              />
              {/* Shown as a headline, not hidden in the rows. A forecast
                  covering 3 of 40 products looks exactly like one covering all
                  40 until somebody counts. */}
              <Stat
                label="Not enough history"
                value={String(forecast.totals.noForecast)}
              />
            </div>

            {forecast.rows.filter((r) => r.forecast.predictedDemand !== null)
              .length === 0 ? (
              <div
                className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}
              >
                Nothing has enough sales history to forecast yet. A product
                needs about three weeks of records, with sales on at least a few
                separate days, before a projection means anything.
              </div>
            ) : (
              <div className={`${cardClass} overflow-x-auto`}>
                <table className="w-full">
                  <thead>
                    <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                      <th className={th}>Product</th>
                      <th className={`${th} text-right`}>Available</th>
                      <th className={`${th} text-right`}>Predicted</th>
                      <th className={`${th} text-right`}>Runs out in</th>
                      <th className={`${th} text-right`}>Consider ordering</th>
                      <th className={th}>Basis</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y-2 divide-[var(--line)]/20">
                    {forecast.rows
                      .filter(
                        (r) =>
                          showUnforecast || r.forecast.predictedDemand !== null
                      )
                      .map((r) => (
                        <tr key={r.productId} className="hover:bg-[var(--hover)]">
                          <td className={`${td} font-bold text-[var(--text)]`}>
                            {r.name}
                            <span className="ml-2 font-mono text-xs text-[var(--muted)]">
                              {r.sku}
                            </span>
                          </td>
                          <td
                            className={`${td} text-right font-semibold text-[var(--muted)]`}
                          >
                            {formatQty(r.available, r.unit)}
                          </td>
                          <td
                            className={`${td} text-right font-semibold text-[var(--text)]`}
                          >
                            {r.forecast.predictedDemand === null ? (
                              <span className="text-[var(--muted)]">—</span>
                            ) : (
                              <>
                                {r.forecast.predictedDemand}
                                <div className="text-xs font-semibold text-[var(--muted)]">
                                  ~{r.forecast.perDay}/day
                                </div>
                              </>
                            )}
                          </td>
                          {/* The most actionable cell on the row. "40 units,
                              12 days left" prompts a decision in a way that
                              "predicted demand 98" does not. */}
                          <td
                            className={`${td} text-right font-black ${
                              r.daysOfCover === null
                                ? "text-[var(--muted)]"
                                : r.daysOfCover <= 7
                                  ? "text-red-500"
                                  : r.daysOfCover <= 21
                                    ? "text-amber-500"
                                    : "text-[var(--muted)]"
                            }`}
                          >
                            {r.daysOfCover === null
                              ? "—"
                              : `${r.daysOfCover}d`}
                          </td>
                          <td
                            className={`${td} text-right font-black text-[var(--text)]`}
                          >
                            {r.suggestion.suggestedQty === null ? (
                              <span className="text-[var(--muted)]">—</span>
                            ) : r.suggestion.suggestedQty === 0 ? (
                              <span className="text-emerald-500">enough</span>
                            ) : (
                              <span title={r.suggestion.reason}>
                                {r.suggestion.suggestedQty} {r.unit}
                              </span>
                            )}
                          </td>
                          <td className={td}>
                            {r.forecast.confidence ? (
                              <>
                                <span
                                  className={`rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-[10px] font-black ${CONFIDENCE_STYLE[r.forecast.confidence].className}`}
                                >
                                  {CONFIDENCE_STYLE[r.forecast.confidence].label}
                                </span>
                                <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
                                  sold on {r.forecast.daysWithSales} of{" "}
                                  {r.forecast.basisDays} days
                                </div>
                              </>
                            ) : (
                              <span className="text-xs font-semibold text-[var(--muted)]">
                                {r.forecast.unavailableReason}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}

            {forecast.totals.noForecast > 0 &&
              forecast.totals.forecast > 0 && (
                <button
                  type="button"
                  onClick={() => setShowUnforecast((v) => !v)}
                  className="text-xs font-black uppercase tracking-wide text-[var(--accent)] hover:underline"
                >
                  {showUnforecast ? "Hide" : "Show"} the{" "}
                  {forecast.totals.noForecast} product
                  {forecast.totals.noForecast === 1 ? "" : "s"} with too little
                  history
                </button>
              )}
          </>
        )}
      </div>

      {/* ---------- Inventory turnover ---------- */}
      <div className="space-y-3">
        <SectionTitle>Inventory turnover</SectionTitle>
        <p className="text-sm font-semibold text-[var(--muted)]">
          How many times you sold and replaced your stock. Cost of goods sold
          divided by the <strong>average</strong> value you held — reconstructed
          from the movement history at each end of the period, not from
          today&rsquo;s figure.
        </p>

        {turnoverError && <ErrorAlert>{turnoverError}</ErrorAlert>}

        {turnover && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat
                label="Turned over"
                value={turnover.ratio === null ? null : `${turnover.ratio}×`}
                unavailable={turnover.unavailableReason ?? undefined}
                tone="accent"
              />
              <Stat
                label="Days of stock"
                value={
                  turnover.daysOfInventory === null
                    ? null
                    : `${turnover.daysOfInventory} days`
                }
                unavailable={
                  turnover.ratio === 0
                    ? "Nothing sold in this period, so the stock would never run out."
                    : "Follows from the turnover figure."
                }
              />
              <Stat
                label="Cost of goods sold"
                value={
                  // A COGS of zero across sales with no recorded cost is not a
                  // measurement, so it isn't shown as one.
                  turnover.salesMissingCost >= turnover.salesCount &&
                  turnover.salesCount > 0
                    ? null
                    : formatMoney(turnover.cogs, currency, 0)
                }
                unavailable="Not recorded for these sales."
              />
              <Stat
                label="Average stock held"
                value={formatMoney(turnover.averageValue, currency, 0)}
              />
            </div>

            {/* Opening and closing shown side by side because the average
                between them is the whole basis of the ratio above — a reader
                who can't see both can't sanity-check it. */}
            <div className={`${cardClass} p-4`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3 text-sm">
                <span className="font-semibold text-[var(--muted)]">
                  Opening{" "}
                  <strong className="text-[var(--text)]">
                    {formatMoney(turnover.openingValue, currency, 0)}
                  </strong>
                  {" → "}
                  closing{" "}
                  <strong className="text-[var(--text)]">
                    {formatMoney(turnover.closingValue, currency, 0)}
                  </strong>
                  <span className="text-[var(--muted)]/70">
                    {" "}
                    over {turnover.period.days} days
                  </span>
                </span>
              </div>
              <p className="mt-2 text-xs font-semibold text-[var(--muted)]/80">
                {turnover.note}
              </p>
            </div>

            {/* Partial cost coverage. Not fatal — the ratio is still computed —
                but it is understated by however many sales carry no cost, and
                a reader comparing periods deserves to know that before they
                conclude their business slowed down. */}
            {turnover.salesMissingCost > 0 &&
              turnover.salesMissingCost < turnover.salesCount && (
                <div
                  className={`${cardClass} border-l-8 border-l-amber-500 p-4 text-sm font-bold text-[var(--text)]`}
                >
                  {turnover.salesMissingCost} of {turnover.salesCount} sales in
                  this period have no recorded cost, so cost of goods sold is
                  understated and the ratio above reads lower than the truth.
                  Sales made before cost tracking started have no cost to
                  report.
                </div>
              )}
          </>
        )}
      </div>

      {/* ---------- Dead & slow-moving stock ---------- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionTitle>Dead &amp; slow-moving stock</SectionTitle>
          {dead && dead.rows.length > 0 && (
            <Button
              variant="secondary"
              onClick={() =>
                downloadCsv(
                  `dead-stock-${today()}.csv`,
                  [
                    "SKU",
                    "Product",
                    "On hand",
                    "Days since last sale",
                    "Status",
                    "Value tied up",
                  ],
                  dead.rows.map((r) => [
                    r.sku,
                    r.name,
                    r.onHand,
                    r.daysSinceLastSale ?? "never sold",
                    r.staleness,
                    r.tiedUpValue,
                  ])
                )
              }
            >
              ⬇ Download CSV
            </Button>
          )}
        </div>

        <p className="text-sm font-semibold text-[var(--muted)]">
          Stock you are holding that isn&rsquo;t selling.{" "}
          <strong>Never sold</strong> is separated from merely slow, because it
          never appears in a sales report at all — it is the easiest kind to
          keep paying for without noticing.
        </p>

        {deadError && <ErrorAlert>{deadError}</ErrorAlert>}

        {dead && dead.rows.length === 0 ? (
          // Two different facts produce zero rows, and only one is good news.
          // Same trap as the turnover card: an empty result is not a reason.
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            {dead.totals.productsHeld === 0
              ? "You aren't holding stock of anything right now, so nothing can be sitting still."
              : `Nothing is sitting still — all ${dead.totals.productsHeld} products you hold have sold within the last ${dead.thresholds.slowAfterDays} days.`}
          </div>
        ) : (
          dead && (
            <>
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
                <Stat
                  label="Money asleep on a shelf"
                  value={formatMoney(dead.totals.tiedUpValue, currency, 0)}
                  tone="danger"
                />
                <Stat
                  label="Products affected"
                  value={String(dead.totals.products)}
                />
                <Stat
                  label="Never sold at all"
                  value={String(dead.totals.dead)}
                  tone={dead.totals.dead > 0 ? "danger" : "text"}
                />
              </div>

              <div className={`${cardClass} overflow-x-auto`}>
                <table className="w-full">
                  <thead>
                    <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                      <th className={th}>Product</th>
                      <th className={`${th} text-right`}>On hand</th>
                      <th className={`${th} text-right`}>Last sold</th>
                      <th className={th}>Status</th>
                      <th className={`${th} text-right`}>Value tied up</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y-2 divide-[var(--line)]/20">
                    {dead.rows.map((r) => (
                      <tr key={r.productId} className="hover:bg-[var(--hover)]">
                        <td className={`${td} font-bold text-[var(--text)]`}>
                          {r.name}
                          <span className="ml-2 font-mono text-xs text-[var(--muted)]">
                            {r.sku}
                          </span>
                        </td>
                        <td
                          className={`${td} text-right font-semibold text-[var(--muted)]`}
                        >
                          {formatQty(r.onHand, r.unit)}
                        </td>
                        <td
                          className={`${td} text-right font-semibold text-[var(--muted)]`}
                        >
                          {r.daysSinceLastSale === null
                            ? "never"
                            : `${r.daysSinceLastSale}d ago`}
                        </td>
                        <td className={td}>
                          <span
                            className={`rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-[10px] font-black ${STALENESS_STYLE[r.staleness].className}`}
                          >
                            {STALENESS_STYLE[r.staleness].label}
                          </span>
                        </td>
                        <td
                          className={`${td} text-right font-black text-[var(--text)]`}
                        >
                          {formatMoney(r.tiedUpValue, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="text-xs font-semibold text-[var(--muted)]/80">
                Slow after {dead.thresholds.slowAfterDays} days without a sale,
                stale after {dead.thresholds.staleAfterDays}. Sorted by money
                tied up — a cheap item gathering dust matters less than an
                expensive one.
              </p>
            </>
          )
        )}
      </div>

      {/* ---------- ABC ---------- */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionTitle>ABC product analysis</SectionTitle>
          <div className="flex gap-2">
            {(["revenue", "quantity"] as const).map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => changeBasis(b)}
                className={`rounded-[5px] border-2 border-[var(--line)] px-3 py-1 text-xs font-bold shadow-[2px_2px_0px_var(--shadow)] ${
                  abcBasis === b
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--card)] text-[var(--text)] hover:bg-[var(--hover)]"
                }`}
              >
                By {b}
              </button>
            ))}
          </div>
        </div>

        <p className="text-sm font-semibold text-[var(--muted)]">
          A small number of products usually carry most of the value.{" "}
          <strong>A</strong> covers the first 80%, <strong>B</strong> the next
          15%, <strong>C</strong> the last 5% — which is normally most of your
          catalogue. Watch the A list closely; don&rsquo;t spend the same
          attention on C.
        </p>

        {abcError && <ErrorAlert>{abcError}</ErrorAlert>}

        {/* The refusal, shown as prominently as a result would be. A reader who
            misses this would take a ranking of six products for an analysis. */}
        {abc?.note && (
          <div
            className={`${cardClass} border-l-8 border-l-amber-500 p-4 text-sm font-bold text-[var(--text)]`}
          >
            {abc.note}
          </div>
        )}

        {abc && abc.rows.length > 0 && (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className={th}>#</th>
                  <th className={th}>Product</th>
                  {abc.classified && <th className={th}>Class</th>}
                  <th className={`${th} text-right`}>
                    {abc.basis === "revenue" ? "Revenue" : "Units"}
                  </th>
                  <th className={`${th} text-right`}>Share</th>
                  <th className={`${th} text-right`}>Running total</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {abc.rows.map((r, i) => (
                  <tr key={r.id} className="hover:bg-[var(--hover)]">
                    <td className={`${td} font-black text-[var(--muted)]`}>
                      {i + 1}
                    </td>
                    <td className={`${td} font-bold text-[var(--text)]`}>
                      {r.label}
                    </td>
                    {abc.classified && (
                      <td className={td}>
                        {r.class && (
                          <span
                            className={`rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-[10px] font-black ${ABC_STYLE[r.class]}`}
                          >
                            {r.class}
                          </span>
                        )}
                      </td>
                    )}
                    <td
                      className={`${td} text-right font-semibold text-[var(--text)]`}
                    >
                      {abc.basis === "revenue"
                        ? formatMoney(r.value, currency)
                        : r.value.toLocaleString()}
                    </td>
                    <td
                      className={`${td} text-right font-semibold text-[var(--muted)]`}
                    >
                      {r.share}%
                    </td>
                    <td className={`${td} text-right font-black text-[var(--text)]`}>
                      {r.cumulativeShare}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {abc && abc.rows.length === 0 && !abc.note && (
          <div className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}>
            No sales in this period.
          </div>
        )}
      </div>

      {/* ---------- Trends ---------- */}
      <div className="space-y-3">
        <SectionTitle>Sales &amp; demand trends</SectionTitle>
        <p className="text-sm font-semibold text-[var(--muted)]">
          The direction things are heading — <strong>not a forecast</strong>.
          This describes what already happened; it makes no claim about next
          month. Small movements are reported as steady on purpose: eleven units
          after ten is noise, not growth.
        </p>

        {trendsError && <ErrorAlert>{trendsError}</ErrorAlert>}

        {trends && (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TrendBadge trend={trends.demandTrend} what="Demand (units)" />
              <TrendBadge trend={trends.revenueTrend} what="Revenue" />
            </div>

            {trends.series.every((d) => d.units === 0) ? (
              <div
                className={`${cardClass} p-6 text-sm font-bold text-[var(--muted)]`}
              >
                No sales in this period.
              </div>
            ) : (
              <div className={`${cardClass} p-4`}>
                <div className="mb-3 text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                  Units sold per day · {trends.period.days} days
                </div>
                <DailyBars series={trends.series} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Units per day as bars.
 *
 * Bars rather than a line, deliberately. A line implies the values BETWEEN two
 * points mean something — but there is no such thing as half past Tuesday's
 * sales. Each day is its own discrete count, and a bar says that.
 *
 * Days with no sales draw a faint baseline stub rather than nothing, so an
 * empty day is visibly an empty day rather than a hole in the chart.
 */
function DailyBars({
  series,
}: {
  series: { date: string; units: number; revenue: number }[];
}) {
  const W = 720;
  const H = 200;
  const padT = 16;
  const padB = 26;
  const innerH = H - padT - padB;
  const n = series.length;
  const max = Math.max(1, ...series.map((d) => d.units));

  const barW = Math.max(1, (W / Math.max(n, 1)) * 0.7);
  const step = W / Math.max(n, 1);
  const x = (i: number) => i * step + (step - barW) / 2;
  const h = (v: number) => (v / max) * innerH;

  const fmtDay = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      role="img"
      aria-label="Units sold per day"
    >
      <line
        x1={0}
        x2={W}
        y1={padT + innerH}
        y2={padT + innerH}
        stroke="var(--line)"
        strokeWidth={1}
        opacity={0.6}
      />
      <text
        x={2}
        y={padT - 4}
        className="fill-[var(--muted)]"
        fontSize={11}
        fontWeight={700}
      >
        {max}
      </text>

      {series.map((d, i) => {
        const barH = h(d.units);
        return (
          <rect
            key={d.date}
            x={x(i)}
            // An empty day still gets 2px so it reads as "zero here", not
            // "no data here".
            y={padT + innerH - Math.max(barH, d.units === 0 ? 2 : barH)}
            width={barW}
            height={Math.max(barH, 2)}
            fill={d.units === 0 ? "var(--line)" : "var(--accent)"}
            opacity={d.units === 0 ? 0.4 : 1}
          >
            <title>{`${fmtDay(d.date)}: ${d.units} sold`}</title>
          </rect>
        );
      })}

      {n > 0 &&
        [0, Math.floor((n - 1) / 2), n - 1]
          .filter((v, idx, arr) => arr.indexOf(v) === idx)
          .map((i) => (
            <text
              key={i}
              x={x(i) + barW / 2}
              y={H - 8}
              textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              className="fill-[var(--muted)]"
              fontSize={11}
              fontWeight={700}
            >
              {fmtDay(series[i]!.date)}
            </text>
          ))}
    </svg>
  );
}
