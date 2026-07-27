/**
 * ProductPicker — a type-to-search replacement for a plain <select> of
 * products. Handles catalogs too big for a dropdown: click to open, type to
 * filter by name or SKU, click a row to choose. Controlled via value/onChange
 * (the product id). Styled to match the app's neubrutalist inputs.
 */
import { useEffect, useRef, useState } from "react";
import type { Product } from "../lib/types";

export function ProductPicker({
  products,
  value,
  onChange,
  placeholder = "Select product…",
}: {
  products: Product[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const selected = products.find((p) => p.id === value);

  const q = query.trim().toLowerCase();
  const filtered = (
    q
      ? products.filter((p) =>
          `${p.name} ${p.sku}`.toLowerCase().includes(q)
        )
      : products
  ).slice(0, 50);

  // Close when clicking outside.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] px-3 py-2 text-left text-sm font-bold text-[var(--text)]"
      >
        <span className={selected ? "" : "text-[var(--muted)]"}>
          {selected ? `${selected.name} (${selected.sku})` : placeholder}
        </span>
        <span className="ml-2 text-[var(--muted)]">▾</span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] shadow-[4px_4px_0px_var(--shadow)]">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type name or SKU…"
            className="w-full border-b-2 border-[var(--line)] bg-transparent px-3 py-2 text-sm font-semibold text-[var(--text)] focus:outline-none"
          />
          <ul className="max-h-56 overflow-auto">
            {filtered.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(p.id);
                    setOpen(false);
                    setQuery("");
                  }}
                  className={`flex w-full items-baseline justify-between px-3 py-2 text-left text-sm hover:bg-[var(--hover)] ${
                    p.id === value ? "bg-[var(--hover)]" : ""
                  }`}
                >
                  <span className="font-bold text-[var(--text)]">{p.name}</span>
                  <span className="ml-2 font-mono text-xs text-[var(--muted)]">
                    {p.sku}
                  </span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm font-semibold text-[var(--muted)]">
                No matches
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
