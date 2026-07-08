# Inventory — Multi-Tenant Inventory Management System

A commercial inventory management product: built once, sold to many businesses.
Each customer company gets isolated data, its own users/roles, and configurable
categories, units, and locations.

## Tech Stack (PERN + TypeScript)

| Layer    | Tech                                      |
| -------- | ----------------------------------------- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS  |
| Backend  | Node.js, Express, TypeScript              |
| Database | PostgreSQL 16, Prisma ORM                 |
| Auth     | JWT (access + refresh), role-based access |
| Infra    | Docker Compose (local dev)                |

## Project Structure

```
Inventory/
├── client/          # React app — what users see in the browser
│   └── src/
├── server/          # Express API — business logic + database access
│   ├── prisma/      # Database schema & migrations
│   └── src/
│       ├── config/      # Environment validation
│       ├── middleware/  # Auth, error handling, tenant scoping
│       └── modules/     # Feature modules (products, stock, users...)
├── docker-compose.yml   # Local PostgreSQL
└── package.json         # npm workspaces root
```

## Getting Started

Prerequisites: Node.js 20+, Docker Desktop.

```bash
# 1. Install all dependencies (root, client, and server at once)
npm install

# 2. Start PostgreSQL
docker compose up -d

# 3. Copy environment template and adjust if needed
copy server\.env.example server\.env

# 4. Run both client and server in dev mode
npm run dev
```

- Client: http://localhost:5173
- API: http://localhost:5000/api/health

## Key Architecture Decisions

1. **Multi-tenancy**: single database, every table carries `company_id`,
   every query is tenant-scoped. No customer can ever see another's data.
2. **Stock is event-sourced**: quantities are never stored directly — every
   stock movement (in/out/transfer/adjustment) is a record, and current stock
   is the sum. This gives a full audit trail.
3. **Multi-location ready**: stock is tracked per location; single-location
   companies simply have one default location.
