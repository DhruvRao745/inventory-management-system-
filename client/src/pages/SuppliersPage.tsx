/**
 * Suppliers — vendors we buy stock from. Phase 1 of Suppliers & POs:
 * master data (a contact book). Purchase orders (Phase 2) will link here.
 * Mirrors the Settings Locations/Team patterns: list card, add/edit modal,
 * deactivate via the shared ConfirmModal, role-gated actions.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import type { Supplier } from "../lib/types";
import { useAuth } from "../context/AuthContext";
import { Modal } from "../components/Modal";
import { ConfirmModal } from "../components/ConfirmModal";
import {
  Button,
  Input,
  Field,
  ErrorAlert,
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

export function SuppliersPage() {
  const { user: me } = useAuth();
  const canEdit = me?.role === "ADMIN" || me?.role === "MANAGER";

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  async function load() {
    setError(null);
    try {
      setSuppliers(await api<Supplier[]>("/suppliers"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // --- add / edit modal ---
  const [modal, setModal] = useState<"closed" | "add" | "edit">("closed");
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);

  function openAdd() {
    setEditId(null);
    setName("");
    setEmail("");
    setPhone("");
    setAddress("");
    setNotes("");
    setModalError(null);
    setModal("add");
  }
  function openEdit(s: Supplier) {
    setEditId(s.id);
    setName(s.name);
    setEmail(s.email ?? "");
    setPhone(s.phone ?? "");
    setAddress(s.address ?? "");
    setNotes(s.notes ?? "");
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
    };
    try {
      if (modal === "add") {
        await api("/suppliers", { method: "POST", body });
      } else {
        await api(`/suppliers/${editId}`, { method: "PATCH", body });
      }
      setModal("closed");
      await load();
    } catch (err) {
      setModalError(err instanceof ApiError ? err.message : "Save failed");
    }
  }

  function toggleActive(s: Supplier) {
    const verb = s.isActive ? "Deactivate" : "Reactivate";
    setConfirm({
      title: `${verb} ${s.name}?`,
      message: s.isActive
        ? "They'll be hidden from active pickers. Their record and history stay intact."
        : "They'll appear in active pickers again.",
      confirmLabel: verb,
      danger: s.isActive,
      action: async () => {
        await api(`/suppliers/${s.id}`, {
          method: "PATCH",
          body: { isActive: !s.isActive },
        });
        await load();
      },
    });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-baseline justify-between">
        <SectionTitle>
          Suppliers{" "}
          <span className="font-bold normal-case tracking-normal text-[var(--muted)]/60">
            ({suppliers.length})
          </span>
        </SectionTitle>
        {canEdit && <Button onClick={openAdd}>+ Add supplier</Button>}
      </div>

      {error && <ErrorAlert>{error}</ErrorAlert>}

      {loading ? (
        <p className="text-sm font-bold text-[var(--muted)]">Loading…</p>
      ) : suppliers.length === 0 ? (
        <div className={`${cardClass} p-8 text-center`}>
          <div className="text-lg font-black text-[var(--text)]">
            No suppliers yet
          </div>
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            {canEdit
              ? "Add the vendors you buy stock from — you'll link them to purchase orders next."
              : "Ask an admin or manager to add your vendors."}
          </p>
        </div>
      ) : (
        <div className={`${cardClass} divide-y-2 divide-[var(--line)]/20`}>
          {suppliers.map((s) => (
            <div
              key={s.id}
              className={`flex items-start justify-between gap-3 px-4 py-3 ${
                s.isActive ? "" : "opacity-50"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    to={`/suppliers/${s.id}`}
                    className="text-sm font-bold text-[var(--text)] hover:text-[var(--accent)] hover:underline"
                  >
                    {s.name}
                  </Link>
                  {!s.isActive && (
                    <span className="rounded-[4px] border-2 border-[var(--line)] bg-[var(--panel)] px-1.5 py-0.5 text-[10px] font-black tracking-wide text-[var(--muted)]">
                      INACTIVE
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs font-semibold text-[var(--muted)]">
                  {[s.email, s.phone].filter(Boolean).join(" · ") || "—"}
                </div>
                {s.address && (
                  <div className="text-xs font-semibold text-[var(--muted)]/80">
                    {s.address}
                  </div>
                )}
                {s.notes && (
                  <div className="mt-1 text-xs font-medium italic text-[var(--muted)]/70">
                    {s.notes}
                  </div>
                )}
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-3">
                  <button
                    onClick={() => openEdit(s)}
                    className="text-xs font-bold text-[var(--muted)] hover:text-[var(--accent)]"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => toggleActive(s)}
                    className={`text-xs font-bold text-[var(--muted)]/60 ${
                      s.isActive
                        ? "hover:text-red-500"
                        : "hover:text-emerald-500"
                    }`}
                  >
                    {s.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* add / edit modal */}
      {modal !== "closed" && (
        <Modal
          title={modal === "add" ? "Add supplier" : "Edit supplier"}
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
                <Input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Address" hint="optional">
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </Field>
            <Field label="Notes" hint="optional">
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
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
