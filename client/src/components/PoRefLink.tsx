/**
 * Renders a stock-movement reference. If it looks like a purchase-order
 * stamp (e.g. "PO-0001"), it becomes a link to that PO (via the number
 * filter on the Purchases list). Anything else (invoice numbers, free text)
 * renders as plain text.
 */
import { Link } from "react-router-dom";

export function PoRefLink({ reference }: { reference: string | null }) {
  if (!reference) return <>—</>;
  const match = /^PO-0*(\d+)$/.exec(reference.trim());
  if (!match) return <>{reference}</>;
  return (
    <Link
      to={`/purchase-orders?number=${match[1]}`}
      className="font-bold text-[var(--accent)] hover:underline"
    >
      {reference}
    </Link>
  );
}
