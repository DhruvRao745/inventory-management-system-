/**
 * The GST toggle (BUG-4).
 *
 * Reported: with GST on, CGST/SGST are configured and saved. Turn GST off,
 * and tax is still charged — as a percentage.
 *
 * Two things kept it alive after the toggle went off:
 *   1. `taxRate`, the FLAT mechanism, survived the switch. The total then took
 *      the FLAT branch and applied a percentage the user could no longer see.
 *   2. The stamped per-line GST columns stayed on the lines, so the saved GST
 *      configuration was still sitting in the database.
 *
 * The rule these tests hold to: the two tax mechanisms are mutually exclusive,
 * and OFF means off — tax is zero unless the caller explicitly asks for a
 * non-GST rate in the same request.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../lib/prisma.js";
import * as invService from "./inv.service.js";
import * as stockService from "../stock/stock.service.js";
import { invoiceTotalDecimal } from "../../lib/money.js";
import { resetDb, createTestCompany } from "../../test/helpers.js";

/** A GST-ready company: state code set, product rated at 18%. */
async function gstSetup() {
  const base = await createTestCompany();

  await prisma.company.update({
    where: { id: base.company.id },
    data: { stateCode: "08", gstin: "08AAAAA0000A1Z5" },
  });
  await prisma.product.update({
    where: { id: base.product.id },
    data: { gstRate: 18, hsnCode: "1234" },
  });

  await stockService.createMovement(base.company.id, base.user.id, {
    productId: base.product.id,
    locationId: base.location.id,
    type: "PURCHASE",
    quantity: 100,
    unitCost: 20,
  } as Parameters<typeof stockService.createMovement>[2]);

  /** One line: 10 × ₹100 = ₹1,000 before tax. */
  const draft = (opts: { useGst: boolean; taxRate?: number }) =>
    invService.createInvoice(base.company.id, base.user.id, {
      customerName: "Ravi Kumar",
      locationId: base.location.id,
      useGst: opts.useGst,
      taxRate: opts.taxRate,
      placeOfSupply: opts.useGst ? "08" : undefined,
      lines: [{ productId: base.product.id, quantity: 10, unitPrice: 100 }],
    } as Parameters<typeof invService.createInvoice>[2]);

  const read = (id: string) => invService.getInvoice(base.company.id, id);

  const lines = (id: string) =>
    prisma.invoiceLine.findMany({ where: { invoiceId: id } });

  return { ...base, draft, read, lines };
}

describe("GST toggle — off must mean off", () => {
  beforeEach(resetDb);

  it("GST enabled: CGST and SGST are stamped and included in the total", async () => {
    const { draft, read } = await gstSetup();
    const inv = await read((await draft({ useGst: true })).id);

    expect(inv.taxMode).toBe("GST");
    expect(inv.supplyType).toBe("INTRA_STATE"); // same state → CGST + SGST
    expect(Number(inv.lines[0]!.cgstAmount)).toBe(90); // 9% of 1000
    expect(Number(inv.lines[0]!.sgstAmount)).toBe(90);
    expect(Number(inv.lines[0]!.igstAmount ?? 0)).toBe(0);
    expect(Number(inv.totalAmount)).toBe(1180);
  });

  it("a GST invoice never stores a flat taxRate", async () => {
    // Both mechanisms present at once is the state the bug needed. Even
    // though the GST total ignores taxRate, storing it leaves the invoice one
    // toggle away from charging it.
    const { draft } = await gstSetup();
    const inv = await draft({ useGst: true, taxRate: 18 });
    expect(inv.taxRate).toBeNull();
  });

  it("GST disabled from the start: no tax, no stamps", async () => {
    const { draft, read } = await gstSetup();
    const inv = await read((await draft({ useGst: false })).id);

    expect(inv.taxMode).toBe("FLAT");
    expect(Number(inv.totalAmount)).toBe(1000);
    expect(inv.gst).toBeNull();
    expect(inv.lines[0]!.cgstAmount).toBeNull();
  });

  it("THE BUG: disabling GST after saving it makes tax zero", async () => {
    const { company, user, draft, read, lines } = await gstSetup();
    const created = await draft({ useGst: true });

    // Configured and saved: ₹1,180 with ₹90 CGST + ₹90 SGST.
    expect(Number((await read(created.id)).totalAmount)).toBe(1180);

    // Now untick GST. Nothing else changes.
    await invService.updateInvoice(company.id, created.id, {
      useGst: false,
    } as Parameters<typeof invService.updateInvoice>[2]);

    const after = await read(created.id);
    expect(after.taxMode).toBe("FLAT");
    expect(Number(after.totalAmount)).toBe(1000); // was 1180 — no tax at all
    expect(after.taxRate).toBeNull();
    expect(after.gst).toBeNull();

    // ...and the saved GST configuration is GONE from the database, not just
    // ignored by the total. A stamp left behind is a stamp the next reader
    // cannot tell from a live one.
    const raw = await lines(created.id);
    expect(raw[0]!.cgstAmount).toBeNull();
    expect(raw[0]!.sgstAmount).toBeNull();
    expect(raw[0]!.gstRate).toBeNull();
    expect(raw[0]!.taxableValue).toBeNull();
    expect(after.placeOfSupply).toBeNull();
    expect(after.supplyType).toBeNull();
  });

  it("disabling GST while explicitly setting a non-GST rate keeps that rate", async () => {
    // The one exception in the spec: a genuinely separate non-GST tax. It
    // survives because the caller ASKED for it in the same request, not
    // because it was left lying around.
    const { company, user, draft, read } = await gstSetup();
    const created = await draft({ useGst: true });

    await invService.updateInvoice(company.id, created.id, {
      useGst: false,
      taxRate: 5,
    } as Parameters<typeof invService.updateInvoice>[2]);

    const after = await read(created.id);
    expect(Number(after.taxRate)).toBe(5);
    expect(Number(after.totalAmount)).toBe(1050);
    expect(after.lines[0]!.cgstAmount).toBeNull(); // still no GST stamps
  });

  it("a flat rate does not survive re-enabling GST", async () => {
    // The mirror image, and the same class of bug: a leftover percentage
    // waiting for someone to switch the toggle back.
    const { company, user, draft, read } = await gstSetup();
    const created = await draft({ useGst: false, taxRate: 5 });
    expect(Number((await read(created.id)).totalAmount)).toBe(1050);

    await invService.updateInvoice(company.id, created.id, {
      useGst: true,
      placeOfSupply: "08",
    } as Parameters<typeof invService.updateInvoice>[2]);

    const after = await read(created.id);
    expect(after.taxRate).toBeNull();
    expect(Number(after.totalAmount)).toBe(1180); // GST only, no 5% on top
  });

  it("off → on → off returns to zero tax every time", async () => {
    const { company, user, draft, read } = await gstSetup();
    const created = await draft({ useGst: false });
    const toggle = (useGst: boolean) =>
      invService.updateInvoice(company.id, created.id, {
        useGst,
        ...(useGst ? { placeOfSupply: "08" } : {}),
      } as Parameters<typeof invService.updateInvoice>[2]);

    expect(Number((await read(created.id)).totalAmount)).toBe(1000);
    await toggle(true);
    expect(Number((await read(created.id)).totalAmount)).toBe(1180);
    await toggle(false);
    expect(Number((await read(created.id)).totalAmount)).toBe(1000);
    await toggle(true);
    expect(Number((await read(created.id)).totalAmount)).toBe(1180);
  });

  it("the invoice total, the stored stamps and the report agree", async () => {
    // One rule, three readers. invoiceTotalDecimal is what reports use, so
    // computing it straight from the row must match what the API returns.
    const { company, draft, read } = await gstSetup();
    const created = await draft({ useGst: true });

    const row = await prisma.invoice.findFirstOrThrow({
      where: { id: created.id, companyId: company.id },
      include: { lines: true },
    });
    const api = await read(created.id);

    expect(Number(invoiceTotalDecimal(row))).toBe(Number(api.totalAmount));
    expect(Number(invoiceTotalDecimal(row))).toBe(1180);
  });
});
