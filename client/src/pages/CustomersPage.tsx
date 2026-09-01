/**
 * Customers — who we sell to. Mirrors Suppliers: list, add/edit modal,
 * deactivate via ConfirmModal, role-gated. Names link to a detail page.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Customer } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { Modal } from "../components/Modal";
import { ConfirmModal } from "../components/ConfirmModal";
import {
  Button,
  Input,
  Select,
  Field,
  ErrorAlert,
  cardClass,
  SectionTitle,
} from "../components/ui";
import { GST_STATES, stateCodeFromGstin } from "../lib/gst";

type ConfirmState = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  action: () => Promise<void>;
};

export function CustomersPage() {
  const { user: me } = useAuth();
  const canEdit = me?.role === "ADMIN" || me?.role === "MANAGER";

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  async function load() {
    setError(null);
    try {
      setCustomers(await api<Customer[]>("/customers"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  const [modal, setModal] = useState<"closed" | "add" | "edit">("closed");
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  // GST details (P2-3). stateCode is the PLACE OF SUPPLY — it is what makes an
  // invoice to this customer intra- or inter-state.
  const [gstin, setGstin] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);

  function openAdd() {
    setEditId(null);
    setName("");
    setEmail("");
    setPhone("");
    setAddress("");
    setGstin("");
    setStateCode("");
    setNotes("");
    setModalError(null);
    setModal("add");
  }
  function openEdit(c: Customer) {
    setEditId(c.id);
    setName(c.name);
    setEmail(c.email ?? "");
    setPhone(c.phone ?? "");
    setAddress(c.address ?? "");
    setNotes(c.notes ?? "");
    setGstin(c.gstin ?? "");
    setStateCode(c.stateCode ?? "");
    setModalError(null);
    setModal("edit");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setModalError(null);
    const body = {
      name,
      email: email || undefined,
      phone: phone || undefined,
      address: address || undefined,
      notes: notes || undefined,
      gstin: gstin || undefined,
      stateCode: stateCode || undefined,
    };
    try {
      if (modal === "add") await api("/customers", { method: "POST", body });
      else await api(`/customers/${editId}`, { method: "PATCH", body });
      setModal("closed");
      await load();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : "Save failed");
    }
  }

  function toggleActive(c: Customer) {
    const verb = c.isActive ? "Deactivate" : "Reactivate";
    setConfirm({
      title: `${verb} ${c.name}?`,
      message: c.isActive
        ? "They'll be hidden from active pickers. Their record + history stay."
        : "They'll appear in active pickers again.",
      confirmLabel: verb,
      danger: c.isActive,
      action: async () => {
        await api(`/customers/${c.id}`, {
          method: "PATCH",
          body: { isActive: !c.isActive },
        });
        await load();
      },
    });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-baseline justify-between">
        <SectionTitle>
          Customers{" "}
          <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
            ({customers.length})
          </span>
        </SectionTitle>
        {canEdit && <Button onClick={openAdd}>+ Add customer</Button>}
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>
      ) : customers.length === 0 ? (
        <div className={`${cardClass} p-8 text-center`}>
          <div className="text-lg font-black text-[var(--text)]">
            No customers yet
          </div>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            {canEdit
              ? "Add the people you sell to — you can pick them on invoices."
              : "Ask an admin or manager to add customers."}
          </p>
        </div>
      ) : (
        <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
          {customers.map((c) => (
            <div
              key={c.id}
              className={`flex items-start justify-between gap-3 px-4 py-3 ${
                c.isActive ? "" : "opacity-50"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    to={`/customers/${c.id}`}
                    className="text-sm font-bold text-[var(--text)] hover:text-[var(--accent)] hover:underline"
                  >
                    {c.name}
                  </Link>
                  {!c.isActive && (
                    <span className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-[var(--muted)]">
                      INACTIVE
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs font-semibold text-[var(--muted)]">
                  {[c.email, c.phone].filter(Boolean).join(" · ") || "—"}
                </div>
                {c.address && (
                  <div className="text-xs font-semibold text-[var(--muted)]/80">
                    {c.address}
                  </div>
                )}
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-3">
                  <button
                    onClick={() => openEdit(c)}
                    className="text-xs font-bold text-[var(--muted)] hover:text-[var(--accent)]"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => toggleActive(c)}
                    className={`text-xs font-bold text-[var(--muted)]/60 ${
                      c.isActive ? "hover:text-red-500" : "hover:text-emerald-500"
                    }`}
                  >
                    {c.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {modal !== "closed" && (
        <Modal
          title={modal === "add" ? "Add customer" : "Edit customer"}
          onClose={() => setModal("closed")}
        >
          <form onSubmit={submit} className="space-y-4">
            <Field label="Name">
              <Input
                required
                minLength={2}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Email" hint="optional">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>
              <Field label="Phone" hint="optional">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </Field>
            </div>
            <Field label="Address" hint="optional">
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="GSTIN" hint="for B2B invoices">
                <Input
                  value={gstin}
                  placeholder="27AAPFU0939F1ZV"
                  onChange={(e) => {
                    const next = e.target.value.toUpperCase();
                    setGstin(next);
                    // A GSTIN already states the customer's state in its first
                    // two digits. Filling it in saves a step and, more
                    // importantly, stops the two fields from disagreeing.
                    const fromGstin = stateCodeFromGstin(next);
                    if (fromGstin) setStateCode(fromGstin);
                  }}
                />
              </Field>
              <Field label="State" hint="place of supply">
                <Select
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value)}
                >
                  <option value="">Not set</option>
                  {GST_STATES.map((st) => (
                    <option key={st.code} value={st.code}>
                      {st.code} — {st.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Notes" hint="optional">
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
            {modalError && <ErrorAlert>{modalError}</ErrorAlert>}
            <div className="flex justify-end gap-3 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setModal("closed")}
              >
                Cancel
              </Button>
              <Button type="submit">Save</Button>
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
