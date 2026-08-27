/**
 * App shell — neubrutalist edition, collapsible sidebar, line icons.
 *
 * Scroll architecture (the fix for the vanishing logout button):
 * the shell is EXACTLY screen height (h-screen + overflow-hidden);
 * only <main> scrolls. The sidebar therefore never stretches with
 * long pages, and the user card stays pinned and visible.
 */
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { api } from "../lib/api";
import type { StockLevel } from "../lib/types";
import { Logo } from "./ui";
import { ThemeSwitch } from "./ThemeSwitch";

/* ---------- Clean line icons (24×24, stroke-based, like the reference) ---------- */
function IconBase({ children }: { children: ReactNode }) {
  return (
    <svg
      width="21"
      height="21"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const icons = {
  dashboard: (
    <IconBase>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
    </IconBase>
  ),
  products: (
    <IconBase>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </IconBase>
  ),
  stock: (
    <IconBase>
      <path d="M17 3l4 4-4 4" />
      <path d="M21 7H7" />
      <path d="M7 21l-4-4 4-4" />
      <path d="M3 17h14" />
    </IconBase>
  ),
  reports: (
    <IconBase>
      <path d="M6 20v-6" />
      <path d="M12 20V4" />
      <path d="M18 20v-10" />
    </IconBase>
  ),
  settings: (
    <IconBase>
      <path d="M4 21v-7M4 10V3" />
      <path d="M12 21v-9M12 8V3" />
      <path d="M20 21v-5M20 12V3" />
      <path d="M1 14h6M9 8h6M17 16h6" />
    </IconBase>
  ),
  suppliers: (
    <IconBase>
      <path d="M1 4h14v11H1z" />
      <path d="M15 8h4l3 3v4h-7z" />
      <circle cx="5.5" cy="18" r="1.5" />
      <circle cx="17.5" cy="18" r="1.5" />
    </IconBase>
  ),
  purchases: (
    <IconBase>
      <path d="M6 2h9l4 4v16H6z" />
      <path d="M15 2v5h5" />
      <path d="M9 13h6M9 17h6" />
    </IconBase>
  ),
  activity: (
    <IconBase>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </IconBase>
  ),
  invoices: (
    <IconBase>
      <path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" />
      <path d="M9 8h6M9 12h4" />
    </IconBase>
  ),
  returns: (
    <IconBase>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </IconBase>
  ),
  batches: (
    <IconBase>
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 12l9 4 9-4M3 17l9 4 9-4" />
    </IconBase>
  ),
  receiving: (
    <IconBase>
      <path d="M3 8l9-5 9 5v8l-9 5-9-5z" />
      <path d="M3 8l9 5 9-5" />
      <path d="M12 13v8" />
    </IconBase>
  ),
  counts: (
    <IconBase>
      <path d="M9 3h6v3H9z" />
      <path d="M15 4.5h3v16H6v-16h3" />
      <path d="M9 11l1.5 1.5L14 9" />
      <path d="M9 16h6" />
    </IconBase>
  ),
  scan: (
    <IconBase>
      <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2" />
      <path d="M4 12h16" />
    </IconBase>
  ),
  customers: (
    <IconBase>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1" />
      <path d="M16 3.5a3 3 0 0 1 0 5.4M21 20v-1a4 4 0 0 0-3-3.8" />
    </IconBase>
  ),
  power: (
    <IconBase>
      <path d="M18.36 6.64a9 9 0 1 1-12.72 0" />
      <path d="M12 2v10" />
    </IconBase>
  ),
  sun: (
    <IconBase>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </IconBase>
  ),
  moon: (
    <IconBase>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </IconBase>
  ),
} as const;

// Each section owns a hue — the sidebar becomes a color legend
const navItems = [
  { to: "/", label: "Dashboard", icon: icons.dashboard, color: "#3b82f6", end: true },
  { to: "/products", label: "Products", icon: icons.products, color: "#a855f7" },
  { to: "/stock", label: "Stock", icon: icons.stock, color: "#f59e0b" },
  { to: "/batches", label: "Batches", icon: icons.batches, color: "#8b5cf6" },
  { to: "/scan", label: "Scan", icon: icons.scan, color: "#06b6d4" },
  { to: "/suppliers", label: "Suppliers", icon: icons.suppliers, color: "#14b8a6" },
  { to: "/purchase-orders", label: "Purchases", icon: icons.purchases, color: "#6366f1" },
  { to: "/receiving", label: "Receiving", icon: icons.receiving, color: "#0ea5e9" },
  { to: "/stock-counts", label: "Stock counts", icon: icons.counts, color: "#f97316" },
  { to: "/invoices", label: "Invoices", icon: icons.invoices, color: "#eab308" },
  { to: "/returns", label: "Returns", icon: icons.returns, color: "#fb7185" },
  { to: "/customers", label: "Customers", icon: icons.customers, color: "#f43f5e" },
  { to: "/reports", label: "Reports", icon: icons.reports, color: "#10b981" },
  { to: "/audit", label: "Activity", icon: icons.activity, color: "#64748b" },
  { to: "/settings", label: "Settings", icon: icons.settings, color: "#ec4899" },
];

function titleFor(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  if (pathname.startsWith("/products/")) return "Product details";
  // Match on a SEGMENT boundary, not a bare prefix: "/stock-counts" starts
  // with "/stock", so a plain startsWith would title the stock-count screen
  // "Stock" purely because that entry sits earlier in the list.
  const item = navItems.find(
    (n) =>
      n.to !== "/" && (pathname === n.to || pathname.startsWith(`${n.to}/`))
  );
  return item?.label ?? "StockPilot";
}

// Nav items are "transparent": no borders or boxes — just the icon
// and label, with the ACTIVE one picked out in the accent blue
// (exactly like the reference: the pink house among grey icons).
const navItemBase = `flex items-center gap-3 rounded-[5px] px-3 py-2.5
  text-sm font-bold transition-colors duration-100`;

function SidebarContent({
  collapsed = false,
  lowStockCount = 0,
  onNavigate,
}: {
  collapsed?: boolean;
  lowStockCount?: number;
  onNavigate?: () => void;
}) {
  const { user, company, logout } = useAuth();

  return (
    <div className="flex h-full flex-col gap-6 p-3">
      {/* Brand */}
      <div
        className={`flex items-center gap-3 px-1 ${collapsed ? "justify-center" : ""}`}
      >
        <Logo size={38} />
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-lg font-black leading-tight tracking-tight text-[var(--text)]">
              StockPilot
            </div>
            <div className="truncate text-xs font-semibold text-[var(--muted)]">
              {company?.name}
            </div>
          </div>
        )}
      </div>

      {/* Nav */}
      {!collapsed && (
        <div className="px-3 text-[10px] font-black tracking-[0.2em] text-[var(--muted)]/70">
          MENU
        </div>
      )}
      <nav className="-mt-3 flex flex-col gap-2">
        {navItems.map((item) => {
          const showBadge = item.to === "/products" && lowStockCount > 0;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                `relative ${navItemBase} ${collapsed ? "justify-center px-0" : ""}
                 ${
                   isActive
                     ? ""
                     : "text-[var(--muted)] hover:translate-x-[2px] hover:bg-[var(--hover)] hover:text-[var(--text)]"
                 }`
              }
              style={({ isActive }) =>
                isActive ? { color: item.color } : undefined
              }
            >
              {({ isActive }) => (
                <>
                  {/* active-page indicator bar, in the section's hue */}
                  {isActive && (
                    <span
                      className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r"
                      style={{ background: item.color }}
                    />
                  )}
                  <span className="relative">
                    {item.icon}
                    {/* collapsed: badge rides the icon's corner */}
                    {showBadge && collapsed && (
                      <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-[var(--line)] bg-red-500 px-0.5 text-[9px] font-black text-white">
                        {lowStockCount}
                      </span>
                    )}
                  </span>
                  {!collapsed && <span className="flex-1">{item.label}</span>}
                  {/* expanded: badge sits at the row's end */}
                  {showBadge && !collapsed && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-[var(--line)] bg-red-500 px-1 text-[10px] font-black text-white">
                      {lowStockCount}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* User area pinned to the bottom — boxless, like the nav */}
      <div
        className={`mt-auto border-t-2 border-[var(--line)]/25 pt-3 ${
          collapsed ? "flex justify-center" : ""
        }`}
      >
        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={logout}
              title={`Logout (${user?.name})`}
              className="rounded-[5px] p-1.5 text-[var(--muted)] transition-colors duration-100
                hover:bg-red-50 hover:text-red-600"
            >
              {icons.power}
            </button>
            <span className="text-[9px] font-semibold text-[var(--muted)]/60">
              v0.1
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 p-1">
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-[var(--text)]">
                {user?.name}
              </div>
              <span className="mt-0.5 inline-block rounded-[4px] border-2 border-[var(--line)] bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-black text-[var(--btn-text)]">
                {user?.role}
              </span>
            </div>
            <button
              onClick={logout}
              title="Logout"
              className="rounded-[5px] p-1.5 text-[var(--muted)] transition-colors duration-100
                hover:bg-red-50 hover:text-red-600"
            >
              {icons.power}
            </button>
          </div>
        )}
        {!collapsed && (
          <div className="mt-1 px-1 text-[10px] font-semibold text-[var(--muted)]/60">
            StockPilot v0.1.0
          </div>
        )}
      </div>
    </div>
  );
}

export function Layout() {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("sidebar_collapsed") === "1"
  );

  // Live low-stock count for the nav badge — refreshed every minute
  // and on every page change (cheap endpoint, big signal).
  const [lowStockCount, setLowStockCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<StockLevel[]>("/stock/levels")
        .then((levels) => {
          if (alive) setLowStockCount(levels.filter((l) => l.lowStock).length);
        })
        .catch(() => {}); // badge is garnish — never break the shell over it
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [location.pathname]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem("sidebar_collapsed", c ? "0" : "1");
      return !c;
    });
  }

  return (
    // h-screen + overflow-hidden: the shell never grows with content
    <div className="flex h-screen overflow-hidden bg-[var(--bg)]">
      {/* Sidebar — desktop */}
      <aside
        className={`hidden shrink-0 overflow-y-auto border-r-2 border-[var(--line)] bg-[var(--panel)] transition-[width] duration-200 lg:block ${
          collapsed ? "w-[72px]" : "w-60"
        }`}
      >
        <SidebarContent collapsed={collapsed} lowStockCount={lowStockCount} />
      </aside>

      {/* Mobile drawer — always the full version */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <aside
            className="h-full w-60 overflow-y-auto border-r-2 border-[var(--line)] bg-[var(--panel)]"
            onClick={(e) => e.stopPropagation()}
          >
            <SidebarContent
              lowStockCount={lowStockCount}
              onNavigate={() => setDrawerOpen(false)}
            />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b-2 border-[var(--line)] bg-[var(--panel)] px-4">
          <button
            onClick={() => setDrawerOpen(true)}
            className="rounded-[5px] px-2 py-1 font-black text-[var(--muted)] transition-colors
              hover:bg-[var(--hover)] hover:text-[var(--text)] lg:hidden"
            aria-label="Open menu"
          >
            ☰
          </button>
          <button
            onClick={toggleCollapsed}
            className="hidden rounded-[5px] px-2.5 py-1 font-black text-[var(--muted)] transition-colors
              hover:bg-[var(--hover)] hover:text-[var(--text)] lg:block"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? "»" : "«"}
          </button>
          <h1 className="text-lg font-black tracking-tight text-[var(--text)]">
            {titleFor(location.pathname)}
          </h1>

          {/* theme slide switch */}
          <ThemeSwitch className="ml-auto" />
        </header>

        {/* the ONLY scrolling region */}
        <main className="flex-1 overflow-auto bg-[radial-gradient(var(--dot)_1.5px,transparent_1.5px)] bg-[size:18px_18px] p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
