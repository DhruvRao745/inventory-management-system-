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
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  ReactNode,
} from "react";

/* ---------- Button ---------- */
type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const base = `inline-flex items-center justify-center gap-2 rounded-[5px]
  border-2 border-[#323232] text-sm font-semibold text-[#323232]
  shadow-[4px_4px_0px_#323232] transition-all duration-100
  active:translate-x-[3px] active:translate-y-[3px] active:shadow-none
  disabled:opacity-50 disabled:pointer-events-none`;

const buttonVariants: Record<ButtonVariant, string> = {
  primary: `${base} bg-[#2d8cf0] text-white`,
  secondary: `${base} bg-white`,
  danger: `${base} bg-white text-red-600`,
  // ghost breaks the pattern on purpose: quiet actions stay quiet
  ghost: `inline-flex items-center justify-center gap-2 rounded-[5px] px-3 py-1.5
    text-sm font-semibold text-[#666] hover:text-[#323232] hover:bg-black/5
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
const fieldClass = `w-full rounded-[5px] border-2 border-[#323232] bg-white
  px-3 py-2 text-sm font-semibold text-[#323232]
  shadow-[4px_4px_0px_#323232] outline-none
  placeholder:text-[#666] placeholder:opacity-80 placeholder:font-medium
  focus:border-[#2d8cf0] transition-colors duration-100`;

export function Input({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${fieldClass} ${className}`} {...props} />;
}

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
      <label className="mb-1.5 flex items-baseline justify-between text-sm font-bold text-[#323232]">
        {label}
        {hint && (
          <span className="text-xs font-medium text-[#666]">{hint}</span>
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
      className={`rounded-[5px] border-2 border-[#323232] bg-[#d3d3d3] p-5 shadow-[4px_4px_0px_#323232] ${className}`}
    >
      {children}
    </div>
  );
}

/* ---------- Brand mark ---------- */
export function Logo({ size = 36 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-[5px] border-2 border-[#323232] bg-[#2d8cf0] text-white shadow-[4px_4px_0px_#323232]"
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
