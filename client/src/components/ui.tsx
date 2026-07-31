/**
 * Design system primitives — NEUBRUTALIST edition.
 *
 * The language (from the user's chosen reference):
 *   border: 2px solid #323232       — hard, honest outlines
 *   shadow: 4px 4px 0 #323232      — solid offset, no blur
 *   active: translate(3px,3px) + shadow removed — buttons "press down"
 *   focus:  border turns #2d8cf0    — the accent blue
 *
 * These exact classes ARE our design tokens. Change them here,
 * the whole app follows.
 */
import { forwardRef } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  ReactNode,
} from "react";

/* ---------- Button ---------- */
type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

// NOTE: base sets NO text color — each variant owns its own.
// (Two text-color utilities on one element = stylesheet-order roulette.)
const base = `inline-flex items-center justify-center gap-2 rounded-[5px]
  border-2 border-[var(--line)] text-sm font-semibold
  shadow-[4px_4px_0px_var(--shadow)] transition-all duration-100
  active:translate-x-[3px] active:translate-y-[3px] active:shadow-none
  disabled:opacity-50 disabled:pointer-events-none`;

const buttonVariants: Record<ButtonVariant, string> = {
  primary: `${base} bg-[var(--btn)] text-[var(--btn-text)] hover:brightness-90`,
  secondary: `${base} bg-[var(--card)] text-[var(--text)]`,
  danger: `${base} bg-[var(--card)] text-red-600`,
  // ghost breaks the pattern on purpose: quiet actions stay quiet
  ghost: `inline-flex items-center justify-center gap-2 rounded-[5px] px-3 py-1.5
    text-sm font-semibold text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]
    transition-colors`,
};

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const padding = variant === "ghost" ? "" : "px-4 py-2";
  return (
    <button
      className={`${buttonVariants[variant]} ${padding} ${className}`}
      {...props}
    />
  );
}

/* ---------- Inputs ---------- */
const fieldClass = `w-full rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)]
  px-3 py-2 text-sm font-semibold text-[var(--text)]
  shadow-[4px_4px_0px_var(--shadow)] outline-none
  placeholder:text-[var(--muted)] placeholder:opacity-80 placeholder:font-medium
  focus:border-[var(--accent)] transition-colors duration-100`;

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className = "", ...props }, ref) {
  return <input ref={ref} className={`${fieldClass} ${className}`} {...props} />;
});

export function Select({
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${fieldClass} ${className}`} {...props} />;
}

/* ---------- Field: label + control ---------- */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 flex items-baseline justify-between text-sm font-bold text-[var(--text)]">
        {label}
        {hint && (
          <span className="text-xs font-medium text-[var(--muted)]">{hint}</span>
        )}
      </label>
      {children}
    </div>
  );
}

/* ---------- Alerts ---------- */
export function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[5px] border-2 border-red-600 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 shadow-[4px_4px_0px_#dc2626]">
      {children}
    </p>
  );
}

export function SuccessAlert({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[5px] border-2 border-emerald-600 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-700 shadow-[4px_4px_0px_#059669]">
      {children}
    </p>
  );
}

/* ---------- Card: the lightgrey bordered panel ---------- */
export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-[5px] border-2 border-[var(--line)] bg-[var(--card-2)] p-5 shadow-[4px_4px_0px_var(--shadow)] ${className}`}
    >
      {children}
    </div>
  );
}

/* ---------- Shared card + section title ---------- */
export const cardClass =
  "rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] shadow-[4px_4px_0px_var(--shadow)]";

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-xs font-black uppercase tracking-[0.15em] text-[var(--muted)]/80">
      {children}
    </h2>
  );
}

/* ---------- Brand mark ---------- */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-[5px] border-2 border-[var(--line)] bg-[var(--accent)] text-[var(--btn-text)] shadow-[4px_4px_0px_var(--shadow)]"
      style={{ width: size, height: size }}
    >
      <svg
        width={size * 0.55}
        height={size * 0.55}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
        <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
      </svg>
    </div>
  );
}
