# Trovara OS

Trovara Farm operations command center - laptop-runnable MVP with dummy data.

## Prerequisites

- **Node.js 22** (see `.nvmrc`)
- **Docker Desktop** or **OrbStack** (for Postgres)

## Quick Start

```bash
cd trovara-os
cp .env.example .env
# Edit .env - set strong local-only POSTGRES_PASSWORD and SEED_* passwords

docker compose up -d
npm install
npm run db:migrate
npm run seed
npm run sync-catalog -w api   # optional: catalogue from farm-knowledge (mirrors trovera)
npm run dev
```

- **Frontend:** http://127.0.0.1:5173
- **API:** http://127.0.0.1:3000/health
- **Production:** https://os.trovara.farm

## Demo Accounts

Staff demo passwords are set in `.env` (`SEED_SUPERVISOR_PASSWORD`, etc.).
The owner / break-glass account (`owner@trovara.farm`) authenticates with
`BREAK_GLASS_PASSWORD` from the environment at login time (not the DB hash).

| Email | Role |
|-------|------|
| owner@trovara.farm | owner (break-glass via `BREAK_GLASS_PASSWORD`) |
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
  docs/    security, integrations, API, copilots, backup runbook
  whatsapp/ Message templates
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
| Assets | `/assets` | All (verify: supervisor+) |
| Sales | `/sales` | All |
| Products | `/products` | Owner |
| Customer questions | `/customer-insights` | Owner |
| WhatsApp | `/whatsapp` | All (send: supervisor+) |
| Finance | `/finance` | Owner |
| Traceability | `/traceability` | All (create/verify gated by role) |
| Reports | `/reports` | Owner |
| Register | `/register` | Public (secret-gated) |
| Public lot lookup | `/lot/:lotCode` | Public (verified lots only) |

Integrations (WhatsApp, AI, cron, QR traceability): `docs/INTEGRATIONS.md`  
Product roadmap (OS + farm + site): `../ROADMAP.md`

