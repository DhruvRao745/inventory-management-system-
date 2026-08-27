/**
 * Scan station — the barcode workflow the senior asked for. A USB/Bluetooth
 * scanner acts like a keyboard: it "types" the barcode then Enter. So we keep
 * a single input focused; each scan looks up the product by barcode and writes
 * a stock movement — PURCHASE when receiving, SALE when selling. Camera
 * scanning is layered on in B3.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { Location, Product } from "../lib/types";
import {
  Input,
  Select,
  Field,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";

type Mode = "RECEIVE" | "SELL";
type FeedItem = {
  id: number;
  ok: boolean;
  text: string;
  qty?: number;
  mode: Mode;
};

let feedSeq = 0;

export function ScanPage() {
  const [mode, setMode] = useState<Mode>("RECEIVE");
  const [locations, setLocations] = useState<Location[]>([]);
  const [locationId, setLocationId] = useState("");
  const [qty, setQty] = useState("1");
  const [code, setCode] = useState("");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [tally, setTally] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Refs so the camera's decode callback always sees the CURRENT settings
  // (a callback captured when the camera started would otherwise go stale).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const locRef = useRef(locationId);
  locRef.current = locationId;
  const qtyRef = useRef(qty);
  qtyRef.current = qty;
  const scannerRef = useRef<any>(null);
  const lastScan = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const processing = useRef(false); // one scan at a time
  const coolUntil = useRef(0); // brief pause after each accepted scan
  const audioRef = useRef<AudioContext | null>(null);

  // Short tone + phone vibration so each accepted scan is unmistakable.
  function feedback(ok: boolean) {
    try {
      const AC =
        window.AudioContext || (window as unknown as any).webkitAudioContext;
      if (AC) {
        if (!audioRef.current) audioRef.current = new AC();
        const ctx = audioRef.current;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = ok ? 880 : 200;
        gain.gain.value = 0.12;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + (ok ? 0.12 : 0.28));
      }
    } catch {
      /* audio not available */
    }
    try {
      navigator.vibrate?.(ok ? 60 : [50, 40, 50]);
    } catch {
      /* vibration not available */
    }
  }

  useEffect(() => {
    api<Location[]>("/locations")
      .then((locs) => {
        setLocations(locs);
        setLocationId(locs.find((l) => l.isDefault)?.id ?? locs[0]?.id ?? "");
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : "Failed to load")
      );
  }, []);

  // Keep the scan box focused (unless the camera is running).
  useEffect(() => {
    if (!cameraOn) inputRef.current?.focus();
  }, [mode, locationId, cameraOn]);

  // Shared by the keyboard box and the camera: resolve a scanned code and
  // record the movement. Ignores an identical code repeated within 2.5s (the
  // camera fires many times a second on the same barcode).
  async function processScan(raw: string) {
    const scanned = raw.trim();
    const loc = locRef.current;
    if (!scanned || !loc) return;

    const now = Date.now();
    // One at a time, and a brief cooldown after each accepted scan so the
    // camera doesn't fire off several items in a burst.
    if (processing.current || now < coolUntil.current) return;
    if (scanned === lastScan.current.code && now - lastScan.current.at < 2500) {
      return;
    }
    processing.current = true;
    lastScan.current = { code: scanned, at: now };

    const m = modeRef.current;
    const n = Math.max(1, Number(qtyRef.current) || 1);
    setBusy(true);
    try {
      const product = await api<Product>(
        `/products/lookup?barcode=${encodeURIComponent(scanned)}`
      );
      await api("/stock/movements", {
        method: "POST",
        body: {
          productId: product.id,
          locationId: loc,
          type: m === "RECEIVE" ? "PURCHASE" : "SALE",
          quantity: n, // positive — the server applies the sign
          note: m === "RECEIVE" ? "Scanned in" : "Scanned out",
        },
      });
      feedback(true);
      coolUntil.current = Date.now() + 1200; // pause ~1.2s after a good scan
      setFeed((f) => [
        { id: ++feedSeq, ok: true, mode: m, qty: n, text: `${product.name}` },
        ...f,
      ]);
      setTally((t) => ({
        ...t,
        [product.name]: (t[product.name] ?? 0) + (m === "RECEIVE" ? n : -n),
      }));
    } catch (err) {
      feedback(false);
      coolUntil.current = Date.now() + 800;
      setFeed((f) => [
        {
          id: ++feedSeq,
          ok: false,
          mode: m,
          text:
            err instanceof ApiError
              ? `${scanned} — ${err.message}`
              : `${scanned} — failed`,
        },
        ...f,
      ]);
    } finally {
      processing.current = false;
      setBusy(false);
      if (!cameraOn) inputRef.current?.focus();
    }
  }

  function handleScan(e: FormEvent) {
    e.preventDefault();
    const scanned = code;
    setCode(""); // clear for the next scan
    void processScan(scanned);
  }

  // Load the camera-scanning library from a CDN on demand (keeps it out of
  // the bundle; nothing to install).
  function loadScannerLib(): Promise<any> {
    const w = window as any;
    if (w.Html5Qrcode) return Promise.resolve(w.Html5Qrcode);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js";
      s.onload = () => resolve((window as any).Html5Qrcode);
      s.onerror = () => reject(new Error("Couldn't load the camera scanner"));
      document.body.appendChild(s);
    });
  }

  // These just flip the flag — the real camera lifecycle runs in the effect
  // below, AFTER the #qr-reader box is rendered visible. Starting the camera
  // from the click handler (while the box was still display:none) is why the
  // preview didn't show.
  function startCamera() {
    setError(null);
    setCameraOn(true);
  }
  function stopCamera() {
    setCameraOn(false);
  }

  useEffect(() => {
    if (!cameraOn) return;
    let active = true;
    (async () => {
      try {
        const Html5Qrcode = await loadScannerLib();
        if (!active) return;
        const fmts = (window as any).Html5QrcodeSupportedFormats;
        const formatsToSupport = fmts
          ? [
              fmts.QR_CODE,
              fmts.CODE_128,
              fmts.CODE_39,
              fmts.EAN_13,
              fmts.EAN_8,
              fmts.UPC_A,
              fmts.UPC_E,
              fmts.ITF,
            ]
          : undefined;
        const scanner = new Html5Qrcode("qr-reader", {
          formatsToSupport,
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          verbose: false,
        } as any);
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: 12,
            qrbox: (vw: number, vh: number) => ({
              width: Math.min(320, Math.floor(vw * 0.9)),
              height: Math.min(240, Math.floor(vh * 0.6)),
            }),
          },
          (decoded: string) => void processScan(decoded),
          () => {} // ignore per-frame "no code" callbacks
        );
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Camera couldn't start"
          );
          setCameraOn(false);
        }
      }
    })();
    return () => {
      active = false;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (s) {
        s.stop()
          .then(() => s.clear())
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn]);

  const receiving = mode === "RECEIVE";

  return (
    <div className="max-w-3xl space-y-5">
      <SectionTitle>Scan station</SectionTitle>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {/* Mode toggle */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setMode("RECEIVE")}
          className={`flex-1 rounded-[5px] border-2 border-[var(--line)] px-4 py-3 text-sm font-black shadow-[3px_3px_0px_var(--shadow)] ${
            receiving
              ? "bg-emerald-500 text-white"
              : "bg-[var(--card)] text-[var(--muted)]"
          }`}
        >
          ▼ Receiving (add stock)
        </button>
        <button
          type="button"
          onClick={() => setMode("SELL")}
          className={`flex-1 rounded-[5px] border-2 border-[var(--line)] px-4 py-3 text-sm font-black shadow-[3px_3px_0px_var(--shadow)] ${
            !receiving
              ? "bg-red-500 text-white"
              : "bg-[var(--card)] text-[var(--muted)]"
          }`}
        >
          ▲ Selling (remove stock)
        </button>
      </div>

      {/* Controls + scan box */}
      <form onSubmit={handleScan} className={`${cardClass} space-y-4 p-5`}>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Location">
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
          <Field label="Qty per scan">
            <Input
              type="number"
              min="1"
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Scan barcode">
          <Input
            ref={inputRef}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Point the scanner here and scan…"
            disabled={busy || !locationId}
          />
        </Field>
        <p className="text-xs font-semibold text-[var(--muted)]">
          {receiving
            ? "Each scan adds stock at this location."
            : "Each scan removes stock — a scan of an out-of-stock item is refused."}
        </p>

        {/* Camera scanning */}
        <div className="border-t-2 border-[var(--line)]/20 pt-4">
          {!cameraOn ? (
            <button
              type="button"
              onClick={startCamera}
              disabled={!locationId}
              className="rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] px-4 py-2 text-sm font-bold text-[var(--text)] shadow-[3px_3px_0px_var(--shadow)] hover:bg-[var(--hover)] disabled:opacity-50"
            >
              📷 Scan with camera
            </button>
          ) : (
            <button
              type="button"
              onClick={stopCamera}
              className="rounded-[5px] border-2 border-[var(--line)] bg-red-500 px-4 py-2 text-sm font-black text-white shadow-[3px_3px_0px_var(--shadow)]"
            >
              ■ Stop camera
            </button>
          )}
          <div
            id="qr-reader"
            className={`mt-3 overflow-hidden rounded-[6px] border-2 border-[var(--line)] ${
              cameraOn ? "" : "hidden"
            }`}
            style={cameraOn ? { minHeight: 260 } : undefined}
          />
          {cameraOn && (
            <p className="mt-2 text-xs font-semibold text-[var(--muted)]">
              Point the camera at a barcode. Same code is ignored for 2.5s so it
              won't double-count.
            </p>
          )}
        </div>
      </form>

      {/* Session feed */}
      {feed.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <SectionTitle>This session</SectionTitle>
            <button
              type="button"
              onClick={() => {
                setFeed([]);
                setTally({});
              }}
              className="text-xs font-bold text-[var(--muted)] hover:text-[var(--accent)]"
            >
              clear
            </button>
          </div>

          {Object.keys(tally).length > 0 && (
            <div className={`${cardClass} flex flex-wrap gap-2 p-3`}>
              {Object.entries(tally).map(([name, q]) => (
                <span
                  key={name}
                  className="rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-xs font-black text-[var(--text)]"
                >
                  {name}: {q > 0 ? `+${q}` : q}
                </span>
              ))}
            </div>
          )}

          <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
            {feed.map((f) => (
              <div
                key={f.id}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <span
                  className={`font-bold ${
                    f.ok ? "text-[var(--text)]" : "text-red-500"
                  }`}
                >
                  {f.ok ? "✓" : "✕"} {f.text}
                </span>
                {f.ok && f.qty !== undefined && (
                  <span
                    className={`rounded-[4px] border-2 border-[var(--line)] px-2 py-0.5 text-xs font-black text-white ${
                      f.mode === "RECEIVE" ? "bg-emerald-500" : "bg-red-500"
                    }`}
                  >
                    {f.mode === "RECEIVE" ? `+${f.qty}` : `-${f.qty}`}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
