# StockPilot — Local Setup Guide

Get StockPilot running on your machine in ~5 minutes.

> **You do NOT need anyone else's database.** Every developer runs their own
> local PostgreSQL. The database schema is recreated from the Prisma migrations
> in this repo, and demo data comes from a seed script. The production database
> is never shared — do not use production credentials locally.

---

## Prerequisites

- **Node.js 18+** (LTS recommended) — <https://nodejs.org>
- **Docker Desktop** — <https://www.docker.com/products/docker-desktop/>
  (the easiest way to get PostgreSQL; a manual Postgres install also works — see below)
- **Git** (recommended: clone the repo instead of downloading the zip, so you can push)

---

## Quick start (with Docker)

From the project root (`inventory/`):

```bash
# 1. Install dependencies (npm workspace — installs client + server)
npm install

# 2. Create your environment file (it is git-ignored, so it isn't in the repo)
#    Windows PowerShell:
copy server\.env.example server\.env
#    macOS / Linux:
cp server/.env.example server/.env
#    The defaults already match the Docker database below — no edits needed for local dev.

# 3. Start PostgreSQL in Docker
docker compose up -d

# 4. Create the database schema + Prisma client (run from the server folder)
cd server
npx prisma migrate deploy
npx prisma generate

# 5. Load demo data (creates a demo company + a login)
npx prisma db seed

# 6. Run the app (back at the project root)
cd ..
npm run dev
```

Then open the client URL that Vite prints (usually **<http://localhost:5173>**) and sign in:

- **Email:** `demo@demo.com`
- **Password:** `demo1234`

The API runs on **<http://localhost:5000>** by default.

---

## Alternative: without Docker (local PostgreSQL)

1. Install PostgreSQL 16 and make sure it is running.
2. Create a database and user. Either match the defaults in `server/.env.example`:
   - user `inventory`, password `inventory_dev_password`, database `inventory`
   - …or use your own and edit `DATABASE_URL` in `server/.env` to match, e.g.
     `postgresql://<user>:<password>@localhost:5432/<database>?schema=public`
3. Run the same steps **4–6** from the Quick start above.

---

## Environment variables (`server/.env`)

Copied from `server/.env.example`:

| Variable | What it is |
|---|---|
| `PORT` | API port (default `5000`) |
| `NODE_ENV` | `development` locally |
| `DATABASE_URL` | Connection string to **your** Postgres |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Any long random strings for local dev; **must** be strong secrets in production |

`server/.env` is git-ignored on purpose — never commit it.

---

## Handy commands

```bash
# Run only the server or only the client
npm run dev:server
npm run dev:client

# Open Prisma Studio to browse/edit the DB in a GUI
cd server && npx prisma studio

# Re-seed demo data (from server/)
npx prisma db seed

# Stop / start the database container
docker compose stop
docker compose up -d

# Wipe the database completely and start fresh (DELETES local data)
docker compose down -v && docker compose up -d
# then re-run:  cd server && npx prisma migrate deploy && npx prisma db seed
```

---

## Running the tests

Tests use a **separate** database (`inventory_test`) so they never touch your dev data.
Make sure the Docker Postgres is running, then from the project root:

```bash
npm test
```

(The test script auto-creates the `inventory_test` schema via `prisma db push`.)

---

## Troubleshooting

- **Port 5432 already in use** — another Postgres (or an old container) is using it.
  Stop it, or change the host port in `docker-compose.yml` (`"5433:5432"`) and update
  the port in `DATABASE_URL`.
- **`Environment variable not found: DATABASE_URL`** — you skipped step 2. Create
  `server/.env` from `server/.env.example`.
- **Prisma `EPERM` / file-lock on Windows** — stop the dev server and close Prisma
  Studio, then re-run `npx prisma generate`.
- **`docker compose` not found** — install/open Docker Desktop, or use the older
  `docker-compose` (with a hyphen).
- **Login fails** — make sure step 5 (`prisma db seed`) ran; the demo account only
  exists after seeding.

---

## Project layout

```
inventory/
  client/            React + Vite + Tailwind frontend
  server/            Express + TypeScript + Prisma API
    prisma/          schema.prisma, migrations, seed.ts
  docker-compose.yml Local PostgreSQL for development
  package.json       npm workspace root (scripts: dev, build, test)
```
dhruv