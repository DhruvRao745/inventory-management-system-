/**
 * ThemeSwitch — a sliding day/night toggle in the house style.
 * Track shows sun (left) and moon (right); the accent thumb slides
 * over the active one. role="switch" tells screen readers the truth.
 */
import { useState } from "react";
import { getTheme, toggleTheme, type Theme } from "../lib/theme";

const sun = (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
  >
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

const moon = (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

export function ThemeSwitch({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(getTheme);
  const dark = theme === "dark";

  /**
   * Theme change with a circular reveal (View Transitions API):
   * the browser snapshots the old look, we flip the theme, and the
   * new look expands as a growing circle FROM THE CLICK POINT.
   * Browsers without the API just switch instantly — a graceful fallback.
   */
  function handleToggle(e: React.MouseEvent) {
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => { ready: Promise<void> };
    };

    if (!doc.startViewTransition) {
      setTheme(toggleTheme());
      return;
    }

    const x = e.clientX;
    const y = e.clientY;
    // radius to the farthest screen corner — the circle must cover everything
    const maxR = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    const transition = doc.startViewTransition(() => setTheme(toggleTheme()));
    transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${maxR}px at ${x}px ${y}px)`,
          ],
        },
        {
          duration: 500,
          easing: "cubic-bezier(0.4, 0, 0.2, 1)",
          pseudoElement: "::view-transition-new(root)",
        }
      );
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      onClick={handleToggle}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className={`relative h-8 w-[60px] shrink-0 rounded-full border-2 border-[var(--line)] bg-[var(--panel)] shadow-[3px_3px_0px_var(--shadow)] transition-colors ${className}`}
    >
      {/* track icons */}
      <span className="absolute left-[7px] top-1/2 -translate-y-1/2 text-[var(--muted)]">
        {sun}
      </span>
      <span className="absolute right-[7px] top-1/2 -translate-y-1/2 text-[var(--muted)]">
        {moon}
      </span>
      {/* the sliding thumb — covers the ACTIVE side's icon */}
      <span
        className={`absolute left-[2px] top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border-2 border-[var(--line)] bg-[var(--accent)] text-[var(--btn-text)] transition-transform duration-200 ${
          dark ? "translate-x-[28px]" : "translate-x-0"
        }`}
      >
        {dark ? moon : sun}
      </span>
    </button>
  );
}
