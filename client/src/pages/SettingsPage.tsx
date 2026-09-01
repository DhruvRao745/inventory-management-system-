/**
 * Settings — neubrutalist edition. Three card-sections (Company,
 * Locations, Team), header actions on the right, logic unchanged.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../lib/api";
import type { Location } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { GST_STATES } from "../lib/gst";
import { Modal } from "../components/Modal";
import { ConfirmModal } from "../components/ConfirmModal";
import { SecurityPanel } from "../components/SecurityPanel";
import {
  Button,
  Input,
  Select,
  Field,
  ErrorAlert,
  SuccessAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void>;
};

type TeamUser = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "MANAGER" | "STAFF";
  isActive: boolean;
  createdAt: string;
};

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AED", "SGD"];

export function SettingsPage() {
  const { user: me, company, refreshMe } = useAuth();
  const isAdmin = me?.role === "ADMIN";
  const canEditLocations = me?.role === "ADMIN" || me?.role === "MANAGER";

  // --- company card ---
  const [coName, setCoName] = useState(company?.name ?? "");
  const [coCurrency, setCoCurrency] = useState(company?.currency ?? "INR");
  // Business details shown on invoices (the "From" block + seal).
  const [coAddress, setCoAddress] = useState(company?.address ?? "");
  const [coPhone, setCoPhone] = useState(company?.phone ?? "");
  const [coEmail, setCoEmail] = useState(company?.email ?? "");
  const [coGstin, setCoGstin] = useState(company?.gstin ?? "");
  const [coPan, setCoPan] = useState(company?.pan ?? "");
  // The single field that decides CGST+SGST vs IGST on every invoice (P2-3).
  // Without it the server refuses to raise a GST invoice at all.
  const [coStateCode, setCoStateCode] = useState(company?.stateCode ?? "");
  const [coSeal, setCoSeal] = useState(company?.sealText ?? "");
  const [coTerms, setCoTerms] = useState(company?.invoiceTerms ?? "");
  const [coError, setCoError] = useState<string | null>(null);
  const [coOk, setCoOk] = useState(false);

  async function saveCompany(e: FormEvent) {
    e.preventDefault();
    setCoError(null);
    setCoOk(false);
    try {
      await api("/company", {
        method: "PATCH",
        body: {
          name: coName,
          currency: coCurrency,
          // Send "" for cleared fields; the server turns that into null.
          address: coAddress,
          phone: coPhone,
          email: coEmail,
          gstin: coGstin,
          pan: coPan,
          stateCode: coStateCode,
          sealText: coSeal,
          invoiceTerms: coTerms,
        },
      });
      await refreshMe();
      setCoOk(true);
      // Fade the confirmation on its own so it doesn't linger indefinitely.
      setTimeout(() => setCoOk(false), 2500);
    } catch (err) {
      setCoError(err instanceof ApiError ? err.message : "Save failed");
    }
  }

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

  // --- location modal ---
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

  // Inline errors for the quick team actions (role change / (de)activate) —
  // replaces the old native alert() popups so it matches the app's style.
  const [teamError, setTeamError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  // --- team modal ---
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
    setTeamError(null);
    try {
      await api(`/users/${u.id}`, { method: "PATCH", body: { role } });
      await load();
    } catch (err) {
      setTeamError(
        err instanceof ApiError ? err.message : "Failed to change role"
      );
    }
  }

  function toggleActive(u: TeamUser) {
    const verb = u.isActive ? "Deactivate" : "Reactivate";
    setTeamError(null);
    setConfirm({
      title: `${verb} ${u.name}?`,
      message: u.isActive
        ? "They'll lose access immediately. Their history and records stay intact."
        : "They'll regain access with their existing role.",
      confirmLabel: verb,
      danger: u.isActive,
      action: async () => {
        await api(`/users/${u.id}`, {
          method: "PATCH",
          body: { isActive: !u.isActive },
        });
        await load();
      },
    });
  }

  return (
    <div className="max-w-3xl space-y-8">
      {error && <ErrorAlert>{error}</ErrorAlert>}

      {/* ---------- Company ---------- */}
      {isAdmin && (
        <div className="space-y-3">
          <SectionTitle>Company</SectionTitle>
          <form onSubmit={saveCompany} className={`${cardClass} space-y-4 p-5`}>
            <div className="flex flex-wrap items-end gap-4">
              <div className="min-w-48 flex-1">
                <Field label="Company name">
                  <Input
                    required
                    minLength={2}
                    value={coName}
                    onChange={(e) => setCoName(e.target.value)}
                  />
                </Field>
              </div>
              <Field label="Currency">
                <Select
                  value={coCurrency}
                  onChange={(e) => setCoCurrency(e.target.value)}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {/* Business details — printed on invoices as the "From" block. */}
            <div className="border-t-2 border-[var(--line)]/20 pt-4">
              <p className="mb-3 text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
                Business details (shown on invoices)
              </p>
              <div className="space-y-4">
                <Field label="Address" hint="optional">
                  <Input
                    value={coAddress}
                    placeholder="Shop 12, MI Road, Jaipur, Rajasthan 302001"
                    onChange={(e) => setCoAddress(e.target.value)}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Phone" hint="optional">
                    <Input
                      value={coPhone}
                      onChange={(e) => setCoPhone(e.target.value)}
                    />
                  </Field>
                  <Field label="Email" hint="optional">
                    <Input
                      type="email"
                      value={coEmail}
                      onChange={(e) => setCoEmail(e.target.value)}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="GSTIN" hint="optional">
                    <Input
                      value={coGstin}
                      placeholder="22AAAAA0000A1Z5"
                      onChange={(e) => setCoGstin(e.target.value.toUpperCase())}
                    />
                  </Field>
                  <Field label="PAN" hint="optional">
                    <Input
                      value={coPan}
                      placeholder="AAAAA0000A"
                      onChange={(e) => setCoPan(e.target.value.toUpperCase())}
                    />
                  </Field>
                </div>

                <Field
                  label="Business state"
                  hint="required for GST invoices"
                >
                  <Select
                    value={coStateCode}
                    onChange={(e) => setCoStateCode(e.target.value)}
                  >
                    <option value="">Not set</option>
                    {GST_STATES.map((st) => (
                      <option key={st.code} value={st.code}>
                        {st.code} — {st.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <p className="-mt-2 text-xs font-semibold text-[var(--muted)]">
                  GST splits by where the <strong>customer</strong> is relative
                  to you: same state charges CGST + SGST, another state charges
                  IGST. Without your state we can't tell the two apart, so GST
                  invoicing stays switched off until this is set.
                </p>
                <Field
                  label="Seal text"
                  hint="one line inside the round stamp — e.g. For Demo Traders"
                >
                  <Input
                    value={coSeal}
                    placeholder="For Demo Traders"
                    onChange={(e) => setCoSeal(e.target.value)}
                  />
                </Field>
                <Field
                  label="Invoice terms & conditions"
                  hint="one per line — printed at the bottom of every invoice"
                >
                  <textarea
                    value={coTerms}
                    onChange={(e) => setCoTerms(e.target.value)}
                    rows={4}
                    placeholder={
                      "Goods once sold will not be taken back.\nWarranty as per manufacturer terms.\nSubject to Jaipur jurisdiction."
                    }
                    className="w-full resize-y rounded-[5px] border-2 border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--text)] shadow-[3px_3px_0px_var(--shadow)] focus:outline-none"
                  />
                </Field>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <Button type="submit">Save</Button>
              {coOk && (
                <span className="text-sm font-bold text-emerald-500">
                  Saved ✓
                </span>
              )}
              {coError && (
                <span className="text-sm font-bold text-red-500">{coError}</span>
              )}
            </div>
          </form>
        </div>
      )}

      {/* ---------- Locations ---------- */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionTitle>
            Locations{" "}
            <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
              ({locations.length})
            </span>
          </SectionTitle>
          {canEditLocations && (
            <Button variant="secondary" onClick={openLocAdd}>
              + Add location
            </Button>
          )}
        </div>
        <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
          {locations.map((l) => (
            <div
              key={l.id}
              className="flex items-center justify-between px-4 py-3"
            >
              <div>
                <span className="text-sm font-bold text-[var(--text)]">
                  {l.name}
                </span>
                {l.isDefault && (
                  <span className="ml-2 rounded-[4px] border-2 border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-black text-[var(--muted)]">
                    DEFAULT
                  </span>
                )}
                {l.address && (
                  <div className="text-xs font-semibold text-[var(--muted)]">
                    {l.address}
                  </div>
                )}
              </div>
              {canEditLocations && (
                <button
                  onClick={() => openLocEdit(l)}
                  className="text-sm font-bold text-[var(--muted)] hover:text-[var(--accent)]"
                >
                  Edit
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ---------- Security (P2-5) ---------- */}
      <SecurityPanel />

      {/* ---------- Team ---------- */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <SectionTitle>
            Team{" "}
            <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
              ({team.length})
            </span>
          </SectionTitle>
          {isAdmin && (
            <Button variant="secondary" onClick={openUserAdd}>
              + Add member
            </Button>
          )}
        </div>
        {teamError && <ErrorAlert>{teamError}</ErrorAlert>}
        <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
          {team.map((u) => (
            <div
              key={u.id}
              className={`flex items-center justify-between gap-3 px-4 py-3 ${
                u.isActive ? "" : "opacity-50"
              }`}
            >
              <div className="min-w-0">
                <span className="text-sm font-bold text-[var(--text)]">
                  {u.name}
                </span>
                {u.id === me?.id && (
                  <span className="ml-2 text-xs font-semibold text-[var(--muted)]/60">
                    (you)
                  </span>
                )}
                {!u.isActive && (
                  <span className="ml-2 rounded-[4px] border-2 border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-[var(--muted)]">
                    INACTIVE
                  </span>
                )}
                <div className="truncate text-xs font-semibold text-[var(--muted)]">
                  {u.email}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {isAdmin && u.id !== me?.id ? (
                  <>
                    <Select
                      value={u.role}
                      onChange={(e) =>
                        changeRole(u, e.target.value as TeamUser["role"])
                      }
                      className="w-32 !py-1 text-xs"
                    >
                      <option value="ADMIN">ADMIN</option>
                      <option value="MANAGER">MANAGER</option>
                      <option value="STAFF">STAFF</option>
                    </Select>
                    <button
                      onClick={() => toggleActive(u)}
                      className={`text-xs font-bold ${
                        u.isActive
                          ? "text-[var(--muted)]/60 hover:text-red-500"
                          : "text-[var(--muted)]/60 hover:text-emerald-500"
                      }`}
                    >
                      {u.isActive ? "Deactivate" : "Reactivate"}
                    </button>
                  </>
                ) : (
                  <span className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-black text-white">
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
          <form onSubmit={submitLocation} className="space-y-4">
            <Field label="Name">
              <Input
                required
                minLength={2}
                value={locName}
                onChange={(e) => setLocName(e.target.value)}
              />
            </Field>
            <Field label="Address" hint="optional">
              <Input
                value={locAddress}
                onChange={(e) => setLocAddress(e.target.value)}
              />
            </Field>
            {locError && <ErrorAlert>{locError}</ErrorAlert>}
            <div className="flex justify-end gap-3 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setLocModal("closed")}
              >
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Modal>
      )}

      {userModalOpen && (
        <Modal title="Add team member" onClose={() => setUserModalOpen(false)}>
          <form onSubmit={submitUser} className="space-y-4">
            <Field label="Name">
              <Input
                required
                value={uName}
                onChange={(e) => setUName(e.target.value)}
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                required
                value={uEmail}
                onChange={(e) => setUEmail(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Temporary password">
                <Input
                  required
                  minLength={8}
                  value={uPassword}
                  onChange={(e) => setUPassword(e.target.value)}
                />
              </Field>
              <Field label="Role">
                <Select
                  value={uRole}
                  onChange={(e) => setURole(e.target.value as TeamUser["role"])}
                >
                  <option value="STAFF">STAFF</option>
                  <option value="MANAGER">MANAGER</option>
                  <option value="ADMIN">ADMIN</option>
                </Select>
              </Field>
            </div>
            <p className="text-xs font-semibold text-[var(--muted)]">
              Share the temporary password with them privately — they log in
              with it at the same address.
            </p>
            {uError && <ErrorAlert>{uError}</ErrorAlert>}
            <div className="flex justify-end gap-3 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setUserModalOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Add member</Button>
            </div>
          </form>
        </Modal>
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={confirm.action}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
