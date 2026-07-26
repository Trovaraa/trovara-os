# Trovara OS - API Contract

Base URL (local dev): `http://127.0.0.1:3000`

All authenticated routes require the `trovara_session` httpOnly cookie. Mutating requests (`POST`, `PATCH`, `DELETE`) also require the double-submit CSRF token: cookie `trovara_csrf` must match header `X-CSRF-Token`. The CSRF cookie is set on successful login.

Errors return JSON: `{ "error": "message" }` with appropriate HTTP status.

Roles: `owner` | `supervisor` | `sales` | `field_worker`

---

## Health

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/health` | No | - | `{ status, service }` |

---

## Auth (`/auth`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| POST | `/auth/login` | No | - | `{ email, password }` | `{ user, mustChangePassword? }` + cookies. Break-glass email uses `BREAK_GLASS_PASSWORD` from env. |
| POST | `/auth/logout` | Yes | any | - | `{ ok: true }` |
| GET | `/auth/me` | Yes | any | - | `{ user }` |
| GET | `/auth/preferences` | Yes | owner | - | `{ butlerTtsMode, orderAlertsSubscribed, workerAlertsSubscribed }` |
| PATCH | `/auth/preferences` | Yes | owner | partial prefs | updated prefs |

Login rate limit: 5 attempts per IP per 15 minutes.
---

## Dashboard (`/api/dashboard`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/dashboard/` | Yes | all (worker: limited) | `{ farm, summary, lowStockItems, alerts }` |

Workers receive task stats for assigned tasks only; no low-stock or approval alerts.

---

## Localized display strings

`ExceptionItem` and `ActionItem` carry optional i18n keys beside their English display strings so clients can render in the viewer's language (`en`, `fr`, `yo`, `pcm`).

| Object | String | Key | Params |
|--------|--------|-----|--------|
| `ExceptionItem` | `title` | `titleKey?` | `titleParams?` |
| `ExceptionItem` | `message` | `messageKey?` | `messageParams?` |
| `ActionItem` | `label` | `labelKey?` | `labelParams?` |
| `ActionItem` | (nested title) | `titleKey?` | `titleParams?` |

- Keys are full dotted i18n paths (e.g. `exceptions.msg.lowStock`, `exceptions.action.approve`).
- Params are a flat `Record<string, string | number>` interpolated into `{placeholder}` slots of the resolved string.
- A param *value* may itself be a key (`exceptions.unassigned`, `exceptions.staff`, `exceptions.block`); resolve it before interpolating, or the fallback word renders in English.
- The `since` and `lastVerified` params are raw ISO 8601 timestamps; the client formats them for the active locale.
- `title` / `message` / `label` always hold English and are the fallback whenever the matching key is absent. Weather-derived exceptions are localized server-side and carry no keys.
- An `ActionItem` label embeds a `{title}`. When `titleKey` is present, resolve it first and interpolate the result; otherwise use `labelParams.title`.

---

## Today home (`/api/today`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/today/` | Yes | all | `{ role, exceptions[], actionList[], summary, weather, advisory, myTasksToday? }` |

Exception types: `overdue_task`, `low_stock`, `pending_approval`, `mortality_today`, `order_pending`, `rejected_task`, `asset_log_missing`, `asset_verification_pending`, `census_missing`, `census_rejected`, `census_stale`, `weather_rain`, `weather_heat`, `weather_wind`, `weather_cold`.

`exceptions[]` items: `{ type, severity, title, titleKey?, titleParams?, message, messageKey?, messageParams?, entityType, entityId, timestamp, metadata? }`; `severity` is `high` | `medium`.

`actionList[]` items: `{ priority, action, label, labelKey?, labelParams?, titleKey?, titleParams?, entityType, entityId, link }`.

See [Localized display strings](#localized-display-strings) for the key/params contract.

Workers also receive `myTasksToday` for assigned open tasks due today or earlier.

---

## Tasks (`/api/tasks`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/tasks/` | Yes | all (worker: own) | - | `{ tasks[] }` |
| POST | `/api/tasks/` | Yes | owner, supervisor | `{ title, description?, plotId?, assignedToId?, dueDate? }` | `{ task }` |
| PATCH | `/api/tasks/:id` | Yes | role-dependent | `{ status?, completionNote? }` | `{ task }` |
| GET | `/api/tasks/pending-approvals` | Yes | owner, supervisor | - | `{ tasks[] }` |

Task status state machine: `pending → in_progress → awaiting_approval → completed | rejected`.

---

## Inventory (`/api/inventory`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/inventory/` | Yes | all | - | `{ items[] }` with `lowStock` flag |
| POST | `/api/inventory/items` | Yes | owner, supervisor | `{ name, category, unit, quantity?, reorderLevel?, costPerUnit?, supplier?, expiryDate?, storageLocation?, batchNumber? }` | `{ item }`, 201 |
| PATCH | `/api/inventory/items/:id` | Yes | owner, supervisor, sales | `{ name?, category?, unit?, reorderLevel?, costPerUnit?, supplier?, expiryDate?, storageLocation?, batchNumber? }` | `{ item }` |
| POST | `/api/inventory/movements` | Yes | owner, supervisor, sales | `{ itemId, delta, reason }` | `{ item }` |
| POST | `/api/inventory/opening-count` | Yes | owner, supervisor, sales | `{ items: [{ itemId, countedQuantity }] }` | `{ items[] }` |
| GET | `/api/inventory/count-sessions` | Yes | all | - | `{ sessions[] }` |
| POST | `/api/inventory/count-sessions` | Yes | all | `{ taskId?, locationText?, lines: [{ itemId?, itemName, category?, unit?, countedQuantity, notes? }] }` | `{ session }`, 201 |
| POST | `/api/inventory/count-sessions/:id/verify` | Yes | owner, supervisor | `{ status: 'verified' \| 'rejected', rejectionReason? }` | `{ session }` |
| GET | `/api/inventory/low-stock` | Yes | all | - | `{ items[] }` |

Negative delta blocked if quantity would go below zero.

Creating an item is owner and supervisor, but correcting one is the same
authority that moves its stock, so sales is included: it is the register they
already sell against. The PATCH changes only the fields the body carries, and is
a 404 for an item on another farm. It does not accept `quantity` — stock moves
only through movements and counts, so every change to it keeps a movement row
behind it.

A count session is a field count anyone may submit and only an owner or
supervisor may resolve, and nobody may verify their own: that is a 400, as is a
rejection with no `rejectionReason` and a session already resolved. Lines cap at
200.

`storageLocation`, a session's `locationText` and a line's `notes` are prose:
stored as canonical English and read back in the viewer's language. On the write
that creates them the author reads their own words back, so they see what they
submitted while other staff see their own language.

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
  "summary": { "overdueTasks", "lowStock", "pendingApprovals", "mortalityToday", "ordersPending", "rejectedTasks", "assetLogsMissing", "assetVerificationPending", "censusMissing", "censusRejected", "censusStale", "weatherAlerts", "total" },
  "sections": { "overdueTasks": { "count", "items" }, ... },
  "exceptions": []
}
```

`items` and `exceptions` hold `ExceptionItem`s, shaped as in [Today home](#today-home-apitoday) and localized per [Localized display strings](#localized-display-strings). `sections` covers only the six task, stock, mortality and order types; asset and census exceptions appear in `exceptions` alone. Weather exceptions are Today-only, so `weatherAlerts` is always `0` here.

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
  "actions": [{ "priority", "action", "label", "labelKey?", "labelParams?", "titleKey?", "titleParams?", "entityType", "entityId", "link" }]
}
```

`summary` is the digest summary shape. `actions` are `ActionItem`s; see [Localized display strings](#localized-display-strings).

---

## Onboarding (`/api/onboarding`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/onboarding/status` | Yes | all | - | `{ checklist, ready }` |
| POST | `/api/onboarding/reset-demo` | Yes | owner | - | `{ ok, message }` |

`checklist`: `{ hasZones, hasTemplates, hasUsers, zonesCount, templatesCount, usersCount }`.

`reset-demo` truncates and re-seeds demo data (requires `BREAK_GLASS_PASSWORD` + `SEED_SUPERVISOR_PASSWORD` + `SEED_WORKER_PASSWORD`).

---

## Crops (`/api/crops`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/crops/` | Yes | all | - | `{ cropCycles[] }` |
| GET | `/api/crops/:id` | Yes | all | - | `{ cropCycle }` |
| POST | `/api/crops/` | Yes | owner, supervisor | create schema | `{ cropCycle }` |
| PATCH | `/api/crops/:id` | Yes | all | update schema | `{ cropCycle }` |
| DELETE | `/api/crops/:id` | Yes | owner, supervisor | - | `{ ok: true }` |
| GET | `/api/crops/:id/lifecycle` | Yes | all | - | `{ cropCycleId, cropType, plantedAt, generated, agronomySkipReason, expectedHarvestAt, totalDays, stages[], tasks[] }` |
| PATCH | `/api/crops/:id/lifecycle/stages/:stageId` | Yes | owner, supervisor | `{ durationDays }` | `{ stage }` |
| POST | `/api/crops/:id/lifecycle/tasks` | Yes | owner, supervisor | task schema | `{ task }` |
| PATCH | `/api/crops/:id/lifecycle/tasks/:taskId` | Yes | owner, supervisor | partial task schema | `{ task }` |
| DELETE | `/api/crops/:id/lifecycle/tasks/:taskId` | Yes | owner, supervisor | - | `{ ok: true }` |
| POST | `/api/crops/:id/agronomy/regenerate` | Yes | owner, supervisor | - | `{ generated, stageCount, taskCount }` or `{ generated: false, reason }` |

Crop stages advance one step: `planted → … → harvested`.

### Cycle lifecycle

The stage lengths and the work each stage needs belong to the cycle, not to the
code. They are generated once from the crop the farmer entered when the cycle is
created — best-effort, so the create returns 201 whether or not it worked — and
are the farm's to edit afterwards. Anything a person writes is stored with
`source: 'manual'` and is never overwritten by a regeneration; a stage the farm
has taken over keeps its duration when a regeneration runs over the rest.

`generated: false` means no lifecycle has been established yet; it is a state,
not an error, and any crop may have one. `expectedHarvestAt` and `totalDays` are
`null` for such a cycle rather than falling back to a default: a generic outline
for the crop would be read as this cycle's own agronomy, and a plantain's stage
lengths are not this plantain's.

`agronomySkipReason` says why that cycle has none, as a stable code the client
maps to a sentence in the reader's language, never a message: one of
`llm_unavailable` (the assistant is not configured for this deployment),
`budget_exhausted` (the farm's daily assistant budget is spent),
`llm_failed`, `invalid_payload` or `write_failed` (the attempt is worth
repeating). It is `null` once the cycle has a lifecycle, whether a later
generation wrote it or the farm entered one by hand. The same code is carried on
each cycle in `GET /api/crops/` and returned by `agronomy/regenerate` as
`reason`.

`expectedHarvestAt` here is derived from this cycle's own stage durations and is
the day its harvest stage opens. It is reported alongside, never written over,
the `expectedHarvestAt` a farmer set on the cycle itself.

A stage's `startsOn`/`endsOn` and a task's `dueDate` are laid end to end from
`plantedAt`. Task `offsetDays` counts from the day its stage is entered, not
from planting, so a stage that runs long does not drag its work out of order.

This is the only endpoint that carries a cycle's tasks. `GET
/api/templates/lifecycles` lists stage durations for every cycle at once and
nothing else, so a caller that needs the work, the stage dates or the skip
reason for one cycle reads it here.

Task `templateName` and `description` are free text: stored in English, rendered
in the viewer's `preferred_locale`, and normalized to English when a farmer
writes them.

Bounds, enforced identically for a generated lifecycle and a hand-written one:

| Field | Bound |
|-------|-------|
| stages | a subset of the `crop_stage` enum, each at most once, in enum order |
| `durationDays` | integer, 0–2000 per stage; 1–4000 across the cycle |
| tasks | at most 40 per cycle |
| `offsetDays` | integer, 0–2000, and never past the end of its own stage |
| `templateName` | 1–200 chars |
| `description` | up to 1000 chars, or null |
| `defaultDurationHours` | integer, 1–24, or null |

A generated lifecycle is all-or-nothing: one entry outside these bounds discards
the whole payload rather than storing a lifecycle with a hole in it, and nothing
is clamped into range.

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
| GET | `/api/livestock/batches/:id/economics` | Yes | all | `{ estimatedWeightPerBirdKg, weightGainKg, fcr, … }` |
| GET | `/api/livestock/batches/:id/vaccination-schedule` | Yes | all | `{ generated, agronomySkipReason, schedule[], completedCount }` |
| POST | `/api/livestock/batches/:id/vaccination-schedule` | Yes | owner, supervisor | `{ entry }` |
| PATCH | `/api/livestock/batches/:id/vaccination-schedule/:entryId` | Yes | owner, supervisor | `{ entry }` |
| DELETE | `/api/livestock/batches/:id/vaccination-schedule/:entryId` | Yes | owner, supervisor | `{ ok: true }` |
| PATCH | `/api/livestock/batches/:id/growth-curve` | Yes | owner, supervisor | `{ batch }` |
| POST | `/api/livestock/batches/:id/agronomy/regenerate` | Yes | owner, supervisor | `{ generated, entryCount }` or `{ generated: false, reason }` |

### Batch agronomy

The vaccination/husbandry calendar and the growth curve belong to the batch, not
to the code. Both are generated once from the species the farmer entered when
the batch is created — best-effort, so the create returns 201 whether or not it
worked — and are the farm's to edit afterwards. Anything a person writes is
stored with `source: 'manual'` and is never overwritten by a regeneration.

`generated: false` on the schedule means no calendar has been established yet;
it is a state, not an error, and any batch may have a calendar whatever species
it holds. `estimatedWeightPerBirdKg`, `weightGainKg` and `fcr` are `null` for a
batch with no growth curve rather than falling back to a default.

`agronomySkipReason` says why that batch has none, as a stable code the client
maps to a sentence in the reader's language, never a message: one of
`species_unsupported` (the batch holds animals this calendar is not written
for), `llm_unavailable` (the assistant is not configured for this deployment),
`budget_exhausted` (the farm's daily assistant budget is spent), `llm_failed`,
`invalid_payload` or `write_failed` (the attempt is worth repeating). It is
`null` once the batch has a calendar or a curve, whether a later generation
wrote it or the farm entered one by hand. The same code is returned by
`agronomy/regenerate` as `reason`.

Generation runs for poultry only: the calendar it writes and the advisory rules
those rows feed are poultry throughout, so a batch that cannot be placed as
poultry is skipped as `species_unsupported` rather than given a flock's
calendar. The batch's own `batch_type` decides that where it has one, since
that is where a worker's answer to the butler's poultry-type question lands;
otherwise the species text is read against the lexicon in
`lib/species-normalize.ts`. A farm keeping goats or catfish still writes its own
schedule by hand, and the read path serves it back like any other.

Editing a batch's species re-runs generation, because a refusal recorded against
the old species may have stopped being true. It rewrites the reason either way,
so a batch renamed but still unplaceable records that again. Entries the farm
authored and a curve the farm owns are outside the regeneration's scope and
survive it.

Entry `name` and `vaccine` are free text: stored in English, rendered in the
viewer's `preferred_locale`, and normalized to English when a farmer writes them.

Bounds, enforced identically for a generated calendar and a hand-written one:

| Field | Bound |
|-------|-------|
| schedule entries | at most 30 per batch, `dayOffset` ascending and unique |
| `dayOffset` | integer, 0–400 days after `acquiredAt` |
| `name` | 1–200 chars |
| `vaccine` | up to 200 chars, or null for a husbandry step |
| `cycleDays` | integer, 7–400 |
| `startWeightKg` | 0.01–5 |
| `targetWeightKg` | 0.05–20, and greater than `startWeightKg` |
| `dailyGainKg` | 0.0005–0.5 |

`startWeightKg + dailyGainKg × cycleDays` must also land within a factor of two
of `targetWeightKg`, so figures that describe no single animal are rejected
rather than clamped. `growth-curve` takes all four figures together.

---

## Sales (`/api/sales`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/sales/` | Yes | owner, supervisor, sales | - | `{ orders[] }` |
| POST | `/api/sales/` | Yes | owner, supervisor, sales | order create | `{ order }` |
| PATCH | `/api/sales/:id` | Yes | owner, supervisor, sales | order update + status | `{ order }` |
| DELETE | `/api/sales/:id` | Yes | owner, supervisor | - | `{ ok: true }` |

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
| GET | `/api/traceability/` | Yes | staff | `{ lots[] }` |
| POST | `/api/traceability/` | Yes | role-gated | `{ lot }` |
| PATCH | `/api/traceability/:id` | Yes | role-gated | `{ lot }` |
| DELETE | `/api/traceability/:id` | Yes | owner | `{ ok: true }` |
| GET | `/api/traceability/export` | Yes | owner | `{ exportedAt, harvestLots, auditChain }` |
| GET | `/api/traceability/:id/certificate.html` | Yes | staff | Traceability certificate HTML |
| GET | `/api/traceability/:id/label.html` | Yes | staff | Printable box QR label HTML |

Public (no auth): `GET /public/lots/:token` (lot page), certificate/label HTML under `/public/lots/...` where exposed.

---

## AI (`/api/ai`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/ai/briefing` | Yes | owner, supervisor | `{ locale, priorities[], ... }` daily briefing built from farm counts |
| POST | `/api/ai/summarize-incident` | Yes | owner, supervisor | Placeholder incident summary |

`/briefing` is deterministic: priorities come from task and stock counts, never a model, so it
works with the LLM off. Labels are rendered server-side in the caller's `preferred_locale` and
echoed as `locale`; counts, units, item names and the farm name are interpolated verbatim.

---

## WhatsApp (`/api/whatsapp`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/whatsapp/templates` | No | - | `{ templates[], configured }` |
| POST | `/api/whatsapp/webhook` | No | - | `501` not configured |

---

## Zones & templates (route modules)

Implemented in `api/src/routes/zones.ts` and `api/src/routes/templates.ts`. Mount at `/api/zones` and `/api/templates` when enabled.

### Zones

- `GET /` - list zones
- `POST /` - create zone (owner, supervisor)
- `GET /:id`, `PATCH /:id`, `DELETE /:id`
- Planting units: `GET /planting-units/list`, `POST /planting-units`, `PATCH /planting-units/:id`, `DELETE /planting-units/:id`
- `GET /plots/:plotId/timeline` - plot activity timeline

### Templates

- `GET /lifecycles` - the farm's own per-cycle lifecycles, one entry per crop cycle that has one (empty when none have been established)
- Task templates CRUD at `/templates`, `/templates/:id`
- Recurring schedules CRUD at `/schedules`, `/schedules/:id`

A template's `checklist` accepts at most 30 items of at most 500 characters, and
a request over either is a 400. Every item is prose, so every item is its own
translation on write: unbounded, one request could spend a farm's whole day of
assistant budget.
- `POST /generate-tasks` - materialize due recurring tasks

---

## Security headers & CORS

- Secure headers on all responses
- CORS origin from `CORS_ORIGIN` (default `http://127.0.0.1:5173`)
- Credentials allowed for cookie auth

See also [`security.md`](./security.md) and [`operating-model.md`](./operating-model.md).
