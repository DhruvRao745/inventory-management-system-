/**
 * Shared shapes of data coming from our API.
 * One place to define them; every page imports from here.
 *
 * Note: costPrice/sellingPrice arrive as STRINGS (e.g. "5") because
 * the database stores exact decimals and JSON numbers can't be trusted
 * with money. Convert with Number() only for display/inputs.
 */

export type Category = { id: string; name: string };

export type Product = {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  hsnCode: string | null;
  categoryId: string | null;
  category: Category | null;
  preferredSupplierId: string | null;
  preferredSupplier: { id: string; name: string } | null;
  unit: string;
  /** Decimal places this product's quantities may use (P1-2). 0 = whole units. */
  precision: number;
  /** Optional purchase pack, e.g. "box" with unitsPerPack "12". */
  packUnit: string | null;
  unitsPerPack: string | null;
  /** Reference cost someone typed in — NOT accounting-grade. Use avgCost. */
  costPrice: string;
  sellingPrice: string;
  /** Weighted-average unit cost (P1-3) — what the stock actually cost us. */
  avgCost: string;
  /** Total value of stock on hand, company-wide (P1-3). */
  stockValue: string;
  /** STRING since P1-2 — Decimal in the DB, like the prices above. */
  lowStockThreshold: string;
  tracksBatch: boolean;
  batchStrategy: BatchStrategy;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Which lot leaves first when batch-tracked stock is sold (P1-1). */
export type BatchStrategy = "FEFO" | "FIFO";

/**
 * One physical lot of a product at a location.
 * Quantities arrive as STRINGS — they're Decimal in the database, and JSON
 * numbers can't be trusted with them any more than they can with money.
 */
export type InventoryBatch = {
  id: string;
  batchNumber: string;
  manufactureDate: string | null;
  expiryDate: string | null;
  unitCost: string;
  receivedQuantity: string;
  remainingQuantity: string;
  createdAt: string;
  updatedAt: string;
  product: { id: string; sku: string; name: string; unit: string };
  location: { id: string; name: string };
};

export type Location = {
  id: string;
  name: string;
  address: string | null;
  isDefault: boolean;
};

export type Supplier = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Customer = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type POStatus =
  | "DRAFT"
  | "ORDERED"
  | "PARTIAL"
  | "RECEIVED"
  | "CANCELLED";

// Row shape from the list endpoint (flattened summary).
export type PurchaseOrderRow = {
  id: string;
  number: number;
  status: POStatus;
  supplier: { id: string; name: string };
  notes: string | null;
  expectedDate: string | null;
  createdAt: string;
  itemCount: number;
  totalCost: number;
};

// unitCost arrives as a STRING (Decimal) — Number() only for display/math.
export type PurchaseOrderLine = {
  id: string;
  productId: string;
  /** STRINGS since P1-2 — Decimal(18,4). */
  quantity: string;
  receivedQty: string;
  unitCost: string;
  product: { id: string; sku: string; name: string; unit: string };
};

export type PurchaseOrder = {
  id: string;
  number: number;
  status: POStatus;
  notes: string | null;
  expectedDate: string | null;
  createdAt: string;
  updatedAt: string;
  supplier: { id: string; name: string };
  createdBy: { id: string; name: string };
  lines: PurchaseOrderLine[];
};

// Display helper: 7 → "PO-0007"
export function poNumber(n: number): string {
  return `PO-${String(n).padStart(4, "0")}`;
}

export type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "CANCELLED";

export type InvoiceRow = {
  id: string;
  number: number;
  status: InvoiceStatus;
  customerName: string;
  location: string;
  issuedAt: string | null;
  createdAt: string;
  itemCount: number;
  total: number;
};

export type InvoiceLine = {
  id: string;
  productId: string;
  /** STRING since P1-2 — Decimal(18,4). Convert with Number() only to display. */
  quantity: string;
  unitPrice: string;
  product: {
    id: string;
    sku: string;
    name: string;
    unit: string;
    hsnCode: string | null;
  };
};

export type Invoice = {
  id: string;
  number: number;
  status: InvoiceStatus;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  customerAddress: string | null;
  customerGstin: string | null;
  notes: string | null;
  taxRate: string | null;
  discount: string | null;
  issuedAt: string | null;
  createdAt: string;
  updatedAt: string;
  location: { id: string; name: string };
  createdBy: { id: string; name: string };
  lines: InvoiceLine[];
  /** Present on GET /invoices/:id (P1-5). */
  payments?: Payment[];
  totalAmount?: string;
  paidAmount?: string;
  balanceAmount?: string;
  paymentStatus?: PaymentStatus;
};

export function invNumber(n: number): string {
  return `INV-${String(n).padStart(4, "0")}`;
}

export type MovementType =
  | "PURCHASE"
  | "SALE"
  | "RETURN_IN"
  | "RETURN_OUT"
  | "ADJUSTMENT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

export type StockMovement = {
  id: string;
  type: MovementType;
  /** STRING since P1-2 — signed Decimal(18,4). */
  quantity: string;
  /** What we PAID, on incoming stock. */
  unitCost: string | null;
  /**
   * The weighted-average cost applied to this movement (P1-3), stamped when
   * it happened and never changed. COGS is built from these.
   */
  costAtTime: string | null;
  /**
   * Which condition bucket this movement landed in (P2-2).
   *
   * Matters most on the two ADJUSTMENT rows a reclassification writes: without
   * it the history shows a bare −5 and +5 on the same product at the same
   * second, which reads like a mistake rather than "5 units released from
   * quarantine".
   */
  status: StockStatus;
  reference: string | null;
  note: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  transferId: string | null;
  createdAt: string;
  product: { id: string; sku: string; name: string };
  location: { id: string; name: string };
  createdBy: { id: string; name: string };
};

export type StockLevel = {
  product: {
    id: string;
    sku: string;
    name: string;
    unit: string;
    lowStockThreshold: string;
  };
  location: { id: string; name: string };
  /**
   * ON HAND — everything owned at this location, in any condition.
   * STRING since P1-2 (Decimal(18,4)).
   *
   * Note the name did NOT change when statuses arrived in P2-2, on purpose:
   * every existing caller reads `quantity`, and quietly redefining it to mean
   * "sellable" would have changed the meaning of a field under their feet.
   */
  quantity: string;

  // --- the P2 breakdown -------------------------------------------------
  /** Good stock — the only condition that may be sold. */
  sellable: string;
  damaged: string;
  quarantine: string;
  expired: string;
  /** Spoken for by a draft invoice; present but promised (P2-1). */
  reserved: string;
  /** sellable − reserved: what a NEW order can actually take. */
  available: string;

  /** Judged on `available`, not on hand — see the note in stock.service.ts. */
  lowStock: boolean;
};

/** The four conditions stock can be in (P2-2). */
export type StockStatus = "AVAILABLE" | "DAMAGED" | "QUARANTINE" | "EXPIRED";

export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  AVAILABLE: "Available",
  DAMAGED: "Damaged",
  QUARANTINE: "Quarantine",
  EXPIRED: "Expired",
};

/** One product's condition breakdown, from /reports/stock-by-status. */
export type StockStatusRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  available: number;
  damaged: number;
  quarantine: number;
  expired: number;
  onHand: number;
  /** Value of everything that CANNOT be sold — the point of the report. */
  blockedValue: number;
};

/** Revenue / COGS / gross profit for a period (P1-3, PRD §7). */
export type ProfitabilityRow = {
  productId: string;
  sku: string;
  name: string;
  unitsSold: number;
  revenue: number;
  cogs: number;
  grossProfit: number;
  margin: number;
};

export type ProfitabilityReport = {
  rows: ProfitabilityRow[];
  totals: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    margin: number;
  };
};

/** How money arrived (P1-5). */
export type PaymentMethod = "CASH" | "UPI" | "CARD" | "BANK_TRANSFER" | "OTHER";

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Cash",
  UPI: "UPI",
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  OTHER: "Other",
};

/** Money actually received against an invoice (P1-5). */
export type Payment = {
  id: string;
  invoiceId: string;
  /** STRING — Decimal(12,2), like every other money field. */
  amount: string;
  method: PaymentMethod;
  paymentDate: string;
  reference: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: { id: string; name: string };
};

/**
 * Derived from the payment rows, never from a status flag (PRD §8).
 * OVERPAID can only appear in historical data — the API refuses it going in.
 */
export type PaymentStatus = "UNPAID" | "PARTIAL" | "PAID" | "OVERPAID";

/** The four figures every invoice now carries. Strings — they are Decimals. */
export type InvoicePaymentSummary = {
  totalAmount: string;
  paidAmount: string;
  balanceAmount: string;
  paymentStatus: PaymentStatus;
};

export type OutstandingRow = {
  invoiceId: string;
  number: number;
  customerName: string;
  issuedAt: string | null;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: PaymentStatus;
};

// ---------- Sales returns (P1-6) ----------

export type SalesReturnStatus =
  | "REQUESTED"
  | "APPROVED"
  | "RECEIVED"
  | "REFUNDED"
  | "CANCELLED";

/** What condition goods came back in — decides whether they can be resold. */
export type ReturnCondition = "SELLABLE" | "DAMAGED" | "QUARANTINE";

export const RETURN_CONDITION_LABELS: Record<ReturnCondition, string> = {
  SELLABLE: "Sellable",
  DAMAGED: "Damaged",
  QUARANTINE: "Quarantine",
};

export type SalesReturnLine = {
  id: string;
  invoiceLineId: string;
  productId: string;
  /** STRING — Decimal(18,4). */
  quantity: string;
  condition: ReturnCondition;
  /** Only ever true for SELLABLE goods (PRD §9). */
  restock: boolean;
  notes: string | null;
  product: { id: string; sku: string; name: string; unit: string };
};

export type SalesReturn = {
  id: string;
  number: number;
  status: SalesReturnStatus;
  reason: string | null;
  refundAmount: string | null;
  notes: string | null;
  approvedAt: string | null;
  receivedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  invoice: { id: string; number: number; customerName: string };
  requestedBy: { id: string; name: string };
  approvedBy: { id: string; name: string } | null;
  receivedBy: { id: string; name: string } | null;
  lines: SalesReturnLine[];
};

/** What's still returnable on an invoice — powers the return form. */
export type ReturnableLine = {
  invoiceLineId: string;
  product: { id: string; sku: string; name: string; unit: string };
  sold: number;
  returned: number;
  returnable: number;
  unitPrice: number;
};

/** Display helper: 7 → "RET-0007" */
export function retNumber(n: number): string {
  return `RET-${String(n).padStart(4, "0")}`;
}

// ---------- Goods receipts + supplier returns (P1-7) ----------

/** One product on a delivery. */
export type GoodsReceiptLine = {
  id: string;
  purchaseOrderLineId: string;
  productId: string;
  /** Goods we took in — the ONLY quantity that entered stock. */
  acceptedQty: string;
  /** Arrived but refused. Recorded to chase the supplier; never inventory. */
  rejectedQty: string;
  /** What we were actually charged — this is what moved the average. */
  actualUnitCost: string;
  rejectReason: string | null;
  batchNumber: string | null;
  manufactureDate: string | null;
  expiryDate: string | null;
  product: { id: string; sku: string; name: string; unit: string };
};

export type GoodsReceipt = {
  id: string;
  number: number;
  notes: string | null;
  createdAt: string;
  purchaseOrder: {
    id: string;
    number: number;
    supplier: { id: string; name: string };
  };
  location: { id: string; name: string };
  receivedBy: { id: string; name: string };
  lines: GoodsReceiptLine[];
};

export type SupplierReturnStatus = "DRAFT" | "SENT" | "COMPLETED" | "CANCELLED";

export type SupplierReturnLine = {
  id: string;
  productId: string;
  quantity: string;
  unitCost: string;
  goodsReceiptLineId: string | null;
  notes: string | null;
  product: { id: string; sku: string; name: string; unit: string };
  goodsReceiptLine: {
    id: string;
    acceptedQty: string;
    batchNumber: string | null;
    goodsReceipt: { id: string; number: number };
  } | null;
};

export type SupplierReturn = {
  id: string;
  number: number;
  status: SupplierReturnStatus;
  goodsReceiptId: string | null;
  reason: string | null;
  notes: string | null;
  sentAt: string | null;
  completedAt: string | null;
  createdAt: string;
  supplier: { id: string; name: string };
  location: { id: string; name: string };
  createdBy: { id: string; name: string };
  lines: SupplierReturnLine[];
};

/** Display helpers: 7 → "GRN-0007" / "SRT-0007" */
export function grnNumber(n: number): string {
  return `GRN-${String(n).padStart(4, "0")}`;
}
export function srtNumber(n: number): string {
  return `SRT-${String(n).padStart(4, "0")}`;
}

// ---------- Location-aware reordering (P1-8) ----------

/**
 * A reorder rule for ONE product at ONE location.
 * Every field is optional — each absent one falls back to the product default.
 */
export type ProductLocationSetting = {
  id: string;
  productId: string;
  locationId: string;
  minQuantity: string | null;
  maxQuantity: string | null;
  reorderQuantity: string | null;
  preferredSupplierId: string | null;
  product: { id: string; sku: string; name: string; unit: string };
  location: { id: string; name: string };
  preferredSupplier: { id: string; name: string } | null;
};

/** One SHORT SHELF — a product at a location that's below its minimum. */
export type ReorderRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  locationId: string;
  locationName: string;
  onHand: number;
  minQuantity: number;
  maxQuantity: number | null;
  suggestedQty: number;
  locationSpecific: boolean;
  costPrice: string;
  preferredSupplier: { id: string; name: string } | null;
};

// ---------- Stock counting (P1-9) ----------

export type StockCountStatus =
  | "OPEN"
  | "COUNTING"
  | "REVIEW"
  | "COMPLETED"
  | "CANCELLED";

export type StockCountItem = {
  id: string;
  productId: string;
  batchId: string | null;
  /** What the system believed when the sheet was prepared. */
  expectedQuantity: string;
  /** What was physically found. NULL = nobody has looked yet (≠ counted zero). */
  countedQuantity: string | null;
  /** Derived, not stored: counted − expected. Null until counted. */
  variance: string | null;
  notes: string | null;
  product: {
    id: string;
    sku: string;
    name: string;
    unit: string;
    precision: number;
  };
  batch: { id: string; batchNumber: string; expiryDate: string | null } | null;
};

/**
 * A physical stocktake.
 *
 * Completing one does NOT overwrite stock — it writes ADJUSTMENT movements for
 * the variance (PRD §12), so the correction is an event with a person attached
 * and the ledger stays the source of truth.
 */
export type StockCount = {
  id: string;
  number: number;
  status: StockCountStatus;
  notes: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  location: { id: string; name: string };
  startedBy: { id: string; name: string };
  completedBy: { id: string; name: string } | null;
  items: StockCountItem[];
};

/** Display helper: 7 → "CNT-0007" */
export function cntNumber(n: number): string {
  return `CNT-${String(n).padStart(4, "0")}`;
}
