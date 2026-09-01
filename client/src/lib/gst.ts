/**
 * GST helpers for the browser (P2-3 UI).
 *
 * Display and form support only — every figure that ends up on an invoice is
 * computed and stamped by the SERVER. Nothing here recalculates tax, and
 * nothing here should start to: an invoice's tax is a stored fact, and a
 * second implementation in the client is a second thing to disagree with it.
 *
 * The state list is duplicated from server/src/lib/gst.ts on purpose. It is
 * static reference data set by statute, changing perhaps once a decade, and an
 * endpoint to fetch 36 constants would be more moving parts than it saves.
 */

/** The 36 GST state codes — the first two digits of any GSTIN. */
export const GST_STATES: { code: string; name: string }[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
];

const NAME_BY_CODE = new Map(GST_STATES.map((s) => [s.code, s.name]));

export function stateName(code: string | null | undefined): string | null {
  return code ? (NAME_BY_CODE.get(code) ?? null) : null;
}

/** "27" → "27 — Maharashtra", for showing a place of supply. */
export function stateLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const name = NAME_BY_CODE.get(code);
  return name ? `${code} — ${name}` : code;
}

/** First two digits of a GSTIN are its state. */
export function stateCodeFromGstin(gstin: string): string | null {
  if (gstin.length < 2) return null;
  const code = gstin.slice(0, 2);
  return NAME_BY_CODE.has(code) ? code : null;
}

/**
 * Shape check only — 15 chars: 2 state + 10 PAN + entity + 'Z' + checksum.
 *
 * A structurally valid GSTIN can belong to nobody, so this must never be
 * presented as proof the number is registered. It exists to catch typing
 * mistakes before the server does.
 */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

export function isValidGstinShape(gstin: string): boolean {
  return GSTIN_PATTERN.test(gstin.toUpperCase());
}

/** The slabs in ordinary use. Free entry is still allowed for the unusual ones. */
export const COMMON_GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];
