/**
 * Renders a scannable Code128 barcode for a value. jsbarcode loads from the
 * jsDelivr CDN on demand — no bundle dependency. (Production CSP allows
 * cdn.jsdelivr.net so this works live too.)
 */
import { useEffect, useRef, useState } from "react";

// One shared promise per script URL — resolves only when the library has
// ACTUALLY loaded (not merely when a <script> tag exists). Survives React
// StrictMode's double effect run and repeat mounts.
const scriptCache = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const cached = scriptCache.get(src);
  if (cached) return cached;
  const p = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(
      `script[src="${src}"]`
    ) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error("failed to load " + src))
      );
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error("failed to load " + src));
    document.body.appendChild(s);
  });
  scriptCache.set(src, p);
  return p;
}

export function BarcodeView({ value }: { value: string }) {
  const bcRef = useRef<SVGSVGElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await loadScript(
          "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"
        );
        const w = window as any;
        if (active && bcRef.current && w.JsBarcode) {
          w.JsBarcode(bcRef.current, value, {
            format: "CODE128",
            height: 60,
            fontSize: 14,
            margin: 6,
          });
        } else if (active) {
          setError(true);
        }
      } catch {
        if (active) setError(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [value]);

  if (error) {
    return (
      <span className="text-sm font-semibold text-[var(--muted)]">
        Couldn't render the barcode (check your connection).
      </span>
    );
  }

  return (
    <svg ref={bcRef} className="max-w-full rounded-[4px] bg-white p-2" />
  );
}
