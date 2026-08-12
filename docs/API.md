# Trovara OS - API Contract

Base URL (local dev): `http://127.0.0.1:3000`

Production runtime environment and feature-conditional variables are documented
in [`PRODUCTION-ENVIRONMENT.md`](./PRODUCTION-ENVIRONMENT.md). Database
migrations currently run through
`20260811173000_0054_payment_status_idempotency`; use the
[expand-contract policy](./EXPAND-CONTRACT-MIGRATIONS.md) for future changes.

All authenticated routes require the `trovara_session` httpOnly cookie. Mutating requests (`POST`, `PATCH`, `DELETE`) also require the double-submit CSRF token: cookie `trovara_csrf` must match header `X-CSRF-Token`. The CSRF cookie is set on successful login.

Errors return JSON: `{ "error": "message" }` with appropriate HTTP status.

Roles: `owner` | `supervisor` | `sales` | `field_worker`

## Journal CMS

Owner-only authenticated reads are `GET /api/journal` and
`GET /api/journal/:id`. Owner-only mutations are `POST /api/journal` (always creates a draft),
`PATCH /api/journal/:id` (including `{ published: true|false }`), and
`DELETE /api/journal/:id`. `POST /api/journal/media` accepts
`{ dataUrl }` for a JPEG, PNG, or WebP cover image up to 1.5 MB and returns
`{ url }` (a `/public/journal/media/{farmId}/{file}` path for storage and marketing).
Owner preview of that file is `GET /api/journal/media/:filename` (session farm only).

Public, rate-limited reads are `GET /public/journal`,
`GET /public/journal/:slug`, and `GET /public/journal/media/:farmId/:filename`.
They expose published posts / public cover bytes only; the list omits
`bodyMarkdown`, while detail includes it. Public cover URLs serve only files
from the dedicated Journal media store. Public farm selection prefers
`CUSTOMER_FARM_ID`, then `TELEGRAM_CUSTOMER_FARM_SLUG`, then the oldest farm.

---

## Newsletter

Trovara OS is the subscriber and consent source of truth. Public subscribe,
confirm, unsubscribe, and signed-webhook actions are rate-limited JSON `POST`
routes below `/public/newsletter`.

- `/subscribe` accepts `name`, `email`, optional `phone`, required
  `consent: true`, `phoneConsent`, and optional `honey`. A phone number requires
  separate phone consent.
- `/confirm` and `/unsubscribe` accept `{ token }`. Raw tokens are never stored.
- `/webhook` accepts only verified Resend/Svix events and deduplicates them by
  `svix-id`.

The owner-only `GET /api/newsletter` list supports optional `status` and
`search` query parameters. Owners can resend pending confirmation, retry Resend
sync, or unsubscribe while retaining consent history using
`POST /api/newsletter/:id/resend-confirmation`,
`POST /api/newsletter/:id/sync`, and `PATCH /api/newsletter/:id/status`.
Re-subscribing requires the subscriber to submit and confirm the public form.

---

## Marketing contacts and product waitlists

Trovara OS is the source of truth for website enquiries and product waitlists.
These records are separate from newsletter consent and are never added to
newsletter subscribers, Resend Contacts, or a Resend Segment.

The public, per-IP rate-limited routes are:

- `POST /public/leads/contact` with
  `{ name, email, phone?, message, subject, honey? }`. `subject` is one of
  `general`, `bulk-order`, `waitlist`, `shop`, `farm-visit`, `farm-os`,
  `farm-advisory`, `partnership`, `export`, `media`, or `other`.
- `POST /public/leads/waitlist` with `{ name, contact, product, honey? }`.
  `contact` is an email or phone number and `product` is `coconut`, `plantain`,
  `poultry`, `eggs`, or `palm-oil`.

Both return the enumeration-safe `{ "ok": true, "accepted": true }`. A filled
honeypot is accepted without persistence. Repeated joins for the same farm,
product, and normalized contact update the original row, increment
`submissionCount`, and reopen `closed` or `spam` leads as `new`.

Owners and Sales can use `GET /api/marketing-leads` with optional `type`,
`status`, and `search` filters. It returns `leads` and counts by status/type.
`PATCH /api/marketing-leads/:id` changes status and/or assignment; assignees
must be active owners or Sales users in the same farm.
`POST /api/marketing-leads/:id/notify` retries staff notification. Every query
is farm-scoped, no delete endpoint exists, and changes are audited.

Initial staff notification is best-effort and never makes a public submission
fail. Delivery status, error, and attempt time remain on the lead for retry.
It uses the existing transactional Resend setup (`RESEND_API_KEY` plus
`EMAIL_FROM` or `RESEND_FROM`). Set the optional
`MARKETING_LEAD_NOTIFICATION_EMAILS` comma-separated list to target known
mailboxes; otherwise active Owner/Sales users are used, excluding break-glass.

---

## Health

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/health` | No | - | `{ status, service }` |
| GET | `/ready` | No | - | `200` when the database is reachable; otherwise `503` |

The deployed frontend also serves `/RELEASE.json` with the immutable Git SHA,
optional exact tag, and release timestamp. It is deployment metadata, not an API
route.

Authenticated owners can read `GET /system-status`. Its sanitized operations
fields include backup report/delivery state and restore-test status, age, and
freshness; it does not expose artifact paths or credentials.

---

## Auth (`/auth`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| POST | `/auth/login` | No | - | `{ email, password }` | `{ user, mustChangePassword? }` + cookies. Break-glass email uses armed `BREAK_GLASS_PASSWORD` (`BREAK_GLASS_ENABLED=true`; 1-hour session). |
| POST | `/auth/logout` | Yes | any | - | `{ ok: true }` |
| GET | `/auth/me` | Yes | any | - | `{ user }` |
| GET | `/auth/preferences` | Yes | owner | - | `{ butlerTtsMode, orderAlertsSubscribed, workerAlertsSubscribed }` |
| PATCH | `/auth/preferences` | Yes | owner | partial prefs | updated prefs |

Login rate limit: 5 attempts per IP per 15 minutes.

---

## Customer Shop (`/shop`)

Customer-facing shop authentication with email verification and password reset.

| Method | Path | Auth | Request | Response |
|--------|------|------|---------|----------|
| POST | `/shop/register` | No | `{ email, password, name, phone? }` | `{ ok: true, needsVerification: true, message }`. Never returns 409 for anti-enumeration. Sends verification email. |
| POST | `/shop/login` | No | `{ email, password }` | `{ account, csrfToken }` + cookies. Returns 403 with `needsVerification: true` if email unverified. Rate limited. |
| POST | `/shop/logout` | Yes | - | `{ ok: true }` |
| GET | `/shop/me` | Yes | - | `{ account, channels }` |
| GET | `/shop/session` | No | - | `{ csrfToken, account? }` |
| POST | `/shop/forgot-password` | No | `{ email }` | `{ ok: true, message }`. Generic response for anti-enumeration. |
| POST | `/shop/reset-password` | No | `{ token, newPassword }` | `{ ok: true, message }`. Revokes all sessions. |
| POST | `/shop/verify-email` | No | `{ token }` | `{ ok: true, message, account, csrfToken }`. Creates session on success. |
| POST | `/shop/resend-verification` | No | `{ email }` | `{ ok: true, message }`. Generic response for anti-enumeration. |
| GET | `/shop/orders` | Yes | - | `{ orders }` with items and traceability. |
| POST | `/shop/orders` | Yes | `{ items, address, phone? }` | Order created. Requires emailVerifiedAt. |
| GET | `/shop/catalog` | No | - | `{ farm, products }` |
| POST | `/shop/link-code` | Yes | - | `{ code, expiresAt, instruction }` for linking chat bots. |

**Security hardening:**
- Existing customer accounts grandfathered: `emailVerifiedAt` set to `createdAt` on migration.
- New registrations: `emailVerifiedAt` null until verified; no session created.
- Login: requires verified email; rate limited (5/15min per IP).
- Orders: require verified email (`emailVerifiedAt IS NOT NULL`).
- Password reset links expire in 1 hour, verification links in 48 hours.
- All tokens are high-entropy, single-use, SHA256 hashed.
- Anti-enumeration: register/forgot-password/resend-verification return generic messages.
- CSRF exempt: register, login, forgot-password, reset-password, verify-email, resend-verification.

Email links use `PUBLIC_MARKETING_URL` (fallback `https://trovara.farm`):
- Password reset: `/shop/reset-password?token=...`
- Email verification: `/shop/verify-email?token=...`

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

## Attendance (`/api/attendance`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/attendance/today` | Yes | all (Sales/worker: own) | - | `{ sessions[] }` |
| GET | `/api/attendance/summary` | Yes | all (Sales/worker: own; Admin/Supervisor: farm-wide or `userId`) | `?range=day\|week\|month\|ytd&userId?=` | `{ range, people[] }` |
| POST | `/api/attendance/clock-in` | Yes | all | `{ plotId?, taskId?, notes? }` | attendance session |
| POST | `/api/attendance/clock-out` | Yes | all | `{ workSummary?: string \| null }` | attendance session |
| PATCH | `/api/attendance/:id` | Yes | owner, supervisor | attendance correction | `{ session }` |

`workSummary` is optional and limited to 2,000 characters. The clock-out still succeeds when it is omitted.
Hours summary ranges use the farm timezone. Open shifts accrue through the
current time; sessions are grouped by staff member and ordered by total minutes.

---

## Inventory (`/api/inventory`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/inventory/` | Yes | all | - | `{ items[] }` with `lowStock` flag |
| POST | `/api/inventory/items` | Yes | owner, supervisor | `{ sku?, name, category, unit, quantity?, reorderLevel?, varianceTolerance?, costPerUnit?, supplier?, expiryDate?, storageLocation?, batchNumber? }` | `{ item }`, 201 |
| PATCH | `/api/inventory/items/:id` | Yes | owner, supervisor | `{ sku?, name?, category?, unit?, reorderLevel?, varianceTolerance?, costPerUnit?, supplier?, expiryDate?, storageLocation?, batchNumber? }` | `{ item }` |
| POST | `/api/inventory/movements` | Yes | owner, supervisor | `{ itemId, delta, reason }` | `{ item }` |
| POST | `/api/inventory/opening-count` | Yes | owner, supervisor | `{ items: [{ itemId, countedQuantity }] }` | `{ items[] }` |
| GET | `/api/inventory/count-sessions` | Yes | all | - | `{ sessions[] }` |
| POST | `/api/inventory/count-sessions` | Yes | owner, supervisor, field_worker | `{ taskId?, locationText?, lines: [{ itemId?, itemName, category?, unit?, countedQuantity, notes? }] }` | `{ session }`, 201 |
| POST | `/api/inventory/count-sessions/:id/verify` | Yes | owner, supervisor | `{ status: 'verified' \| 'rejected', rejectionReason? }` | `{ session }` |
| GET | `/api/inventory/reconciliation-alerts` | Yes | owner, supervisor | - | `{ alerts[] }` |
| PATCH | `/api/inventory/reconciliation-alerts/:id` | Yes | owner, supervisor | `{ status: 'acknowledged' \| 'resolved' }` | `{ alert }` |
| GET | `/api/inventory/shrink-alerts` | Yes | owner, supervisor | - | `{ alerts[] }` period I/O leakage |
| POST | `/api/inventory/shrink-alerts/refresh` | Yes | owner, supervisor | `?days=30` | `{ created, updated, cleared, items[] }` |
| PATCH | `/api/inventory/shrink-alerts/:id` | Yes | owner, supervisor | `{ status: 'acknowledged' \| 'resolved' }` | `{ alert }` |
| GET | `/api/inventory/low-stock` | Yes | all | - | `{ items[] }` |

Negative delta blocked if quantity would go below zero.

Creating and correcting an item, recording movements and setting opening counts
are restricted to owners and supervisors. Sales may read inventory to fulfil an
order, but cannot modify stock through the API. PATCH changes only the fields the
body carries and returns 404 for another farm's item. It does not accept `quantity` — stock moves
only through movements and counts, so every change to it keeps a movement row
behind it.

`unit` may be corrected only while nothing has ever moved against the item. A
movement's `delta` is a bare number and the unit lives on the item, so once the
ledger holds a row the unit is what that whole history is denominated in and
changing it would silently restate every past move: that is a 400. An item
already carrying movements needs a new item under the correct unit instead.

A count session may be submitted by operational staff, but never Sales. Only an
owner or supervisor may resolve it, and nobody may verify their own: that is a 400, as is a
rejection with no `rejectionReason` and a session already resolved. Lines cap at
200. Each linked line snapshots the expected quantity and computes a variance.
If the variance exceeds the item's tolerance, Trovara creates a reconciliation
alert for a manager to acknowledge or resolve before the discrepancy is forgotten.

Items may optionally link to a catalogue `productId` (one stock row per product).
Dispatch of a paid order decrements linked stock with reason `sale`. Verified
harvest lots credit linked stock with reason `harvest_in`. Manual outs may use
typed `spoilage` or free-text adjust reasons. Period shrink reports compare
inputs vs typed outs and sold qty vs sale movements; `POST …/shrink-alerts/refresh`
persists open leakage alerts when unexplained out or sales/stock mismatch exceeds
the item's variance tolerance.

Every inventory item has a farm-unique SKU. Legacy API callers may omit it and
receive a generated `INV-XXXXXXXX` SKU. Units are controlled values so the
same stock is not measured inconsistently across movements and counts.

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
| GET | `/api/reports/inventory-shrink` | Yes | owner, supervisor | Input/output shrink report (`?days=30`) |
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

## Products (`/api/products`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/products/` | Yes | all | - | `{ products[] }` |
| POST | `/api/products/` | Yes | owner, supervisor, sales | `{ sku?, name, unit, priceKobo?, currency?, active?, sortOrder? }` | `{ product }`, 201 |
| PATCH | `/api/products/:id` | Yes | owner, supervisor, sales | partial product | `{ product }` |
| DELETE | `/api/products/:id` | Yes | owner | - | `{ ok: true }` (soft delete) |

Each SKU is unique within a farm and normalized to uppercase. Legacy API callers
may omit it and receive a generated `PRD-XXXXXXXX` SKU. Product units are
controlled (`kg`, `tonne`, `crate`, `tray`, `bag`, `bunch`, `piece`, `pack`,
`bird`, `litre`, `unit`) so order and harvest metrics stay comparable.

---

## Field reports (`/api/field-reports`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/field-reports/` | Yes | owner, supervisor, field_worker | - | `{ reports[] }` (worker: own) |
| POST | `/api/field-reports/` | Yes | owner, supervisor, field_worker | `{ category, severity?, description, plotId?, batchId?, assetId?, photoUrl? }` | `{ report }`, 201 |
| PATCH | `/api/field-reports/:id` | Yes | owner, supervisor | `{ status, assignedToId? }` | `{ report }` |

Urgent, critical and theft reports notify the configured operational alert
channels. Photo evidence is optional and validated against the evidence data-URL allowlist.

---

## Customer support (`/api/support`)

| Method | Path | Auth | Roles | Request | Response |
|--------|------|------|-------|---------|----------|
| GET | `/api/support/` | Yes | owner, supervisor, sales | - | `{ tickets[] }` |
| POST | `/api/support/` | Yes | owner, supervisor, sales | `{ description, contactId?, orderId?, category?, priority? }` | `{ ticket }`, 201 |
| PATCH | `/api/support/:id` | Yes | owner, supervisor, sales | `{ status, priority?, assignedToId? }` | `{ ticket }` |

Customer WhatsApp/Telegram order conversations also accept `4`, `complaint`,
`support`, `problem`, or `issue`. Trovara returns a reference in the form
`TRV-SUP-YYYYMMDD-XXXXXX` and adds the ticket to the same staff queue.

---

## Finance (`/api/finance`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/finance/` | Yes | owner | `{ expenses[] }` |
| GET | `/api/finance/summary` | Yes | owner | `{ summary }` |
| POST | `/api/finance/` | Yes | owner | `{ expense }` |
| PATCH | `/api/finance/:id` | Yes | owner | `{ expense }` |
| DELETE | `/api/finance/:id` | Yes | owner | `{ ok: true }` |

### Resend finance inbound (`/public/finance/inbound`)

`POST /public/finance/inbound` is an unauthenticated, rate-limited Resend
Receiving webhook. It requires the raw request body plus `svix-id`,
`svix-timestamp`, and `svix-signature`; the signature is verified with the
separate `RESEND_INBOUND_WEBHOOK_SECRET`. Missing or invalid signature headers
return `401`, and missing `RESEND_API_KEY` or webhook secret returns `503`.

Only `email.received` events addressed to `FINANCE_INBOUND_RECIPIENTS` create a
pending expense. The setting is a comma-separated address allowlist and defaults
to `finance@trovara.farm`. The same local part on a subdomain of an allowed
domain is also accepted for Receiving/forwarding hosts (for example,
`finance@inbound.trovara.farm`); unrelated recipients are acknowledged and
ignored.

Successful responses contain `{ received: true, ok: true, expenseId? }` and may
include `duplicate: true` or `ignored: true`. Events are deduplicated by
`svix-id`, then by Resend `email_id`. The first PDF, JPEG, PNG, or WebP
attachment up to 25 MB is stored under the private evidence root and linked to
the draft expense.

---

## Traceability (`/api/traceability`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/traceability/` | Yes | staff | `{ lots[] }` |
| POST | `/api/traceability/` | Yes | role-gated | `{ productId, quantityKg, unit?, plotId?, cropCycleId?, harvestedAt?, publicNotes?, internalNotes?, photoUrl? }` | `{ lot }` |
| PATCH | `/api/traceability/:id` | Yes | role-gated | `{ lot }` |
| DELETE | `/api/traceability/:id` | Yes | owner | `{ ok: true }` |
| GET | `/api/traceability/export` | Yes | owner | `{ exportedAt, harvestLots, auditChain }` |
| GET | `/api/traceability/:id/certificate.html` | Yes | staff | Traceability certificate HTML |
| GET | `/api/traceability/:id/label.html` | Yes | staff | Printable box QR label HTML |

Public (no auth): `GET /public/lots/:token` (lot page), certificate/label HTML under `/public/lots/...` where exposed.

The current app requires standalone lots to select a catalogue `productId`.
Order-created lots inherit the ordered product ID automatically, preserving
SKU-to-lot traceability. The API temporarily accepts a name-only legacy payload
so older field clients can continue syncing while they are upgraded.

---

## AI (`/api/ai`)

| Method | Path | Auth | Roles | Response |
|--------|------|------|-------|----------|
| GET | `/api/ai/status` | Yes | `ai.use` | Model availability |
| GET | `/api/ai/conversations` | Yes | `ai.use` | Current user's active conversation list |
| POST | `/api/ai/conversations` | Yes | `ai.use` | Create a private conversation |
| GET | `/api/ai/conversations/:id` | Yes | `ai.use` | Owned conversation and persisted messages |
| DELETE | `/api/ai/conversations/:id/messages` | Yes | `ai.use` | Clear owned conversation messages and stored attachments |
| POST | `/api/ai/conversations/:id/archive` | Yes | `ai.use` | Archive owned conversation |
| POST | `/api/ai/ask` | Yes | `ai.use` | Permission-filtered answer or reviewable action draft |
| GET | `/api/ai/actions/capabilities` | Yes | `ai.use` | Action types allowed by the user's current grants |
| POST | `/api/ai/actions/:draftId/confirm` | Yes | `ai.use` + action permission | Revalidate and execute an owned action draft |
| POST | `/api/ai/actions/:draftId/cancel` | Yes | `ai.use` | Cancel an owned action draft |
| POST | `/api/ai/transcribe` | Yes | `ai.use` | Voice transcription |
| GET | `/api/ai/briefing` | Yes | owner, supervisor | `{ locale, priorities[], ... }` daily briefing built from farm counts |
| POST | `/api/ai/summarize-incident` | Yes | owner, supervisor | Placeholder incident summary |

`/briefing` is deterministic: priorities come from task and stock counts, never a model, so it
works with the LLM off. Labels are rendered server-side in the caller's `preferred_locale` and
echoed as `locale`; counts, units, item names and the farm name are interpolated verbatim.

Web Copilot conversations are scoped by both `farm_id` and `user_id`; another user cannot list,
open, clear, archive, confirm, or cancel them. The API builds model history from persisted server
messages and ignores client-supplied history as a source of authority. Uploaded photos are stored
as private evidence references rather than retaining data URLs in the database.

AI never grants an operation by itself. Explicit commands may prepare typed drafts for tasks,
inventory, zones/plots, livestock logs, census, asset counts, field reports, and customer support.
The required OS permission is checked when the draft is prepared and again when it is confirmed.
Sales can use permitted order/support actions but cannot change inventory through AI.

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
