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
