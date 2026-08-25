/**
 * Invoice — create (/new), edit a draft, view an issued/paid/cancelled one,
 * and print. Issuing deducts stock (SALE movements). Mirrors the PO detail
 * page; the payoff action here is "Issue".
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Invoice, Product, Location, Customer } from "../lib/types";
import { invNumber } from "../lib/types";
import { formatMoney } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { ConfirmModal } from "../components/ConfirmModal";
import { ProductPicker } from "../components/ProductPicker";
import { InvoiceStatusPill } from "./InvoicesPage";
import {
  Button,
  Input,
  Select,
  Field,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";

type LineDraft = { productId: string; quantity: string; unitPrice: string };
const emptyLine: LineDraft = { productId: "", quantity: "1", unitPrice: "" };

// --- amount in words (Indian numbering: thousand / lakh / crore) ---
// Used on the printed invoice, e.g. 127990 → "One Lakh Twenty Seven Thousand
// Nine Hundred Ninety". Kept generic so the currency name is passed in.
const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = [
  "", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety",
];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? " " + ONES[n % 10] : ""}`;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return `${h ? ONES[h] + " Hundred" + (rest ? " " : "") : ""}${
    rest ? twoDigits(rest) : ""
  }`;
}

// Whole-number part in the Indian system (…, crore, lakh, thousand, hundred).
function integerToWords(n: number): string {
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${integerToWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(" ");
}

const CURRENCY_WORDS: Record<string, [string, string]> = {
  INR: ["Rupees", "Paise"],
  USD: ["Dollars", "Cents"],
  EUR: ["Euros", "Cents"],
  GBP: ["Pounds", "Pence"],
  AED: ["Dirhams", "Fils"],
  SGD: ["Dollars", "Cents"],
};

function amountInWords(amount: number, currency = "INR"): string {
  const [major, minor] = CURRENCY_WORDS[currency] ?? [currency, "Cents"];
  const whole = Math.floor(amount);
  const frac = Math.round((amount - whole) * 100);
  const main = `${integerToWords(whole)} ${major}`;
  const paise = frac ? ` and ${twoDigits(frac)} ${minor}` : "";
  return `${main}${paise} Only`;
}

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const isNew = !id;
  const navigate = useNavigate();
  const { user: me, company } = useAuth();
  const currency = company?.currency;
  const canEdit = me?.role === "ADMIN" || me?.role === "MANAGER";

  const [inv, setInv] = useState<Invoice | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");
  const [customerGstin, setCustomerGstin] = useState("");
  const [notes, setNotes] = useState("");
  const [taxRate, setTaxRate] = useState("");
  const [discount, setDiscount] = useState("");
  const [locationId, setLocationId] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ ...emptyLine }]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    async function loadAll() {
      setLoading(true);
      setError(null);
      try {
        const [prod, locs, custs] = await Promise.all([
          api<{ items: Product[] }>("/products?take=500"),
          api<Location[]>("/locations"),
          api<Customer[]>("/customers"),
        ]);
        setProducts(prod.items);
        setLocations(locs);
        setCustomers(custs);
        setLocationId(locs.find((l) => l.isDefault)?.id ?? locs[0]?.id ?? "");

        if (!isNew) {
          const loaded = await api<Invoice>(`/invoices/${id}`);
          setInv(loaded);
          setCustomerId(loaded.customerId ?? "");
          setCustomerName(loaded.customerName);
          setCustomerPhone(loaded.customerPhone ?? "");
          setCustomerAddress(loaded.customerAddress ?? "");
          setCustomerGstin(loaded.customerGstin ?? "");
          setNotes(loaded.notes ?? "");
          setTaxRate(loaded.taxRate ?? "");
          setDiscount(loaded.discount ?? "");
          setLocationId(loaded.location.id);
          setLines(
            loaded.lines.map((l) => ({
              productId: l.productId,
              quantity: String(l.quantity),
              unitPrice: l.unitPrice,
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

  const editable = isNew || (inv?.status === "DRAFT" && canEdit);

  const bill = useMemo(() => {
    const subtotal =
      !editable && inv
        ? inv.lines.reduce((s, l) => s + Number(l.unitPrice) * l.quantity, 0)
        : lines.reduce(
            (s, l) =>
              s + (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0),
            0
          );
    const tr =
      !editable && inv ? Number(inv.taxRate ?? 0) : Number(taxRate) || 0;
    const disc =
      !editable && inv ? Number(inv.discount ?? 0) : Number(discount) || 0;
    const discountAmt = Math.min(Math.max(0, disc), subtotal);
    const taxable = Math.max(0, subtotal - discountAmt);
    const taxAmt = (taxable * tr) / 100;
    return {
      subtotal,
      discountAmt,
      taxRate: tr,
      taxAmt,
      total: taxable + taxAmt,
    };
  }, [editable, inv, lines, taxRate, discount]);
  const total = bill.total;

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
    if (!customerName.trim()) return setFormError("Enter a customer name.");
    if (!locationId) return setFormError("Pick a location.");
    const clean = lines
      .filter((l) => l.productId)
      .map((l) => ({
        productId: l.productId,
        quantity: Number(l.quantity),
        unitPrice: Number(l.unitPrice || 0),
      }));
    if (clean.length === 0) return setFormError("Add at least one line.");
    if (clean.some((l) => !Number.isInteger(l.quantity) || l.quantity < 1))
      return setFormError("Every line needs a whole quantity of 1 or more.");

    const body = {
      customerId: customerId || undefined,
      customerName,
      customerPhone: customerPhone || undefined,
      customerAddress: customerAddress || undefined,
      customerGstin: customerGstin || undefined,
      notes: notes || undefined,
      taxRate: taxRate ? Number(taxRate) : undefined,
      discount: discount ? Number(discount) : undefined,
      locationId,
      lines: clean,
    };

    setSaving(true);
    try {
      if (isNew) {
        const created = await api<Invoice>("/invoices", { method: "POST", body });
        navigate(`/invoices/${created.id}`);
      } else {
        setInv(await api<Invoice>(`/invoices/${id}`, { method: "PATCH", body }));
      }
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function action(path: string, failMsg: string) {
    setFormError(null);
    try {
      setInv(await api<Invoice>(`/invoices/${id}/${path}`, { method: "POST" }));
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : failMsg);
    }
  }

  function printInvoice() {
    if (!inv) return;

    // Guard against HTML injection from free-text fields (customer name/address,
    // notes, product names). Without this, a product literally named
    // "<script>" would break the printed document.
    const esc = (s: string | number | null | undefined) =>
      String(s ?? "").replace(
        /[&<>"']/g,
        (c) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
            c
          ] as string,
      );

    const issued = new Date(inv.issuedAt ?? inv.createdAt);
    const statusColor =
      inv.status === "PAID"
        ? "#059669"
        : inv.status === "CANCELLED"
          ? "#dc2626"
          : "#2d8cf0";

    const ref = invNumber(inv.number);
    const cur = currency ?? "INR";

    // One row of a label:value detail block; skips itself if the value is blank.
    const kv = (label: string, value?: string | null) =>
      `<tr><td class="k">${label}</td><td class="c">:</td><td class="v">${
        value ? esc(value) : "—"
      }</td></tr>`;

    const rows = inv.lines
      .map(
        (l, i) => `<tr>
          <td class="c">${i + 1}</td>
          <td><span class="pname">${esc(l.product.name)}</span>
            <span class="psku">${esc(l.product.sku)}</span></td>
          <td class="c">${l.product.hsnCode ? esc(l.product.hsnCode) : "—"}</td>
          <td class="r">${l.quantity} ${esc(l.product.unit)}</td>
          <td class="r">${formatMoney(Number(l.unitPrice), cur)}</td>
          <td class="r b">${formatMoney(Number(l.unitPrice) * l.quantity, cur)}</td>
        </tr>`,
      )
      .join("");

    // CGST + SGST split — half the rate each, for a sale within one state.
    const halfRate = bill.taxRate / 2;
    const halfTax = bill.taxAmt / 2;
    const roundedTotal = Math.round(bill.total);
    const roundOff = roundedTotal - bill.total;

    const tRow = (label: string, value: string, opts: { grand?: boolean } = {}) =>
      `<tr class="${opts.grand ? "grand" : ""}">
        <td class="tl">${label}</td><td class="tv">${value}</td>
      </tr>`;

    // Terms: split the setting on newlines into a numbered list; fall back to
    // a sensible default so the block is never empty.
    const termsText =
      company?.invoiceTerms ||
      "Goods once sold will not be taken back or exchanged.\nAll disputes subject to local jurisdiction.";
    const terms = termsText
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => `<li>${esc(t)}</li>`)
      .join("");

    const sealTop = esc(company?.sealText || `For ${company?.name ?? "Company"}`);

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${ref} — ${esc(
      company?.name ?? "Invoice",
    )}</title>
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{font-family:'Segoe UI',Arial,sans-serif;color:#111;background:#eceef1;
          padding:24px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .sheet{max-width:820px;margin:auto;background:#fff;border:1.5px solid #111}
        .pad{padding:14px 18px}
        /* header */
        .top{display:flex;justify-content:space-between;align-items:flex-start;
          border-bottom:1.5px solid #111}
        .top .co{padding:14px 18px}
        .co .co-name{font-size:24px;font-weight:800;letter-spacing:-.3px;text-transform:uppercase}
        .co .co-addr{font-size:11px;color:#333;margin-top:3px;max-width:340px;line-height:1.4}
        .top .bc{padding:14px 18px;text-align:right}
        .bc svg{max-width:180px}
        .bc .no{font-size:12px;font-weight:800;margin-top:2px;letter-spacing:1px}
        /* seller details grid */
        .sdet{border-bottom:1.5px solid #111;padding:8px 18px}
        table.kv{border-collapse:collapse}
        table.kv td{font-size:11.5px;padding:1.5px 0;vertical-align:top}
        table.kv .k{color:#555;width:120px;font-weight:600}
        table.kv .c{color:#555;width:14px;text-align:center}
        table.kv .v{font-weight:600}
        /* tax invoice band */
        .band{text-align:center;font-size:15px;font-weight:800;letter-spacing:2px;
          padding:6px;border-bottom:1.5px solid #111;text-transform:uppercase}
        .band .star{color:#999;margin:0 8px}
        /* customer + meta two columns */
        .cust{display:flex;border-bottom:1.5px solid #111}
        .cust .col{flex:1;padding:10px 18px}
        .cust .col+.col{border-left:1.5px solid #111}
        /* items */
        table.items{width:100%;border-collapse:collapse}
        table.items th{font-size:10px;text-transform:uppercase;letter-spacing:.5px;
          background:#f0f1f3;border:1px solid #111;padding:7px 8px;font-weight:800}
        table.items td{border:1px solid #ccc;border-left:1px solid #111;border-right:1px solid #111;
          padding:8px;font-size:12px}
        table.items .c{text-align:center}
        table.items .r{text-align:right;white-space:nowrap}
        table.items .b{font-weight:800}
        .pname{font-weight:700;display:block}
        .psku{font-size:10px;color:#888}
        /* terms + totals split */
        .split{display:flex;border-bottom:1.5px solid #111}
        .split .terms{flex:1;padding:10px 18px;border-right:1.5px solid #111}
        .terms h4{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#555;margin-bottom:5px}
        .terms ol{margin:0;padding-left:16px}
        .terms li{font-size:10.5px;color:#333;line-height:1.5;margin-bottom:2px}
        .split .sums{width:300px}
        table.sums{width:100%;border-collapse:collapse}
        table.sums td{font-size:12px;padding:6px 12px;border-bottom:1px solid #e0e0e0}
        table.sums .tl{color:#333}
        table.sums .tv{text-align:right;font-weight:600;white-space:nowrap}
        table.sums .grand td{background:#111;color:#fff;font-weight:800;font-size:14px}
        /* words */
        .words{padding:8px 18px;border-bottom:1.5px solid #111;font-size:12px}
        .words b{font-weight:800}
        /* signatures */
        .sign{display:flex;min-height:120px}
        .sign .s{flex:1;padding:14px 18px;display:flex;flex-direction:column;justify-content:space-between}
        .sign .s+.s{border-left:1.5px solid #111;text-align:right;align-items:flex-end}
        .sign .lbl{font-size:11px;color:#555;font-weight:600}
        .sign .co2{font-size:11px;font-weight:800;text-transform:uppercase}
        .seal{width:112px;height:112px;border:2.5px double #1f3a8a;border-radius:50%;
          display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;
          color:#1f3a8a;transform:rotate(-7deg);opacity:.85;padding:10px;margin:6px 0}
        .seal .s-top{font-size:10px;font-weight:800;text-transform:uppercase;line-height:1.15}
        .seal .s-div{width:60%;height:1.5px;background:#1f3a8a;margin:5px 0}
        .seal .s-bot{font-size:7.5px;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
        .foot{text-align:center;font-size:11px;color:#555;padding:8px;border-top:1.5px solid #111}
        @media print{ body{background:#fff;padding:0} .sheet{max-width:100%} }
      </style></head><body>
      <div class="sheet">
        <div class="top">
          <div class="co">
            <div class="co-name">${esc(company?.name ?? "Company")}</div>
            ${company?.address ? `<div class="co-addr">${esc(company.address)}</div>` : ""}
          </div>
          <div class="bc">
            <svg id="bc"></svg>
            <div class="no">${ref}</div>
          </div>
        </div>

        <div class="sdet">
          <table class="kv">
            ${company?.phone ? kv("Phone", company.phone) : ""}
            ${company?.gstin ? kv("GSTIN", company.gstin) : ""}
            ${company?.email ? kv("Email ID", company.email) : ""}
            ${company?.pan ? kv("PAN No", company.pan) : ""}
          </table>
        </div>

        <div class="band"><span class="star">*</span>Tax Invoice<span class="star">*</span></div>

        <div class="cust">
          <div class="col">
            <table class="kv">
              ${kv("Customer Name", inv.customerName)}
              ${kv("Address", inv.customerAddress)}
              ${kv("Phone", inv.customerPhone)}
            </table>
          </div>
          <div class="col">
            <table class="kv">
              ${kv("GSTIN", inv.customerGstin)}
              ${kv("Invoice No.", ref)}
              ${kv("Invoice Date", issued.toLocaleDateString())}
              ${kv("Location", inv.location.name)}
              ${kv("Status", inv.status)}
            </table>
          </div>
        </div>

        <table class="items">
          <thead><tr>
            <th class="c" style="width:34px">Sr.</th><th>Item</th>
            <th class="c" style="width:80px">HSN</th>
            <th class="r" style="width:70px">Qty</th>
            <th class="r" style="width:100px">Rate</th>
            <th class="r" style="width:110px">Amount</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>

        <div class="split">
          <div class="terms">
            <h4>Terms &amp; Conditions</h4>
            <ol>${terms}</ol>
          </div>
          <div class="sums">
            <table class="sums">
              ${tRow("Subtotal", formatMoney(bill.subtotal, cur))}
              ${bill.discountAmt > 0 ? tRow("Discount", `-${formatMoney(bill.discountAmt, cur)}`) : ""}
              ${bill.taxAmt > 0 ? tRow(`CGST @ ${halfRate}%`, formatMoney(halfTax, cur)) : ""}
              ${bill.taxAmt > 0 ? tRow(`SGST @ ${halfRate}%`, formatMoney(halfTax, cur)) : ""}
              ${Math.abs(roundOff) > 0.001 ? tRow("Round off", formatMoney(roundOff, cur)) : ""}
              ${tRow("Invoice Total", formatMoney(roundedTotal, cur), { grand: true })}
            </table>
          </div>
        </div>

        <div class="words">
          <b>${amountInWords(roundedTotal, cur)}</b>
        </div>

        <div class="sign">
          <div class="s">
            ${inv.notes ? `<div class="lbl">Remarks: ${esc(inv.notes)}</div>` : "<div></div>"}
            <div class="lbl">Customer Signature</div>
          </div>
          <div class="s">
            <div class="co2">${esc(company?.name ?? "")}</div>
            <div class="seal">
              <div class="s-top">${sealTop}</div>
              <div class="s-div"></div>
              <div class="s-bot">Authorised Signatory</div>
            </div>
            <div class="lbl">Authorised Signatory</div>
          </div>
        </div>

        <div class="foot">Thank you for your business — issued by ${esc(inv.createdBy.name)}</div>
      </div>
      <script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"><\/script>
      <script>window.onload=function(){
        try{JsBarcode('#bc', ${JSON.stringify(ref)}, {format:'CODE128',height:40,fontSize:11,margin:0,displayValue:false});}catch(e){}
        setTimeout(function(){window.print();},450);
      };<\/script>
      </body></html>`;

    const w = window.open("", "_blank", "width=900,height=1040");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
  }

  if (loading)
    return <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>;
  if (error)
    return (
      <div className="space-y-4">
        <ErrorAlert>{error}</ErrorAlert>
        <Link to="/invoices" className="text-sm font-bold text-[var(--accent)] underline">
          ← Back to invoices
        </Link>
      </div>
    );
  // We have an id but the invoice hasn't arrived yet (e.g. just after
  // creating + navigating). Show loading instead of crashing on null.
  if (!isNew && !inv)
    return <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>;

  return (
    <div className="max-w-3xl space-y-6">
      <Link
        to="/invoices"
        className="text-sm font-bold text-[var(--muted)] underline hover:text-[var(--text)]"
      >
        ← Back to invoices
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <SectionTitle>
            {isNew ? "New invoice" : invNumber(inv!.number)}
          </SectionTitle>
          {inv && <InvoiceStatusPill status={inv.status} />}
        </div>
        {inv && (
          <div className="flex gap-3">
            {inv.status !== "DRAFT" && inv.status !== "CANCELLED" && (
              <Button variant="secondary" onClick={printInvoice}>
                Print / PDF
              </Button>
            )}
            {canEdit && inv.status === "DRAFT" && (
              <>
                <Button variant="secondary" onClick={() => action("issue", "Failed to issue")}>
                  Issue
                </Button>
                <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                  Cancel
                </Button>
              </>
            )}
            {canEdit && inv.status === "ISSUED" && (
              <>
                <Button
                  variant="secondary"
                  onClick={() => action("pay", "Failed to mark paid")}
                >
                  Mark paid
                </Button>
                <Button variant="danger" onClick={() => setConfirmCancel(true)}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {editable ? (
        <form onSubmit={save} className={`${cardClass} space-y-5 p-5`}>
          {customers.length > 0 && (
            <Field label="Saved customer" hint="optional — or type a new one below">
              <Select
                value={customerId}
                onChange={(e) => {
                  const cid = e.target.value;
                  setCustomerId(cid);
                  const c = customers.find((x) => x.id === cid);
                  if (c) {
                    setCustomerName(c.name);
                    setCustomerPhone(c.phone ?? "");
                    setCustomerAddress(c.address ?? "");
                  }
                }}
              >
                <option value="">— walk-in / type below —</option>
                {customers
                  .filter((c) => c.isActive || c.id === customerId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer name">
              <Input
                value={customerName}
                onChange={(e) => {
                  setCustomerName(e.target.value);
                  setCustomerId(""); // typing a name = unlink from saved customer
                }}
              />
            </Field>
            <Field label="Phone" hint="optional">
              <Input
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address" hint="optional">
              <Input
                value={customerAddress}
                onChange={(e) => setCustomerAddress(e.target.value)}
              />
            </Field>
            <Field label="Sell from location">
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
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer GSTIN" hint="optional — for B2B invoices">
              <Input
                value={customerGstin}
                placeholder="22AAAAA0000A1Z5"
                onChange={(e) => setCustomerGstin(e.target.value.toUpperCase())}
              />
            </Field>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide text-[var(--muted)]">
              <span className="flex-1">Item</span>
              <span className="w-20 text-center">Qty</span>
              <span className="w-28 text-right">Unit price</span>
              <span className="w-28 text-right">Amount</span>
              <span className="w-6" />
            </div>
            {lines.map((l, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <ProductPicker
                    products={products.filter(
                      (p) => p.isActive || p.id === l.productId
                    )}
                    value={l.productId}
                    onChange={(pid) => {
                      // Pre-fill the unit price with the product's selling
                      // price (still editable afterwards).
                      const prod = products.find((p) => p.id === pid);
                      setLine(i, {
                        productId: pid,
                        unitPrice: prod ? prod.sellingPrice : l.unitPrice,
                      });
                    }}
                  />
                </div>
                <div className="w-20">
                  <Input
                    type="number"
                    min="1"
                    step="1"
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
                    placeholder="Unit price"
                    value={l.unitPrice}
                    onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                  />
                </div>
                <div className="w-28 pb-2 text-right text-sm font-black text-[var(--text)]">
                  {formatMoney(
                    (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0),
                    currency
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  disabled={lines.length === 1}
                  className="w-6 pb-2 text-lg font-black text-[var(--muted)] hover:text-red-500 disabled:opacity-30"
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

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Discount" hint="flat amount, optional">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
            <Field label="Tax %" hint="optional">
              <Input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
              />
            </Field>
            <Field label="Notes" hint="optional">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>

          <div className="border-t-2 border-[var(--line)]/20 pt-4">
            <div className="ml-auto max-w-xs space-y-1 text-sm">
              <div className="flex justify-between text-[var(--muted)]">
                <span>Subtotal</span>
                <span>{formatMoney(bill.subtotal, currency)}</span>
              </div>
              {bill.discountAmt > 0 && (
                <div className="flex justify-between text-[var(--muted)]">
                  <span>Discount</span>
                  <span>−{formatMoney(bill.discountAmt, currency)}</span>
                </div>
              )}
              {bill.taxAmt > 0 && (
                <div className="flex justify-between text-[var(--muted)]">
                  <span>Tax ({bill.taxRate}%)</span>
                  <span>{formatMoney(bill.taxAmt, currency)}</span>
                </div>
              )}
              <div className="flex justify-between border-t-2 border-[var(--line)]/20 pt-1 text-base font-black text-[var(--text)]">
                <span>Total</span>
                <span>{formatMoney(bill.total, currency)}</span>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : isNew ? "Create draft" : "Save changes"}
              </Button>
            </div>
          </div>

          {formError && <ErrorAlert>{formError}</ErrorAlert>}
        </form>
      ) : (
        <>
          {formError && <ErrorAlert>{formError}</ErrorAlert>}
          <div className={`${cardClass} p-5`}>
            <div className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs font-bold text-[var(--muted)]">Customer</div>
                <div className="font-black text-[var(--text)]">
                  {inv!.customerName}
                </div>
                {(inv!.customerPhone || inv!.customerAddress) && (
                  <div className="text-xs font-semibold text-[var(--muted)]">
                    {[inv!.customerPhone, inv!.customerAddress]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </div>
              <div>
                <div className="text-xs font-bold text-[var(--muted)]">Sold from</div>
                <div className="font-black text-[var(--text)]">
                  {inv!.location.name}
                </div>
              </div>
              <div>
                <div className="text-xs font-bold text-[var(--muted)]">Issued</div>
                <div className="font-black text-[var(--text)]">
                  {inv!.issuedAt
                    ? new Date(inv!.issuedAt).toLocaleDateString()
                    : "—"}
                </div>
              </div>
            </div>
            {inv!.notes && (
              <div className="mt-4 border-t-2 border-[var(--line)]/20 pt-3 text-sm font-medium italic text-[var(--muted)]">
                {inv!.notes}
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
                    Qty
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Unit price
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-[var(--line)]/20">
                {inv!.lines.map((l) => (
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
                    <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--muted)]">
                      {formatMoney(Number(l.unitPrice), currency)}
                    </td>
                    <td className="px-4 py-3 text-right text-sm font-black text-[var(--text)]">
                      {formatMoney(Number(l.unitPrice) * l.quantity, currency)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-[var(--line)] bg-[var(--panel)]">
                  <td className="px-4 py-2 text-sm font-bold text-[var(--muted)]" colSpan={3}>
                    Subtotal
                  </td>
                  <td className="px-4 py-2 text-right text-sm font-semibold text-[var(--muted)]">
                    {formatMoney(bill.subtotal, currency)}
                  </td>
                </tr>
                {bill.discountAmt > 0 && (
                  <tr className="bg-[var(--panel)]">
                    <td className="px-4 py-1 text-sm font-bold text-[var(--muted)]" colSpan={3}>
                      Discount
                    </td>
                    <td className="px-4 py-1 text-right text-sm font-semibold text-[var(--muted)]">
                      −{formatMoney(bill.discountAmt, currency)}
                    </td>
                  </tr>
                )}
                {bill.taxAmt > 0 && (
                  <tr className="bg-[var(--panel)]">
                    <td className="px-4 py-1 text-sm font-bold text-[var(--muted)]" colSpan={3}>
                      Tax ({bill.taxRate}%)
                    </td>
                    <td className="px-4 py-1 text-right text-sm font-semibold text-[var(--muted)]">
                      {formatMoney(bill.taxAmt, currency)}
                    </td>
                  </tr>
                )}
                <tr className="bg-[var(--panel)]">
                  <td
                    className="px-4 py-3 text-sm font-black text-[var(--text)]"
                    colSpan={3}
                  >
                    TOTAL
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-black text-[var(--accent)]">
                    {formatMoney(bill.total, currency)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {confirmCancel && (
        <ConfirmModal
          title={`Cancel ${inv ? invNumber(inv.number) : "this invoice"}?`}
          message={
            inv?.status === "ISSUED"
              ? "This cancels the invoice and returns its items to stock. It stays on record as cancelled."
              : "This marks the draft cancelled. It stays on record but can't be issued."
          }
          confirmLabel="Cancel invoice"
          danger
          onConfirm={async () => {
            setInv(
              await api<Invoice>(`/invoices/${id}/cancel`, { method: "POST" })
            );
          }}
          onClose={() => setConfirmCancel(false)}
        />
      )}
    </div>
  );
}
