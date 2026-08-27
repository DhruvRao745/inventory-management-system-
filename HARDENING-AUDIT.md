# StockPilot — Production Hardening Audit

_Audit date: 27 August 2026 · Against: "Inventory Management System — Production Hardening PRD" (20pp, 16 phases)_

**Status: 🔴 P0 implemented 27 Aug — see "P0 resolution" below. P1–P3 untouched.**

---

## 1. Architecture Summary

### Shape

Single npm-workspaces monorepo, deployed as **one container**.

```
inventory/
├── server/          Express 4 + TypeScript (ESM) + Prisma 6 + PostgreSQL
├── client/          React 19 + Vite + Tailwind v4
├── Dockerfile       builds both; copies client/dist → server/public
└── docker-compose[.prod].yml
```

In production Express serves the API *and* the built React bundle from the same
origin (`app.ts` → `express.static` + SPA fallback). No CORS in prod. Currently
live on Railway with Neon Postgres.

### Server layering

```
routes  →  service  →  prisma
  ↑          ↑
 Zod      business rules
```

- `app.ts` — helmet (CSP allows jsDelivr for barcode libs), CORS, JSON, 13 routers under `/api/*`, error handler last.
- `middleware/auth.ts` — `requireAuth` (JWT verify → `req.user = {userId, companyId, role}`), `requireRole(...)`.
- `middleware/error.ts` — `AppError(status, msg)`, `asyncHandler`, central `errorHandler` (ZodError → 400 field list; unknown → 500, internals hidden in prod).
- `middleware/rateLimit.ts` — IP limiter on all auth routes (100/15min) + per-IP+email login limiter (5 failed/20min, successes skipped).
- `config/env.ts` — Zod-validated env, **fails fast at boot**.

**Module convention** (consistent, worth preserving): `X.routes.ts` (HTTP + Zod parse) → `X.service.ts` (rules, transactions) → `X.schemas.ts` (Zod). Some thin modules (categories, locations, suppliers, customers, company, users, audit, reports) keep logic inline in routes.

### Frontend

18 pages, `AuthContext` holds `{user, company}` from login/`/me`, `ProtectedRoute` gates, `lib/api.ts` wraps fetch with silent token refresh. Neubrutalist design system on CSS variables, light/dark.

### Test infrastructure

Vitest against a **separate** `inventory_test` database. `pretest` runs `prisma db push`. `test/helpers.ts` gives `resetDb()` + `createTestCompany()`. **13 tests in 2 files** — stock service (7) and auth service (5).

---

## 2. Current Database Model

11 models. Every model except `Company` carries `companyId` — the stated "one rule".

```
Company ─┬─ User ──────────┐
         ├─ Location ──────┤
         ├─ Category ── Product ──┬── StockMovement ──┐
         ├─ Supplier ──┬──────────┤                   │
         │             └─ PurchaseOrder ── POLine ────┤
         ├─ Customer ──── Invoice ── InvoiceLine ─────┤
         └────────────────────────────────────────────┘
                                    (all carry companyId)
```

### The ledger (the heart)

`StockMovement` is append-only by convention — no update/delete path exists anywhere in the codebase. Quantity is a **signed Int**; direction is decided server-side by a `DIRECTION` map. Current stock is always `SUM(quantity)` over movements, never stored.

```
MovementType: PURCHASE | SALE | RETURN_IN | RETURN_OUT
            | ADJUSTMENT | TRANSFER_IN | TRANSFER_OUT
```

Transfers = two rows sharing a `transferId`, created in one transaction.

### Money & quantity types

| Field | Type | Note |
|---|---|---|
| `Product.costPrice` / `sellingPrice` | `Decimal(12,2)` | ✅ correct |
| `StockMovement.unitCost` | `Decimal(12,2)?` | captured, **never used for costing** |
| `Invoice.taxRate` | `Decimal(5,2)?` | one generic rate |
| `Invoice.discount` | `Decimal(12,2)?` | flat amount |
| **All quantities** | **`Int`** | ⚠️ no decimal support |

### Indexes and constraints

9 unique indexes, all correctly `(companyId, ...)` scoped — SKU, barcode, invoice number, PO number, user email, category/location/supplier/customer name. Composite indexes on `(companyId, productId, locationId)` and `(companyId, createdAt)` for the hot ledger queries.

**Zero CHECK constraints exist in any of the 12 migrations.** Verified by grep. Every invariant (non-negative stock, non-negative money) lives only in application code.

### Batch/expiry today

`StockMovement.batchNumber` (String?) and `expiryDate` (DateTime?) plus `Product.tracksBatch` (Boolean). These are **loose annotations on movement rows**. There is no batch entity, no remaining-quantity tracking, and nothing consumes them.

---

## 3. Current Inventory Flow

### Stock in — purchase order

```
createPO(DRAFT) → place(ORDERED) → receivePO()
                                      ├─ validate ALL lines first
                                      ├─ per line: StockMovement PURCHASE (+qty, unitCost, ref PO-0001)
                                      ├─ bump POLine.receivedQty
                                      └─ status → PARTIAL or RECEIVED
```

Partial receiving works. Over-receiving is blocked (`r.quantity > remaining`). All inside one `$transaction`.

### Stock out — invoice

```
createInvoice(DRAFT) → issueInvoice()
                          ├─ per line: aggregate on-hand at location
                          ├─ if current − qty < 0 → throw 400
                          ├─ StockMovement SALE (−qty, ref INV-0001)
                          └─ status → ISSUED, issuedAt = now
      → payInvoice()  status → PAID          (flag only, no money recorded)
      → cancelInvoice() ISSUED → RETURN_IN (+qty) per line, status → CANCELLED
```

### Direct movement / transfer

`createMovement()` — ownership check, sign applied server-side, oversell guard inside `$transaction`, then fire-and-forget low-stock notification.

`transfer()` — source check, then TRANSFER_OUT + TRANSFER_IN sharing a `transferId`, one transaction.

### Reads

`stockLevels()` — `groupBy(productId, locationId)` summing quantity, then two lookups for names, `lowStock = quantity <= product.lowStockThreshold`.

---

## 4. Gap Analysis

Format per PRD §Final Instruction: **Requirement | Existing | Problem | Required change | Priority**

### 🔴 P0 — correctness and security

| # | Requirement | Existing implementation | Problem | Required change |
|---|---|---|---|---|
| G1 | **Concurrency-safe deduction** (§4) | `createMovement` / `issueInvoice` / `transfer` do `aggregate → compare → insert` inside `prisma.$transaction` | **The transaction does not prevent this race.** Postgres defaults to READ COMMITTED; `aggregate` is a plain `SELECT` taking no lock, and there is no existing row to lock because we only ever INSERT. Two concurrent sales both read 10, both pass, both insert. **Stock goes negative.** The code comment claims otherwise — it is wrong. | Serialize per `(companyId, productId, locationId)`. Cleanest fit for an append-only ledger: `SELECT pg_advisory_xact_lock(hashtext(key))` at the top of the transaction, or a `StockLevel` cache row locked `FOR UPDATE`, or `isolationLevel: "Serializable"` + retry. Must be applied at **all three** call sites. |
| G2 | **Negative stock impossible** (§21) | Application `if` checks only | No DB-level backstop. Any future code path that forgets the check corrupts the ledger silently. | Add the concurrency guard (G1) **plus** a defensive DB constraint/trigger. Minimum: CHECK constraints on non-negative money and on `quantity <> 0`. |
| G3 | **Secrets** (§3.1) | `.gitignore` correct; `.env` **never committed** (verified via `git log --all`); `.env.example` holds placeholders only | Repo hygiene is **already good** — no leak in git history. But the **live Railway deployment is running `JWT_SECRET=change-me-in-production`**, the literal placeholder. Anyone reading `.env.example` on GitHub can forge a token for any user in any company. Additionally, secrets generated in a chat session earlier today must be treated as compromised. | Rotate `JWT_SECRET` + `JWT_REFRESH_SECRET` on Railway to fresh 48-byte values generated locally. Rotate the Neon password. Document rotation in `SETUP.md`. Remove the `${VAR:-fallback}` dev-password defaults from `docker-compose.prod.yml`. |
| G4 | **Invoice/PO numbering under concurrency** (§21) | `findFirst orderBy number desc` → `+1` | Two concurrent creates compute the same number. The `@@unique([companyId, number])` index prevents duplication but surfaces as an unhandled **P2002 → 500**. | Postgres sequence per company, or advisory lock, or catch P2002 and retry. |
| G5 | **Tenant isolation** (§14) | Consistent `findFirst({id, companyId})` → then act by id. Spot-checked categories, locations, suppliers, customers, users, invoices, POs, products, stock. `assertProducts`/`assertSupplier`/`assertLocation` validate referenced entities too. | **Largely already correct** — the PRD assumes this is broken; it mostly isn't. Genuine gap is **test coverage**: exactly 1 tenant test exists (`stock.service.test.ts:185`). No API-level cross-tenant tests, no test that company A can't attach company B's product to an invoice or supplier to a PO. | Keep the pattern. Add a cross-tenant test matrix across all entity endpoints. Consider Prisma Client Extensions to make `companyId` structurally impossible to omit. |

### 🟠 P1 — core business functionality

| # | Requirement | Existing implementation | Problem | Required change |
|---|---|---|---|---|
| G6 | **Batch inventory model** (§5) | `StockMovement.batchNumber` + `expiryDate` strings; `Product.tracksBatch` flag | No batch entity. System cannot answer *"Product X → Location Y → Batch Z → remaining?"*. Nothing decrements a batch. | New `InventoryBatch` model per PRD §5 with `receivedQuantity`/`remainingQuantity`, unique on `(companyId, productId, locationId, batchNumber)`. Link movements to batches. |
| G7 | **FEFO allocation** (§5) | None | No allocation logic of any kind. | Allocation service: expiry-tracked → FEFO, else FIFO. Must be transactional with G1's lock. Acceptance test: 100@Sep + 100@Dec, sell 120 → 0 and 80. |
| G8 | **Decimal quantities + UOM** (§6) | All quantities `Int`. `Product.unit` is a free-text String | Cannot sell 2.5 kg or 0.75 L. `unit` is decorative — no precision, no conversion. | Migrate quantity columns to `Decimal(18,4)`. Add `precision`, optional `conversionFactor` + base unit. **Widest-blast-radius migration in the PRD** — touches every service, every test, every UI number input, CSV export. |
| G9 | **Weighted-average costing + COGS** (§7) | Single `Product.costPrice`. `StockMovement.unitCost` is *stored but never read* | No moving average, no COGS, no cost-at-time-of-sale. Historical margin silently changes when a new purchase changes cost. | Maintain running average on receipt; stamp `unitCostAtSale` on SALE movements. `unitCost` already exists on the ledger — good foundation. |
| G10 | **Profitability reports** (§7) | `/reports/valuation` uses **current** `costPrice`; `/reports/summary`; top-products | Reports labelled as value/profit are `sellingPrice − current costPrice`. PRD explicitly forbids calling this accounting profit. | Rebuild on COGS from G9. Add gross profit, margin, product-level profitability. |
| G11 | **Payments** (§8) | `InvoiceStatus.PAID` enum flag; `payInvoice()` flips a status | No money is recorded anywhere. No partial payment, no balance, no method, no payment date. Payment state is *inferred from a status field* — explicitly prohibited. | `Payment` model per PRD. Derive `paidAmount`/`balanceAmount`/`paymentStatus`. Overpayment validation. |
| G12 | **Sales returns** (§9) | `cancelInvoice()` writes `RETURN_IN` for the whole invoice | No return document, no partial/item-level return, no reason, no condition, no refund. Cancel-restores-everything is a blunt substitute. | `SalesReturn` + `SalesReturnLine`, states `REQUESTED → APPROVED → RECEIVED → REFUNDED`, condition `sellable/damaged/quarantine`. **Only sellable increases available stock.** |
| G13 | **Goods receipt entity** (§10) | `receivePO()` bumps `POLine.receivedQty` inline | Partial receiving works, over-receiving blocked — genuinely decent. But no receipt document, no rejected/damaged quantity, no batch capture at receipt, no actual-cost-vs-ordered-cost. | `GoodsReceipt` + lines. Capture batch/expiry (feeds G6) and actual cost (feeds G9). |
| G14 | **Supplier returns** (§10) | `RETURN_OUT` movement type exists in the enum, unused by any workflow | No supplier-return document or link back to receiving. | `SupplierReturn` referencing the receipt/PO. |
| G15 | **Location-aware reordering** (§11) | `Product.lowStockThreshold` — a single **company-wide** Int | Exactly the PRD's counter-example: Warehouse A with 2 units and Warehouse B with 100 will not warn, because the check is per product-location row against one global threshold. Also no max, no reorder qty, no per-location preferred supplier. | `ProductLocationSetting` model: min/max/reorderQty/preferredSupplier per `(product, location)`. |
| G16 | **Stock counting** (§12) | None. Only free-form `ADJUSTMENT` movements | No count workflow, no expected-vs-counted variance, no review gate. | `StockCount` + `StockCountItem`, `OPEN → COUNTING → REVIEW → COMPLETED`, completion generates adjustment movements. Never overwrite stock directly. |

### 🟡 P2 — business maturity

| # | Requirement | Existing implementation | Problem | Required change |
|---|---|---|---|---|
| G17 | **Stock statuses / reservations** (§13) | None. On-hand is the only concept | No `Available = On Hand − Reserved`. | PRD warns: implement fully or leave disabled. Recommend **deferring** and shipping nothing user-visible until complete. |
| G18 | **GST structure** (§14) | One `Invoice.taxRate` Decimal. `Product.hsnCode` and `Invoice.customerGstin` exist (added 25 Aug). The printed invoice splits CGST/SGST **in the browser, by halving the rate** | The split is **presentation-only** — the database stores one generic rate. No IGST, no place of supply, no intra/inter-state determination, no per-line taxable value. Print output *looks* GST-compliant while the data model isn't. PRD §14 explicitly cautions against claiming compliance. | Per-line `taxableValue`/`cgst`/`sgst`/`igst`/`rate`. Add `placeOfSupply` + company state; derive intra vs inter. Keep rules in a swappable module. |
| G19 | **Session security** (§13) | Stateless JWT: 15-min access + 30-day refresh, both signed only | Refresh tokens **cannot be revoked**. Nothing stored server-side. No logout, no session list, no revoke-all. A stolen refresh token is valid for 30 days. | `Session`/`RefreshToken` table storing **hashes** only. Endpoints for logout, revoke one, revoke all, list devices. |
| G20 | **Real audit log** (§15) | `/api/audit` **derives** a feed by merging stock movements + PO creations + product/supplier/user `createdAt` | Not an audit table. Cannot record logins, permission changes, payments, cancellations, or before/after values. Anything without a `createdAt` row is invisible. | Dedicated `AuditEvent` table (user, company, action, entity, entityId, metadata, before/after). Keep the derived view as a *read model* over it. |
| G21 | **Trustworthy reporting** (§16) | 3 reports: valuation, movement summary, top products | Missing: stock by batch, expiring, expired, sales by customer, purchases by supplier, outstanding balances (needs G11), COGS/margin (needs G9). | Build after G9/G11 land — most reports are blocked on those. |
| G22 | **Dashboard from transactional data** (§19) | Dashboard calls the same report endpoints — **already derived, not counters** | ✅ Principle already satisfied. Missing metrics are downstream of G9/G11/G6. | Extend once dependencies land. |

### Testing & integrity (cross-cutting)

| # | Requirement | Existing | Problem | Required change |
|---|---|---|---|---|
| G23 | **Concurrency test** (§20) | None | The single most important test in the PRD does not exist. | Stock=10, fire 8 and 7 simultaneously, assert exactly one succeeds and final stock ≥ 0. |
| G24 | **Test coverage** (§20) | 13 tests, 2 files, service-level only | No HTTP-level tests, no role/permission tests, no cross-tenant matrix, no costing/tax/payment/batch unit tests. | Expand per PRD §20 as each phase lands. |
| G25 | **DB constraints** (§21) | 9 unique indexes ✅, sensible composite indexes ✅, **zero CHECK constraints** | Application code is the only safety layer. | Add CHECKs for non-negative money/quantities; unique batch identity with G6. |

### Already satisfied — do not rebuild

Worth stating explicitly, since the PRD says *"do not rebuild working modules without a technical reason"*:

- ✅ Event-sourced ledger with no update/delete path — the PRD's #1 non-negotiable is **already the design**
- ✅ Server-side sign rule (`DIRECTION` map); clients send positive quantities
- ✅ Tenant scoping pattern applied consistently (G5 — tests missing, not logic)
- ✅ Zod validation on every mutating route; env validated at boot
- ✅ Two-layer rate limiting with per-credential bucketing
- ✅ Money as `Decimal`, never float
- ✅ Transfers atomic via paired rows + `transferId`
- ✅ Partial receiving with over-receipt validation
- ✅ Dashboard already derives from reporting queries
- ✅ `.env` never committed; `.gitignore` correct

---

## 5. Implementation Plan (ordered by dependency)

The PRD's suggested A–L ordering is sound. Two deviations, justified below.

### Phase A — Secrets & tenant test coverage `P0` · ~0.5 day

1. Rotate Railway `JWT_SECRET` / `JWT_REFRESH_SECRET` (fresh, locally generated)
2. Rotate Neon password; update `DATABASE_URL`
3. Strip dev-password fallbacks from `docker-compose.prod.yml`
4. Document rotation procedure in `SETUP.md`
5. Cross-tenant test matrix across all entity endpoints

*No schema change. Ships independently. Do this first — it is the only gap currently exploitable in production.*

### Phase B — Concurrency-safe stock engine `P0` · ~2 days ⭐

**The critical phase.** Everything downstream writes to the ledger; if the ledger races, every later feature inherits the bug.

1. Extract a single `applyMovement(tx, …)` chokepoint — all writes funnel through it
2. Add advisory lock keyed on `(companyId, productId, locationId)`
3. Route `createMovement`, `issueInvoice`, `transfer`, `receivePO` through it
4. Fix numbering race (G4)
5. **Write the concurrent test first** (G23) — prove it fails, then fix
6. Add CHECK constraints (G25)

*Blocks: everything.*

### Phase C — Decimal quantities + UOM `P1` · ~2 days

**Moved ahead of batches** (PRD has this at D, after batches at C). Reason: `InventoryBatch` carries `receivedQuantity`/`remainingQuantity`. Building it on `Int` then migrating to `Decimal` means migrating the batch tables too. Doing the numeric widening once, before new quantity-bearing tables exist, is strictly less work.

1. `Int` → `Decimal(18,4)` on all quantity columns
2. `Product.precision` + optional `conversionFactor`
3. Update services, Zod schemas, tests, UI inputs, CSV export

*Depends on B. Widest blast radius — do it while the surface is still small.*

### Phase D — Batch inventory + FEFO `P1` · ~3 days

1. `InventoryBatch` model + unique constraint
2. Link movements to batches
3. FEFO/FIFO allocation inside Phase B's lock
4. Capture batch at goods receipt
5. Acceptance test (100@Sep + 100@Dec, sell 120 → 0/80)

*Depends on B, C.*

### Phase E — Costing + COGS `P1` · ~2 days

1. Weighted-average maintained on every receipt
2. Stamp cost-at-sale on SALE movements
3. Inventory valuation from actual cost
4. COGS / gross profit / margin reports replacing the current `sellingPrice − costPrice` figures

*Depends on B, C, D (batch cost is per-batch). Unblocks G10, G21, G22.*

### Phase F — Payments `P1` · ~1.5 days

`Payment` model, derived balance, partial/over-payment validation, payments UI. *Depends on B. Unblocks outstanding-balance reports.*

### Phase G — Sales returns `P1` · ~2 days

Return document, item-level quantities, condition handling — only `sellable` restocks. Replaces the cancel-restores-all hack. *Depends on B, D, E.*

### Phase H — Purchasing + supplier returns `P1` · ~2 days

`GoodsReceipt` entity, rejected/damaged quantities, batch + actual cost capture, supplier returns. *Depends on B, D, E.*

### Phase I — Location reordering + stock counting `P1` · ~2 days

`ProductLocationSetting` (min/max/reorder/preferred supplier per location); `StockCount` workflow generating adjustments. *Depends on B, D.*

### Phase J — GST restructure `P2` · ~2 days

Per-line tax components, IGST, place of supply, intra/inter determination, modular rule engine. **Until this lands, avoid describing the current output as GST-compliant** — the split is cosmetic. *Depends on C.*

### Phase K — Sessions + real audit log `P2` · ~2 days

`Session` table with hashed refresh tokens, logout/revoke/list. `AuditEvent` table; keep the derived feed as a read model. *Depends on A.*

### Phase L — Reports, dashboard, regression, deploy hardening `P2` · ~2 days

All remaining reports; dashboard extension; full regression; **fix the Railway start-command override so `prisma migrate deploy` actually runs** (see `NOTES.md` battle scar #4 — currently migrations do not run in the container).

### Dependency graph

```
A (secrets, tests) ─────────────────────────┐
                                            │
B (concurrency) ⭐ ──┬── C (decimal) ── D (batch) ── E (costing) ──┬── G (sales returns)
                     │                                            ├── H (purchasing)
                     ├── F (payments) ─────────────────────────────┤
                     └── I (reorder, counts) ─────────────────────┘
                                            │
                     C ── J (GST)           ├──> L (reports, dashboard, regression)
                     A ── K (sessions, audit)┘
```

### Deferred

**G17 (reservations / stock statuses)** — PRD §13 says implement consistently or leave disabled. It touches every availability calculation. Recommend deferring until B–E are stable, and shipping no UI for it before then.

---

## Recommended first move

**Phase A, then Phase B.**

Phase A because it is the only gap an attacker can exploit *today* — the live deployment is signing tokens with a placeholder secret that is published in `.env.example`.

Phase B because the ledger race is the deepest correctness bug, the code comment above it currently asserts the opposite, and every subsequent phase writes through that same path. Fixing it after building batches, costing, and returns means retrofitting locks into five call sites instead of one.

Suggested opening task: **write the failing concurrency test** (stock=10, concurrent 8 and 7). It converts an abstract risk into a red test, and turns Phase B's completion into something objectively verifiable.

---

# P0 Resolution — 27 August 2026

| Gap | Status | Where |
|---|---|---|
| G1 Concurrency-safe deduction | ✅ Fixed | `server/src/lib/locks.ts` + 5 call sites |
| G2 Negative stock impossible | ✅ Fixed | advisory locks + 13 CHECK constraints |
| G3 Secrets | ⚠️ Code fixed, **rotation still on you** | `config/env.ts`, `docker-compose.prod.yml`, `SETUP.md` |
| G4 Numbering race | ✅ Fixed | `lockCounter` in `inv.service.ts`, `po.service.ts` |
| G5 Tenant isolation | ✅ Tests added | `modules/tenant-isolation.test.ts` (14 tests) |
| — Lost update in `receivePO` | ✅ Fixed (found during work, not in audit) | `lockDocument` + atomic increment |

### Evidence

The race was **reproduced**, not assumed. Against the real schema on
PostgreSQL 18, stock 10, simultaneous sales of 8 and 7:

```
WITHOUT lock:  A saw 10 -> SOLD | B saw 10 -> SOLD   FINAL: -5   ❌
WITH lock:     A saw 10 -> SOLD | B saw  2 -> REFUSED FINAL:  2   ✅
```

Also verified: all 13 migrations apply to a fresh database; the parameterised
`pg_advisory_xact_lock(hashtextextended($1::text, 0))` call executes correctly;
`tsc --noEmit` clean on server (37 files) and client.

### Not verified

**The vitest suite has not been executed** — Prisma's engine binaries could not
be downloaded in the environment this work was done in. Tests are written and
typecheck; they have never run. Run `cd server && npm test` before pushing.

### Deliberately not done (P1+)

Batch inventory, FEFO, decimal quantities, costing/COGS, payments, returns,
supplier returns, location reordering, stock counting, reservations, GST
restructure, sessions, real audit table, extended reports.
