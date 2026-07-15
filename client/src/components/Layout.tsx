/**
 * App shell — neubrutalist edition.
 * Sidebar: logo, pressable nav chips, user card with logout.
 * Header: hamburger (mobile) + current page title.
 * Canvas: the same dot-grid stage as the login page.
 */
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { Logo } from "./ui";

const navItems = [
  { to: "/", label: "Dashboard", icon: "📊", end: true },
  { to: "/products", label: "Products", icon: "📦" },
  { to: "/stock", label: "Stock", icon: "🔄" },
  { to: "/reports", label: "Reports", icon: "📈" },
  { to: "/settings", label: "Settings", icon: "⚙️" },
];

/** Page title for the header, derived from the URL */
function titleFor(pathname: string): string {
  if (pathname === "/") return "Dashboard";
  if (pathname.startsWith("/products/")) return "Product details";
  const item = navItems.find((n) => pathname.startsWith(n.to) && n.to !== "/");
  return item?.label ?? "StockPilot";
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, company, logout } = useAuth();

  return (
    <div className="flex h-full flex-col gap-6 p-4">
      {/* Brand */}
      <div className="flex items-center gap-3 px-1">
        <Logo size={38} />
        <div className="min-w-0">
          <div className="text-lg font-black leading-tight tracking-tight text-[#323232]">
            StockPilot
          </div>
          <div className="truncate text-xs font-semibold text-[#666]">
            {company?.name}
          </div>
        </div>
      </div>

      {/* Nav chips */}
      <nav className="flex flex-col gap-3">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-[5px] border-2 border-[#323232] px-3 py-2
               text-sm font-bold transition-all duration-100
               shadow-[4px_4px_0px_#323232]
               active:translate-x-[3px] active:translate-y-[3px] active:shadow-none
               ${
                 isActive
                   ? "bg-[#2d8cf0] text-white translate-x-[2px] translate-y-[2px] shadow-[2px_2px_0px_#323232]"
                   : "bg-white text-[#323232] hover:bg-[#eaeaea]"
               }`
            }
          >
            <span aria-hidden>{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* User card pinned to the bottom */}
      <div className="mt-auto rounded-[5px] border-2 border-[#323232] bg-white p-3 shadow-[4px_4px_0px_#323232]">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-bold text-[#323232]">
              {user?.name}
            </div>
            <span className="mt-0.5 inline-block rounded-[4px] border-2 border-[#323232] bg-[#2d8cf0] px-1.5 py-0.5 text-[10px] font-black text-white">
              {user?.role}
            </span>
          </div>
          <button
            onClick={logout}
            title="Logout"
            className="rounded-[5px] border-2 border-[#323232] bg-white px-2 py-1 text-xs font-bold text-[#323232]
              shadow-[3px_3px_0px_#323232] transition-all duration-100
              hover:bg-red-50 hover:text-red-600
              active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          >
            ⏻
          </button>
        </div>
      </div>
    </div>
  );
}

export function Layout() {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-[#f4f4f4]">
      {/* Sidebar — fixed on desktop */}
      <aside className="hidden w-60 shrink-0 border-r-2 border-[#323232] bg-[#fafafa] lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        >
          <aside
            className="h-full w-60 border-r-2 border-[#323232] bg-[#fafafa]"
            onClick={(e) => e.stopPropagation()}
          >
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex h-14 items-center gap-3 border-b-2 border-[#323232] bg-white px-4">
          <button
            onClick={() => setDrawerOpen(true)}
            className="rounded-[5px] border-2 border-[#323232] bg-white px-2 py-1 font-black shadow-[3px_3px_0px_#323232]
              active:translate-x-[2px] active:translate-y-[2px] active:shadow-none lg:hidden"
            aria-label="Open menu"
          >
            ☰
          </button>
          <h1 className="text-lg font-black tracking-tight text-[#323232]">
            {titleFor(location.pathname)}
          </h1>
        </header>

        {/* Page content on the dot-grid stage */}
        <main className="flex-1 overflow-auto bg-[radial-gradient(#32323215_1.5px,transparent_1.5px)] bg-[size:18px_18px] p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
