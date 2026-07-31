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
    const rows = inv.lines
      .map(
        (l) => `<tr>
          <td>${l.product.name} <small>${l.product.sku}</small></td>
          <td style="text-align:right">${l.quantity}</td>
          <td style="text-align:right">${formatMoney(Number(l.unitPrice), currency)}</td>
          <td style="text-align:right">${formatMoney(Number(l.unitPrice) * l.quantity, currency)}</td>
        </tr>`
      )
      .join("");
    const html = `<!doctype html><html><head><title>${invNumber(inv.number)}</title>
      <style>
        body{font-family:Arial,sans-serif;color:#111;padding:32px;max-width:720px;margin:auto}
        h1{margin:0 0 4px} .muted{color:#666;font-size:13px}
        table{width:100%;border-collapse:collapse;margin-top:24px}
        th,td{padding:8px;border-bottom:1px solid #ddd;font-size:14px;text-align:left}
        th{text-transform:uppercase;font-size:11px;color:#666}
        tfoot td{font-weight:bold;border-top:2px solid #111;border-bottom:none}
        small{color:#888}
      </style></head><body>
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div><h1>${company?.name ?? "Invoice"}</h1><div class="muted">Invoice</div></div>
        <div style="text-align:right"><h1>${invNumber(inv.number)}</h1>
          <div class="muted">${new Date(inv.issuedAt ?? inv.createdAt).toLocaleDateString()}</div>
          <div class="muted">Status: ${inv.status}</div></div>
      </div>
      <div style="margin-top:20px"><strong>Bill to:</strong><br>${inv.customerName}
        ${inv.customerPhone ? `<br>${inv.customerPhone}` : ""}
        ${inv.customerAddress ? `<br>${inv.customerAddress}` : ""}</div>
      <table><thead><tr><th>Item</th><th style="text-align:right">Qty</th>
        <th style="text-align:right">Price</th><th style="text-align:right">Amount</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr><td colspan="3" style="text-align:right;border-top:2px solid #111">Subtotal</td>
            <td style="text-align:right;border-top:2px solid #111">${formatMoney(bill.subtotal, currency)}</td></tr>
          ${
            bill.discountAmt > 0
              ? `<tr><td colspan="3" style="text-align:right;border:none">Discount</td><td style="text-align:right;border:none">-${formatMoney(bill.discountAmt, currency)}</td></tr>`
              : ""
          }
          ${
            bill.taxAmt > 0
              ? `<tr><td colspan="3" style="text-align:right;border:none">Tax (${bill.taxRate}%)</td><td style="text-align:right;border:none">${formatMoney(bill.taxAmt, currency)}</td></tr>`
              : ""
          }
          <tr><td colspan="3" style="text-align:right;font-weight:bold;border:none">TOTAL</td>
            <td style="text-align:right;font-weight:bold;border:none">${formatMoney(bill.total, currency)}</td></tr>
        </tfoot>
      </table>
      ${inv.notes ? `<p class="muted" style="margin-top:20px">${inv.notes}</p>` : ""}
      </body></html>`;
    const w = window.open("", "_blank", "width=800,height=900");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
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
              <Button variant="secondary" onClick={() => action("pay", "Failed to mark paid")}>
                Mark paid
              </Button>
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

          <div className="space-y-2">
            <div className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">
              Items
            </div>
            {lines.map((l, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1">
                  <ProductPicker
                    products={products.filter(
                      (p) => p.isActive || p.id === l.productId
                    )}
                    value={l.productId}
                    onChange={(pid) => setLine(i, { productId: pid })}
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
                <button
                  type="button"
                  onClick={() => removeLine(i)}
                  disabled={lines.length === 1}
                  className="px-2 pb-2 text-lg font-black text-[var(--muted)] hover:text-red-500 disabled:opacity-30"
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
          message="This marks the draft cancelled. It stays on record but can't be issued."
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
