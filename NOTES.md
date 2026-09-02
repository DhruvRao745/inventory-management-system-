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

---

# 🏁 P2 COMPLETE — all six features

**319 tests, 19 files, 37 migrations.** Built in PRD §27 order.

| # | Feature | API | UI | Tests |
|---|---|---|---|---|
| 1 | Reservations | ✅ | — | 21 |
| 2 | Inventory statuses | ✅ | — | 18 |
| 3 | GST structure | ✅ | — | 34 |
| 4 | Reporting + dashboard | ✅ | — | 19 |
| 5 | Session management | ✅ | partial | 26 |
| 6 | Audit history | ✅ | — | 20 |

UI is owed for all six — the P2 work was deliberately API-first, since every
one of these changes a rule the UI would otherwise have to guess at.

---

## P2-1 — Reservations

**The formula:** `Available = On hand − Reserved`, and a reservation writes
NOTHING to the ledger. PRD §13: a future reservation must not subtract physical
stock. Put a promise in the ledger and stock on hand drops for goods nobody has
taken, valuation falls for stock the company still owns, and a stocktake reports
a variance against goods sitting in plain sight.

**The decision that makes it work:** issuing an invoice checks availability
*excluding its own hold*. A draft reserves its lines, so at issue time the stock
it needs is already spoken for — by itself. Count that and every draft blocks
its own issue: reserve 5, be told 5 are unavailable, forever.

**Concurrency:** reserving takes the SAME advisory lock, on the SAME key, as
ledger writes. Reserving is read-check-write — the exact race P0 fixed. A
separate lock key would be a separate queue, which is the same as no lock.

**Reversed mid-implementation:** drafts were originally refused when stock was
short. Changed to reserve what's available and never block, because a draft is
work in progress, not a promise — you must be able to write up an order before
the delivery that fills it arrives. Issuing is the real gate.

## P2-2 — Inventory statuses

Stock can be OWNED without being SELLABLE.

```
On hand   = SUM(all movements)                   — what we own
Sellable  = SUM(movements WHERE status=AVAILABLE) — what we may sell
Available = Sellable − Reserved                   — what's still free
```

**Reclassifying is a PAIR of ADJUSTMENT movements**, never an in-place status
edit. Editing would destroy the record that goods were ever quarantined — the
ledger would claim they'd always been available, and no one could tell an
inspection happened. This keeps the P0 append-only rule intact.

**A bug caught during implementation:** I first forced every outgoing movement
to `AVAILABLE`. That would have made quarantine a one-way door — the negative
half of a reclassification must be allowed to name the bucket it drains. Sales
stay forced, because letting a client tag a sale DAMAGED would drain a bucket
nothing was put into.

**Batches carry their own status.** FEFO reads batches, not movements, so an
allocator knowing only movement statuses would pick a quarantined lot — and
since FEFO takes nearest-expiry first, a short-dated quarantined lot is exactly
the one it grabs. The batch unique key now includes status, so "B1 available"
and "B1 damaged" can't merge into one row where bad units hide behind good.

**Visible behaviour change:** damaged sales returns now enter the ledger. They
used to be noted on the return document and vanish — not counted, not valued,
invisible to a stocktake. The warehouse held goods the system denied existed.

## P2-3 — GST

GST is one tax collected by two governments. Intra-state it splits (CGST +
SGST); inter-state the whole amount is IGST. Same total, different split — and
the split decides which government gets the money.

**Tax is STAMPED at write time, never recomputed.** Same principle as
`costAtTime` in P1-3. Change a product's rate from 18% to 28% and every invoice
already issued keeps its 18% — otherwise financial history rewrites itself and
the customer's copy stops matching ours, with no way to tell which is right.

**`taxMode` is load-bearing.** Without it, "legacy invoice, no GST columns" and
"GST invoice at 0%" are identical on the wire — and a nil-rated invoice is a
real thing.

**Two fiddly bits:** the discount is apportioned across lines BEFORE tax (taxing
full price then subtracting charges tax on money never paid), and CGST/SGST are
derived by halving-then-subtracting so they always sum to the total — rounding
both halves independently turns ₹0.03 into ₹0.04.

**Not claimed:** reverse charge, composition scheme, e-way bills, e-invoicing,
exports/SEZ, ITC matching, GSTR filing. Listed in `lib/gst.ts`'s header, because
PRD §16 warns against claiming compliance.

## P2-4 — Reporting + dashboard

Five reports PRD §18 required that didn't exist: stock-by-status (with the value
of stock that CAN'T be sold), stock-by-batch, expired (flagging stock still
counted as good — meaning valuation is overstated right now), returns (a RATE,
not a count — ten returns is excellent on 10,000 sales and alarming on 20), and
gst-summary.

**Every dashboard figure is derived, none stored.** PRD §19 forbids counters and
the reason is worth keeping: a counter has to be missed ONCE — one early return,
one retry that double-counts — and it's silently wrong forever, on the screen
people stop checking once they trust it. The test writes a movement directly to
the database, bypassing every service, and asserts the dashboard still sees it.

**First tests in the suite to cross HTTP** (supertest added here). The
double-`JSON.stringify` bug survived 181 green tests precisely because nothing
did.

## P2-5 — Sessions

**Logout used to do nothing.** A refresh token was a signed JWT; the signature
was the only check. The server kept no record it existed, so it couldn't later
say "not any more". Logout cleared localStorage — any copy taken beforehand kept
working for 30 days, and nothing a user or admin could do would stop it. The
only remedy was rotating `JWT_REFRESH_SECRET`, signing out everyone everywhere.

**Refresh tokens are no longer JWTs.** A JWT is self-validating — anyone holding
one can prove it genuine without asking us, which is exactly wrong when the
server needs the final say. Now opaque random bytes, stored as SHA-256.

**SHA-256, not bcrypt.** bcrypt is slow to make guessing human-chosen passwords
expensive. A refresh token is 256 bits of server randomness — nothing to guess,
so the slowness buys nothing on a path that runs every 15 minutes.

**Reuse detection by family.** Every refresh retires the token used, so one
should be used exactly once. A retired token reappearing is either theft-replay
or a client that lost its successor — indistinguishable from the server, so the
whole lineage dies. Other devices survive, or this would be too disruptive to
leave on.

**Client change that is load-bearing:** `api.ts` must store the rotated token.
Without it the next refresh presents a retired token, the server reads a replay,
and the user is logged out for no reason they could understand.

**Deliberate limit:** access tokens stay stateless and unchecked — a DB read per
API call would make the database a single point of failure for every request. A
revoked session therefore has a ≤15-minute tail.

## P2-6 — Audit history

The old feed INFERRED history from tables with timestamps. Kept, because it
works retroactively — but inference only sees what still exists, in its current
state. It shows a product at ₹500; it cannot say the price was ₹50 last Tuesday.

The events an audit exists for leave no trace in the final row: logins, FAILED
logins, permission changes, price edits, cancellations. A failed login changes
nothing anywhere — which is why a burst of them, the clearest sign of an attack
in progress, was completely invisible.

**Audit writes go inside the caller's transaction.** The async alternative
sounds safer and is worse: a log with gaps isn't weaker, it's unusable — a gap
is indistinguishable from nothing having happened, so one missing entry poisons
every conclusion including "this person did nothing wrong". And gaps wouldn't be
random: writes fail under load and during incidents, exactly the periods anyone
would later reconstruct.

**Stock movements are NOT logged.** The ledger is already append-only — it IS an
audit trail, and a better one. Duplicating it doubles writes on the hottest path
and buries the entries that matter.

**Two guarantees in the sanitiser:** `passwordHash` never reaches the table (the
log is read widely during investigations — credentials would make it the softest
target in the system), and Decimals are stored as strings, since JSON has no
decimal type and a price becoming 49.99999999 undermines the one thing the trail
is for.

---

# Bugs found by tests, not by reports

Three, all during P2:

1. **Double `JSON.stringify`** (P2 start) — `api()` already serialises the body;
   three call sites stringified first, producing a quoted string that
   `express.json()` rejects in strict mode. Raising a sales return, recording a
   refund, and recording a payment were ALL dead in the browser while 181 tests
   passed. Verified with a throwaway express harness: double-encoded → HTTP 400,
   single → 200. **The lesson:** a green suite only covers the seams it crosses.
   Nothing tested the client↔server boundary.

2. **Forced AVAILABLE on outgoing movements** (P2-2) — my own change, caught
   minutes later. Would have made quarantine impossible to release.

3. **Blank SKU accepted by the service** (P2-6) — a test calling
   `updateProduct` directly saved `sku: ""`. Not reachable via the API (Zod
   blocks it at the route) but nothing in the database disagreed. Now constrained.

---

---

# 🏁 Phase L + §25 — the PRD's own remaining work

P3 in the PRD (§27) is a bare list of seven headings under "**Future**" — no
requirements, no acceptance criteria, nothing. The numbered phases stop at
**Phase 16 (Reporting)**, and §24's plan stops at **Phase L**. So there was
nothing to implement from it, and inventing a spec would have broken the
instruction not to add features outside the PRD.

What the PRD DID still specify and we hadn't done: **Phase L**, and **§25's
Definition of Done** — item 7, "UI supports the workflow", which four P2
features failed.

## Phase L-1 — the constraints are finally under test

`pretest` built the test database with `prisma db push`, which reads
`schema.prisma`. But **Prisma's schema language cannot express CHECK
constraints** — all 115 constraint statements live only in hand-written
migration SQL. So production had 38 guards the test suite had never once
exercised.

Now `prisma migrate reset --force --skip-generate --skip-seed`. Three things
that proved, beyond the tests staying green:

- **The migration chain replays cleanly from empty.** Never verified before,
  and it matters far beyond tests — it's every fresh environment and any
  disaster recovery.
- **All 115 constraints agree with the code.** No test was relying on data
  production would reject.
- **They're guarded now.** A wrong constraint will fail the suite.

Cost: a drop-and-replay per run. Measured at roughly nothing.

## Phase L-2 — container hardening

**The Dockerfile was already right.** Its `CMD` runs `prisma migrate deploy &&
node dist/index.js`. Railway's **Custom Start Command** override — bare `node
dist/index.js` — is what had been suppressing it, which is why migrations were
being applied by hand every deploy. A config problem wearing a code problem's
clothes.

Added: **non-root user** (`chown -R node:node` then `USER node` — root inside a
container is root on the mounted filesystem), and **EXPOSE 8080** to match what
the server actually binds, where it had said 5000.

**Multi-stage build deliberately NOT done.** `prisma` is a devDependency and
the container runs `npx prisma migrate deploy` at startup — pruning dev
dependencies would break the start command, and it would fail at RUNTIME, not
build time: a green build followed by a crash-looping container. Noted in the
Dockerfile for whoever tries it later.

**Also found:** Railway's **Watch Paths** were set to `/server/**`, so every
frontend-only commit was silently SKIPPED — not failed, skipped, which is
hidden behind "Show Skipped" by default. Two commits had never deployed. The
dashboard showed a green ACTIVE deployment throughout; true, just not of the
code that had been pushed.

## §25 — the four features that were not "done"

### GST (the one with a real bug in it)

The invoice screen computed tax from `inv.taxRate` — which is **NULL on a GST
invoice**. Every GST invoice displayed and printed with **₹0 tax**. And the
print output hardcoded `taxRate / 2` as CGST+SGST, so an **inter-state** sale
printed CGST/SGST on an invoice where IGST was charged: a legally wrong
document naming the wrong governments.

Both now read the STAMPED values. The client never computes GST; it renders
what the server stored.

Added: company state (Settings), per-product GST rate, customer GSTIN + state
with the state auto-filled from the GSTIN's first two digits, an opt-in toggle
per invoice, place of supply, per-slab breakdown in both totals blocks and the
print, and an IGST / CGST+SGST badge.

### Sessions, audit, reservations

Device list with revoke, change-password, the recorded audit log with
before/after values, and a "stock held by drafts" panel that names the invoice
holding each unit. The reservations panel hides itself when nothing is held —
a permanently empty card is furniture.

---

# Bugs found by clicking, not by tests

Seven now. All passed `tsc`. All passed the full suite.

1. **Double `JSON.stringify`** — returns, refunds and payments were dead in the
   browser while 181 tests passed. Nothing crossed HTTP.
2. **Forced AVAILABLE on outgoing movements** — would have made quarantine a
   one-way door.
3. **Blank SKU accepted by the service** — now constrained.
4. **Reclassify button hidden on healthy stock** — gated on `blocked > 0`, so
   you could only reclassify stock that had already been reclassified.
5. **Reclassify dialog defaulted to QUARANTINE** — "0 pcs here", unusable until
   the dropdown was changed.
6. **To-dropdown displayed a value it wasn't set to** — a `<select>` holding a
   value absent from its options shows the first option instead. Screen said
   "Damaged → Available"; code saw "Damaged → Damaged".
7. **`publicCompany()` dropped `stateCode`** — saved fine, came back as "Not
   set". `?? null` on an optional field means a forgotten field is a silent
   null, not a type error.

**They share a shape.** Not one is a logic error — the logic was right every
time. They are failures of REACHABILITY: a control you can't reach, a state you
can't act from, a value you can't trust, a field that vanishes in transit.
Tests assert what functions return. They cannot assert that a human can drive
them, and four of these seven were invisible until someone clicked.

Twice the instinct was to suspect the save, and twice the save was fine and the
DISPLAY was wrong.

---

---

# Opening costs for legacy stock

`avgCost` and `stockValue` are maintained by lib/costing.ts, which only began
running at P1-3. Stock received before that contributed nothing, so the company
held 1,358 units and reported a stock value of **₹0** — and valuation, gross
profit and dashboard COGS were all zero with it.

Nothing was broken. The costing engine had no history to work from.

`prisma/backfill-costs.ts` supplies the opening balance it never got. All ten
products resolved from **real purchase data** — the weighted average of every
incoming movement carrying a `unitCost`. No fallbacks were needed.

That replay is not an approximation: the average only moves when stock comes
IN (selling removes value at the current average, it doesn't re-price what's
left), so the weighted average of all purchases IS the current average.

**`costAtTime` on past movements was deliberately left alone.** Backfilling it
would make historical COGS non-zero, which looks like a fix and isn't — PRD §7
forbids changing the cost of a completed sale, and we don't know what those
sales cost. A plausible invented number is worse than a zero: the zero is
visibly unknown, the invented one is indistinguishable from real data forever.

Dry run is the default; `--apply` writes. A script that writes to production on
first invocation is one keystroke from an accident.

---

# API contract tests — closing the seam

**335 tests, 20 files.**

Almost every other test calls a service function directly. Fast, precise, and
blind to everything that happens BETWEEN the browser and the service — which is
where **four of this project's seven bugs lived**.

`modules/api-contract.test.ts` asks one question: does the wire contract hold?
It does not re-test business logic; costing, concurrency, FEFO, GST and
reservations are covered properly elsewhere.

What it covers that nothing else could:

- **`/auth/me` returns every company field** — the direct regression test for
  the `stateCode` bug. That field saved correctly and vanished on the way out.
  TypeScript was satisfied because `?? null` turns a forgotten optional field
  into a valid null.
- **Login and `/auth/me` return identical company shapes** — same helper, two
  paths; drift means a form blank after login and populated after a refresh.
- **A double-encoded body is rejected cleanly** — the original bug reproduced,
  asserting a 4xx AND zero rows written, not a silent partial write.
- **Query-string coercion** — params arrive as strings, so a schema missing its
  `coerce` fails only over HTTP. A service test hands it real numbers.
- **403 vs 401**, and tenancy enforced at the ROUTE rather than trusting a
  service that is always passed the right `companyId`.
- **No stack traces in error bodies** — a leaked trace hands over the
  framework, the file layout and often the query.

---

# P3 — the spec Mr. Rao wrote

PRD §27 listed seven headings under "Future" with no requirements anywhere in
the document, so P3 could not be built from the PRD. Mr. Rao supplied a written
spec covering four areas, with accounting integration explicitly excluded.

The three constraints that shaped the code more than anything else — each one
draws the same line, between a system that RECOMMENDS and a system that ACTS:

1. "Never automatically place an order with a supplier."
2. "Forecasting is advisory only; it must never directly modify stock or
   create orders."
3. "POS sales must use the same inventory, pricing, tax, payment and
   stock-movement logic as normal sales. Do not create a separate inventory
   system for POS."

Order of work: purchase automation → analytics → forecasting → POS. Analytics
before forecasting on purpose: a forecast is only as good as the demand history
underneath it, and building the honest view of that history first meant the
forecast had something real to sit on.

---

## P3-1 — Purchase automation

`POST /api/reorder/generate-pos` turns the existing location-based reorder
recommendations into DRAFT purchase orders.

**It cannot place an order, and not because of a check.** The generator has no
code path that sets any status but DRAFT, because it calls `createPO()`, which
only ever creates drafts. A guard someone can delete is a different thing from
a capability that doesn't exist. Reaching a supplier still needs a human to
move the order to ORDERED, exactly as before.

Two grouping decisions:

- **One PO per supplier, not one per product.** A purchase order goes to one
  supplier; the reorder report spans many. Grouping isn't a convenience, it's
  what makes the output a valid document.
- **A product short at two locations becomes ONE line.** The report is per
  shelf because that's how you restock, but you order from a supplier once —
  where the goods go is decided at receiving.

**What it refuses to do:** a product with no `preferredSupplier` is skipped and
reported in `skipped[]` with a reason, never assigned a supplier by guesswork.
Choosing one would be inventing a commercial relationship. The refusal is
surfaced in the UI rather than logged, because a missing supplier will block
that product on every future run until someone sets one.

`PurchaseOrder.generatedFrom` ("reorder" or null) exists to answer a question
the reorder rules can't answer about themselves: are they being acted on, or
ignored? A rule nobody follows still looks like coverage.

Schema: `PurchaseOrder.generatedFrom String?`, `Invoice.source InvoiceSource`
(MANUAL | POS) — one migration, `20260901190443_p3_po_source_and_invoice_source`.

### Two test failures that were the test's fault, not the code's

Worth recording because both mistakes were about the FIXTURE, not the logic:

- `createTestCompany()` ships a "Test Widget" with `lowStockThreshold: 5` and
  no stock and no supplier, so it landed in `skipped` on every run and drowned
  out what each test was actually checking. Set its threshold to 0 in the
  fixture.
- I assumed filtering to an empty location would yield nothing. Wrong: a shelf
  holding zero of a TRACKED product is short by definition — `onHand: 0` is
  below any minimum. "No stock here" and "not relevant here" look alike and are
  opposites; only a zero minimum removes a shelf from the report. The test now
  asserts the empty location orders MORE than the stocked one.

---

## P3-2 — Advanced analytics

No schema changes. Everything is computed from what the ledger already holds.

`lib/analytics.ts` holds the maths as pure functions with no database access,
for the same reason `lib/gst.ts` has none: these are formulas with opinions
baked into them, and an opinion should be testable in isolation rather than
buried in a query.

**The design rule: every function can return "I don't know."** Analytics is the
part of a system most likely to produce a confident number from nothing — a
turnover ratio from two weeks of data, an ABC classification of four products,
a "declining" trend drawn from three sales. Those figures are worse than
blanks, because a blank prompts a question and a wrong number ends one.

### Turnover — why it reconstructs history

COGS ÷ **average** inventory value. The tempting implementation divides by
today's `stockValue`, because that's the number sitting in the database. It is
wrong the moment stock levels moved during the period — which is always, since
selling is what turnover measures. A shop that ran its stock down would report
a spectacular ratio purely because the denominator collapsed.

The ledger is append-only, so stock at any past date is exactly
`SUM(movements WHERE createdAt <= date)`. Not an estimate — a reconstruction.

One approximation remains and the response states it in `note`: historical
QUANTITIES are valued at today's average cost, because a per-product-per-day
running average isn't stored. Fine for a ratio, explicitly not a balance sheet.

`ratio` is null, not 0, when no stock was held. Zero reads as "nothing sold",
which is a different and damning claim.

### The ABC bug the test caught

`abcAnalysis` banded on the cumulative share AFTER adding each item. Take one
product worth 81% of revenue: 81 > 80, so the single most important line in the
business is filed under B and nothing at all is an A. Demoted for being too
important.

Correct question: "had we already covered 80% BEFORE reaching this one?" The
top item always has 0% behind it, so there is always at least one A. Same rule,
off by one item — and the difference only ever shows on the item straddling the
boundary, which is exactly the one that matters.

**The docstring already described the correct behaviour.** I wrote the intent
down and then implemented the opposite. The test disagreed with the code only
because it was written from the intent rather than from the implementation —
tests written by reading the code back to yourself agree with it by
construction and catch nothing.

### The judgement calls, stated

- **ABC refuses below 10 selling products.** Sorting six items into three bands
  tells you nothing you couldn't see by looking at six items, and dresses an
  arbitrary split in the language of analysis. It still ranks them.
- **Trend has a ±15% dead zone.** 10 units then 11 is noise. Calling it growth
  gets someone ordering stock on the strength of one extra sale.
- **Trend needs 6 points.** Halving a three-point series is not analysis.
- **0 → 10 reports no percentage.** Growth from nothing has no percentage;
  "infinite" is not a figure.
- **Dead (never sold) is separated from slow.** The remedy differs — slow stock
  might need a promotion, dead stock probably needs writing off. And dead stock
  never appears in any sales report BY DEFINITION, so it is the easiest kind to
  keep paying for without noticing.
- **A product with no stock is not dead, it's absent.** Reporting it would fill
  the list with things that cost nothing to hold.

### Endpoints

`GET /reports/turnover?from&to` · `/dead-stock?slowAfterDays&staleAfterDays`
(defaults 60/120) · `/abc?from&to&basis=revenue|quantity` · `/trends?from&to&tzOffset`

ABC reads revenue from invoice LINES, not stock movements: a movement knows
what stock cost, not what it sold for. Trends emit a point for every day
including empty ones — a gap is a real zero, and dropping it would flatter the
trend by hiding the days nothing sold.

### The UI is a separate page on purpose

`/analytics`, not more of `/reports`. Reports answers "what happened" — every
figure is a fact you could count by hand. These four answer "what does it
mean", and each has a judgement call inside it. On one page, the authority of a
bank balance leaks onto a trend line drawn from eleven days of data.

Consequences of that, in the markup:

- Turnover prints opening → closing side by side, because the average between
  them IS the denominator above. A reader who can't see both can't check it.
- "Days of stock" distinguishes two blanks: no stock held, versus stock held
  and nothing sold. Both would otherwise be a dash, and a dash looks like a bug.
- ABC's refusal is styled as loudly as a result would be — amber left border,
  not grey small print. The failure mode is skimming past it.
- Trend badges HIDE the percentage when the verdict is "steady". Show "+7%"
  next to the word steady and people believe the number and ignore the word.
- Daily volume is drawn as bars, not a line. A line implies the values between
  two points mean something; there is no such thing as half past Tuesday's
  sales. Empty days draw a 2px stub so a zero looks like a zero, not a hole.
- Default range is 3 months, not the current month like Reports — every figure
  here degrades as the window shrinks.

Dead stock is deliberately NOT tied to the date range: stock sitting unsold is
sitting unsold whatever window you're looking at, and "no dead stock in March"
is a meaningless comfort.

383 tests passing (347 → +12 generate-PO, +20 analytics maths, +16 analytics
endpoints, minus overlap).

---

## P3-3 — Demand forecasting

`GET /api/reports/forecast`, `lib/forecast.ts`, and a Forecast section at the
top of the Analytics page. No schema changes.

**Advisory-only is structural, not a promise.** No POST route, no service call
that writes, no transaction. The first test counts movements, orders, invoices
and products before and after two forecast calls and asserts they are
identical — a comment saying "this doesn't write" is worth nothing beside a
test that checks.

**Weighted moving average, four buckets, 1:2:3:4 oldest to newest.** Demand
drifts; a product that sold well in June and stopped in August has a flat
average describing neither month. Exponential smoothing or ARIMA would give a
more PRECISE answer to a question this data cannot support, and precision reads
as confidence. This one can be explained in a sentence to the person spending
the money, which matters more here than a better fit.

Any remainder in the split goes to the LATER buckets, so the newest quarter is
never the short one — giving recent data fewer days would work against the
whole point of the weighting.

**Three refusals, each with its reason on screen:**

- under 21 days of history — there are no "recent weeks", only days
- sold on fewer than 3 separate days — two sale days in ninety is two events,
  not a rate, and their average is an artefact of where they fell
- volatility over 150% of the mean — occasional bulk orders separated by
  nothing; an average across that describes no day that ever happened

A product that has never sold returns a confident **0**, not a refusal. Ninety
days of evidence that nobody wants it is real information, and different from
having no evidence.

**The buffer scales with doubt, not size** (10/20/35% by confidence). Not
because shaky demand is higher, but because the two errors cost differently:
too much stock ties up cash, too little loses the sale.

**Two deliberate omissions.** Suggested quantities do NOT allow for supplier
lead time, because nothing in the schema records it — ordering 30 days of stock
from a supplier who takes 3 weeks leaves a gap this number cannot see. The
caveat is in the API payload, not only the UI, so anything else consuming the
endpoint inherits it. And availability excludes DAMAGED / QUARANTINE / EXPIRED
stock: counting those would advise against reordering goods that cannot be
sold.

`daysOfCover` is the most actionable figure on the row. "40 units, 12 days
left" prompts a decision; "predicted demand 98" does not.

### Eight test failures from one line

`createMovement` takes a POSITIVE quantity and derives the sign from the type —
only ADJUSTMENT may arrive already signed ("found 2 broken" = −2). My helper
passed `-quantity` for a SALE and the service rejected every one.

---

# The same bug three times, and the rule that comes out of it

Worth its own section because it is not about analytics.

1. **Turnover printed "stock held, nothing sold"** above a chart showing 129
   units sold. COGS was zero because legacy sales have no `costAtTime`, and the
   UI inferred "no sales" from "no cost".
2. **Dead stock printed "everything you hold has sold within 60 days"**
   whenever the result was empty — but empty also means *you are holding
   nothing*, and the message picked the reassuring cause.
3. **Turnover called a full warehouse empty.** Stock value was zero because
   nothing had a recorded cost, and the `average <= 0` branch reported "no
   stock was held at any point in this period" about a warehouse you could walk
   into.

Every one is the same mistake: **an ambiguous value, a branch choosing one of
its meanings, and the wrong one printed with confidence.**

> **The rule: when a number can reach the same value by two different routes,
> the value is not the answer. Carry the reason down from the point where the
> routes diverge.**

In practice that meant `unavailableReason` as text from the server, plus
`salesCount`, `productsHeld` and `heldStock` as inputs — `heldStock` made
REQUIRED with no default, so the six other call sites failed to compile and had
to decide rather than inherit a guess.

All 383 tests passed while bug 1 was live on screen. The maths was right; the
EXPLANATION was wrong, and no test asserted on an explanation. Several do now.

---

## P3-4 — Point of sale

`POST /api/pos/sale` — one route, and that is the entire server surface. A till
also needs barcode lookup, locations and printing; all three already exist, so
the screen calls the ordinary endpoints. POS-flavoured copies would have been
the first step toward the separate system the spec forbids.

**`pos.service.ts` composes, it does not implement:**

```
createInvoice()  →  issueInvoice()  →  recordPayment()
```

Search that file for `stockMovement`, `avgCost` or `cgst` and there are none.
No stock written, no tax computed, no cost stamped — all of it happens in the
code that already does it for a typed invoice.

**Why this is the decision that mattered.** A POS is where a second inventory
system gets born. The pressure is real: the till must be fast, the invoice
screen has fields a counter doesn't want, and writing a movement directly is
three lines instead of a service call. Take that shortcut and two code paths
both deduct stock — and every rule added afterwards (oversell guards, FEFO,
GST, reservations, costing) has to be remembered twice. The second one rots
quietly. Six months later the shop's counter sales aren't in COGS and nobody
can say when that started.

**So the first test rings up identical goods twice** — once through the till,
once through the invoice screen — and asserts the two ledger rows are
`toEqual`: quantity, stamped cost, status, shelf. A comment claiming "we reuse
the invoice service" would survive someone adding a stock write here. That test
would not.

### Deliberately NOT one transaction

The three services each own their transaction and POS does not wrap them in a
fourth. That looks like a gap; it is a decision, and the reason is physical.

If payment fails, one transaction would roll back the stock deduction too — but
at a counter the goods are already in the customer's bag. Un-selling them makes
the ledger disagree with the shelf, which is the one thing this system exists
to prevent. The stock left; that is a fact, and facts are not rolled back
because a later step failed.

What you get instead is an ISSUED, UNPAID invoice — not a corruption but a
state the system already models, displays and collects against. The one real
danger is a blind retry of the whole sale, which would deduct stock twice, so
the error names the invoice and says explicitly **do not ring this sale again**.

### Two smaller decisions

- **Prices resolve server-side.** The till may override, but the default is
  read at the moment of sale. A price sent up from the browser is whatever that
  tab loaded — possibly hours old, possibly edited — and the resulting invoice
  would look entirely ordinary afterwards.
- **Change, not overpayment.** ₹500 tendered against a ₹380 bill records ₹380
  and reports ₹120 change. Recording ₹500 would leave the invoice permanently
  in credit for money that went back across the counter in coins.

`source` is a service PARAMETER, not a request field — same pattern as
`generatedFrom` on `createPO`. A client that could set it could make counter
sales appear in the till's takings, or hide them from it. There is a test.

STAFF may sell. Gating a counter sale to managers would leave a shop unable to
serve customers whenever the manager is out, and staff can already issue
invoices — the same act through a different screen.

### The till screen (`/pos`)

Everything follows from one fact: somebody is standing there waiting.

- The scan box keeps focus between customers. A scanner types into whatever is
  focused; if nothing is, it types into the void.
- The total is the largest thing on screen because it is read aloud.
- Change is enormous and stays up after the sale, because it is counted out of
  a drawer by hand while the next customer is already talking.
- Scanning the same item twice bumps the line rather than adding another —
  "Milk ×1, Milk ×1, Milk ×1" is needlessly hard to check against a bag.

The running total is labelled an ESTIMATE and excludes tax. This screen doesn't
know the place of supply, each product's rate, or how rounding falls, and
reimplementing that here to show a slightly better number is exactly how a
second, wrong tax engine gets written. The receipt shows the server's figures.

Online-only per the spec: no queue, no local persistence. A sale that cannot
reach the server has not happened, and the cashier finds out immediately rather
than discovering at closing time that a queue never drained.

446 tests passing.

---

# A missing GST rate is not a rate of zero

Found by ringing up a real sale at the till, not by a test. The invoice printed
**CGST @ 0% / SGST @ 0%** for a product whose `gstRate` had never been set.

One line caused it, in `computeInvoiceGst`:

```ts
const rate = line.gstRate ?? params.defaultGstRate ?? ZERO;
```

`Product.gstRate` is nullable, and the two states are different facts:

- `0` → nil-rated or exempt goods. A real, deliberate answer.
- `null` → nobody has decided yet.

Collapsing them makes the invoice state that the goods are zero-rated. On a
tax document that is a claim, not a blank field — and once the line is stamped
nothing downstream can tell which happened.

**This is the fourth instance of the pattern in the section above**, and the
only one with legal weight. Same shape every time: an ambiguous value, a branch
picking one meaning, the wrong one printed with confidence.

### Where the check had to go, and why it isn't where I first put it

My instinct was to block at ISSUE time — a draft isn't a legal document, an
issued invoice is. That would not have worked. `stampGst` runs at draft CREATE
and writes the resolved rate onto the line, so by issue time the row reads
`gstRate = 0` with no way to know whether a human typed it. The null is already
gone.

> **The check has to live at the last moment the ambiguity still exists.**
> Here that is inside `stampGst`, immediately before the write that destroys it.

`stampGst` is called only from draft create and draft update, never on an
issued invoice (history is immutable), so no existing invoice is re-stamped or
changed.

### The escape hatches, all deliberate

- **Explicit `0` passes** — nil-rated and exempt supplies are real, and someone
  who typed 0 has decided. That IS the distinction.
- **Per-line `gstRate` override passes** — this sale's rate, without editing
  product master data for every future sale.
- **Non-GST invoices untouched** — a FLAT invoice makes no claim about GST, so
  it has nothing to be wrong about. Blocking it would be scope creep with real
  cost; most shops here never raise a GST invoice.

The POS inherits the block for free by composing `createInvoice`, but it is
tested there separately: the till is where an unrated product is most likely to
be scanned with nobody looking, and the test also asserts no invoice row
survives the refusal.

### Then the same check, moved earlier

The server can only refuse at the moment of sale, which at a counter is the
worst possible time — goods bagged, total said out loud. So `PosPage` runs the
identical check the instant "GST invoice" is ticked, naming the products and
linking to them, and disables the button.

Possible only because the client already holds every product's rate, so nothing
is duplicated that it would otherwise have to fetch. It reports the gap and
never guesses what the rate should be — the server still decides.

The disabled button is the point: **a button that can only fail is worse than a
disabled one**, because it invites a cashier to keep pressing it in front of a
customer.

### Then earlier still: the rate became mandatory on the product

Mr. Rao's call, and the right one — it moves the discovery from the busiest
moment (a customer waiting at the till) to the calmest (creating the product).

**Scoped to GST-REGISTERED companies, not to everyone.** `assertGstRateDecided`
in `product.service.ts` checks whether the company has a `stateCode` or
`gstin`; if not, the field stays optional.

The reasoning matters more than the code. StockPilot is multi-tenant and plenty
of shops never raise a GST invoice — `taxMode` FLAT exists for exactly them,
and a company with no state code is already blocked from GST invoicing. Forcing
those companies to answer a tax question that means nothing to them would not
make anything more correct; it would make them type a number to get past the
form.

> **A required field people resent is a field full of lies.** A catalogue of
> 18%s nobody meant is worse than an honest blank, because the blank is
> visible and the fake rate is not.

Tying the rule to the registration rather than to a separate setting also means
it flips on by itself: registering for GST later cannot leave a half-configured
catalogue behind.

**Enforced on create AND update.** No backfill is possible — nobody can infer a
tax rate from a product name, and guessing is the exact mistake this whole
change exists to prevent. Enforcing on edit turns each future edit into a small
cleanup at the moment someone already has the product open.

CSV import inherits it for free, because `importProducts` calls
`createProduct`; rate-less rows come back in the existing per-row error list
instead of being created silently.

On the form, "Not set" is no longer OFFERED to a GST-registered company — an
option the server will reject is worse than no option — replaced by
"— choose a rate —" and a note that 0% is a real answer and blank is not.

Existing products stay sellable throughout: the rule gates writing a product,
not selling one, and a FLAT invoice makes no claim about tax.

463 tests passing.

---

# Still open

- **Railway Custom Start Command** still overrides the Dockerfile CMD, so
  `migrate deploy` never runs on deploy. Clearing it ends the manual step.
- **Railway Custom Build Command** is dormant (the Dockerfile wins) but would
  ship a server with no frontend if the Dockerfile were ever renamed.
- **The till lets you build a basket before finding out stock is unsellable.**
  The GST gap is now caught the moment it appears, but a batch-tracked product
  with an empty batch pool still fails at the payment moment. Fixing that needs
  per-location availability on the client — a server call per basket line, so a
  bigger piece than the GST check.
- ~~Some products have no GST rate.~~ Fixed by Mr. Rao; GST sales through the
  till confirmed working. Any remaining product without a rate is now caught
  the next time it is edited.
- **Barcode scanning at the till needs barcodes on products.** The `add_product_barcode`
  migration ran, but products still need codes generated (Products → edit →
  Generate barcode). Until then the scan box finds nothing and the search
  picker is the only way to add an item — which works, but isn't the till
  experience.
- **P3 is code-complete**: purchase automation, analytics, forecasting, POS.
  Accounting integration remains explicitly out of scope per Mr. Rao's spec.

## Closed since last time

- **Samsung S26 Ultra valued at ₹60,000/unit** — recorded at the selling price
  instead of cost. Corrected via `prisma/revalue-product.ts`, which fixes
  `avgCost`/`stockValue` in a transaction and writes a `stock.revalue` audit
  entry, leaving the movement rows untouched. Production never held the
  product, so no prod run was needed.
- **P3 had no specification.** Mr. Rao wrote one; see above.
