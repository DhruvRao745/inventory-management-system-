# StockPilot — Project Notes

_Last updated: 23 July 2026_

Multi-tenant inventory management SaaS ("build once, sell to many businesses").
Live at: **https://stockpilot-6x5n.onrender.com** (older build — redesign not yet deployed).
Repo: private GitHub (`DhruvRao745`), auto-deploys to Render on push to `main`.

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
  oversell guard inside DB transactions, transfers as linked twin rows,
  per-location levels with low-stock flags. No update/delete — corrections
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
- **Tests**: 12 vitest integration tests against a separate
  `inventory_test` DB — sign rule, oversell, transfer atomicity,
  **tenant isolation**, auth flows. `npm test` from root.
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
3. **Push + deploy the redesign** to Render.
4. Remaining page-by-page queue: Stock (history filters?), Reports
   (sales-over-time chart?), Settings/Product detail (light polish).
5. Free Render Postgres **expires ~Aug 13** — upgrade or accept reset.

### V2 backlog (build when customers ask)

Suppliers/POs · low-stock email/WhatsApp alerts · barcode scanning ·
batch/expiry tracking · invoicing · audit log viewer · searchable
product pickers (500+ SKUs) · Google sign-in · subscription billing ·
custom domain + paid hosting before first real customer.
