/**
 * Advisory locks — the doorman for the stock ledger.
 *
 * WHY THIS FILE EXISTS
 *
 * Our ledger is append-only: current stock is SUM(quantity) over movements.
 * That makes every stock write look like this:
 *
 *     read the sum  →  check it's enough  →  insert a new row
 *
 * Wrapping those three steps in a transaction does NOT make them safe.
 * Postgres runs at READ COMMITTED by default, the read is a plain SELECT
 * that takes no lock, and there is no existing row to lock because we only
 * ever INSERT. So two simultaneous sales both read "10 available", both
 * pass the check, and both write. Stock goes negative.
 *
 * Two cashiers glance at the same shelf, both see 10 items, and both promise
 * 8 to different customers. Putting each cashier in their own "transaction"
 * changes nothing, because neither ever put a hand on the shelf.
 *
 * An advisory lock is Postgres handing out a named key on request. It isn't
 * attached to any table — you invent the name. The first transaction to ask
 * for "stock:<company>:<product>:<location>" gets it; anyone else asking for
 * the same name waits at the counter until the first one commits.
 *
 * `pg_advisory_xact_lock` (note the _xact_) releases automatically when the
 * transaction ends, commit OR rollback. A crashed request can never strand a
 * lock forever, which is exactly the failure mode that makes session-level
 * advisory locks dangerous.
 *
 * TWO RULES THAT MAKE THIS CORRECT
 *
 * 1. EVERY writer must take the lock. A lock only one participant respects
 *    protects nothing. All ledger paths — createMovement, transfer,
 *    issueInvoice, cancelInvoice, receivePO — call lockStock() first.
 *
 * 2. Locks must always be taken in the SAME ORDER. A transfer locks two
 *    keys; a 20-line invoice locks 20. If transaction A grabs key1 then
 *    key2 while B grabs key2 then key1, they wait on each other forever —
 *    a deadlock. So we de-duplicate and SORT the keys before locking.
 *    Sorted order is a total order every caller agrees on, so a cycle is
 *    impossible.
 */
import { prisma } from "./prisma.js";

/**
 * The shape of a Prisma transaction client — same derivation used across the
 * services, so this helper accepts whatever `$transaction` hands the callback.
 */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** One shelf: a product at a location. */
export type StockKey = { productId: string; locationId: string };

/**
 * Options for transactions that take advisory locks.
 *
 * Prisma's default interactive-transaction timeout is 5 seconds. Waiting for
 * a lock now counts against that budget, so under real contention a perfectly
 * healthy request could time out. We give it room.
 */
export const LOCKED_TX_OPTIONS = { timeout: 15_000, maxWait: 10_000 } as const;

/**
 * Serialize access to one or more (product, location) shelves for the rest of
 * this transaction. Call it BEFORE reading the stock level — locking after the
 * read defeats the entire purpose.
 */
export async function lockStock(
  tx: Tx,
  companyId: string,
  keys: StockKey[]
): Promise<void> {
  // Dedupe (an invoice may list the same product twice) and sort (see rule 2).
  const names = [
    ...new Set(
      keys.map((k) => `stock:${companyId}:${k.productId}:${k.locationId}`)
    ),
  ].sort();

  for (const name of names) {
    // hashtextextended() turns our text key into the bigint the lock function
    // wants. Available since Postgres 11. A hash collision between two
    // different keys is harmless: worst case two unrelated shelves briefly
    // queue behind each other.
    //
    // Two casts, both load-bearing:
    //
    //   ${name}::text  tells Postgres the bound parameter is text, so it
    //                  doesn't have to infer the type.
    //
    //   ...::text      pg_advisory_xact_lock() returns `void` (type OID 2278),
    //                  and Prisma's deserializer has no mapping for it — it
    //                  throws "Failed to deserialize column of type 'void'".
    //                  Casting the result to text hands it an ordinary column
    //                  it can read. The value is discarded; only the lock
    //                  matters.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}::text, 0))::text AS locked`;
  }
}

/**
 * Serialize a per-company counter — invoice and PO numbers.
 *
 * Without this, two simultaneous creates both read "highest number is 7" and
 * both try to write 8. The unique index catches it, but surfaces as an
 * unhandled P2002 → 500. Queueing turns a crash into a wait.
 */
export async function lockCounter(
  tx: Tx,
  companyId: string,
  name:
    | "invoice"
    | "purchase-order"
    | "sales-return"
    | "goods-receipt"
    | "supplier-return"
    | "stock-count"
): Promise<void> {
  const key = `counter:${name}:${companyId}`;
  // ::text on the result — see the note in lockStock about void deserialization.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))::text AS locked`;
}

/**
 * Serialize weighted-average costing for a product (P1-3).
 *
 * WHY THIS ISN'T COVERED BY lockStock
 *
 * `lockStock` is keyed on (company, product, LOCATION) — right for the ledger,
 * because stock levels are per location. But the weighted average is
 * **company-wide**: one `avgCost` and one `stockValue` per product, across
 * every shelf.
 *
 * So two sales of the same product at two DIFFERENT locations take two
 * different stock locks, sail past each other, and then both read-modify-write
 * the same `Product.avgCost`. One update is lost and the average is wrong from
 * then on — with no error, and no way to tell later which figure was right.
 *
 * Hence a second key, on (company, product) only.
 *
 * ORDERING: callers take stock locks FIRST, then cost locks. Always that way
 * round, so two transactions can never hold one and queue for the other in
 * opposite directions.
 */
export async function lockCost(
  tx: Tx,
  companyId: string,
  productIds: string[]
): Promise<void> {
  const names = [...new Set(productIds.map((p) => `cost:${companyId}:${p}`))].sort();
  for (const name of names) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${name}::text, 0))::text AS locked`;
  }
}

/**
 * Serialize work on ONE document.
 *
 * Needed wherever we read a document's own counters, decide something from
 * them, then write them back — the classic lost update. Receiving against a
 * purchase order is the case in point: two simultaneous receipts both read
 * `receivedQty = 0`, both compute `0 + 5`, and the order ends up recording 5
 * received instead of 10.
 *
 * Take this BEFORE validating, so the validation and the write see the same
 * state.
 */
export async function lockDocument(
  tx: Tx,
  kind:
    | "purchase-order"
    | "invoice"
    | "sales-return"
    | "supplier-return"
    | "stock-count",
  id: string
): Promise<void> {
  const key = `doc:${kind}:${id}`;
  // ::text on the result — see the note in lockStock about void deserialization.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))::text AS locked`;
}
