/**
 * ConfirmModal — a styled replacement for the browser's native window.confirm().
 * Consistent with the app's neubrutalist look, and it runs the confirmed
 * action itself so it can show a busy state and surface errors inline
 * (no more alert() popups).
 */
import { useState } from "react";
import { Modal } from "./Modal";
import { Button, ErrorAlert } from "./ui";
import { ApiError } from "../lib/api";

export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm font-semibold text-[var(--muted)]">{message}</p>
      {error && (
        <div className="mt-3">
          <ErrorAlert>{error}</ErrorAlert>
        </div>
      )}
      <div className="mt-5 flex justify-end gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant={danger ? "danger" : "primary"}
          onClick={handleConfirm}
          disabled={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
