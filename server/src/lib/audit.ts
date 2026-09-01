/**
 * Audit logging (P2-6, PRD §15).
 *
 * "Every important action must be traceable."
 *
 * WHY THE WRITE IS INSIDE THE CALLER'S TRANSACTION
 *
 * `recordAudit` takes a transaction client and writes through it, so the audit
 * row commits with the thing it describes — or neither does.
 *
 * The alternative, logging asynchronously so a failure can never disturb real
 * work, sounds safer and is worse. It makes the trail best-effort, and an
 * audit log with gaps is not a weaker audit log; it is an unusable one. A gap
 * is indistinguishable from nothing having happened, so a single missing entry
 * poisons every conclusion drawn from the whole table — including the
 * conclusion that someone did nothing wrong.
 *
 * And the gaps would not be random. Writes fail under load, during incidents,
 * when the database is struggling — exactly the periods anyone would later
 * want to reconstruct.
 *
 * The cost is real and worth naming: a failed audit write rolls back the
 * business operation. That is the trade, chosen deliberately.
 *
 * WHAT ISN'T LOGGED HERE
 *
 * Stock movements. The ledger is already append-only and never edited — it IS
 * an audit trail, and a better one than this. Duplicating it would double
 * writes on the hottest path and bury the entries that matter.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import type { Tx } from "./locks.js";

/**
 * The actions worth recording. A union rather than free-text so a typo
 * ("payment.recorded" vs "payment.record") can't quietly split one action into
 * two that no query will ever join back together.
 */
export type AuditAction =
  // access
  | "login"
  | "login.failed"
  | "logout"
  | "password.change"
  | "session.revoke"
  // people and permissions
  | "user.create"
  | "user.role_change"
  | "user.deactivate"
  | "user.reactivate"
  // master data
  | "product.create"
  | "product.update"
  | "product.deactivate"
  | "supplier.update"
  | "customer.update"
  | "company.update"
  // money and documents
  | "invoice.issue"
  | "invoice.cancel"
  | "payment.record"
  | "return.approve"
  | "return.refund"
  | "po.receive"
  | "supplier_return.send"
  // inventory decisions (the ledger records the movement; this records the
  // DECISION and who made it)
  | "stock.reclassify"
  | "stock_count.complete"
  /**
   * Correcting a product's weighted-average cost.
   *
   * Needed when a purchase was recorded at the wrong unit cost. The movement
   * rows are NOT edited — they record what was entered at the time, and that
   * remains true even though the figure was a mistake. What gets corrected is
   * `avgCost`/`stockValue`, which are maintained current state rather than
   * history.
   *
   * It is logged because a valuation that changes with no name and no reason
   * attached is indistinguishable from tampering.
   */
  | "stock.revalue";

export type AuditEntry = {
  companyId: string;
  userId?: string | null;
  actorEmail?: string | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  summary?: string;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Fields never worth writing down, and one that must never be. */
const REDACTED = new Set([
  "passwordHash", // never, under any circumstances
  "password",
  "tokenHash",
  "refreshToken",
  "updatedAt", // noise: changes on every write, tells you nothing
  "createdAt",
]);

/**
 * Strip secrets and noise before anything is stored.
 *
 * `passwordHash` is the one that matters. A "user.update" entry carrying a
 * before/after of the password hash would put credentials in a table that
 * exists to be read widely during investigations — the audit log would become
 * the softest target in the system.
 *
 * Decimals become strings rather than numbers: JSON has no decimal type, and a
 * price silently becoming 49.99999999 in the audit trail would undermine the
 * one thing the trail is for.
 */
export function sanitise(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Prisma.Decimal) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitise);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED.has(k)) continue;
      out[k] = sanitise(v);
    }
    return out;
  }
  return value;
}

/**
 * Reduce before/after to the fields that ACTUALLY CHANGED.
 *
 * Storing whole rows makes every entry look alike and forces a reader to
 * diff by eye. "sellingPrice: 50 → 500" is the entry someone needs; the other
 * nineteen unchanged fields are what hides it.
 */
export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b = (sanitise(before ?? {}) ?? {}) as Record<string, unknown>;
  const a = (sanitise(after ?? {}) ?? {}) as Record<string, unknown>;

  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};

  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    // JSON comparison — good enough for the scalar fields this deals with,
    // and it treats 5 and "5" as different, which for a price is correct.
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      changedBefore[key] = b[key] ?? null;
      changedAfter[key] = a[key] ?? null;
    }
  }

  return { before: changedBefore, after: changedAfter };
}

/**
 * Record an action inside the caller's transaction.
 *
 * Pass the SAME `tx` the operation is using. Passing the global client instead
 * would write the audit row outside the transaction, and it would survive a
 * rollback — leaving the log asserting that something happened which didn't.
 */
export async function recordAudit(
  client: Tx | typeof prisma,
  entry: AuditEntry
): Promise<void> {
  await client.auditLog.create({
    data: {
      companyId: entry.companyId,
      userId: entry.userId ?? null,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      summary: entry.summary ?? null,
      before:
        entry.before === undefined
          ? undefined
          : (sanitise(entry.before) as Prisma.InputJsonValue),
      after:
        entry.after === undefined
          ? undefined
          : (sanitise(entry.after) as Prisma.InputJsonValue),
      ipAddress: entry.ipAddress ?? null,
      userAgent: entry.userAgent ?? null,
    },
  });
}

/**
 * Record a change, storing only what differs.
 *
 * Returns without writing when nothing changed — a "user pressed save and
 * altered nothing" entry is pure noise, and enough of them make the log
 * something people stop reading.
 */
export async function recordChange(
  client: Tx | typeof prisma,
  entry: Omit<AuditEntry, "before" | "after"> & {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }
): Promise<void> {
  const diff = diffFields(entry.before, entry.after);
  if (Object.keys(diff.after).length === 0) return;

  await recordAudit(client, { ...entry, before: diff.before, after: diff.after });
}

/**
 * Log a security event OUTSIDE any transaction — the one exception.
 *
 * A failed login has no business transaction to join, and must be recorded
 * even though the request it belongs to ends in an error. Its own try/catch
 * exists so that a logging failure can never turn a 401 into a 500 and tell an
 * attacker they found something interesting.
 */
export async function recordSecurityEvent(
  entry: AuditEntry
): Promise<void> {
  try {
    await recordAudit(prisma, entry);
  } catch {
    /* never let audit failure change what the caller sees */
  }
}
