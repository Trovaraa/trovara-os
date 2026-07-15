# Trovara OS - Operating Model & State Machines

This document defines the rules that make Trovara OS behave like an operating system, not just a set of screens. Based on product review feedback (Perplexity + internal plan).

## How a farm day runs

| Time | Who | Action | System surface |
|------|-----|--------|----------------|
| **06:00** | Supervisor | Open **Today** home - review overdue + pending approvals | Exception dashboard |
| **06:15** | Supervisor | Assign or confirm field tasks for the day | Tasks |
| **07:00–16:00** | Worker | One-tap: start task → submit for approval | Tasks (mobile) |
| **12:00** | Supervisor | Log inventory consumption from morning work | Inventory |
| **16:30** | Supervisor | Approve/reject submitted tasks; escalate blockers | Tasks queue |
| **17:00** | Owner | Review daily exception digest + P&L snapshot | Reports |
| **Weekly Mon** | Owner | Crop stage update per plot; stock count; order review | Crops, Inventory, Sales |

**Blockers** (must surface on Today home):
- Task overdue > 24h
- Item at or below reorder level
- Task awaiting approval > 12h
- Livestock mortality logged today
- Order pending > 48h

**Escalation path:** Worker logs → Supervisor approves/rejects → Owner sees exceptions + finance impact.

---

## System of record

| Object | System of record | Immutable events |
|--------|------------------|------------------|
| Plot | `plots` table | Create only; no delete in MVP |
| Task | `tasks` + `audit_events` | Status transitions logged; completed tasks not deleted |
| Inventory | `inventory_items` + `inventory_movements` | Movements append-only; quantity derived from movements |
| Crop cycle | `crop_cycles` | Stage transitions logged; harvest date set once |
| Livestock batch | `livestock_batches` + `livestock_logs` | Logs append-only; mortality decrements head count |
| Harvest lot | `harvest_lots` | Lot code immutable after create |
| Order | `orders` | Status transitions logged |
| Expense | `expenses` | Owner can edit; changes audit-logged |
| Audit | `audit_events` | Append-only, never update/delete |

---

## Required fields

### Plot
- `name`, `cropType`, `areaAcres`, `farmId`

### Task
- Required: `title`, `assignedToId`, `createdById`, `status`
- Optional: `description`, `plotId`, `dueDate`, `completionNote`

### Inventory item
- Required: `name`, `category`, `unit`, `quantity`, `reorderLevel`

### Inventory movement
- Required: `itemId`, `delta` (non-zero), `reason`, `recordedById`

### Crop cycle
- Required: `plotId`, `cropType`, `stage`, `plantedAt`
- Optional: `expectedHarvestAt`, `expectedYieldKg`, `notes`

### Livestock batch
- Required: `name`, `species`, `headCount`, `acquiredAt`
- Optional: `plotId`, `notes`

### Livestock log
- Required: `batchId`, `logType`, `recordedById`
- Conditional: `headCount` required for `mortality`

### Harvest lot
- Required: `lotCode` (unique per farm), `productName`, `quantityKg`, `harvestedAt`

### Order
- Required: `customerName`, `status`, `totalAmount`
- Optional: `customerPhone`, `lotId`, `notes`

### Expense
- Required: `category`, `description`, `amount`, `expenseDate`, `recordedById`

---

## State machines

### Task

```
pending → in_progress → awaiting_approval → completed
                              ↓
                          rejected → in_progress (worker resubmits)
```

| Transition | Allowed roles |
|------------|---------------|
| pending → in_progress | worker (own), supervisor, owner |
| in_progress → awaiting_approval | worker (own) |
| awaiting_approval → completed | supervisor, owner |
| awaiting_approval → rejected | supervisor, owner |
| rejected → in_progress | worker (own) |
| Any → archived | supervisor, owner (future) |

**Rules:** Workers cannot skip states. Supervisors cannot complete without approval step unless they performed the work themselves.

### Inventory movement
- Movements are **append-only** - no edit/delete in MVP
- Negative delta blocked if result quantity < 0
- Partial delivery: multiple movements with reason "partial delivery batch X"

### Crop cycle stage

```
planted → germination → vegetative → flowering → fruiting → harvest_ready → harvested
```

| Transition | Allowed roles |
|------------|---------------|
| Advance one stage | supervisor, owner |
| Set harvested + actualYieldKg | supervisor, owner |

Stages cannot move backward without owner override (future).

### Order

```
pending → confirmed → dispatched → delivered
   ↓           ↓
cancelled   cancelled
```

| Transition | Allowed roles |
|------------|---------------|
| pending → confirmed | supervisor, owner |
| confirmed → dispatched | supervisor, owner (sets dispatchedAt) |
| dispatched → delivered | supervisor, owner |
| pending/confirmed → cancelled | supervisor, owner |

### Livestock log types
- `feeding`, `vaccination`, `health_check` - append only
- `mortality` - decrements `headCount`; cannot exceed current count
- `incident` - triggers exception digest entry

---

## Exception workflows

| Exception | Detection | Action |
|-----------|-----------|--------|
| Late task | `dueDate` passed, status ≠ completed | Surface on Today home; daily digest |
| Rejected task | status = rejected | Worker notified (future WhatsApp); resubmit |
| Low stock | quantity ≤ reorderLevel | Alert on dashboard + digest |
| Inventory burn rate | avg daily consumption × days remaining | Report: days until stockout |
| Missing data | required field null on submit | Zod validation error, block save |
| Duplicate lot code | unique constraint | 400 error with message |
| Offline log | client queue (future) | Sync on reconnect; timestamp preserved |
| Pest/disease incident | livestock_log or task tag = incident | Escalate to owner digest |
| Partial delivery | movement reason contains batch ref | Allow multiple partial movements |

---

## Report definitions

Each report states: **purpose**, **metrics**, **frequency**, **audience**.

| Report | Purpose | Key metrics | Frequency | Audience |
|--------|---------|-------------|-----------|----------|
| **Daily exception digest** | What needs attention now | overdue tasks, pending approvals, low stock, today's mortality | Daily 17:00 | owner, supervisor |
| **Manager action list** | What to do next | unassigned tasks, awaiting approval, orders pending | Real-time | supervisor |
| **Daily ops summary** | Confirm day ran correctly | tasks by status, completion rate | Daily | owner |
| **Inventory burn rate** | Prevent stockouts | avg daily use, days remaining, reorder items | Daily | supervisor, owner |
| **Plot activity timeline** | Trace work per plot | tasks + movements + crop stage changes by plot | Weekly | owner, supervisor |
| **Profitability bridge** | Link work to cost | expenses by category, revenue, net, cost per plot (future) | Weekly | owner |
| **Trust / audit report** | Compliance + tokenization prep | all mutations by user, entity, timestamp | On demand | owner |
| **Weekly P&L** | Financial health | revenue, expenses, net margin | Weekly Mon | owner |

---

## UX principles (mobile-first, bilingual)

- **Today home** - only urgent items; max 5 cards
- **One-tap actions** - Start, Submit, Approve on task cards
- **Large touch targets** - min 44px tap areas on field screens
- **Languages** - English primary; Yoruba + Pidgin for worker-facing labels and WhatsApp templates
- **Search/filters** - tasks by status/plot/assignee; inventory by category
- **Saved views** - "My tasks today", "Pending approvals" (supervisor)

---

## AI direction (automation, not chatbot)

Phase 4 AI should automate operations, not generic chat:

| Feature | Input | Output |
|---------|-------|--------|
| Daily summary | tasks, inventory, exceptions | Plain-language briefing |
| Anomaly detection | movement deltas, task delays | Risk flags on dashboard |
| Incident clustering | livestock_logs, task notes | Grouped incident summary |
| Suggested actions | pending approvals, low stock | "Approve X", "Reorder Y" list |
| WhatsApp drafts | template + context | Pre-filled message for supervisor send |

---

## Go-live checklist (internal Trovara)

- [ ] Node 22 LTS on all devices
- [ ] `.env` secrets rotated from dev defaults
- [ ] `pg_dump` backup script documented and tested
- [ ] Admin recovery: owner can reset supervisor passwords
- [ ] Offline failure mode documented (manual WhatsApp fallback)
- [ ] 2-week pilot with owner + 2 supervisors logging daily

## Commercial checklist (future SaaS)

- [ ] Tenant onboarding wizard (farm name, plots, users)
- [ ] Demo data reset per tenant
- [ ] Feature flags by plan tier
- [ ] Export/import (JSON) for migration
- [ ] Billing integration (deferred)

---

## Priority next build items (recommended order)

1. **Formal state machines in code** - enforce transitions server-side (tasks partially done)
2. **Report definition layer** - `/api/reports/digest`, burn rate, action list
3. **Manager exception dashboard** - replace generic dashboard with Today home
4. **Mobile-first + bilingual UI** - worker task screen, i18n scaffold
5. **Backup/recovery runbook** - `docs/backup.md` + pg_dump script
6. **Tenant onboarding + demo reset** - for SaaS path
