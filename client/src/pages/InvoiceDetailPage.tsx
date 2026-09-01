/**
 * Invoice — create (/new), edit a draft, view an issued/paid/cancelled one,
 * and print. Issuing deducts stock (SALE movements). Mirrors the PO detail
 * page; the payoff action here is "Issue".
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type {
  Invoice,
  Product,
  Location,
  Customer,
  Payment,
  PaymentMethod,
} from "../lib/types";
import { PAYMENT_METHOD_LABELS } from "../lib/types";
import { invNumber } from "../lib/types";
import { formatMoney, qtyNum, formatQty } from "../lib/format";
import { useAuth } from "../context/AuthContext";
import { GST_STATES, stateLabel } from "../lib/gst";
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

// Table cell styles, matching the inline classes used elsewhere in this file.
const th =
  "px-4 py-3 text-left text-xs font-black uppercase tracking-wide text-[var(--muted)]";
const td = "px-4 py-3 text-sm";

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
  // GST controls (P2-3). Opt-in PER INVOICE rather than a global switch, so
  // turning GST on never changes the meaning of an invoice already raised.
  const [useGst, setUseGst] = useState(false);
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const companyState = company?.stateCode ?? null;
  const gstReady = !!companyState;
  const [discount, setDiscount] = useState("");
  const [locationId, setLocationId] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([{ ...emptyLine }]);
  const [formError, setFormError] = useState<string | null>(null);

  // --- Payments (P1-5) ---
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<PaymentMethod>("CASH");
  const [payReference, setPayReference] = useState("");
  const [payError, setPayError] = useState<string | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [deletingPaymentId, setDeletingPaymentId] = useState<string | null>(null);
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
          setUseGst(loaded.taxMode === "GST");
          setPlaceOfSupply(loaded.placeOfSupply ?? "");
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
        ? inv.lines.reduce(
            (s, l) => s + Number(l.unitPrice) * qtyNum(l.quantity),
            0
          )
        : lines.reduce(
            (s, l) =>
              s + (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0),
            0
          );
    const disc =
      !editable && inv ? Number(inv.discount ?? 0) : Number(discount) || 0;
    const discountAmt = Math.min(Math.max(0, disc), subtotal);

    // A GST invoice is READ, not recalculated (P2-3).
    //
    // Its tax was computed per line and stamped when the invoice was raised.
    // Recomputing here would be wrong twice over: `inv.taxRate` is NULL on a
    // GST invoice, so this used to display ₹0 tax on a fully-taxed bill; and
    // even with a rate to hand, a client-side recalculation is a second
    // implementation waiting to disagree with the stored figures the customer
    // was actually charged.
    // Shown while EDITING a draft too, not only on a read-only invoice.
    //
    // GST is computed server-side and stamped on save, so a draft being edited
    // has real figures to display from its last save. Restricting this to
    // read-only mode meant a saved GST draft showed "Total ₹550" with no tax
    // at all — the invoice looked untaxed until it was issued.
    //
    // The numbers refresh on each save; mid-edit they describe the last saved
    // state, which is the only honest thing to show for a figure this side
    // cannot compute.
    if (inv?.taxMode === "GST" && inv.gst) {
      const g = inv.gst;
      const cgst = Number(g.cgstAmount);
      const sgst = Number(g.sgstAmount);
      const igst = Number(g.igstAmount);
      const taxableValue = Number(g.taxableValue);
      return {
        subtotal,
        discountAmt,
        // Kept for the flat-rate display path; meaningless under GST, where
        // each line carries its own rate.
        taxRate: 0,
        taxAmt: cgst + sgst + igst,
        total: taxableValue + cgst + sgst + igst,
        gst: g,
        isGst: true as const,
        cgst,
        sgst,
        igst,
        taxableValue,
      };
    }

    const tr =
      !editable && inv ? Number(inv.taxRate ?? 0) : Number(taxRate) || 0;
    const taxable = Math.max(0, subtotal - discountAmt);
    const taxAmt = (taxable * tr) / 100;
    return {
      subtotal,
      discountAmt,
      taxRate: tr,
      taxAmt,
      total: taxable + taxAmt,
      gst: null,
      isGst: false as const,
      cgst: 0,
      sgst: 0,
      igst: 0,
      taxableValue: taxable,
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
      taxRate: useGst ? undefined : taxRate ? Number(taxRate) : undefined,
      useGst: useGst || undefined,
      placeOfSupply: useGst && placeOfSupply ? placeOfSupply : undefined,
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
        // PATCH and the action endpoints return the raw invoice row. Only
        // GET /invoices/:id attaches the derived extras — the GST breakdown
        // and the payment summary. Trusting the write response therefore
        // wiped the CGST/SGST lines off the screen on every save.
        await api<Invoice>(`/invoices/${id}`, { method: "PATCH", body });
        setInv(await api<Invoice>(`/invoices/${id}`));
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
      await api<Invoice>(`/invoices/${id}/${path}`, { method: "POST" });
      // Re-read for the same reason as save() — the action response carries no
      // GST breakdown or payment summary.
      setInv(await api<Invoice>(`/invoices/${id}`));
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : failMsg);
    }
  }

  /** Reload the invoice so the derived balance/status come from the server. */
  async function reloadInvoice() {
    setInv(await api<Invoice>(`/invoices/${id}`));
  }

  async function recordPayment(e: FormEvent) {
    e.preventDefault();
    setPayError(null);
    setPayBusy(true);
    try {
      await api("/payments", {
        method: "POST",
        body: {
          invoiceId: id,
          amount: Number(payAmount),
          method: payMethod,
          reference: payReference.trim() || undefined,
        },
      });
      setPayAmount("");
      setPayReference("");
      await reloadInvoice();
    } catch (err) {
      setPayError(
        err instanceof ApiError ? err.message : "Could not record payment"
      );
    } finally {
      setPayBusy(false);
    }
  }

  async function removePayment(paymentId: string) {
    setPayError(null);
    setDeletingPaymentId(paymentId);
    try {
      await api(`/payments/${paymentId}`, { method: "DELETE" });
      await reloadInvoice();
    } catch (err) {
      setPayError(
        err instanceof ApiError ? err.message : "Could not remove payment"
      );
    } finally {
      setDeletingPaymentId(null);
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
          <td class="r">${formatQty(l.quantity)} ${esc(l.product.unit)}</td>
          <td class="r">${formatMoney(Number(l.unitPrice), cur)}</td>
          <td class="r b">${formatMoney(Number(l.unitPrice) * qtyNum(l.quantity), cur)}</td>
        </tr>`,
      )
      .join("");

    // Tax rows for the printed bill.
    //
    // FLAT invoices keep the old approximation: halve the single rate and call
    // it CGST + SGST. That assumes an intra-state sale, which is all a flat
    // rate could ever describe.
    //
    // GST invoices print the amounts STAMPED on their lines, grouped by rate
    // slab, and print IGST instead of CGST/SGST on an inter-state sale.
    // Printing a halved rate there would produce a legally wrong document:
    // CGST/SGST and IGST go to different governments, so showing the wrong
    // pair misstates who was paid.
    // Same markup as tRow below, declared here because the tax rows are built
    // before that helper exists.
    const taxRow = (label: string, value: string) =>
      `<tr><td class="tl">${label}</td><td class="tv">${value}</td></tr>`;

    const taxRows: string[] = [];
    if (bill.isGst && bill.gst) {
      for (const slab of bill.gst.byRate) {
        const rate = Number(slab.gstRate);
        const half = rate / 2;
        if (Number(slab.igstAmount) > 0) {
          taxRows.push(
            taxRow(`IGST @ ${rate}%`, formatMoney(Number(slab.igstAmount), cur))
          );
        } else if (Number(slab.cgstAmount) > 0 || Number(slab.sgstAmount) > 0) {
          taxRows.push(
            taxRow(`CGST @ ${half}%`, formatMoney(Number(slab.cgstAmount), cur)),
            taxRow(`SGST @ ${half}%`, formatMoney(Number(slab.sgstAmount), cur))
          );
        }
      }
    } else if (bill.taxAmt > 0) {
      const halfRate = bill.taxRate / 2;
      const halfTax = bill.taxAmt / 2;
      taxRows.push(
        taxRow(`CGST @ ${halfRate}%`, formatMoney(halfTax, cur)),
        taxRow(`SGST @ ${halfRate}%`, formatMoney(halfTax, cur))
      );
    }
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
              ${taxRows.join("")}
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
          {/* Which GST treatment applied, stated plainly. The tax lines below
              imply it, but "why does this say IGST?" is a question worth
              answering without arithmetic. */}
          {inv?.taxMode === "GST" && (
            <span
              className="rounded-[4px] border-2 border-[var(--line)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-white"
              style={{
                background:
                  inv.supplyType === "INTER_STATE" ? "#8b5cf6" : "#0ea5e9",
              }}
              title={
                inv.supplyType === "INTER_STATE"
                  ? `Inter-state sale to ${stateLabel(inv.placeOfSupply)} — charged as IGST`
                  : `Sale within your state — charged as CGST + SGST`
              }
            >
              {inv.supplyType === "INTER_STATE" ? "IGST" : "CGST+SGST"}
            </span>
          )}
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
            {/* The switch itself. Disabled until the company has a state,
                because without one the server cannot tell an intra-state sale
                from an inter-state one and refuses the invoice — better to
                explain that here than to fail on submit. */}
            <label
              className={`flex items-start gap-2 text-sm font-bold text-[var(--text)] ${
                gstReady ? "" : "opacity-60"
              }`}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={useGst}
                disabled={!gstReady}
                onChange={(e) => setUseGst(e.target.checked)}
              />
              <span>
                Raise as a GST invoice
                <span className="block text-xs font-medium text-[var(--muted)]">
                  {gstReady
                    ? "Tax is worked out per line from each product's GST rate, then split into CGST/SGST or IGST."
                    : "Set your business state in Settings first — it decides CGST/SGST vs IGST."}
                </span>
              </span>
            </label>

            {/* Flat rate only applies when GST is off — the two are
                alternative regimes, not layers. Showing both at once would
                invite someone to fill in a rate that is then ignored. */}
            {!useGst && (
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
            )}
            {useGst && (
              <Field label="Place of supply" hint="where the customer is">
                <Select
                  value={placeOfSupply}
                  onChange={(e) => setPlaceOfSupply(e.target.value)}
                >
                  <option value="">
                    Same as your state ({stateLabel(companyState)})
                  </option>
                  {GST_STATES.map((st) => (
                    <option key={st.code} value={st.code}>
                      {st.code} — {st.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
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
              {/* GST prints per rate slab — a GST invoice is required to
                  show tax under each rate separately, not as one figure. */}
              {bill.isGst && bill.gst
                ? bill.gst.byRate.map((slab) => {
                    const rate = Number(slab.gstRate);
                    const igst = Number(slab.igstAmount);
                    return igst > 0 ? (
                      <div
                        key={slab.gstRate}
                        className="flex justify-between text-[var(--muted)]"
                      >
                        <span>IGST @ {rate}%</span>
                        <span>{formatMoney(igst, currency)}</span>
                      </div>
                    ) : (
                      <div key={slab.gstRate} className="space-y-1">
                        <div className="flex justify-between text-[var(--muted)]">
                          <span>CGST @ {rate / 2}%</span>
                          <span>
                            {formatMoney(Number(slab.cgstAmount), currency)}
                          </span>
                        </div>
                        <div className="flex justify-between text-[var(--muted)]">
                          <span>SGST @ {rate / 2}%</span>
                          <span>
                            {formatMoney(Number(slab.sgstAmount), currency)}
                          </span>
                        </div>
                      </div>
                    );
                  })
                : bill.taxAmt > 0 && (
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
                      {formatMoney(Number(l.unitPrice) * qtyNum(l.quantity), currency)}
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
                {/* Per rate slab under GST; one line for a flat-rate invoice. */}
                {bill.isGst && bill.gst
                  ? bill.gst.byRate.flatMap((slab) => {
                      const rate = Number(slab.gstRate);
                      const igst = Number(slab.igstAmount);
                      const cell =
                        "px-4 py-1 text-sm font-bold text-[var(--muted)]";
                      const amt =
                        "px-4 py-1 text-right text-sm font-semibold text-[var(--muted)]";
                      return igst > 0
                        ? [
                            <tr key={`i${slab.gstRate}`} className="bg-[var(--panel)]">
                              <td className={cell} colSpan={3}>
                                IGST @ {rate}%
                              </td>
                              <td className={amt}>
                                {formatMoney(igst, currency)}
                              </td>
                            </tr>,
                          ]
                        : [
                            <tr key={`c${slab.gstRate}`} className="bg-[var(--panel)]">
                              <td className={cell} colSpan={3}>
                                CGST @ {rate / 2}%
                              </td>
                              <td className={amt}>
                                {formatMoney(Number(slab.cgstAmount), currency)}
                              </td>
                            </tr>,
                            <tr key={`s${slab.gstRate}`} className="bg-[var(--panel)]">
                              <td className={cell} colSpan={3}>
                                SGST @ {rate / 2}%
                              </td>
                              <td className={amt}>
                                {formatMoney(Number(slab.sgstAmount), currency)}
                              </td>
                            </tr>,
                          ];
                    })
                  : bill.taxAmt > 0 && (
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


          {/* ---------- Payments (P1-5) ---------- */}
          {inv && inv.status !== "DRAFT" && inv.status !== "CANCELLED" && (
            <div className={`${cardClass} space-y-4 p-5`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <SectionTitle>Payments</SectionTitle>
                {inv.paymentStatus && (
                  <span
                    className={`rounded-[5px] border-2 border-[var(--line)] px-3 py-1 text-xs font-black uppercase tracking-wide ${
                      inv.paymentStatus === "PAID"
                        ? "bg-emerald-500 text-white"
                        : inv.paymentStatus === "PARTIAL"
                          ? "bg-amber-500 text-white"
                          : inv.paymentStatus === "OVERPAID"
                            ? "bg-red-500 text-white"
                            : "bg-[var(--panel)] text-[var(--muted)]"
                    }`}
                  >
                    {inv.paymentStatus}
                  </span>
                )}
              </div>

              {/* The three figures, straight from the server's derivation. */}
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">
                    Invoice total
                  </div>
                  <div className="mt-1 text-lg font-black text-[var(--text)]">
                    {formatMoney(Number(inv.totalAmount ?? 0), currency)}
                  </div>
                </div>
                <div className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">
                    Paid
                  </div>
                  <div className="mt-1 text-lg font-black text-emerald-500">
                    {formatMoney(Number(inv.paidAmount ?? 0), currency)}
                  </div>
                </div>
                <div className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--panel)] p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">
                    Balance
                  </div>
                  <div
                    className={`mt-1 text-lg font-black ${
                      Number(inv.balanceAmount ?? 0) > 0
                        ? "text-[var(--accent)]"
                        : "text-[var(--muted)]"
                    }`}
                  >
                    {formatMoney(Number(inv.balanceAmount ?? 0), currency)}
                  </div>
                </div>
              </div>

              {payError && <ErrorAlert>{payError}</ErrorAlert>}

              {/* Only offer the form while something is actually outstanding —
                  the server refuses overpayment, but a form that always
                  appears invites an error instead of preventing one. */}
              {canEdit && Number(inv.balanceAmount ?? 0) > 0 && (
                <form
                  onSubmit={recordPayment}
                  className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
                >
                  <Field label="Amount">
                    <Input
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      placeholder={String(inv.balanceAmount ?? "")}
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                    />
                  </Field>
                  <Field label="Method">
                    <Select
                      value={payMethod}
                      onChange={(e) =>
                        setPayMethod(e.target.value as PaymentMethod)
                      }
                    >
                      {(
                        Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]
                      ).map((m) => (
                        <option key={m} value={m}>
                          {PAYMENT_METHOD_LABELS[m]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Reference" hint="optional">
                    <Input
                      value={payReference}
                      onChange={(e) => setPayReference(e.target.value)}
                      placeholder="UPI ref, cheque no."
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button type="submit" disabled={payBusy}>
                      {payBusy ? "Recording…" : "Record payment"}
                    </Button>
                  </div>
                </form>
              )}

              {inv.payments && inv.payments.length > 0 ? (
                <div className="overflow-x-auto rounded-[5px] border-2 border-[var(--line)]">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b-2 border-[var(--line)] bg-[var(--panel)]">
                        <th className={th}>Date</th>
                        <th className={th}>Method</th>
                        <th className={th}>Reference</th>
                        <th className={th}>Recorded by</th>
                        <th className={`${th} text-right`}>Amount</th>
                        {canEdit && <th className={`${th} text-right`} />}
                      </tr>
                    </thead>
                    <tbody>
                      {inv.payments.map((p: Payment) => (
                        <tr
                          key={p.id}
                          className="border-b border-[var(--line)] last:border-0"
                        >
                          <td className={`${td} font-semibold text-[var(--text)]`}>
                            {new Date(p.paymentDate).toLocaleDateString()}
                          </td>
                          <td className={`${td} font-semibold text-[var(--muted)]`}>
                            {PAYMENT_METHOD_LABELS[p.method]}
                          </td>
                          <td className={`${td} font-semibold text-[var(--muted)]`}>
                            {p.reference || "—"}
                          </td>
                          <td className={`${td} font-semibold text-[var(--muted)]`}>
                            {p.createdBy.name}
                          </td>
                          <td className={`${td} text-right font-black text-[var(--text)]`}>
                            {formatMoney(Number(p.amount), currency)}
                          </td>
                          {canEdit && (
                            <td className={`${td} text-right`}>
                              <button
                                type="button"
                                onClick={() => removePayment(p.id)}
                                disabled={deletingPaymentId === p.id}
                                title="Remove this payment (for a mistyped entry)"
                                className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--card)] px-2 py-1 text-xs font-bold text-[var(--text)] hover:bg-[var(--hover)] disabled:opacity-40"
                              >
                                {deletingPaymentId === p.id ? "…" : "Remove"}
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm font-bold text-[var(--muted)]">
                  Nothing received yet.
                </p>
              )}
            </div>
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
