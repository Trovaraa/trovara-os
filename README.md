# Trovara OS

Trovara Farm operations command center — laptop-runnable MVP with dummy data.

> **AI / handoff context:** see [`CONTEXT.md`](./CONTEXT.md) (auto-loaded via `.cursor/rules/`).

## Prerequisites

- **Node.js 20.17+** or **22 LTS** (see `.nvmrc`) — required; Node 19 is not supported
- **Docker Desktop** or **OrbStack** (for Postgres)

## Quick Start

```bash
cd trovara-os
cp .env.example .env
# Edit .env — set strong passwords for POSTGRES_PASSWORD, SESSION_SECRET, and SEED_* passwords

docker compose up -d
npm install
npm run db:migrate
npm run seed
npm run dev
```

- **Frontend:** http://127.0.0.1:5173
- **API:** http://127.0.0.1:3000/health

## Demo Accounts

Passwords are set in `.env` (`SEED_OWNER_PASSWORD`, etc.):

| Email | Role |
|-------|------|
| owner@trovara.farm | owner |
| supervisor1@trovara.farm | supervisor |
| supervisor2@trovara.farm | supervisor |
| worker1@trovara.farm | field_worker |
| worker2@trovara.farm | field_worker |

## Security

- API binds to `127.0.0.1` only
- httpOnly session cookies, argon2 passwords, server-side RBAC
- See `docs/security.md`

## Structure

```
trovara-os/
  api/     Hono + Drizzle + Postgres
  app/     Vue 3 + Vite + Tailwind
  docs/    ROADMAP, security, integrations, API, backup runbook
  whatsapp/ Message templates (Phase 4)
```

## Modules

| Module | Route | Roles |
|--------|-------|-------|
| Today (field home) | `/today` | field_worker (default home) |
| Worker queue | `/worker` | field_worker |
| Dashboard | `/dashboard` | All (AI briefing API: owner, supervisor) |
| Tasks | `/tasks` | All (create: supervisor+) |
| Inventory | `/inventory` | All (movements: supervisor+) |
| Crops | `/crops` | All |
| Livestock | `/livestock` | All |
| Sales | `/sales` | All |
| WhatsApp | `/whatsapp` | All (send: supervisor+; API: `POST /api/whatsapp/send`) |
| Finance | `/finance` | Owner |
| Traceability | `/traceability` | Owner |
| Reports | `/reports` | Owner |
| Public lot lookup | `/lot/:lotCode` | Public (API: `GET /public/lots/:lotCode`) |

Integrations (WhatsApp, AI, cron, QR traceability): `docs/INTEGRATIONS.md`

Roadmap: `docs/ROADMAP.md`
