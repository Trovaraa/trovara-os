# Trovara OS

Trovara Farm operations command center. Local laptop MVP with optional demo seed;
production runs at `https://os.trovara.farm` with real farm data (no seed).

## Prerequisites

- **Node.js 22** (see `.nvmrc`)
- **Docker Desktop** or **OrbStack** (for Postgres)

## Quick Start (local)

```bash
cd trovara-os
cp .env.example .env
# Edit .env - set strong local-only POSTGRES_PASSWORD, SEED_* staff passwords,
# and BREAK_GLASS_PASSWORD for the owner account

docker compose up -d
npm install
npm run db:migrate
npm run seed                  # local demo only — never on production
npm run sync-catalog -w api   # optional: catalogue from farm-knowledge
npm run dev
```

- **Frontend:** http://127.0.0.1:5173
- **API:** http://127.0.0.1:3000/health
- **Production:** https://os.trovara.farm

## Demo Accounts (local seed only)

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
| sales@trovara.farm | sales |

## Security

- API binds to `127.0.0.1` only (local)
- httpOnly session cookies, argon2 passwords, server-side RBAC
- Break-glass password is env-only (`BREAK_GLASS_PASSWORD`)
- See `docs/security.md` and `docs/ROLE-PERMISSION-MATRIX.md`

## Structure

```
trovara-os/
  api/     Hono + Drizzle + Postgres
  app/     Vue 3 + Vite + Tailwind
  docs/    security, integrations, API, copilots, backup runbook
  whatsapp/ Message templates
```

## Modules (effective access)

Access is enforced by the API and router allowlists. Hiding a menu is not enough.
“Admin” in the product UI is the `owner` role. Full matrix: `docs/ROLE-PERMISSION-MATRIX.md`.

| Module | Route | Who can use it |
|--------|-------|----------------|
| Today | `/today` | All signed-in roles (worker default home; sales sees sales day-close) |
| My Tasks | `/worker` | Field worker |
| Dashboard | `/dashboard` | Admin, supervisor, sales (not field worker) |
| Advisory | `/advisory` | Admin, supervisor, field worker |
| Tasks | `/tasks` | Admin, supervisor (create/approve); workers use My Tasks |
| Field reports | `/field-reports` | Admin, supervisor, field worker |
| Inventory | `/inventory` | Admin, supervisor (read/write). Sales has **no** inventory screen; order dispatch may still decrement linked finished goods |
| Crops / Livestock / Zones / Templates | `/crops`, `/livestock`, `/zones`, `/templates` | Admin, supervisor |
| Equipment | `/assets` | Admin, supervisor, field worker (log/report; verify: supervisor+) |
| Harvest / Traceability | `/traceability` | Admin, supervisor, sales, field worker (create/verify gated by role) |
| Sales / Support / Products | `/sales`, `/support`, `/products` | Admin, supervisor, sales (product remove: admin) |
| Customer questions | `/customer-insights` | Admin |
| WhatsApp | `/whatsapp` | Admin, supervisor, sales (view/copy templates); **send via Meta API: Admin/Supervisor only** |
| Finance | `/finance` | Admin, sales |
| AI Copilot | `/ai` | Admin, supervisor |
| Reports | `/reports` | Admin |
| Journal | `/journal` | Admin (publishes to marketing via Netlify build hook) |
| Events / audit | `/events` | Admin, supervisor |
| Settings | `/settings` | All (farm admin / TOTP / alerts: admin) |
| Register | `/register` | Public (single-use registration token) |
| Public lot | `/lot/:farmSlug/:lotCode` | Public (verified lots only) |

Integrations index: `docs/INTEGRATIONS.md`  
Staff messaging: `docs/TELEGRAM-COPILOT.md`, `docs/WHATSAPP-COPILOT.md`  
Customer payments: `docs/PAYSTACK.md` (production activation still in progress)  
Product roadmap: `../ROADMAP.md` · active OS backlog: `../next-steps-trovara-os.md`
