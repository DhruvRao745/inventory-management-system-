/**
 * Theme switching: one attribute on <html> selects which set of
 * CSS variables applies (see index.css). Saved in localStorage.
 */
const KEY = "theme";

export type Theme = "light" | "dark";

export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme) ?? "dark";
}

export function initTheme() {
  document.documentElement.dataset.theme = getTheme();
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  localStorage.setItem(KEY, next);
  document.documentElement.dataset.theme = next;
  return next;
}
