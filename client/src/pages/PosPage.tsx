/**
 * The till (P3-4).
 *
 * A counter screen has one job the rest of the app doesn't: somebody is
 * standing there waiting. Every decision below follows from that.
 *
 *   - The scan box keeps focus. A cashier should never have to click anything
 *     between customers, and a barcode scanner types into whatever is focused.
 *   - The total is the biggest thing on the screen, because it is the number
 *     being read aloud.
 *   - Change is enormous and stays up after the sale, because it is counted
 *     out of a drawer by hand while the next customer arrives.
 *
 * WHAT THIS SCREEN DOES NOT DO
 *
 * It doesn't touch stock, price anything, or work out tax. The basket is a
 * list of product ids and quantities; it is sent to POST /api/pos/sale and the
 * server does the rest through the same services an invoice uses. The prices
 * shown here are an ESTIMATE for the customer's benefit — the invoice that
 * comes back is the authority, and if the two ever disagree the invoice wins.
 * That is why the receipt panel shows the server's totals, not these.
 *
 * Online-only, per the spec. No queue, no local persistence: a sale that
 * cannot reach the server has not happened, and the cashier learns that
 * immediately rather than at closing time.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { formatMoney } from "../lib/format";
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
import { ProductPicker } from "../components/ProductPicker";
import type { Product, Location, Invoice } from "../lib/types";

const PAYMENT_METHODS = ["CASH", "CARD", "UPI", "BANK_TRANSFER", "CHEQUE", "OTHER"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

type BasketLine = {
  product: Product;
  quantity: number;
  /** Set only when the cashier overrode it. Otherwise the server prices it. */
  unitPrice: number | null;
};

type SaleResult = {
  invoice: Invoice;
  payment: { amount: number; method: string; change: number } | null;
  balance: number;
};

export function PosPage() {
  const { company } = useAuth();
  const currency = company?.currency;

  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);

  const [basket, setBasket] = useState<BasketLine[]>([]);
  const [scan, setScan] = useState("");
  const [scanError, setScanError] = useState<string | null>(null);

  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [tendered, setTendered] = useState("");
  const [onAccount, setOnAccount] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [useGst, setUseGst] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SaleResult | null>(null);

  const scanRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<AudioContext | null>(null);

  /** A short tone, so a scan that failed is audible without looking up. */
  function beep(ok: boolean) {
    try {
      const AC =
        window.AudioContext || (window as unknown as any).webkitAudioContext;
      if (!AC) return;
      if (!audioRef.current) audioRef.current = new AC();
      const ctx = audioRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = ok ? 880 : 200;
      gain.gain.value = 0.1;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + (ok ? 0.1 : 0.26));
    } catch {
      /* no audio available */
    }
  }

  useEffect(() => {
    api<Location[]>("/locations")
      .then((locs) => {
        setLocations(locs);
        setLocationId(locs.find((l) => l.isDefault)?.id ?? locs[0]?.id ?? "");
      })
      .catch((e) =>
        setError(e instanceof ApiError ? e.message : "Failed to load tills")
      );
    api<{ items?: Product[] } | Product[]>("/products?take=500")
      .then((r) => setProducts(Array.isArray(r) ? r : (r.items ?? [])))
      .catch(() => setProducts([]));
  }, []);

  // Keep the scan box focused between customers. A cashier should never need
  // to click before scanning, and the scanner types wherever focus happens
  // to be — into the void, if nothing has it.
  useEffect(() => {
    if (!result) scanRef.current?.focus();
  }, [basket.length, result, locationId]);

  function addToBasket(product: Product, quantity = 1) {
    setBasket((b) => {
      const at = b.findIndex(
        (l) => l.product.id === product.id && l.unitPrice === null
      );
      if (at === -1) return [...b, { product, quantity, unitPrice: null }];
      // Scanning the same item twice bumps the line rather than adding a
      // second one — a receipt reading "Milk ×1, Milk ×1, Milk ×1" is
      // needlessly hard to check against a bag.
      const next = [...b];
      next[at] = { ...next[at]!, quantity: next[at]!.quantity + quantity };
      return next;
    });
  }

  async function handleScan(e: FormEvent) {
    e.preventDefault();
    const code = scan.trim();
    if (!code) return;
    setScan("");
    setScanError(null);

    // Try the catalogue we already have before asking the server — a shop
    // scans the same hundred barcodes all day.
    const known = products.find(
      (p) => p.barcode && p.barcode.toLowerCase() === code.toLowerCase()
    );
    if (known) {
      addToBasket(known);
      beep(true);
      return;
    }

    try {
      const found = await api<Product>(
        `/products/lookup?barcode=${encodeURIComponent(code)}`
      );
      addToBasket(found);
      beep(true);
    } catch {
      setScanError(`No product with barcode ${code}`);
      beep(false);
    }
  }

  function setQuantity(index: number, quantity: number) {
    setBasket((b) =>
      quantity <= 0
        ? b.filter((_, i) => i !== index)
        : b.map((l, i) => (i === index ? { ...l, quantity } : l))
    );
  }

  function setPrice(index: number, raw: string) {
    const n = raw === "" ? null : Number(raw);
    setBasket((b) =>
      b.map((l, i) =>
        i === index
          ? { ...l, unitPrice: n === null || Number.isNaN(n) ? null : n }
          : l
      )
    );
  }

  /**
   * A running total for the CUSTOMER, not for the books.
   *
   * Deliberately excludes tax: this screen doesn't know whether the sale is
   * intra- or inter-state, what each product's rate is, or how rounding falls
   * — and reimplementing that here to show a slightly better number is exactly
   * how a second, wrong tax engine gets written. The invoice below carries the
   * real total.
   */
  const estimate = basket.reduce(
    (sum, l) =>
      sum + l.quantity * (l.unitPrice ?? Number(l.product.sellingPrice)),
    0
  );

  const tenderedNum = Number(tendered);
  const changeEstimate =
    tendered !== "" && !Number.isNaN(tenderedNum)
      ? tenderedNum - estimate
      : null;

  /**
   * Items in the basket with no GST rate decided.
   *
   * The server refuses these, and rightly — a blank rate printed as "0%" is a
   * claim about the goods, not a note about a blank field. But the server can
   * only refuse at the moment of sale, which at a counter is the worst
   * possible time: the goods are bagged and the total has been said out loud.
   *
   * This is the SAME check, moved earlier. It is possible only because the
   * client already holds every product's rate, so nothing is being duplicated
   * that it would have to fetch or infer — and it deliberately does not try to
   * be clever about WHAT the rate should be. It reports the gap; the server
   * still decides.
   *
   * null means "nobody decided"; 0 means "nil-rated", which is a real answer
   * and passes.
   */
  const unratedForGst = useGst
    ? basket.filter((l) => l.product.gstRate === null)
    : [];

  async function completeSale() {
    if (basket.length === 0 || !locationId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<SaleResult>("/pos/sale", {
        method: "POST",
        body: {
          locationId,
          customerName: customerName.trim() || undefined,
          useGst: useGst || undefined,
          lines: basket.map((l) => ({
            productId: l.product.id,
            quantity: l.quantity,
            // Omitted unless overridden, so the SERVER prices the line from
            // the live catalogue rather than from whatever this tab loaded.
            ...(l.unitPrice !== null ? { unitPrice: l.unitPrice } : {}),
          })),
          payment: onAccount
            ? undefined
            : {
                method,
                ...(tendered !== "" && !Number.isNaN(tenderedNum)
                  ? { amount: tenderedNum }
                  : {}),
              },
        },
      });
      setResult(res);
      setBasket([]);
      setTendered("");
      setCustomerName("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not complete sale");
      beep(false);
    } finally {
      setBusy(false);
    }
  }

  function newSale() {
    setResult(null);
    setError(null);
    setScanError(null);
  }

  /* ---------------------------------------------------------------- *
   * Receipt — shown after a completed sale                            *
   * ---------------------------------------------------------------- */
  if (result) {
    return (
      <div className="max-w-2xl space-y-5">
        <div className={`${cardClass} border-l-8 border-l-emerald-500 p-6`}>
          <div className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
            Sale complete
          </div>
          <div className="mt-1 text-3xl font-black tracking-tight text-[var(--text)]">
            INV-{String(result.invoice.number).padStart(4, "0")}
          </div>

          {/* Change is the biggest thing here because it is counted out of a
              drawer by hand, often while the next customer is already
              talking. It stays on screen until the cashier starts a new sale. */}
          {result.payment && result.payment.change > 0 && (
            <div className="mt-5 rounded-[6px] border-2 border-[var(--line)] bg-[var(--panel)] p-5">
              <div className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                Change to give
              </div>
              <div className="text-5xl font-black tracking-tight text-emerald-500">
                {formatMoney(result.payment.change, currency)}
              </div>
            </div>
          )}

          <div className="mt-5 space-y-1 text-sm font-bold">
            {result.payment && (
              <div className="flex justify-between">
                <span className="text-[var(--muted)]">
                  Paid · {result.payment.method}
                </span>
                <span className="text-[var(--text)]">
                  {formatMoney(result.payment.amount, currency)}
                </span>
              </div>
            )}
            {result.balance > 0 && (
              <div className="flex justify-between text-amber-500">
                <span>Still owing</span>
                <span>{formatMoney(result.balance, currency)}</span>
              </div>
            )}
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={newSale}>Next customer</Button>
            <Link
              to={`/invoices/${result.invoice.id}`}
              className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] px-4 py-2 text-sm font-bold text-[var(--text)] shadow-[2px_2px_0px_var(--shadow)] hover:bg-[var(--hover)]"
            >
              Open invoice / print
            </Link>
          </div>
        </div>

        <p className="text-xs font-semibold text-[var(--muted)]">
          This sale is an ordinary invoice — it deducted stock, recorded cost of
          goods, and appears in every report exactly like one raised by hand.
        </p>
      </div>
    );
  }

  /* ---------------------------------------------------------------- *
   * Till                                                              *
   * ---------------------------------------------------------------- */
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      {/* ---------------- basket ---------------- */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="Till / location">
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
        </div>

        <form onSubmit={handleScan} className={`${cardClass} p-4`}>
          <label className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
            Scan a barcode
          </label>
          <Input
            ref={scanRef}
            autoFocus
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder="Scan or type a barcode, then Enter"
            className="mt-1 text-lg"
          />
          {scanError && (
            <p className="mt-2 text-sm font-bold text-red-500">{scanError}</p>
          )}
          <div className="mt-3">
            <span className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
              or find it by name
            </span>
            <div className="mt-1">
              <ProductPicker
                products={products}
                value=""
                onChange={(id) => {
                  const p = products.find((x) => x.id === id);
                  if (p) addToBasket(p);
                  scanRef.current?.focus();
                }}
                placeholder="Search products…"
              />
            </div>
          </div>
        </form>

        {basket.length === 0 ? (
          <div className={`${cardClass} p-10 text-center`}>
            <div className="text-sm font-bold text-[var(--muted)]">
              Basket is empty — scan something to start.
            </div>
          </div>
        ) : (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                  <th className="px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Item
                  </th>
                  <th className="px-3 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Qty
                  </th>
                  <th className="px-3 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Price
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Line
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {basket.map((l, i) => {
                  const price = l.unitPrice ?? Number(l.product.sellingPrice);
                  return (
                    <tr key={`${l.product.id}-${i}`}>
                      <td className="px-4 py-3">
                        <div className="font-bold text-[var(--text)]">
                          {l.product.name}
                        </div>
                        <div className="font-mono text-xs text-[var(--muted)]">
                          {l.product.sku}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={l.quantity}
                          onChange={(e) =>
                            setQuantity(i, Number(e.target.value))
                          }
                          className="w-20 rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] px-2 py-1 text-right text-sm font-bold text-[var(--text)]"
                        />
                      </td>
                      <td className="px-3 py-3 text-right">
                        <input
                          type="number"
                          min={0}
                          step="any"
                          value={l.unitPrice ?? ""}
                          placeholder={String(l.product.sellingPrice)}
                          onChange={(e) => setPrice(i, e.target.value)}
                          title="Leave blank to use the catalogue price"
                          className="w-24 rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] px-2 py-1 text-right text-sm font-bold text-[var(--text)]"
                        />
                      </td>
                      <td className="px-4 py-3 text-right text-sm font-black text-[var(--text)]">
                        {formatMoney(l.quantity * price, currency)}
                      </td>
                      <td className="px-2 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setQuantity(i, 0)}
                          className="px-2 text-lg font-black text-[var(--muted)] hover:text-red-500"
                          title="Remove"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------------- payment ---------------- */}
      <div className="space-y-4">
        <div className={`${cardClass} p-5`}>
          <div className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
            Total {useGst && <span>(before tax)</span>}
          </div>
          {/* The number being read aloud to the customer, so it is the largest
              thing on the screen. */}
          <div className="text-4xl font-black tracking-tight text-[var(--text)]">
            {formatMoney(estimate, currency)}
          </div>
          <div className="mt-1 text-xs font-semibold text-[var(--muted)]">
            {basket.reduce((n, l) => n + l.quantity, 0)} item
            {basket.reduce((n, l) => n + l.quantity, 0) === 1 ? "" : "s"}
            {useGst && " · tax is added by the invoice"}
          </div>
        </div>

        <div className={`${cardClass} space-y-3 p-5`}>
          <SectionTitle>Payment</SectionTitle>

          <label className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
            <input
              type="checkbox"
              checked={onAccount}
              onChange={(e) => setOnAccount(e.target.checked)}
            />
            Put on account (pay later)
          </label>

          {!onAccount && (
            <>
              <Field label="Method">
                <Select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m.replace("_", " ")}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Cash tendered (optional)">
                <Input
                  type="number"
                  min={0}
                  step="any"
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  placeholder="Exact amount"
                />
              </Field>

              {/* An ESTIMATE, and labelled as one. The server decides the real
                  change once it has applied tax — showing a confident figure
                  here that the receipt then contradicts is worse than showing
                  a rough one. */}
              {changeEstimate !== null && changeEstimate > 0 && (
                <div className="rounded-[6px] border-2 border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Change (approx.)
                  </div>
                  <div className="text-2xl font-black text-emerald-500">
                    {formatMoney(changeEstimate, currency)}
                  </div>
                </div>
              )}
              {changeEstimate !== null && changeEstimate < 0 && (
                <p className="text-sm font-bold text-amber-500">
                  Short by {formatMoney(-changeEstimate, currency)} — this will
                  be recorded as a part payment.
                </p>
              )}
            </>
          )}

          <Field label="Customer (optional)">
            <Input
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
              placeholder="Walk-in customer"
            />
          </Field>

          <label className="flex items-center gap-2 text-sm font-bold text-[var(--text)]">
            <input
              type="checkbox"
              checked={useGst}
              onChange={(e) => setUseGst(e.target.checked)}
            />
            GST invoice
          </label>

          {/* Surfaced the moment GST is ticked, not at payment. Amber rather
              than red: nothing has gone wrong yet, and there is still time to
              fix it or sell without GST. */}
          {unratedForGst.length > 0 && (
            <div className="rounded-[6px] border-2 border-[var(--line)] border-l-8 border-l-amber-500 bg-[var(--panel)] p-3">
              <div className="text-xs font-black uppercase tracking-wide text-amber-500">
                No GST rate set
              </div>
              <ul className="mt-1 space-y-0.5 text-sm font-bold text-[var(--text)]">
                {[...new Set(unratedForGst.map((l) => l.product.id))].map(
                  (id) => {
                    const p = unratedForGst.find((l) => l.product.id === id)!
                      .product;
                    return (
                      <li key={id}>
                        {p.name}{" "}
                        <Link
                          to={`/products/${p.id}`}
                          className="font-mono text-xs text-[var(--accent)] hover:underline"
                        >
                          {p.sku} →
                        </Link>
                      </li>
                    );
                  }
                )}
              </ul>
              <p className="mt-2 text-xs font-semibold text-[var(--muted)]">
                Set a rate on the product (enter <strong>0</strong> if the goods
                really are nil-rated), or untick GST invoice to sell without it.
              </p>
            </div>
          )}

          {error && <ErrorAlert>{error}</ErrorAlert>}

          <Button
            onClick={completeSale}
            disabled={
              busy ||
              basket.length === 0 ||
              !locationId ||
              // Blocked here as well as on the server. Not belt-and-braces:
              // the server's refusal is the one that counts, but a button that
              // can only fail is worse than a disabled one — it invites the
              // cashier to keep pressing it in front of a customer.
              unratedForGst.length > 0
            }
            className="w-full"
          >
            {busy
              ? "Completing…"
              : unratedForGst.length > 0
                ? "Set GST rates first"
                : onAccount
                  ? "Complete (on account)"
                  : `Take ${formatMoney(estimate, currency)}`}
          </Button>

          {basket.length > 0 && (
            <button
              type="button"
              onClick={() => setBasket([])}
              className="w-full text-xs font-black uppercase tracking-wide text-[var(--muted)] hover:text-red-500"
            >
              Clear basket
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
