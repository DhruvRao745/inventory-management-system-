# StockPilot — Project Notes

_Last updated: 27 August 2026_

Multi-tenant inventory management SaaS ("build once, sell to many businesses").
Live at: **https://server-production-2c406.up.railway.app** (Railway + Neon).
Repo: private GitHub (`DhruvRao745`), auto-deploys to Railway on push to `main`.
⚠️ Not ready to share — see the checklist at the end of the Deployment section.

---

## ✅ Done

### Backend (Express + TypeScript + Prisma + PostgreSQL)

- **Auth**: company registration (company + admin + default location in one
  transaction), login, JWT with 15-min access + 30-day refresh tokens
  (silent renewal), `/auth/me`, deactivated users locked out on refresh.
- **Multi-tenancy**: every table carries `companyId`; every query is
  tenant-scoped — including lookups by id (cross-tenant = 404).
- **Products**: CRUD with per-company unique SKUs, soft delete (retire),
  category assignment, search/filter, **pagination (take/skip + total)**.
- **Categories**: CRUD; safe hard-delete (products become uncategorized).
- **Locations**: list/create/edit; default location per company.
- **Stock ledger** (the heart): immutable movements, server-side sign rule,
  oversell guard **serialized by Postgres advisory locks** (a transaction alone
  did NOT make this safe — see the 27 Aug P0 section), transfers as linked twin
  rows, per-location levels with low-stock flags. No update/delete — corrections
  are compensating entries.
- **Users/team**: invite with role (ADMIN/MANAGER/STAFF), change role,
  deactivate; admins can't demote/deactivate themselves.
- **Company settings**: rename + currency (schema migration #2).
- **Reports**: stock valuation (cost/retail + totals), movement summary
  by date range (timezone-safe: client sends ISO instants),
  **top-products by period** (powers dashboard chart).
- **Security**: bcrypt, Zod validation everywhere, identical
  invalid-login messages, two-layer rate limiting (100/15min per IP on
  auth; 10 failed/15min per IP+email on login, successes don't count).
- **Tests**: 34 vitest integration tests against a separate
  `inventory_test` DB — sign rule, oversell, transfer atomicity, auth flows,
  **concurrency** (7) and a **cross-tenant isolation matrix** (14).
  `npm test` from root.
- **Deployment**: Dockerfile (single-stage; prisma runs from `server/`),
  `docker-compose.prod.yml` (project name `inventory-prod` to avoid dev
  collision), `migrate deploy` on container start, seed script
  (`demo@demo.com` / `demo1234` — seeded on live DB too).

### Frontend (React + TypeScript + Vite + Tailwind v4)

- **Design system**: neubrutalism (2px borders, solid offset shadows,
  press-down buttons) on **CSS-variable tokens** (`index.css`) —
  light + dark themes, persisted toggle, **circular-reveal animation**
  (View Transitions API) from the slide ThemeSwitch.
- **Colors**: light accent blue `#2d8cf0` / dark accent silk blue
  `#60a5fa`; action buttons ink `#323232` (light) via separate
  `--btn`/`--btn-text` tokens; **functional color system** — per-section
  nav hues, per-metric stat card crowns, per-movement-type chip colors,
  hash-assigned category colors.
- **Shell**: collapsible sidebar (persisted), thin line icons,
  transparent nav with colored active bar, **live low-stock badge**
  (60s poll), h-screen scroll architecture, mobile drawer.
- **Auth pages** (SIGNED OFF by senior ✅): split layout with
  Sign in/Sign up tabs, floating live-styled product mini-cards with
  colored shadows, gradient canvas (off-white→blue light /
  midnight dark), notched labels, password eye, demo quick-fill box.
- **Dashboard v2**: stat cards with honest month-over-month trends
  (double summary call), top-sellers bars, movements-by-type bars,
  stock-by-location SVG donut, low-stock alerts (clickable),
  recent activity, "+ Record movement" CTA.
- **Products page**: paginated table with **On hand** column,
  red-tinted low-stock rows with ⚠, search + category filter,
  add/edit/retire modals, category manager.
- **Stock page**: movement form (adapts fields to type), transfer card
  + modal, history table with colored type chips and CSV export.
- **Reports page**: valuation + movement summary tables, CSV downloads.
- **Settings**: company card, locations, team management (role-aware UI).
- **Product detail**: per-location stock, full movement history.

### Documents

- `Inventory-PRD.docx` — product requirements doc (sent to senior).
- `README.md` — setup, structure, architecture decisions.

## 🔄 In progress / awaiting review

- **Auth redesign**: SIGNED OFF by senior, committed. ✅
- **Dashboard v2 + Products page upgrades**: built and working locally,
  **uncommitted** — awaiting senior's verdict.
- **Deploy of the redesign**: the live site still runs the pre-redesign
  build. Next `git push` ships everything.

## 📌 Key decisions (and why)

1. **PERN over MERN** — stock is transactional/relational; ACID matters.
2. **Event-sourced stock** — quantities never stored, always summed from
   immutable movements → audit trail, no drift.
3. **Single DB multi-tenancy** via `companyId` row scoping (+ defense in
   depth: tenant filter even on primary-key lookups).
4. **Soft delete only for referenced data** (products); hard delete OK
   for unreferenced (categories).
5. **Decimal for money**, never float.
6. **Server owns movement signs** — clients send positive quantities.
7. **Short access + refresh tokens** over 7-day tokens.
8. **Per-credential rate limiting** (IP+email) so one user's typos can't
   lock an office sharing one IP (Mr. Rao's catch).
9. **Design tokens as CSS variables** — dark mode and rebrands are
   one-line changes; two position/text-color utilities on one element
   is forbidden (caused 2 bugs).
10. **Adapt references, never copy** — Kezak/Tasky/HRMS/Invendor
    contributed layouts and features, tokens stayed ours.
11. **One page at a time** — UI changes scoped to current page;
    Mr. Rao (with senior) is the sign-off gate.
12. **Timezone rule** — browser converts local dates to ISO instants;
    server never guesses.
13. **No dead buttons** — features ship with their backends (Google
    login parked in V2 for this reason).

## 🐛 Battle scars (bugs survived, lessons kept)

- UTC-vs-IST report bug (caught by Mr. Rao comparing expected numbers).
- Docker compose project-name collision deleted the dev DB container.
- `health-postgres` container squatting port 5432; container recreated
  without published ports (`--force-recreate`).
- Prisma EPERM on Windows (stop dev server + Studio before generate).
- Workspace bin not hoisted in Docker (run prisma from `server/`).
- Utility-clash pair: sidebar switch positioning, invisible button text.

## 🧩 Onboarding
- `SETUP.md` (added) — collaborator local-setup guide. Key point: each dev runs
  their OWN local Postgres (Docker `docker compose up -d`); schema from Prisma
  migrations, demo data from `prisma db seed` (demo@demo.com / demo1234).
  `server/.env` is git-ignored → collaborator copies it from `.env.example`.
  Never share Render production DB creds.

## 🔜 Next

1. Senior's verdict on Dashboard v2 → commit or adjust.
2. Products page verdict → commit.
3. ✅ Deployed — Railway + Neon (see Deployment section).
4. **Blockers before handing the URL to anyone** (see Deployment):
   rotate JWT secrets, fix `CLIENT_ORIGIN`, resolve the start-command override.
5. Remaining page-by-page queue: Stock (history filters?), Reports
   (sales-over-time chart?), Settings/Product detail (light polish).
6. Render dropped — free tier expired. Replaced by Railway + Neon.

### V2 backlog (build when customers ask)

Suppliers/POs · low-stock email/WhatsApp alerts · barcode scanning ·
batch/expiry tracking · invoicing · audit log viewer · searchable
product pickers (500+ SKUs) · Google sign-in · subscription billing ·
custom domain + paid hosting before first real customer.

---

## Invoice redesign + business details (25 Aug)

Reworked the printed invoice (`InvoiceDetailPage.printInvoice`) from a plain
text layout into a professional bordered document, and added the company/buyer
data it needs to look official.

**New DB fields** (migration `20260825120000_add_business_details`):
- `Company`: `address`, `phone`, `email`, `gstin`, `pan`, `sealText` — all optional.
- `Invoice`: `customerGstin` — buyer's GST snapshot for B2B invoices.

⚠️ **Run once locally to apply:** `cd server && npx prisma migrate dev` (this
also regenerates the Prisma client). Until then, `tsc` shows 2 expected errors in
`inv.service.ts` about `customerGstin` — they're purely the stale generated client,
not real bugs; they vanish after generate. Same class of issue as Shivaay's `tx` error.

**Wiring:**
- `company.routes.ts` — GET + PATCH now carry the new fields; blank string → null
  (so a cleared field prints nothing). Shared `companySelect` so GET/PATCH can't drift.
- `auth.service.ts` — added a `publicCompany()` helper used by register/login/getMe,
  so the company object (with business details) rides along on every auth response.
  The invoice reads company from context — no extra request.
- `AuthContext.Company` type + `Invoice` type gained the new fields.
- Settings page: a "Business details" block under Company (address, phone, email,
  GSTIN, PAN, seal text). GSTIN/PAN auto-uppercase.
- Invoice form: a "Customer GSTIN" field.

**The printed invoice now has:**
- Big "INVOICE" wordmark top-left; a scannable **Code128 barcode** of the invoice
  number top-right (same jsbarcode pattern as the product labels — their scan station
  reads it). Chose a barcode over the reference's QR because their scanner already
  reads Code128.
- **From / Bill To** two-column block: seller (name, address, phone, email, GSTIN, PAN)
  and buyer (name, address, phone, GSTIN). Blank lines are omitted, not printed empty.
- Meta strip (date, location, colored status pill).
- Item table with row numbers, zebra striping, unit next to qty.
- A generated round **rubber-stamp seal** (double blue border, rotated, "For <company>"
  / "Authorised Signatory") — text customizable via the `sealText` setting. No image
  upload needed.
- Boxed totals with the grand total inverted (white on dark).

**Decisions:**
- **Aadhaar deliberately left out.** It's sensitive personal ID; UIDAI discourages
  printing it publicly. PAN + GST are the correct/expected business IDs on an invoice.
- **Logo deferred** — needs image upload/hosting (this project has none set up). Seal
  is generated from text instead, so it shipped now.
- HTML-escaping added on all free-text (was missing before — a product named with a
  `<` would have broken the print). Print fires from `window.onload` after the barcode
  renders, matching the product-label popup pattern.

Client `tsc` clean. Server `tsc` clean except the 2 stale-client errors noted above.

## GST tax-invoice format (25 Aug, same day, second pass)

User shared a real dealer invoice (Vedika Automobiles / Revolt) and wanted "this
type". Rebuilt the print again into a **fully-bordered Indian GST tax invoice**.
Adapted the *format*, not the vehicle-specific columns (chassis/motor/battery/
colour/variant don't map to generic products).

**New DB fields** (migration `20260825140000_gst_invoice_fields`):
- `Product.hsnCode` — HSN/SAC tax code, printed per line.
- `Company.invoiceTerms` — T&C text (one per line), printed on every invoice.

✅ **Applied.** Both `20260825120000_add_business_details` and
`20260825140000_gst_invoice_fields` are live locally and on Neon (see Deployment
section below).

**Wiring:** product schema/form gained `hsnCode` (input next to Description);
invoice line `include` selects it; Settings gained an "Invoice terms & conditions"
textarea; `Company.invoiceTerms` flows through `companySelect` + `publicCompany` like
the other business fields.

**The printed invoice now matches the reference:**
- Full outer border with ruled cells throughout.
- Company name + address top-left, Code128 barcode of the invoice no. top-right.
- Seller detail grid (Phone / GSTIN / Email / PAN) in `label : value` rows.
- Centered `* Tax Invoice *` band.
- Two-column customer / invoice-meta block (name, address, phone | GSTIN, no., date,
  location, status).
- Item table with **Sr. / Item / HSN / Qty / Rate / Amount**.
- **CGST + SGST split** — the single tax rate shown as two half-rate lines (intra-state
  GST norm), plus a **Round off** line to the nearest rupee.
- **Amount in words** (new `amountInWords()` helper — Indian lakh/crore numbering,
  currency-aware: Rupees/Paise, Dollars/Cents, etc.).
- **Terms & Conditions** numbered list (from the `invoiceTerms` setting, with a default).
- **Signature blocks**: Customer Signature (left) | company name + generated round seal
  + Authorised Signatory (right).
- "Thank you for your business" footer.

`amountInWords` lives at module scope in `InvoiceDetailPage.tsx` (ONES/TENS →
twoDigits → threeDigits → integerToWords with crore/lakh/thousand, + a currency-word map).

Client + server `tsc` both clean.

## Deployment — Railway + Neon (25 Aug)

Render's free tier expired, so the whole thing moved. New stack:

| Piece | Where | Why |
|---|---|---|
| App (API **and** React) | Railway, one service | Dockerfile builds both; Express serves `client/dist` |
| Postgres | Neon (serverless free tier) | Railway's own Postgres isn't free |

**Live URL:** `https://server-production-2c406.up.railway.app`
**Railway project:** `eloquent-clarity` / environment `production` / service `server`

### One service, not two
Railway auto-detected the npm workspaces and offered to create **two** services
(`server` + `client`). Deleted `client`. Correct call — the Dockerfile already does:

```dockerfile
RUN ... npm run build && cp -r client/dist server/public
```

and `app.ts` serves it in production (`express.static` + SPA fallback to
`index.html`). One container, same origin, no CORS in prod.

### Environment variables (Railway → Variables)
- `DATABASE_URL` — Neon string. **Pooling OFF** (needed for migrations).
  Dropped `&channel_binding=require`; kept `?sslmode=require`.
- `JWT_SECRET`, `JWT_REFRESH_SECRET`
- `CLIENT_ORIGIN` — only used for CORS; prod is same-origin so it's near-cosmetic.
- `PORT=8080` — **set explicitly.** See below.

### 🐛 Battle scars from this deploy

**1. "Unexposed service" — deployed but no front door.**
Railway built and ran the container but never generated a public domain, so
"Online" meant nothing was reachable. Fix: Settings → Networking → Generate
Domain. (It generated *two* domains; deleted the spare.)

**2. Port mismatch.** Railway's generated domain routes to **8080**; `env.ts`
defaults `PORT` to **5000**. Rather than rely on whether Railway injects its own
`PORT`, set `PORT=8080` explicitly as a service variable. Deterministic.

**3. Login returned 500, not 401.** Misleading, and the diagnosis order matters:
`/api/health` returns a hardcoded literal and `/` serves a static file — *neither
touches the database*. Login was the first real Prisma query. The 500 was
`P2021: table does not exist`.
→ **Rule of thumb: an empty DB gives 401. A schema-less DB gives 500.**

**4. Migrations never ran in the container.** Running `migrate deploy` from the
laptop applied all **12** migrations fresh — proving the container's `CMD`
(`prisma migrate deploy && node dist/index.js`) is not executing. Suspicion:
Railway auto-set a **Custom Start Command** that overrides the Dockerfile `CMD`.
The *build* clearly ran (frontend is served), only the start command was replaced.
**⚠️ UNRESOLVED — the next schema change will silently not apply and 500s will
return.** Check Settings → Deploy → Custom Start Command and clear it.

**5. `$env:DATABASE_URL` leaks into the whole PowerShell window.** Set it to seed
Neon, then any `npm run dev` started in that *same* window connects to Neon —
which looks exactly like "my local data vanished." It hadn't. Safer one-liner:

```powershell
$env:DATABASE_URL="postgres://neon..."; npx prisma db seed; Remove-Item Env:DATABASE_URL
```

Also worth knowing: `prisma db seed` **deletes and rebuilds the demo company**
(scoped to `demo@demo.com`'s `companyId` — other companies are untouched). Its
cleanup deletes products but **not** invoices, so once real invoices exist it will
fail on an FK constraint. Don't re-run it casually after handover.

### Deploy workflow from here

- **Code change** → `git push origin main` → Railway rebuilds automatically.
- **Schema change** → locally `npx prisma migrate dev --name x`, commit the
  generated `prisma/migrations/<...>/` folder, push. The container is *supposed*
  to run `migrate deploy` on boot — see battle scar #4 first.
- **Never** run `migrate dev` against Neon; it can reset the DB. Production gets
  `migrate deploy` only.

### ⚠️ Open before sharing the URL
- [ ] `JWT_SECRET` / `JWT_REFRESH_SECRET` are still `change-me-in-production`.
      Anyone knowing them can forge a token for any user in any company.
      Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- [ ] `CLIENT_ORIGIN` still points at the placeholder `stockpilot-xxxx.railway.app`.
- [ ] Battle scar #4 (start-command override).
- [ ] Verify an invoice prints against Neon — proves the GST columns really landed.

**Jio/DNS note:** `*.up.railway.app` is DNS-blocked by some Indian ISPs (hit this
on Shivaay). If the senior can't reach it, it's not the app — switch DNS to
`8.8.8.8`, or attach a custom domain.

## P0 production hardening (27 Aug)

Senior supplied a 20-page "Production Hardening PRD" (16 phases). Audited the
repo against it first — see `HARDENING-AUDIT.md` for the full gap matrix.
Implemented **P0 only**; P1 deliberately untouched.

### 🔴 The real bug: the ledger race

`stock.service.ts` carried this comment:

> "We check and write inside ONE transaction so two simultaneous sales can't
> both pass the check and together oversell the shelf."

**That was wrong.** Postgres defaults to READ COMMITTED, `aggregate` is a plain
SELECT taking no lock, and there is no existing row to lock because the ledger
only ever INSERTs. Two concurrent sales both read 10, both pass, both write.

Reproduced against the real schema on Postgres 18 — **stock 10, simultaneous
sales of 8 and 7, final stock −5.** With the fix: one sells, one gets a clean
400, final stock 2.

The same pattern existed in `issueInvoice` and `transfer`.

### The fix — `server/src/lib/locks.ts`

Transaction-scoped **advisory locks** keyed `stock:<company>:<product>:<location>`.
Chosen because an append-only ledger has no row to `SELECT … FOR UPDATE`, and
`Serializable` would force retry loops on every caller.

Three things that make it correct:

1. `pg_advisory_xact_lock` (note `_xact_`) releases on commit **or rollback** —
   a crashed request can't strand a lock.
2. Keys are **deduped and sorted**, so a 20-line invoice and an opposing
   transfer acquire overlapping keys in the same order → no deadlock.
3. **Every** writer takes it. A lock one path ignores protects nothing.
   All five paths route through it: `createMovement`, `transfer`,
   `issueInvoice`, `cancelInvoice`, `receivePO`.

Also raised the Prisma transaction timeout to 15s — lock waiting now counts
against the default 5s budget.

### Other P0 items

- **Numbering race (G4)** — `findFirst desc → +1` let two creates compute the
  same number; the unique index turned it into an unhandled P2002 → 500. Now
  serialized by a `counter:` advisory lock.
- **Lost update in `receivePO`** — found during implementation, not in the
  audit. Two concurrent receipts both read `receivedQty` from one snapshot and
  one update vanished. Fixed with a `doc:` lock + atomic `{ increment }`.
- **13 CHECK constraints** (`20260827000000_p0_integrity_constraints`) — the
  DB-level backstop. No `schema.prisma` change, so no client regeneration.
- **Secrets (G3)** — `.env` was never committed (verified via `git log --all`);
  repo hygiene was already fine. The real exposure was the **live deployment
  running `JWT_SECRET=change-me-in-production`**, the literal value published in
  `.env.example`. `env.ts` now refuses to boot in production on a placeholder,
  a secret under 32 chars, or both secrets being equal. `docker-compose.prod.yml`
  swapped `${VAR:-fallback}` for `${VAR:?message}`. Rotation documented in
  `SETUP.md`.
- **Tenant isolation (G5)** — service code was **already correct** and
  consistent; the gap was tests. Added a 14-test cross-tenant matrix.

### Tests added

`concurrency.test.ts` (7) — PRD acceptance case, 10-way contention, transfer
overdraw, opposing-transfer deadlock check, invoice oversell, per-product
parallelism, numbering.
`tenant-isolation.test.ts` (14) — stock/invoice/PO/product cross-tenant matrix.
`resetDb()` extended — it was missing invoices, POs, suppliers and customers,
so anything touching them leaked between tests.

### 🐛 Battle scar: `void` and `$queryRaw`

First test run: **27 of 34 failed**, all with

> Failed to deserialize column of type 'void'

`pg_advisory_xact_lock()` returns `void` (type OID **2278**) and Prisma's
result deserializer has no mapping for it. The lock SQL was written with
`$executeRaw` (correct — it discards results), then changed to `$queryRaw`
on the reasoning that "this is a SELECT, and `$executeRaw` is for statements
with an affected-row count". That reasoning was fine in the abstract and
wrong in practice: `$queryRaw` deserializes, and there was nothing valid to
deserialize.

Fix: cast the result — `pg_advisory_xact_lock(...)::text AS locked` — which
returns OID 25 (text). The value is discarded; only the lock matters.

Verified against a live Postgres afterwards: column type is 25, a second
transaction genuinely **blocks** while the first holds the lock, the lock
releases on both COMMIT and ROLLBACK, and sorted multi-key acquisition works.

Lesson: don't "improve" untested code on abstract reasoning. Either test the
change or leave the working version alone.

### ⚠️ Verification status — read before trusting this

Both `tsc` runs are clean (37 server files). Migrations verified: all 13 apply
to a fresh Postgres. Lock mechanism verified empirically (race reproduced, fix
proven). Prisma's parameterised lock call verified against a live server.

✅ **34/34 tests passing** (4 files, ~4s) — verified on Mr. Rao's machine
27 Aug. Run 1: 27 failed on the `void` bug above. Run 2 after the `::text`
fix: all green.

Also verified: all 13 migrations apply to a fresh database; the lock genuinely
blocks a competing transaction and releases on both COMMIT and ROLLBACK;
`tsc --noEmit` clean on server (37 files) and client.

The oversell race is now proven dead by test, not by argument:
`concurrency.test.ts` fails if stock ever goes negative.

```bash
cd server && npm test    # 34 passed
```

## P1-1: Batch inventory + FEFO (27 Aug)

First of nine P1 features. `HARDENING-AUDIT.md` has the full P1 queue.

### What it solves
The ledger says "200 units here". For perishables that isn't enough: if 100
expire in September and 100 in December and you ship the December ones first,
the September ones rot. `InventoryBatch` gives units an identity;
`batch.service.ts` decides which ones leave.

### Schema
- `InventoryBatch` — lot per (company, product, location, batchNumber), with
  `receivedQuantity` / `remainingQuantity` as `Decimal(18,4)`.
- `StockMovementBatch` — which lots one movement drew from.
- `enum BatchStrategy { FEFO, FIFO }` + `Product.batchStrategy` (default FEFO).

**Quantities are Decimal(18,4) from birth**, so the P1-2 decimal migration only
has to convert the *legacy* Int columns — no table gets migrated twice. This is
how PRD phase order (batch before decimal) was kept without doing the work
twice.

### Three decisions
1. **A movement stays ONE row.** Selling 120 across two lots could have been
   two SALE rows, but that changes `createMovement`'s return shape and breaks
   the client. Instead: one movement + child `StockMovementBatch` rows holding
   the split. `SUM(quantity)` is still the stock level.
2. **Batch tracking stays opt-in** via the existing `Product.tracksBatch`.
   Forcing it on would mean inventing batches for all existing stock — a
   migration with no correct answer. Untracked products behave exactly as before.
3. **FEFO orders `expiryDate ASC NULLS LAST`.** The nulls part is load-bearing:
   SQL defaults NULLs *first* on ASC, which would ship never-expiring stock
   ahead of stock expiring next week — precisely backwards. Verified in SQL.

### How it sits on P0
Allocation reads `remainingQuantity`, decides a split, writes it back — the
exact read-then-write shape that caused the oversell bug. It is safe **only
because it runs inside `lockStock`**, whose key (company, product, location) is
a batch's identity minus its number. No new lock needed, but the ordering is
load-bearing: callers must not move allocation outside the lock.

Three layers of defence, same as P0: advisory lock → conditional
`updateMany(remainingQuantity >= take)` → CHECK constraints.

### Verified in sandbox
- FEFO ordering: `SEP -> DEC -> NOEXPIRY` ✅ (nulls genuinely last)
- Constraints reject: negative remaining, remaining > received, expiry before
  manufacture, zero-quantity allocation ✅
- Decimal exactness: `100 - 0.1 - 0.2 = 99.7000` ✅ (no float drift)
- Client `tsc` clean ✅

### ⚠️ Server tsc: 28 errors until the client is regenerated
Every one is `inventoryBatch` / `stockMovementBatch` / `batchStrategy` "does
not exist on PrismaClient" — the stale-client class. Zero errors of any other
kind (checked). They clear after:

```bash
cd server
npx prisma migrate dev --name batch_inventory_fefo   # creates migration + regenerates client
npx tsc --noEmit
npm test
```

The hand-written `20260827120000_p1_batch_constraints` migration adds the CHECK
constraints and must sort AFTER the generated one — it does, by timestamp.

### ✅ Verified — 49/49 passing (27 Aug)
Local run green after `migrate dev` regenerated the client.

### 🐛 Battle scar: migration ordering vs the shadow database
The hand-written constraints migration was timestamped to sort after the
batch-table migration — but the batch-table migration **did not exist yet**.
`migrate dev` replays every existing migration on a shadow DB *before*
generating the new one, so `ALTER TABLE "InventoryBatch"` ran against a
database where that table had never been created:

    P3006 / P1014 — The underlying table for model `InventoryBatch` does not exist

No timestamp can fix that; a migration cannot reference a table that no
earlier migration creates. Fix: park the constraints file, let Prisma generate
the table migration, then re-add the constraints as
`20260827010000_p1_batch_constraints` (after both the tables at
`20260826200037` and the P0 constraints at `20260827000000`).

**Rule: hand-written migrations that ALTER a Prisma-managed table must be
added only AFTER the migration creating that table exists on disk.**

Verified by replaying all 15 migrations against an empty database — clean, 19
CHECK constraints total.

### ⚠️ Known gap: CHECK constraints are NOT exercised by the test suite
`pretest` runs `prisma db push`, which builds the test database from
`schema.prisma` alone and **never executes migration files**. Prisma cannot
express CHECK constraints, so none of the 19 exist in `inventory_test`.

Consequence: the tests pass, but they have never touched the DB-level backstop.
A regression that removed a constraint would go unnoticed. The constraints
themselves are known-good (verified directly against Postgres), but they are
unverified *by the suite*.

Fix when convenient: point `pretest` at `prisma migrate reset --force
--skip-seed` so the test DB is built from migrations like production is.

### Tests added (15)
`batch.service.test.ts` (all passing) — PRD acceptance case (100@Sep + 100@Dec, sell 120 →
0/80), nulls-last, FIFO mode, three-batch span, refusal leaves ledger AND batch
untouched, re-receive tops up, batch-number required on intake, untracked
products unaffected, batch total always equals ledger total, allocation
recording, transfer carries expiry across, cancel returns to original lots,
invoice issue allocates FEFO, and concurrent sales can't over-allocate.


## P1-2: Decimal quantities + UOM (27 Aug)

Second of nine P1 features. The widest-blast-radius change in the PRD.

### What it solves
Money has always been `Decimal` here for the obvious reason. Quantities had the
same problem the moment you stock anything by weight: sell 0.1 kg three times
from a 1 kg bag using JS numbers and the bag holds **0.7000000000000001 kg —
forever**. Nothing errors, no test fails, and every report inherits the lie.

### Schema
`Int` → `Decimal(18,4)` on five columns:
`StockMovement.quantity`, `InvoiceLine.quantity`, `PurchaseOrderLine.quantity`,
`PurchaseOrderLine.receivedQty`, `Product.lowStockThreshold`.

New on Product: `precision Int @default(0)`, `packUnit String?`,
`unitsPerPack Decimal?`.

Batch tables were already `Decimal(18,4)` (built that way in P1-1 on purpose),
so **nothing gets migrated twice**.

### The key decision: precision is PER PRODUCT
`Decimal(18,4)` says the DATABASE can hold four places. It says nothing about
whether a product SHOULD. You cannot sell half a stapler, and 0.333333 kg of
rice leaves dust in the ledger that can never be sold or counted.

So `Product.precision` decides: 0 for staplers, 3 for rice. Enforced in
`lib/quantity.ts` — **not** in Zod, because Zod validates the request before we
know which product it's for. Errors name the unit ("Blue Pen is counted in
whole pcs") rather than saying "at most 0 decimal places", which is meaningless
to someone at a counter.

### Wire format change ⚠️
Quantities now cross the API as **strings**, exactly like `costPrice` already
did. `client/src/lib/format.ts` gained `qtyNum()` and `formatQty()`; all 8
pages converted. Number inputs moved from `step="1"` to `step="any"` — the
browser accepts decimals, the server decides whether this product may have them.

### Integration with P0/P1-1
No new locking. Every rewritten comparison stayed inside the advisory-lock
transaction it was already in — `current.plus(signed).isNegative()` replaces
`current + signed < 0` and nothing moved. Batch allocation already spoke
Decimal, so `planAllocation` needed no change at all.

### Verified in sandbox
- All 15 existing migrations replay clean ✅
- The `Int → Decimal` change applied over EXISTING data: `100` → `100.0000`,
  no loss ✅
- P0 CHECK constraints survive the type change and still bite ✅
- `2.5 + (-0.1) = 2.4000` exact in Postgres ✅
- Client `tsc` clean (0 errors) ✅

### ⚠️ Server tsc: 40 errors until the client is regenerated
All the stale-client class — Prisma still types `quantity` as `number`. Same
situation as P1-1. Clears after:

```bash
cd server
npx prisma migrate dev --name decimal_quantities_uom
npx tsc --noEmit
npm test
```

### Tests added (14, unrun)
`decimal-quantity.test.ts` — the 0.1×3 float trap, string quantities arriving
unmangled, 20 small movements without drift, fractional oversell still refused,
whole-unit products rejecting fractions, precision limits, a rejected line
leaving NO invoice behind, fractional invoice totals (2.5 × ₹33.33), and a
fractional `lowStockThreshold`.

Existing tests updated: `getStockLevel()` returns Decimal now, so assertions
wrap it in `Number()`.


## P1-3: Weighted-average costing + COGS (27 Aug)

Third of nine P1 features. This is the one that makes the profit numbers mean
something.

### What was wrong
One `Product.costPrice` — whatever someone last typed. Reports multiplied stock
by it and called it "value"; `sellingPrice − costPrice` was called "profit".
Change `costPrice` today and **every historical margin silently changes with
it**. A March sale, at a real cost actually paid, would suddenly report a
different profit because April's delivery was dearer.

### The rule that drives the design
PRD §7: *"The historical cost used for a completed sale must not change simply
because a later purchase changes the average cost."*

Satisfied **structurally**, not by discipline: the average in force is stamped
onto the movement row as `costAtTime` at the instant of sale. Movements are
append-only, so that number cannot be rewritten. COGS is a sum over rows that
already hold their own answer.

### Schema
- `Product.avgCost Decimal(18,6)` — running weighted average
- `Product.stockValue Decimal(18,4)` — total value on hand
- `StockMovement.costAtTime Decimal(18,6)?` — the cost applied to this movement

### Three decisions
1. **Average is company-wide per product**, not per location — matches the
   PRD formula and makes transfers cost-neutral. Moving your own stock between
   your own shelves doesn't change what it cost you, so transfers skip costing
   entirely.
2. **`Decimal(18,6)` for unit cost**, vs `(12,2)` for money. ₹100 over 3 units
   is 33.333333; rounding to paise on every receipt compounds into real drift.
3. **Cancellations restore the ORIGINAL cost**, not today's average. Otherwise
   undoing a sale would conjure profit — the books would gain value from
   nothing happening.

### 🔑 New lock: `lockCost` (company-wide per product)
`lockStock` is keyed (company, product, **location**). `avgCost` is
**company-wide**. So two receipts of the same product at two DIFFERENT
locations take different stock locks, sail past each other, and both
read-modify-write the same `Product.avgCost` — one update lost, average wrong
forever, no error.

Hence a second key on (company, product). **Ordering rule: stock locks first,
then cost locks, everywhere** — so two transactions can never hold one and
queue for the other in opposite directions. There's a test for it.

### Reports
`/reports/valuation` now uses `avgCost`, not `costPrice`.
New `/reports/profitability?from&to` — revenue, COGS, gross profit, margin,
plus per-product rows. COGS comes from the **ledger**, not the invoices.

### 🐛 Battle scar: made the P1-1 migration mistake again
Wrote `20260828000000_p1_costing_constraints` referencing `Product.avgCost`
before any migration creates that column. The sandbox replay caught it
(`column "stockValue" does not exist`) rather than Mr. Rao hitting P3006 —
but the lesson from P1-1 should have prevented writing it at all.

**Standing rule, now twice-learned:** a hand-written migration that ALTERs a
Prisma-managed table can only be added AFTER the migration creating that
column exists on disk. Park it, run `migrate dev`, then re-add with a later
timestamp.

### Verified in sandbox
- All 16 migrations replay clean ✅
- Parked constraints apply correctly once the columns exist ✅
- Negative `stockValue` and `avgCost` both rejected ✅
- Client `tsc` clean ✅
- Server `tsc`: 53 errors, **all** stale-client class, zero of any other kind ✅

### Tests added (16, unrun)
`costing.test.ts` — the PRD formula (10@100 + 10@120 → 110), selling doesn't
move the average, 6-dp precision, value never negative, **a sale keeps its cost
after a later dearer purchase**, COGS across two averages, invoice sales
stamped, gross profit/margin, cancellation restoring original cost, adjustment
at current average, transfers cost-neutral, and the concurrent-receipt test
that fails without `lockCost`.


## P1-4: Profitability reports UI (27 Aug)

Fourth of nine. Mostly wiring — the `/reports/profitability` endpoint landed
with P1-3; this gives it a screen.

`ReportsPage` gained a **Profitability** section above Sales: four cards
(Revenue / COGS / Gross profit / Margin), a per-product table sorted by profit,
and CSV export. Gross profit is colour-coded — a product sold below cost shows
red, which is the whole point of having the number.

The section carries a one-line caption explaining that COGS comes from the cost
recorded at the moment of each sale. Without it, a reader reasonably assumes
it's `sellingPrice − costPrice` like the old figures were, and the PRD is
explicit (§7) that those must not be labelled accounting profit.

### 🔑 Real bugs surfaced once the Prisma client was regenerated
With the client finally in sync, `tsc` stopped hiding behind stale-type noise
and found **8 genuine Decimal errors left over from P1-2** — sites where a
`Decimal` was still being used as a JS number:

- `audit.routes.ts` — `m.quantity > 0` in the activity feed
- `report.routes.ts` — `Math.abs(s.quantity)` in sales-per-day; PO ordered vs
  received totals; invoice subtotal; per-line revenue share; `p.units +=`
- `product.schemas.ts` — CSV import couldn't set `precision`, so an imported
  spreadsheet of goods sold by weight would land as whole-units-only and then
  reject every fractional movement, with no obvious cause

**Lesson:** while the generated client is stale, `tsc` output is nearly
useless for finding real problems — the signal drowns in expected noise. Worth
running `prisma migrate dev` and a clean `tsc` immediately after each schema
change rather than at the end.

Both `tsc` runs now clean: **server 0 errors, client 0 errors.**


## P1-5: Payments (27 Aug)

Fifth of nine. Before this, "paid" was a flag someone flipped — no record of
how much arrived, when, or by what means. A half-paid invoice could not be
represented at all, and "who still owes us money?" had no answer the system
could give.

### The rule (PRD §8)
*"Do not infer payment state only from a status field."*

Payment state is now **derived from payment rows**. `Invoice.status` still
reads PAID, but as a *consequence* of the arithmetic — kept in step by
`syncInvoiceStatus`, deliberately one-directional. Payments decide the status,
never the reverse.

### Schema
`Payment` (amount, method, paymentDate, reference, notes, createdBy) +
`PaymentMethod` enum (CASH / UPI / CARD / BANK_TRANSFER / OTHER).

Every invoice now exposes the four figures §8 asks for: `totalAmount`,
`paidAmount`, `balanceAmount`, `paymentStatus`.

### Decisions
1. **`lib/money.ts` is new, to avoid a circular import.** `payment.service`
   needs the invoice total; `inv.service` needs the payment summary. Each
   importing the other is the kind of cycle that "works" until module load
   order shifts and something is `undefined` at runtime. Both functions are
   pure, so both services import downward from a shared leaf. `grandTotal`
   moved there and is re-exported from `inv.service` so reports don't churn.
2. **Overpayment is refused on the way in, but REPORTED if found.** A report
   that quietly said PAID over an existing overpayment would hide a refund the
   business owes someone.
3. **Payments are deletable; stock movements are not.** Deliberate asymmetry.
   A stock movement records a physical event that genuinely happened, so it's
   corrected by a compensating entry. A payment that was never received didn't
   happen at all — leaving a phantom ₹5,000 to be cancelled by a phantom
   −₹5,000 makes the customer's statement harder to read, not easier.
4. **`payInvoice` is no longer a flag flip** — it records a real payment for
   the full balance. Kept so existing UI works.

### Integration with P0
Recording a payment is read-balance → check → insert: the oversell shape
again. Two people recording the last ₹600 of a ₹1,000 invoice simultaneously
would both see ₹600 outstanding and both be allowed. Reuses
`lockDocument(tx, "invoice", id)` from P0 — no new lock needed.

### ✅ Applied the migration lesson BEFORE being bitten
`_pending_p1_payment_constraints.sql` is parked outside `migrations/` from the
start, with a comment explaining why. Third time this pattern has come up
(P1-1 hit it, P1-3 hit it, P1-5 avoided it).

### Tests added (19, unrun)
`payment.service.test.ts` — the four figures, PARTIAL state, accumulation to
PAID, status following the money, overpayment refusal (single, cumulative, and
once-paid), DRAFT/CANCELLED rejection, paid invoices no longer cancellable,
delete un-paying an invoice, outstanding balances, **two simultaneous payments
cannot together overpay**, and the pure summary maths.

### Status
Client `tsc` clean. Server `tsc`: 19 errors, all stale-client (`Payment` not in
the generated client yet).

### UI (built — P1-5 is now complete per PRD §25)
PRD §25 says a feature is done only when "UI supports the workflow", so a
tested API nobody can reach doesn't count.

**`InvoiceDetailPage`** — a Payments panel on any ISSUED/PAID invoice: the
three figures (total / paid / balance), a colour-coded status pill, a
record-payment form (amount, method, optional reference), and the payment
history with a Remove button for mistyped entries.

The form only appears while a balance is actually outstanding. The server
refuses overpayment either way, but a form that's always present invites an
error rather than preventing one.

**`ReportsPage`** — an Outstanding customer balances section: total owed, plus
a per-invoice table linking straight to each invoice. Deliberately NOT tied to
the date range — an unpaid invoice is unpaid regardless of the window you're
looking at.

Also fixed: `tenant-isolation.test.ts` called `payInvoice` with the old
two-argument signature.

Both `tsc` runs clean — server 0, client 0.


## P1-6: Sales returns (27 Aug)

Sixth of nine.

### What was wrong
The only way to reverse a sale was cancelling the whole invoice, which restored
every line in full. A customer returning 2 of 10 items had **no representation
at all**, and there was no concept of goods coming back broken — so anything
returned went straight into sellable stock and the shop would confidently try
to sell it again.

### The rule (PRD §9)
*"Only sellable returned stock should increase available stock."*

### Schema
`SalesReturn` + `SalesReturnLine`, `SalesReturnStatus`
(REQUESTED → APPROVED → RECEIVED → REFUNDED, plus CANCELLED),
`ReturnCondition` (SELLABLE / DAMAGED / QUARANTINE).

### Four decisions
1. **`restock` is a decision, but a constrained one.** The PRD asks for a
   "restocking decision" AND says only sellable increases stock. Both hold if
   you may decline to restock good goods but may never restock broken ones.
   Enforced in Zod, again in the service, and by a CHECK constraint:
   `restock = false OR condition = 'SELLABLE'`.
2. **Damaged/quarantine goods generate NO stock movement.** They're recorded on
   the return document with their condition but stay out of the ledger, because
   they aren't available to sell. Inventing a "damaged bucket" now would be
   faking P2's inventory statuses — PRD §13 warns specifically against
   half-implementing that, and a bucket nothing can draw from is worse than an
   honest absence.
3. **Stock moves at RECEIVED, not REQUESTED.** A customer *saying* they'll send
   something back is not goods on your shelf; treating it as such would let
   anyone inflate stock by filing return requests.
4. **Refund is recorded, not paid.** `Payment` rows are positive by CHECK
   constraint — a refund isn't a negative payment, it's a different business
   event. The return records the decision and amount; building a refund ledger
   is beyond what §9 asks for. **Flagged as a known limitation.**

### Cumulative return validation
The over-return check spans **every** non-cancelled return against the invoice,
not just the current one. Without that, a customer could send back 10 of 10
items three times over. Cancelled returns release their quantity again.

### Integration with P0/P1
- `lockDocument(invoice)` on create — two simultaneous returns would otherwise
  each see the same "already returned" figure and together exceed what was sold.
  There's a test.
- `lockStock` then `lockCost` on receive, in that order (the P1-3 rule).
- Returned stock comes back at the **original sale's `costAtTime`**, not
  today's average — otherwise a return after a dearer purchase would conjure
  value out of a customer's change of mind.
- Batch-tracked goods return to their original lots via `restoreAllocationsOf`,
  so a return can't launder September-expiry stock into December-expiry stock.

### ✅ Verified — 122/122 tests passing, both `tsc` runs clean
The 3 `implicitly any` cascades did clear with the regenerated client, as
suspected (they came from `prisma.salesReturnLine` not existing).

Constraints landed as `20260827060000_p1_return_constraints`. **Note the
timestamp:** Prisma generated `20260827055526_sales_returns`, which sorts AFTER
the earlier constraint files (000000–030000). Ordering is by folder name across
the WHOLE directory, so the new file had to be later than 055526 — not merely
later than the other constraint migrations.

Verified against real Postgres: 22 migrations replay clean, 26 CHECK
constraints, and the rule of this feature holds at DB level —
`restock = true` with `condition = 'DAMAGED'` is **rejected**, while
sellable+restock and damaged+no-restock are both allowed.

### Tests added (26, all passing)
`return.service.test.ts` — sellable restocks, **DAMAGED and QUARANTINE do
not**, damaged still recorded on the document, refusing to restock damaged
goods, declining to restock sellable ones, mixed returns restocking only the
sellable part, partial returns, cumulative over-return refusal, cancelled
returns releasing quantity, the full status flow with stock moving only at
RECEIVED, DRAFT/CANCELLED invoice rules, a rejected line leaving no document
behind, cost-at-original-price, and two simultaneous returns not exceeding what
was sold.

### UI — built (see the UI catch-up entry below)


## UI catch-up: Returns + Batches screens (27 Aug)

Two finished backend features had no way in. PRD §23 lists both as required
screens and §25 says a feature is done only when the UI supports the workflow,
so this closes both rather than letting the gap grow.

### `ReturnsPage` (`/returns`)
List with status filter, plus the whole workflow inline: **Approve → Mark
received → Record refund**, and Cancel while it's still just a request.

The raise-a-return modal asks the server what's still returnable
(`GET /returns/returnable/:invoiceId`) rather than guessing from the invoice —
the server knows about earlier returns, and a form offering 10 units when only
3 remain would just produce a rejection.

**The rule is enforced in the UI as well as the server**: choosing DAMAGED or
QUARANTINE flips *Restock* off and disables it, so nobody can submit a
combination the API will refuse. The page also carries a plain-language line
saying stock only returns on *received*, and only the sellable part — otherwise
someone reasonably assumes a received return means stock is back.

Per-line condition badges are colour-coded on the list (green/red/amber) with
a tooltip saying whether that line was restocked.

### `BatchesPage` (`/batches`)
Read-only view of live lots, **nearest expiry first — the same order FEFO
consumes them**, so the top of the list is literally what goes out next.

Filters: product (batch-tracked only), location, expiry window (7/30/90 days),
and "show used-up lots". Three summary cards: lot count, how many expire within
30 days, and value at cost.

Expiry badges are coloured by *urgency, not an arbitrary scale* — already
expired is red (a loss that has happened), ≤7 days orange (still actionable),
≤30 amber, beyond that green. Non-expiring lots say so explicitly rather than
showing a blank.

If no product is batch-tracked yet, the page says so and points at the
**Track batches** toggle rather than showing an unexplained empty table.

### Wiring
Routes in `App.tsx`; nav entries in `Layout.tsx` with two new icons —
**Batches** next to Stock, **Returns** next to Invoices, grouped with what
they relate to.

Client `tsc` clean. API response shapes verified against the server rather than
assumed (`/locations` returns a bare array; `/products` and `/stock/batches`
return `{items,total}`).

### P1 status: 6 of 9 complete, all with UI
Remaining: goods receipt + supplier returns, location-aware reordering, stock
counting.


## P1-7: Goods receipt + supplier returns (27 Aug)

Seventh of nine. PRD §10's flow: `PO → Goods Receipt → Inventory`, plus the
reverse path `Received Stock → Supplier Return → Stock Decrease`.

### What was missing
Receiving worked but left **no document** — you couldn't say "this pallet
arrived Tuesday, three were broken, and the supplier charged more than
quoted". The only trace was a bumped `receivedQty` counter. And there was no
supplier-return path at all: `RETURN_OUT` had been sitting unused in the
MovementType enum since day one.

### Schema
`GoodsReceipt` + `GoodsReceiptLine` (acceptedQty / rejectedQty /
actualUnitCost / rejectReason / batch fields).
`SupplierReturn` + `SupplierReturnLine` + `SupplierReturnStatus`
(DRAFT → SENT → COMPLETED, plus CANCELLED).

### Four decisions
1. **Only ACCEPTED goods enter stock.** Rejected goods are recorded so the
   supplier can be chased, but never become inventory — the mirror of P1-6's
   sellable rule.
2. **`receivedQty` counts accepted only.** 10 arrive, 3 rejected → you've
   received 7 and still need 3. A broken unit doesn't fulfil an order. The PO
   stays PARTIAL, which is the honest answer.
3. **Actual cost moves the weighted average, not the quoted price.** If the
   supplier charged ₹25 against a ₹20 quote, the stock is worth ₹25 —
   otherwise every valuation rests on a quote nobody honoured.
4. **Stock leaves at SENT, not DRAFT.** A draft return is a plan, not a
   dispatch; deducting for a plan would leave the shelf lying about itself.

### Non-breaking refactor
`receivePO` now creates a `GoodsReceipt` as part of the same transaction, and
returns `{ ...po, receipt }`. The PO shape is unchanged at the top level, so
existing callers and the UI keep working — they just get a document alongside.

### Integration
- `lockCounter("goods-receipt")` and `lockCounter("supplier-return")` for the
  new per-company sequences.
- `lockDocument("supplier-return")` on send.
- `lockStock` then `lockCost`, in that order (the P1-3 rule).
- Supplier returns run the same oversell guard as sales, and allocate batches
  via `planAllocation` — stock physically leaving has to come from real lots.

### Status
Client `tsc` clean. Server `tsc`: 25 errors, **all** stale-client, zero of any
other kind (checked).

`_pending_p1_receipt_constraints.sql` parked, with a note that its timestamp
must be later than the generated migration — the trap hit in P1-6 where
Prisma's folder sorted after the earlier constraint files.

### Tests added (21, unrun)
`supplier-return.service.test.ts` — receipts as documents, **rejected goods
recorded but not stocked**, rejected goods not fulfilling the order, actual
cost moving the average (and falling back to quoted), RETURN_OUT written on
send, stock decreasing only at SENT, oversell refusal, the goods-receipt
reference PRD §10 asks for, return value defaulting to carried cost, the full
status flow, and cross-tenant isolation on both new entities.

### ⚠️ No UI yet
Goods receipts and supplier returns have no screens. PRD §23 lists both
("Goods receiving", "Returns"). Same position P1-6 was in before its UI landed.


## P1-8: Location-aware reordering (27 Aug)

Eighth of nine.

### The bug, straight from PRD §11
`/reports/reorder` did `groupBy({ by: ["productId"] })` — summing stock across
**every** location, then comparing the total against one company-wide
threshold:

    Warehouse A: 2 units   Warehouse B: 100 units   minimum: 10
    → total 102 → "plenty of stock" → no warning

Warehouse A is empty and the staff there have nothing to sell. **A company
total tells you nothing about the shelf someone is standing at.**

Verified the bug existed before fixing it, rather than taking the PRD's word.

### Schema
`ProductLocationSetting` — min / max / reorderQuantity / preferredSupplier per
(product, location). **Every field optional**, each falling back to the
product-level default, so nothing changes for anyone who hasn't set a rule.
That's what makes this additive rather than a migration of everyone's data.

### How much to order (priority order)
1. `reorderQuantity` — a fixed size, for suppliers who sell by the pallet
2. `maxQuantity − onHand` — top the shelf back up to full
3. `2 × min − onHand` — the old heuristic, when nothing better is known

Never below one unit: "order 0.4" helps nobody.

### Decisions
- **A zero minimum means "don't track here."** Otherwise every product at
  every location appears the moment it hits zero, burying the shelves that
  genuinely need attention.
- **Preferred supplier can differ per location** — a northern warehouse may
  buy from a different local depot than a southern one.
- **Max below min is rejected** at 400. It would ask for a negative order,
  which would surface as a mystifying suggested quantity of "1".
- **`/reports/reorder` now delegates** to the new service rather than being
  left as a second, still-broken implementation. `/api/reorder` is canonical;
  the old path is an alias so existing callers don't break.

### UI
The Reports reorder table now has a **Location** column, shows
`minimum / maximum`, and badges shelves with their own rule as `OWN RULE`.
Rows are keyed per shelf, and "Draft PO" tracks per shelf too — a product can
legitimately appear twice.

### Status
Client `tsc` clean. Server `tsc`: 16 errors — stale-client plus the usual
`implicitly any` cascades from `prisma.productLocationSetting` not existing
yet. Expect them to clear after `migrate dev`; **worth confirming rather than
assuming** (they did clear in P1-6).

### Tests added (17, unrun)
`reorder.service.test.ts` — **the PRD §11 case** (2 + 100 with a minimum of 10
must still warn about A), one row per short shelf, location filter, emptiest
first, per-location minimum overriding the default, fallback behaviour, zero
meaning don't-track, all three order-size rules, the one-unit floor,
per-location supplier override, upsert-not-duplicate, max-below-min rejection,
delete reverting to default, and cross-tenant rejection.


## P1-9: Stock counting (27 Aug) — P1 COMPLETE

Ninth of nine.

### The rule (PRD §12)
*"Never silently overwrite system stock."*

Completing a count writes **ADJUSTMENT movements**, so a correction is an event
with a person and a time attached. A stocktake that quietly rewrote the numbers
would destroy the audit trail that makes the ledger worth having — "the
computer says 47" with no explanation is exactly what an inventory system
exists to prevent.

### Schema
`StockCount` + `StockCountItem`, `StockCountStatus`
(OPEN → COUNTING → REVIEW → COMPLETED, plus CANCELLED).

### ⭐ The decision that matters: delta, not overwrite
This only shows itself when stock moves while people are counting.

Count 95 against an expected 100, then a genuine sale of 5 before anyone
completes:

| Approach | Ledger ends at | Correct? |
|---|---|---|
| Set stock **to** the count (95) | 95 | ❌ shelf holds 90 — the sale is erased |
| Apply the **variance** (−5) | 90 | ✅ |

A count measures a **discrepancy at a point in time**. Applying it as a delta
preserves whatever legitimately happened since — which is why
`expectedQuantity` is snapshotted when the sheet is prepared rather than
re-read at the end. There's a test for exactly this.

### Other decisions
- **`variance` is NOT stored**, though §12 lists it as a field. It's exactly
  `counted − expected` — two columns in the same row. A third stored value can
  only ever disagree with the two it derives from. Computed on read; the
  deviation is documented in the schema.
- **`countedQuantity` is nullable.** "Nobody has looked yet" is a different
  state from "counted zero", and conflating them loses real information.
- **A matching line writes nothing.** There's no event to record when reality
  agreed with the system, and zero-quantity movements would bury the real
  corrections.
- **Zero-stock products are off the sheet by default.** A sheet listing 2,000
  products the shop never carried is a sheet nobody finishes. A *named*
  product is included even at zero — "confirm there are none" is legitimate.
- **REVIEW is a hard gate.** Adjustments can't be applied straight from
  counting; someone has to look at the variances first.

### Permissions
Entering figures is floor work — any signed-in user. Preparing a sheet and
**applying the adjustments** are decisions: ADMIN/MANAGER only.

### Status
Server `tsc`: 24 errors, all stale-client / `implicitly any` cascades, zero of
any other kind. `_pending_p1_count_constraints.sql` parked with the
timestamp-ordering note.

### Tests added (21, unrun)
`count.service.test.ts` — sheet snapshotting, zero-stock skipping, named
products at zero, variance computed and null-until-counted, **negative and
positive adjustments**, matching lines writing nothing, **the sale-during-count
test**, stock value at current average, every workflow gate, zero as a valid
count, cancellation touching nothing, and cross-tenant isolation.

---

# 🏁 P1 COMPLETE — all nine features

| # | Feature | API | UI | Tests |
|---|---|---|---|---|
| 1 | Batch inventory + FEFO | ✅ | ✅ | 15 |
| 2 | Decimal quantities + UOM | ✅ | ✅ | 14 |
| 3 | Weighted-average costing + COGS | ✅ | — | 15 |
| 4 | Profitability reports | ✅ | ✅ | — |
| 5 | Payments | ✅ | ✅ | 18 |
| 6 | Sales returns | ✅ | ✅ | 26 |
| 7 | Goods receipt + supplier returns | ✅ | ✅ | 21 |
| 8 | Location-aware reordering | ✅ | ✅ | 17 |
| 9 | Stock counting | ✅ | ✅ | 21 |

**Still open generally:** `pretest` uses `db push`, so none of the ~34 CHECK
constraints exist in the test database — the suite cannot catch a constraint
regression.

---

# Deployment resolved

Committed and pushed; Railway deployed from GitHub and came up green. Three
things were settled in the process:

**Nothing secret leaked.** `.gitignore` covered `.env` from the start — only
`.env.example` (placeholders) was ever tracked. Worth confirming rather than
assuming, because the cost of being wrong is a credential rotation.

**Neon was never the dev database.** Every `prisma migrate dev` in this project
ran against local Postgres; `DATABASE_URL` in `server/.env` points at
`localhost:5432`. So the schema work and the production database had silently
drifted 28 migrations apart.

**The container started, and that meant nothing.** Railway reported "Active /
Online" while the API threw `P2022 — column does not exist` on stock, products,
and reports. The process booting only proves the process booted. A green
deployment badge is not a working system, and if the health check doesn't touch
the database, it will happily report health while every real endpoint 500s.
Fixed by running `prisma migrate deploy` against Neon and putting it in the
start command so it can't silently not-run again.

---

# UI for P1-7 and P1-9

## The bug found on the way in

Three call sites double-encoded their request bodies:

```ts
api("/returns", { method: "POST", body: JSON.stringify({...}) })
```

`api()` already does `JSON.stringify(options.body)`, so this produced
`JSON.stringify(JSON.stringify(obj))` — a quoted *string*, not an object.
`express.json()` runs strict by default and rejects a non-object at the top
level, so **raising a sales return, recording a refund, and recording an
invoice payment were all broken in the browser**. Verified empirically with a
throwaway express harness: double-encoded → HTTP 400, single → HTTP 200.

The lesson is about where the tests aren't. All 181 tests call service
functions directly — they never cross HTTP, so the request body is never
encoded at all. Every one of them passed while three user-facing actions were
dead. **A green suite only covers the seams it actually crosses**; the
client↔server boundary was invisible to it, which is precisely why the bug
survived two features and a deployment.

## StockCountsPage

Three rules the design enforces, each protecting the count from a different
failure:

**The expected figure stays hidden until REVIEW.** Show someone "expected: 47"
beside an empty box and a fair number will write 47 without walking to the
shelf. The count then agrees with the system perfectly and has measured
nothing — worse than skipping it, because now the wrong number carries
confidence.

**Blank ≠ zero.** Empty means nobody looked; `0` means someone looked and the
shelf was empty. `countedQuantity` is nullable for exactly this reason, so the
sheet shows a running "12 of 40 counted" and highlights untouched rows.

**Completing is honest about moving stock.** The confirm lists every
discrepancy and says how many adjustments will be written, because completing
is a ledger event, not a save.

**Backend left strict, deliberately.** `submitForReview` already refused to
advance with uncounted lines. The lenient behaviour was considered and
rejected: the UI now disables Submit and names the outstanding count instead of
relaxing a server guard to suit a screen. `completeCount` still filters nulls
defensively — belt and braces at the layer that writes.

## ReceivingPage — two tabs

**Deliveries** are read-only. A goods receipt is created by receiving against a
purchase order and never standalone; a freehand delivery form would be a way to
conjure stock from nothing. The columns emphasise **accepted** (the only
quantity that entered stock) and **actual unit cost** (what moved the average —
not always what was quoted).

**Returns to supplier** are raised *from a delivery*, which is how "which
shipment was this from?" gets an answer at all (PRD §10). The screen repeats
one thing: a draft is paperwork, **stock leaves on Send**.

## One quiet routing bug fixed

`titleFor()` matched with `pathname.startsWith(n.to)`, so `/stock-counts`
matched `/stock` — the new page would have shown "Stock" in the header purely
because that entry sits earlier in the array. Now matches on a segment
boundary. Prefix matching on paths is a trap that only springs when a later
route happens to extend an earlier one.

## Verification

Client `tsc --noEmit` clean; production build clean (80 modules). The **server
suite was not re-run here** — Prisma's engine binaries can't be downloaded in
the sandbox (403), so tests must be run locally. Changes are client-only, so
the expected result is an unchanged 181 passing.
