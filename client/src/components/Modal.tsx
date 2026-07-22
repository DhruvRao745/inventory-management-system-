/**
 * Modal — neubrutalist card floating over a dark overlay.
 * Clicking the backdrop closes; clicking inside doesn't.
 */
import type { ReactNode } from "react";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] p-6 shadow-[6px_6px_0px_var(--shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-black tracking-tight text-[var(--text)]">
            {title}
          </h2>
          <button
            onClick={onClose}
            className="rounded-[5px] px-2 text-xl leading-none text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--text)]"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
