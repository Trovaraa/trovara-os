# Trovara OS — API Contract

Base URL (local dev): `http://127.0.0.1:3000`

All authenticated routes require the `trovara_session` httpOnly cookie. Mutating requests (`POST`, `PATCH`, `DELETE`) also require the double-submit CSRF token: cookie `trovara_csrf` must match header `X-CSRF-Token`. The CSRF cookie is set on successful login.

Errors return JSON: `{ "error": "message" }` with appropriate HTTP status.

Roles: `owner` | `supervisor` | `field_worker`

---

## Health

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/health` | No | — | `{ status, service }` |

---

## Auth (`/auth`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| POST | `/auth/login` | No | — | `{ email, password }` | `{ user: { id, email, name, role, farmId } }` + sets session + CSRF cookies |
| POST | `/auth/logout` | Yes | any | — | `{ ok: true }` |
| GET | `/auth/me` | Yes | any | — | `{ user }` |

Login rate limit: 5 attempts per IP per 15 minutes.

---

## Dashboard (`/api/dashboard`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/dashboard/` | Yes | all (worker: limited) | `{ farm, summary, lowStockItems, alerts }` |

Workers receive task stats for assigned tasks only; no low-stock or approval alerts.

---

## Today home (`/api/today`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/today/` | Yes | all | `{ role, exceptions[], actionList[], summary, myTasksToday? }` |

Exception types: `overdue_task`, `low_stock`, `pending_approval`, `mortality_today`, `order_pending`, `rejected_task`.

Workers also receive `myTasksToday` for assigned open tasks due today or earlier.

---

## Tasks (`/api/tasks`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/tasks/` | Yes | all (worker: own) | — | `{ tasks[] }` |
| POST | `/api/tasks/` | Yes | owner, supervisor | `{ title, description?, plotId?, assignedToId?, dueDate? }` | `{ task }` |
| PATCH | `/api/tasks/:id` | Yes | role-dependent | `{ status?, completionNote? }` | `{ task }` |
| GET | `/api/tasks/pending-approvals` | Yes | owner, supervisor | — | `{ tasks[] }` |

Task status state machine: `pending → in_progress → awaiting_approval → completed | rejected`.

---

## Inventory (`/api/inventory`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/inventory/` | Yes | all | — | `{ items[] }` with `lowStock` flag |
| POST | `/api/inventory/movements` | Yes | owner, supervisor | `{ itemId, delta, reason }` | `{ item }` |
| GET | `/api/inventory/low-stock` | Yes | all | — | `{ items[] }` |

Negative delta blocked if quantity would go below zero.

---

## Reports (`/api/reports`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/reports/owner` | Yes | owner | Full owner report bundle |
| GET | `/api/reports/digest` | Yes | owner, supervisor | Daily exception digest |
| GET | `/api/reports/burn-rate` | Yes | owner, supervisor | Inventory burn rate (30-day lookback) |
| GET | `/api/reports/action-list` | Yes | owner, supervisor | Manager action list |
| GET | `/api/reports/audit-export` | Yes | owner | `{ events[] }` |

### Digest response shape

```json
{
  "generatedAt": "ISO8601",
  "report": "daily_exception_digest",
  "summary": { "overdueTasks", "lowStock", "pendingApprovals", "mortalityToday", "ordersPending", "rejectedTasks", "total" },
  "sections": { "overdueTasks": { "count", "items" }, ... },
  "exceptions": []
}
```

### Burn rate response shape

```json
{
  "generatedAt": "ISO8601",
  "report": "inventory_burn_rate",
  "periodDays": 30,
  "items": [{ "itemId", "name", "avgDailyConsumption", "daysRemaining", "needsReorder", ... }]
}
```

### Action list response shape

```json
{
  "generatedAt": "ISO8601",
  "report": "manager_action_list",
  "summary": {},
  "actions": [{ "priority", "action", "label", "entityType", "entityId", "link" }]
}
```

---

## Onboarding (`/api/onboarding`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/onboarding/status` | Yes | all | — | `{ checklist, ready }` |
| POST | `/api/onboarding/reset-demo` | Yes | owner | — | `{ ok, message }` |

`checklist`: `{ hasZones, hasTemplates, hasUsers, zonesCount, templatesCount, usersCount }`.

`reset-demo` truncates and re-seeds demo data (requires seed env passwords).

---

## Crops (`/api/crops`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/crops/` | Yes | all | — | `{ cropCycles[] }` |
| GET | `/api/crops/:id` | Yes | all | — | `{ cropCycle }` |
| POST | `/api/crops/` | Yes | owner, supervisor | create schema | `{ cropCycle }` |
| PATCH | `/api/crops/:id` | Yes | all | update schema | `{ cropCycle }` |
| DELETE | `/api/crops/:id` | Yes | owner, supervisor | — | `{ ok: true }` |

Crop stages advance one step: `planted → … → harvested`.

---

## Livestock (`/api/livestock`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/livestock/batches` | Yes | all | `{ batches[] }` |
| GET | `/api/livestock/batches/:id` | Yes | all | `{ batch }` |
| POST | `/api/livestock/batches` | Yes | owner, supervisor | `{ batch }` |
| PATCH | `/api/livestock/batches/:id` | Yes | owner, supervisor | `{ batch }` |
| DELETE | `/api/livestock/batches/:id` | Yes | owner, supervisor | soft-deactivate `{ ok: true }` |
| GET | `/api/livestock/batches/:id/logs` | Yes | all | `{ logs[] }` |
| POST | `/api/livestock/batches/:id/logs` | Yes | all | `{ log }` |

---

## Sales (`/api/sales`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/sales/` | Yes | all | — | `{ orders[] }` |
| POST | `/api/sales/` | Yes | owner, supervisor | order create | `{ order }` |
| PATCH | `/api/sales/:id` | Yes | owner, supervisor | order update + status | `{ order }` |
| DELETE | `/api/sales/:id` | Yes | owner, supervisor | — | `{ ok: true }` |

Order status: `pending → confirmed → dispatched → delivered` or `cancelled`.

---

## Finance (`/api/finance`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/finance/` | Yes | owner | `{ expenses[] }` |
| GET | `/api/finance/summary` | Yes | owner | `{ summary }` |
| POST | `/api/finance/` | Yes | owner | `{ expense }` |
| PATCH | `/api/finance/:id` | Yes | owner | `{ expense }` |
| DELETE | `/api/finance/:id` | Yes | owner | `{ ok: true }` |

---

## Traceability (`/api/traceability`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/traceability/` | Yes | owner | `{ lots[] }` |
| POST | `/api/traceability/` | Yes | owner | `{ lot }` |
| PATCH | `/api/traceability/:id` | Yes | owner | `{ lot }` |
| DELETE | `/api/traceability/:id` | Yes | owner | `{ ok: true }` |
| GET | `/api/traceability/export` | Yes | owner | `{ exportedAt, harvestLots, auditChain }` |

---

## AI (`/api/ai`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/ai/briefing` | Yes | owner, supervisor | Placeholder daily briefing |
| POST | `/api/ai/summarize-incident` | Yes | owner, supervisor | Placeholder incident summary |

---

## WhatsApp (`/api/whatsapp`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/whatsapp/templates` | No | — | `{ templates[], configured }` |
| POST | `/api/whatsapp/webhook` | No | — | `501` not configured |

---

## Zones & templates (route modules)

Implemented in `api/src/routes/zones.ts` and `api/src/routes/templates.ts`. Mount at `/api/zones` and `/api/templates` when enabled.

### Zones

- `GET /` — list zones
- `POST /` — create zone (owner, supervisor)
- `GET /:id`, `PATCH /:id`, `DELETE /:id`
- Planting units: `GET /planting-units/list`, `POST /planting-units`, `PATCH /planting-units/:id`, `DELETE /planting-units/:id`
- `GET /plots/:plotId/timeline` — plot activity timeline

### Templates

- `GET /lifecycles` — crop lifecycle definitions
- Task templates CRUD at `/templates`, `/templates/:id`
- Recurring schedules CRUD at `/schedules`, `/schedules/:id`
- `POST /generate-tasks` — materialize due recurring tasks

---

## Security headers & CORS

- Secure headers on all responses
- CORS origin from `CORS_ORIGIN` (default `http://127.0.0.1:5173`)
- Credentials allowed for cookie auth

See also [`security.md`](./security.md) and [`operating-model.md`](./operating-model.md).
