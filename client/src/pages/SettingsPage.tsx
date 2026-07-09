/**
 * Settings — two cards: Locations (ADMIN/MANAGER can edit)
 * and Team (visible to all, editable by ADMIN only).
 *
 * Same rhythms you already know: load on arrival, re-load after
 * changes, modals for forms, server errors shown to humans.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { Location } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { Modal } from "../components/Modal";

type TeamUser = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "STAFF";
  isActive: boolean;
  createdAt: string;
};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400";

export function SettingsPage() {
  const { user: me } = useAuth();
  const isAdmin = me?.role === "ADMIN";
  const canEditLocations = me?.role === "ADMIN" || me?.role === "MANAGER";

  // --- data ---
  const [locations, setLocations] = useState<Location[]>([]);
  const [team, setTeam] = useState<TeamUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [locs, users] = await Promise.all([
        api<Location[]>("/locations"),
        api<TeamUser[]>("/users"),
      ]);
      setLocations(locs);
      setTeam(users);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    }
  }

  useEffect(() => {
    load();
  }, []);

  // --- location modal (add or edit) ---
  const [locModal, setLocModal] = useState<"closed" | "add" | "edit">("closed");
  const [locId, setLocId] = useState<string | null>(null);
  const [locName, setLocName] = useState("");
  const [locAddress, setLocAddress] = useState("");
  const [locError, setLocError] = useState<string | null>(null);

  function openLocAdd() {
    setLocId(null);
    setLocName("");
    setLocAddress("");
    setLocError(null);
    setLocModal("add");
  }
  function openLocEdit(l: Location) {
    setLocId(l.id);
    setLocName(l.name);
    setLocAddress(l.address ?? "");
    setLocError(null);
    setLocModal("edit");
  }

  async function submitLocation(e: FormEvent) {
    e.preventDefault();
    setLocError(null);
    const body = { name: locName, address: locAddress || undefined };
    try {
      if (locModal === "add") {
        await api("/locations", { method: "POST", body });
      } else {
        await api(`/locations/${locId}`, { method: "PATCH", body });
      }
      setLocModal("closed");
      await load();
    } catch (err) {
      setLocError(err instanceof ApiError ? err.message : "Save failed");
    }
  }

  // --- team modal (add member) ---
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [uName, setUName] = useState("");
  const [uEmail, setUEmail] = useState("");
  const [uPassword, setUPassword] = useState("");
  const [uRole, setURole] = useState<TeamUser["role"]>("STAFF");
  const [uError, setUError] = useState<string | null>(null);

  function openUserAdd() {
    setUName("");
    setUEmail("");
    setUPassword("");
    setURole("STAFF");
    setUError(null);
    setUserModalOpen(true);
  }

  async function submitUser(e: FormEvent) {
    e.preventDefault();
    setUError(null);
    try {
      await api("/users", {
        method: "POST",
        body: { name: uName, email: uEmail, password: uPassword, role: uRole },
      });
      setUserModalOpen(false);
      await load();
    } catch (err) {
      setUError(err instanceof ApiError ? err.message : "Save failed");
    }
  }

  async function changeRole(u: TeamUser, role: TeamUser["role"]) {
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: { role } });
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Failed to change role");
    }
  }

  async function toggleActive(u: TeamUser) {
    const verb = u.isActive ? "Deactivate" : "Reactivate";
    if (!window.confirm(`${verb} ${u.name}?`)) return;
    try {
      await api(`/users/${u.id}`, {
        method: "PATCH",
        body: { isActive: !u.isActive },
      });
      await load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Failed");
    }
  }

  return (
    <div>
      <h1 className="text-xl font-bold text-slate-800">Settings</h1>
      {error && (
        <p className="mt-4 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 inline-block">
          {error}
        </p>
      )}

      {/* ---------- Locations ---------- */}
      <div className="mt-6 max-w-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
            Locations
          </h2>
          {canEditLocations && (
            <button
              onClick={openLocAdd}
              className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-700"
            >
              + Add location
            </button>
          )}
        </div>
        <div className="mt-3 bg-white rounded-xl shadow-sm divide-y divide-slate-100">
          {locations.map((l) => (
            <div
              key={l.id}
              className="px-4 py-3 flex items-center justify-between"
            >
              <div>
                <span className="text-sm text-slate-800">{l.name}</span>
                {l.isDefault && (
                  <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                    default
                  </span>
                )}
                {l.address && (
                  <div className="text-xs text-slate-400">{l.address}</div>
                )}
              </div>
              {canEditLocations && (
                <button
                  onClick={() => openLocEdit(l)}
                  className="text-sm text-slate-500 hover:text-slate-900"
                >
                  Edit
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ---------- Team ---------- */}
      <div className="mt-8 max-w-3xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-600 uppercase tracking-wide">
            Team
          </h2>
          {isAdmin && (
            <button
              onClick={openUserAdd}
              className="rounded-lg bg-slate-900 text-white px-3 py-1.5 text-sm hover:bg-slate-700"
            >
              + Add member
            </button>
          )}
        </div>
        <div className="mt-3 bg-white rounded-xl shadow-sm divide-y divide-slate-100">
          {team.map((u) => (
            <div
              key={u.id}
              className={`px-4 py-3 flex items-center justify-between ${
                u.isActive ? "" : "opacity-50"
              }`}
            >
              <div>
                <span className="text-sm text-slate-800">{u.name}</span>
                {u.id === me?.id && (
                  <span className="ml-2 text-xs text-slate-400">(you)</span>
                )}
                <div className="text-xs text-slate-400">{u.email}</div>
              </div>
              <div className="flex items-center gap-3">
                {isAdmin && u.id !== me?.id ? (
                  <>
                    <select
                      value={u.role}
                      onChange={(e) =>
                        changeRole(u, e.target.value as TeamUser["role"])
                      }
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs"
                    >
                      <option value="ADMIN">ADMIN</option>
                      <option value="MANAGER">MANAGER</option>
                      <option value="STAFF">STAFF</option>
                    </select>
                    <button
                      onClick={() => toggleActive(u)}
                      className={`text-xs ${
                        u.isActive
                          ? "text-slate-400 hover:text-red-600"
                          : "text-slate-400 hover:text-green-700"
                      }`}
                    >
                      {u.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  </>
                ) : (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                    {u.role}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ---------- Modals ---------- */}
      {locModal !== "closed" && (
        <Modal
          title={locModal === "add" ? "Add location" : "Edit location"}
          onClose={() => setLocModal("closed")}
        >
          <form onSubmit={submitLocation} className="space-y-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">Name</label>
              <input
                required
                value={locName}
                onChange={(e) => setLocName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">
                Address (optional)
              </label>
              <input
                value={locAddress}
                onChange={(e) => setLocAddress(e.target.value)}
                className={inputClass}
              />
            </div>
            {locError && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {locError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setLocModal("closed")}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-700"
              >
                Save
              </button>
            </div>
          </form>
        </Modal>
      )}

      {userModalOpen && (
        <Modal title="Add team member" onClose={() => setUserModalOpen(false)}>
          <form onSubmit={submitUser} className="space-y-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">Name</label>
              <input
                required
                value={uName}
                onChange={(e) => setUName(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">Email</label>
              <input
                type="email"
                required
                value={uEmail}
                onChange={(e) => setUEmail(e.target.value)}
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-600 mb-1">
                  Temporary password
                </label>
                <input
                  required
                  minLength={8}
                  value={uPassword}
                  onChange={(e) => setUPassword(e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm text-slate-600 mb-1">Role</label>
                <select
                  value={uRole}
                  onChange={(e) => setURole(e.target.value as TeamUser["role"])}
                  className={inputClass}
                >
                  <option value="STAFF">STAFF</option>
                  <option value="MANAGER">MANAGER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-slate-400">
              Share the temporary password with them privately — they log in
              with it at the same address.
            </p>
            {uError && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                {uError}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setUserModalOpen(false)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-slate-900 text-white px-4 py-2 text-sm font-medium hover:bg-slate-700"
              >
                Add member
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
