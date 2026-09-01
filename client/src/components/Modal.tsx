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
      {/*
        The card is capped at the viewport height and scrolls its BODY, not the
        whole card. A tall form (the product editor is ~12 fields) otherwise
        grows past the bottom of the screen and takes its Save and Cancel
        buttons with it — leaving a dialog that cannot be submitted or closed
        except by the × or the backdrop.

        max-h-[90dvh] rather than vh: on mobile browsers the URL bar shrinks the
        visible area, and vh ignores that, so the buttons hide behind it.

        The header stays put (shrink-0) so the title and × are always reachable
        no matter how far down the body is scrolled.
      */}
      <div
        className="flex max-h-[90dvh] w-full max-w-md flex-col rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] shadow-[6px_6px_0px_var(--shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b-2 border-[var(--line)]/20 p-6 pb-4">
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
        <div className="min-h-0 flex-1 overflow-y-auto p-6 pt-4">{children}</div>
      </div>
    </div>
  );
}
