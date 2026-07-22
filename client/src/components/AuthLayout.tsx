/**
 * AuthLayout — the shared stage for Login and Register.
 *
 * Adapted (not copied) from the Kezak reference: split screen with a
 * Sign In / Sign Up toggle on the left and a product showcase on the
 * right. Instead of pasted screenshots, the showcase is built from
 * miniature LIVE-styled cards — they follow the theme and can never
 * go out of date. Notched input labels adapted from the Tasky ref.
 */
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Logo } from "./ui";
import { ThemeSwitch } from "./ThemeSwitch";

/* Tasky-style notched label: sits on the input's top border */
export function NotchField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="relative pt-2">
      <label className="absolute left-3 top-0 z-10 rounded-sm bg-[var(--card)] px-1.5 text-xs font-bold text-[var(--muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}

/* ---------- The floating product miniatures ---------- */
const mini =
  "absolute rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] shadow-[5px_5px_0px_var(--shadow)] p-4";

function Showcase() {
  return (
    <div className="relative mx-auto h-[340px] w-full max-w-md">
      {/* stat card — emerald crown + emerald shadow */}
      <div
        className={`${mini} left-0 top-4 w-56 -rotate-3 overflow-hidden`}
        style={{ boxShadow: "5px 5px 0px #10b981" }}
      >
        <div className="-mx-4 -mt-4 mb-3 h-1.5 bg-[#10b981]" />
        <div className="text-[10px] font-black uppercase tracking-wide text-[var(--muted)]">
          Stock value (cost)
        </div>
        <div className="mt-1 text-2xl font-black text-[var(--text)]">
          ₹19,594
        </div>
        <div className="mt-1 text-[10px] font-bold text-emerald-500">
          537 units across 2 locations
        </div>
      </div>

      {/* low stock alert — red crown + red shadow */}
      <div
        className={`${mini} right-0 top-24 w-60 rotate-2 overflow-hidden`}
        style={{ boxShadow: "5px 5px 0px #ef4444" }}
      >
        <div className="-mx-4 -mt-4 mb-3 h-1.5 bg-[#ef4444]" />
        <div className="flex items-center justify-between">
          <div className="text-[10px] font-black uppercase tracking-wide text-[var(--muted)]">
            Low stock alerts
          </div>
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-[var(--line)] bg-red-500 px-1 text-[9px] font-black text-white">
            2
          </span>
        </div>
        <div className="mt-2 text-xs font-bold text-[var(--text)]">
          Gel Pen Black
          <span className="ml-1 font-semibold text-[var(--muted)]">
            · Main Shop
          </span>
        </div>
        <div className="mt-1 text-[10px] font-semibold text-[var(--muted)]">
          28 left · alert at 30
        </div>
      </div>

      {/* movement tile — amber crown + amber shadow */}
      <div
        className={`${mini} bottom-6 left-8 w-64 rotate-[-1deg] overflow-hidden`}
        style={{ boxShadow: "5px 5px 0px #f59e0b" }}
      >
        <div className="-mx-4 -mt-4 mb-3 h-1.5 bg-[#f59e0b]" />
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-bold text-[var(--text)]">
              A4 Paper Ream 500
            </div>
            <div className="text-[10px] font-semibold text-[var(--muted)]">
              <span className="font-black text-emerald-500">PURCHASE</span> ·
              Godown · just now
            </div>
          </div>
          <span className="rounded-[4px] border-2 border-[var(--line)] bg-emerald-500 px-2 py-0.5 text-xs font-black text-white">
            +100
          </span>
        </div>
      </div>
    </div>
  );
}

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  const { pathname } = useLocation();

  const tab = (to: string, label: string) => {
    const active = pathname === to;
    return (
      <Link
        to={to}
        className={`flex-1 rounded-[4px] py-2 text-center text-sm font-bold transition-colors ${
          active
            ? "bg-[var(--btn)] text-[var(--btn-text)]"
            : "bg-[var(--card)] text-[var(--text)] hover:bg-[var(--hover)]"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="auth-gradient relative flex min-h-screen">
      {/* theme switch — top-right, above everything.
          Positioned via a WRAPPER: the switch itself is position:relative
          inside (for its sliding thumb), so styling the wrapper avoids
          the two position utilities fighting. */}
      <div className="absolute right-4 top-4 z-20">
        <ThemeSwitch />
      </div>

      {/* ---------- Form side ---------- */}
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <span className="text-2xl font-black tracking-tight text-[var(--text)]">
              StockPilot
            </span>
          </div>

          {/* Sign in / Sign up toggle */}
          <div className="mt-8 flex rounded-[5px] border-2 border-[var(--line)] bg-[var(--panel)] p-1 shadow-[4px_4px_0px_var(--shadow)]">
            {tab("/login", "Sign in")}
            {tab("/register", "Sign up")}
          </div>

          <h1 className="mt-8 text-2xl font-black tracking-tight text-[var(--text)]">
            {title}
          </h1>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            {subtitle}
          </p>

          <div className="mt-7">{children}</div>
        </div>
      </div>

      {/* ---------- Showcase side (desktop only) ---------- */}
      {/* transparent over the gradient — only the dot texture on top */}
      <div className="relative hidden w-[46%] flex-col justify-center gap-10 overflow-hidden border-l-2 border-[var(--line)] bg-[radial-gradient(var(--dot)_1.5px,transparent_1.5px)] bg-[size:18px_18px] p-10 lg:flex">
        <Showcase />
        <div className="mx-auto max-w-md text-center">
          <div className="text-2xl font-black leading-tight tracking-tight text-[var(--text)]">
            Every unit,{" "}
            <span className="bg-[var(--accent)] px-2 text-[var(--btn-text)] shadow-[4px_4px_0px_var(--shadow)]">
              accounted for.
            </span>
          </div>
          <p className="mt-3 text-sm font-semibold text-[var(--muted)]">
            Real-time stock across all your locations, backed by a
            tamper-proof ledger of every movement — who, what, when.
          </p>
          {/* colored feature chips — the sidebar's hues, previewed */}
          <div className="mt-5 flex flex-wrap justify-center gap-2.5">
            {[
              { label: "Multi-location", color: "#3b82f6" },
              { label: "Audit trail", color: "#10b981" },
              { label: "Team roles", color: "#ec4899" },
              { label: "Live reports", color: "#f59e0b" },
            ].map((chip) => (
              <span
                key={chip.label}
                className="rounded-[5px] border-2 border-[var(--line)] px-2.5 py-1 text-xs font-black text-white shadow-[3px_3px_0px_var(--shadow)]"
                style={{ background: chip.color }}
              >
                {chip.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
