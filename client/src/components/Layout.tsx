/**
 * The app shell: sidebar navigation + top header + page content.
 * <Outlet /> is React Router's "insert the current page here" slot.
 */
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/products", label: "Products" },
  { to: "/stock", label: "Stock" },
];

export function Layout() {
  const { user, company, logout } = useAuth();

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Sidebar */}
      <aside className="w-56 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-4 py-5 border-b border-slate-700">
          <div className="text-lg font-bold">Inventory</div>
          <div className="text-xs text-slate-400 truncate">{company?.name}</div>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded px-3 py-2 text-sm ${
                  isActive
                    ? "bg-slate-700 text-white"
                    : "text-slate-300 hover:bg-slate-800"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col">
        <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between">
          <div />
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">
              {user?.name}
              <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                {user?.role}
              </span>
            </span>
            <button
              onClick={logout}
              className="text-slate-500 hover:text-red-600"
            >
              Logout
            </button>
          </div>
        </header>

        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
