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
  name: string;
  description: string | null;
  categoryId: string | null;
  category: Category | null;
  preferredSupplierId: string | null;
  preferredSupplier: { id: string; name: string } | null;
  unit: string;
  costPrice: string;
  sellingPrice: string;
  lowStockThreshold: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
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
  quantity: number;
  receivedQty: number;
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
  quantity: number;
  unitCost: string | null;
  reference: string | null;
  note: string | null;
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
    lowStockThreshold: number;
  };
  location: { id: string; name: string };
  quantity: number;
  lowStock: boolean;
};
