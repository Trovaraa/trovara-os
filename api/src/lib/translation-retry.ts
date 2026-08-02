/**
 * Retry job for content that was stored in the author's own language.
 *
 * A translation failure must never block a farm worker's write, so the write
 * paths store the original French/Yoruba/Pidgin text and mark the row
 * `translationStatus: 'pending'`. That is the only way non-English text ever
 * reaches a content column, and it is meant to be transient — this job is what
 * makes it transient.
 *
 * Every table carrying prose has to appear in `TEXT_TABLES` below. A table with
 * the locale columns but no entry here is the worst possible state: its rows sit
 * at 'pending' forever, or worse reach 'done' still holding another language,
 * and nothing ever looks at them again. The registry is therefore the whole
 * design — adding a table is a data change, not a new code path.
 *
 * Design notes that are easy to get wrong:
 *  - Bounded: at most `limit` rows are examined per table per run.
 *  - Give-up counter: `translation_attempts` (migration 0029) counts *failed
 *    LLM attempts*, and a row is abandoned ('failed') once it reaches
 *    `giveUpAttempts`. It replaces the old `updatedAt`/`createdAt` clock, which
 *    an unrelated edit could reset and which aged rows out while the job was
 *    down without ever having tried them. Running out of budget is not an
 *    attempt, so a starved farm never ages out either.
 *  - Budget: backfill may only use `budgetShare` of a farm's daily LLM budget,
 *    so an unattended run cannot starve the interactive butler.
 *  - Concurrency: every write is a compare-and-set on the row still being
 *    'pending' and on each column still holding the exact text we translated,
 *    so a second copy of this job — or a worker editing the row while the LLM
 *    call was in flight — can never be clobbered. No row locks are held across
 *    an LLM call, because that could block the worker's own write.
 */
import { and, asc, Column, eq, getTableName, inArray, is, ne, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn, PgTable, PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { db } from '../db/index.js'
import {
  actionDrafts,
  advisoryObservations,
  assetEvents,
  assetLogs,
  assets,
  attendanceSessions,
  cropCensusSurveys,
  cropCycleTasks,
  cropCycles,
  customerInquiries,
  expenses,
  goodsReceipts,
  harvestLots,
  inventoryCountLines,
  inventoryCountSessions,
  inventoryItems,
  inventoryMovements,
  livestockBatches,
  livestockLogs,
  livestockScheduleEntries,
  orders,
  paymentRefunds,
  plots,
  purchaseOrders,
  suppliers,
  taskTemplates,
  tasks,
  zones,
} from '../db/schema.js'
import { logApiEvent } from './api-log.js'
import { authorLocaleHint, isTranslatable, toCanonicalEnglish } from './content-locale.js'
import { normalizeQuestion } from './customer-inquiry.js'
import { checkLlmBudget } from './llm-budget.js'
import { DRAFT_FREE_TEXT_FIELDS } from './draft-canonical.js'
import { MOVEMENT_REASON_SENTINELS } from './inventory-stock.js'

const DEFAULT_BATCH_LIMIT = 20
const MAX_BATCH_LIMIT = 200
const DEFAULT_GIVE_UP_ATTEMPTS = 6
const DEFAULT_BUDGET_SHARE = 0.5

export type TranslationRetryCounts = {
  /** Pending rows examined this run (never the whole table). */
  scanned: number
  /** Rows fully translated and moved to 'done'. */
  translated: number
  /** Rows left 'pending' for a later run, including partial successes. */
  stillPending: number
  /** Rows abandoned as 'failed'; their original text is left untouched. */
  failed: number
  /** Rows skipped because the farm had no backfill budget left today. */
  budgetSkipped: number
}

export type TranslationRetryOptions = {
  /** Max rows examined per table per run. Cron and tests deliberately differ. */
  limit?: number
  /** Restrict the run to one farm. */
  farmId?: string
  /** Abandon a row after this many failed translation attempts. */
  giveUpAttempts?: number
  /** Fraction of a farm's daily LLM budget this job may consume. */
  budgetShare?: number
  /** Injectable clock for tests. */
  now?: Date
}

type ResolvedOptions = {
  limit: number
  farmId?: string
  giveUpAttempts: number
  budgetShare: number
}

function positiveNumber(raw: number | string | undefined, fallback: number): number {
  const n = Number(raw ?? '')
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function resolveOptions(options: TranslationRetryOptions): ResolvedOptions {
  const limit = Math.min(
    Math.floor(
      positiveNumber(
        options.limit ?? process.env.TRANSLATION_RETRY_BATCH_LIMIT,
        DEFAULT_BATCH_LIMIT,
      ),
    ),
    MAX_BATCH_LIMIT,
  )
  const giveUpAttempts = Math.floor(
    positiveNumber(
      options.giveUpAttempts ?? process.env.TRANSLATION_RETRY_GIVE_UP_ATTEMPTS,
      DEFAULT_GIVE_UP_ATTEMPTS,
    ),
  )
  const budgetShare = Math.min(
    positiveNumber(
      options.budgetShare ?? process.env.TRANSLATION_RETRY_BUDGET_SHARE,
      DEFAULT_BUDGET_SHARE,
    ),
    1,
  )

  return {
    limit,
    farmId: options.farmId,
    giveUpAttempts,
    budgetShare,
  }
}

/**
 * True while this job may still call the LLM for the farm. Consumption is
 * recorded inside `content-locale` (shared with the butler), so reading the
 * live counter here is what leaves interactive users their headroom: once the
 * farm's day is `budgetShare` spent — by backfill or by workers — backfill stops.
 */
function hasBackfillHeadroom(farmId: string, budgetShare: number): boolean {
  const { allowed, used, limit } = checkLlmBudget(farmId)
  return allowed && used < Math.floor(limit * budgetShare)
}

/**
 * `inventory_movements.reason` doubles as a marker column: the stock paths write
 * sentinel strings (see `MOVEMENT_REASON_SENTINELS`) and only the hand-typed
 * reasons next to them are prose. They read like lowercase words, so
 * `isTranslatable` cannot tell them apart — they need that shared list.
 */

/**
 * `orders.source` is 'staff' for a web-entered order and the channel name for
 * one the bot took. Listing the staff value rather than the bot ones means a
 * channel added later is left verbatim until someone says otherwise.
 */
const STAFF_AUTHORED_ORDER = { column: orders.source, values: new Set(['staff']) }

/** One prose column, and whatever makes it special. */
type ProseColumn = {
  column: AnyPgColumn
  /** A json array of strings, translated element by element. */
  array?: true
  /** Machine-written markers sharing the column with prose; never translated. */
  sentinels?: ReadonlySet<string>
  /**
   * A sibling column that decides whether this field is prose for a given row,
   * and the values that say it is. Everything else is left verbatim, so a new
   * writer has to opt in rather than inherit translation by accident.
   */
  proseOnlyWhen?: { column: AnyPgColumn; values: ReadonlySet<string> }
  /**
   * Columns that are a pure function of this one and must be rewritten in the
   * same statement. Returning null means the derivation failed and the
   * translation is dropped, because saving one without the other is worse.
   */
  derive?: (english: string) => Record<string, string> | null
}

/**
 * How to reach the farm that owns a row. The per-farm budget check makes this
 * mandatory: a table with no `farm_id` of its own has to be joined to one.
 */
type FarmRef =
  | { kind: 'own'; column: AnyPgColumn }
  | {
      kind: 'parent'
      /** Foreign key on the swept table. */
      local: AnyPgColumn
      parent: PgTable
      parentId: AnyPgColumn
      parentFarmId: AnyPgColumn
    }

type TextTableSpec = {
  name: string
  table: PgTable
  id: AnyPgColumn
  farm: FarmRef
  sourceLocale: AnyPgColumn
  status: AnyPgColumn
  attempts: AnyPgColumn
  /** Ordering only — oldest backlog first. Give-up is by `attempts`. */
  clock: AnyPgColumn
  fields: Readonly<Record<string, ProseColumn>>
}

function ownFarm(column: AnyPgColumn): FarmRef {
  return { kind: 'own', column }
}

function farmColumn(farm: FarmRef): AnyPgColumn {
  return farm.kind === 'own' ? farm.column : farm.parentFarmId
}

/** Columns migration 0029 gave every prose table, under these shared names. */
const LOCALE_COLUMNS = ['id', 'sourceLocale', 'translationStatus', 'translationAttempts'] as const

/**
 * Registry entry from the few things that actually differ per table. The locale
 * quartet is looked up by property name rather than spelled out 25 times; a
 * table that is missing one throws at import, so a typo cannot become a
 * silently unswept table.
 */
function proseTable(entry: {
  table: PgTable
  farm: FarmRef
  clock: AnyPgColumn
  /** A bare column is shorthand for a plain prose column. */
  fields: Readonly<Record<string, ProseColumn | AnyPgColumn>>
}): TextTableSpec {
  const columns = entry.table as unknown as Record<string, AnyPgColumn | undefined>
  for (const name of LOCALE_COLUMNS) {
    if (!columns[name]) {
      throw new Error(`${getTableName(entry.table)} has no ${name} column`)
    }
  }

  const fields: Record<string, ProseColumn> = {}
  for (const [name, field] of Object.entries(entry.fields)) {
    fields[name] = is(field, Column) ? { column: field as AnyPgColumn } : (field as ProseColumn)
  }

  return {
    name: getTableName(entry.table),
    table: entry.table,
    id: columns.id!,
    farm: entry.farm,
    sourceLocale: columns.sourceLocale!,
    status: columns.translationStatus!,
    attempts: columns.translationAttempts!,
    clock: entry.clock,
    fields,
  }
}

/**
 * Every table whose prose columns this job owns. Columns absent from an entry
 * are deliberate: lookup keys matched by exact or lowercased string (plot, zone,
 * batch, asset, item and product names, crop types, lot codes) and i18n message
 * keys (`assets.cond.<condition>`) must survive untranslated, or the lookups and
 * labels that read them break.
 */
const TEXT_TABLES: readonly TextTableSpec[] = [
  proseTable({
    table: tasks,
    farm: ownFarm(tasks.farmId),
    clock: tasks.updatedAt,
    fields: {
      title: tasks.title,
      description: tasks.description,
      completionNote: tasks.completionNote,
      rejectionReason: tasks.rejectionReason,
    },
  }),
  proseTable({
    table: livestockLogs,
    farm: ownFarm(livestockLogs.farmId),
    clock: livestockLogs.createdAt,
    fields: { notes: livestockLogs.notes },
  }),
  proseTable({
    table: cropCycleTasks,
    farm: ownFarm(cropCycleTasks.farmId),
    clock: cropCycleTasks.updatedAt,
    // `stage` is an enum and the offsets are numbers; only the two the farmer
    // reads are prose.
    fields: {
      templateName: cropCycleTasks.templateName,
      description: cropCycleTasks.description,
    },
  }),
  proseTable({
    table: livestockScheduleEntries,
    farm: ownFarm(livestockScheduleEntries.farmId),
    clock: livestockScheduleEntries.updatedAt,
    // `vaccine` is a product name, but a farmer types it in their own language
    // and it is displayed rather than matched, so it is translated like any
    // other prose. `day_offset` and `source` are not text.
    fields: {
      name: livestockScheduleEntries.name,
      vaccine: livestockScheduleEntries.vaccine,
    },
  }),
  proseTable({
    table: attendanceSessions,
    farm: ownFarm(attendanceSessions.farmId),
    clock: attendanceSessions.createdAt,
    fields: { notes: attendanceSessions.notes },
  }),
  proseTable({
    table: cropCensusSurveys,
    farm: ownFarm(cropCensusSurveys.farmId),
    clock: cropCensusSurveys.createdAt,
    fields: {
      conditionNotes: cropCensusSurveys.conditionNotes,
      mortalityNotes: cropCensusSurveys.mortalityNotes,
      rejectionReason: cropCensusSurveys.rejectionReason,
    },
  }),
  proseTable({
    table: taskTemplates,
    farm: ownFarm(taskTemplates.farmId),
    clock: taskTemplates.createdAt,
    fields: {
      name: taskTemplates.name,
      description: taskTemplates.description,
      // Steps a worker ticks off one by one, so each element is its own prose.
      checklist: { column: taskTemplates.checklist, array: true },
    },
  }),
  proseTable({
    table: zones,
    farm: ownFarm(zones.farmId),
    clock: zones.createdAt,
    fields: { description: zones.description },
  }),
  proseTable({
    table: plots,
    farm: ownFarm(plots.farmId),
    clock: plots.createdAt,
    fields: { notes: plots.notes },
  }),
  proseTable({
    table: inventoryItems,
    farm: ownFarm(inventoryItems.farmId),
    clock: inventoryItems.createdAt,
    fields: { storageLocation: inventoryItems.storageLocation },
  }),
  proseTable({
    table: inventoryMovements,
    farm: ownFarm(inventoryMovements.farmId),
    clock: inventoryMovements.createdAt,
    fields: {
      reason: { column: inventoryMovements.reason, sentinels: MOVEMENT_REASON_SENTINELS },
    },
  }),
  proseTable({
    table: suppliers,
    farm: ownFarm(suppliers.farmId),
    clock: suppliers.createdAt,
    fields: { notes: suppliers.notes },
  }),
  proseTable({
    table: purchaseOrders,
    farm: ownFarm(purchaseOrders.farmId),
    clock: purchaseOrders.createdAt,
    fields: { notes: purchaseOrders.notes },
  }),
  proseTable({
    table: goodsReceipts,
    farm: ownFarm(goodsReceipts.farmId),
    clock: goodsReceipts.receivedAt,
    fields: { notes: goodsReceipts.notes },
  }),
  proseTable({
    table: cropCycles,
    farm: ownFarm(cropCycles.farmId),
    clock: cropCycles.createdAt,
    fields: { notes: cropCycles.notes },
  }),
  proseTable({
    table: advisoryObservations,
    farm: ownFarm(advisoryObservations.farmId),
    clock: advisoryObservations.createdAt,
    fields: { note: advisoryObservations.note },
  }),
  proseTable({
    table: livestockBatches,
    farm: ownFarm(livestockBatches.farmId),
    clock: livestockBatches.createdAt,
    fields: { notes: livestockBatches.notes },
  }),
  proseTable({
    table: harvestLots,
    farm: ownFarm(harvestLots.farmId),
    clock: harvestLots.createdAt,
    fields: {
      publicNotes: harvestLots.publicNotes,
      internalNotes: harvestLots.internalNotes,
    },
  }),
  proseTable({
    table: orders,
    farm: ownFarm(orders.farmId),
    clock: orders.createdAt,
    fields: {
      // A staff order's notes are the author's prose. An order that arrived
      // through a bot channel puts the customer's delivery address here
      // instead, so it is translated only for the staff-written case.
      notes: { column: orders.notes, proseOnlyWhen: STAFF_AUTHORED_ORDER },
      customerFeedback: orders.customerFeedback,
    },
  }),
  proseTable({
    table: paymentRefunds,
    farm: ownFarm(paymentRefunds.farmId),
    clock: paymentRefunds.createdAt,
    fields: { reason: paymentRefunds.reason },
  }),
  proseTable({
    table: assets,
    farm: ownFarm(assets.farmId),
    clock: assets.createdAt,
    fields: {
      notes: assets.notes,
      // Free-form "where it lives" text; never matched, only displayed.
      locationText: assets.locationText,
    },
  }),
  proseTable({
    table: assetEvents,
    farm: ownFarm(assetEvents.farmId),
    clock: assetEvents.createdAt,
    fields: { notes: assetEvents.notes },
  }),
  proseTable({
    table: assetLogs,
    farm: ownFarm(assetLogs.farmId),
    clock: assetLogs.createdAt,
    fields: { note: assetLogs.note },
  }),
  proseTable({
    table: customerInquiries,
    farm: ownFarm(customerInquiries.farmId),
    clock: customerInquiries.createdAt,
    fields: {
      question: {
        column: customerInquiries.question,
        // `normalized` is the GROUP BY key behind the "most asked" view. It has
        // to be recomputed from the English question with the same function the
        // write path used, or one question counts once per language it was
        // asked in. `normalizeQuestion` is imported rather than copied for
        // exactly that reason.
        derive: (english) => {
          const normalized = normalizeQuestion(english)
          return normalized ? { normalized } : null
        },
      },
    },
  }),
  proseTable({
    table: expenses,
    farm: ownFarm(expenses.farmId),
    clock: expenses.createdAt,
    fields: { description: expenses.description },
  }),
  proseTable({
    table: inventoryCountSessions,
    farm: ownFarm(inventoryCountSessions.farmId),
    clock: inventoryCountSessions.createdAt,
    fields: {
      rejectionReason: inventoryCountSessions.rejectionReason,
      locationText: inventoryCountSessions.locationText,
    },
  }),
  proseTable({
    table: inventoryCountLines,
    // No `farm_id` of its own: the owning farm comes from the session, and the
    // per-farm budget check cannot be skipped, so the scan joins for it.
    farm: {
      kind: 'parent',
      local: inventoryCountLines.sessionId,
      parent: inventoryCountSessions,
      parentId: inventoryCountSessions.id,
      parentFarmId: inventoryCountSessions.farmId,
    },
    clock: inventoryCountLines.createdAt,
    fields: { notes: inventoryCountLines.notes },
  }),
]

/**
 * Both clauses are deliberate. `<> 'done'` is spelled exactly like the
 * predicate of the partial index `<table>_translation_status_idx`, so the
 * planner matches it without having to prove implication; `= 'pending'` keeps
 * rows we already gave up on out of the batch.
 */
function pendingOnly(status: AnyPgColumn, farmColumn: AnyPgColumn, farmId?: string): SQL {
  const pending = and(ne(status, 'done'), eq(status, 'pending'))!
  return farmId ? and(pending, eq(farmColumn, farmId))! : pending
}

/** The tables share a shape but not a type, so dynamic writes need one cast. */
type DynamicSet = Record<string, unknown>

function updateSet(values: DynamicSet): PgUpdateSetSource<PgTable> {
  return values as PgUpdateSetSource<PgTable>
}

/**
 * The two scan shapes — with and without the parent join — run the identical
 * chain but have different static types, so the builder is narrowed to what
 * this job actually calls.
 */
type PendingScan = {
  innerJoin: (table: PgTable, on: SQL) => PendingScan
  where: (where: SQL) => {
    orderBy: (order: SQL) => {
      limit: (n: number) => Promise<Record<string, unknown>[]>
    }
  }
}

type ProseValue = string | string[] | null

type PendingRow = {
  id: string
  farmId: string
  sourceLocale: string | null
  attempts: number
  text: Record<string, ProseValue>
  /** Value of each field's `proseOnlyWhen` column, keyed by field name. */
  guards: Record<string, string | null>
}

const TEXT_PREFIX = 'text_'
const GUARD_PREFIX = 'guard_'

async function selectPending(spec: TextTableSpec, opts: ResolvedOptions): Promise<PendingRow[]> {
  const farm = farmColumn(spec.farm)
  const selection: Record<string, AnyPgColumn> = {
    id: spec.id,
    farmId: farm,
    sourceLocale: spec.sourceLocale,
    attempts: spec.attempts,
  }
  for (const [name, field] of Object.entries(spec.fields)) {
    selection[`${TEXT_PREFIX}${name}`] = field.column
    if (field.proseOnlyWhen) selection[`${GUARD_PREFIX}${name}`] = field.proseOnlyWhen.column
  }

  const scan = db.select(selection).from(spec.table) as unknown as PendingScan
  const scoped =
    spec.farm.kind === 'parent'
      ? scan.innerJoin(spec.farm.parent, eq(spec.farm.local, spec.farm.parentId))
      : scan

  const rows = await scoped
    .where(pendingOnly(spec.status, farm, opts.farmId))
    .orderBy(asc(spec.clock))
    .limit(opts.limit)

  return rows.map((row) => {
    const text: Record<string, ProseValue> = {}
    const guards: Record<string, string | null> = {}
    for (const [name, field] of Object.entries(spec.fields)) {
      const raw = row[`${TEXT_PREFIX}${name}`]
      text[name] = Array.isArray(raw) ? (raw as string[]) : ((raw as string | null) ?? null)
      if (field.proseOnlyWhen) {
        guards[name] = (row[`${GUARD_PREFIX}${name}`] as string | null) ?? null
      }
    }
    return {
      id: String(row.id),
      farmId: String(row.farmId),
      sourceLocale: (row.sourceLocale as string | null) ?? null,
      attempts: Number(row.attempts ?? 0),
      text,
      guards,
    }
  })
}

/** Abandon rows. Compare-and-set on 'pending' so a concurrent run cannot double-count. */
async function giveUp(spec: TextTableSpec, ids: string[], reason: string): Promise<number> {
  if (ids.length === 0) return 0
  const updated = (await db
    .update(spec.table)
    .set(updateSet({ translationStatus: 'failed' }))
    .where(and(inArray(spec.id, ids), eq(spec.status, 'pending'))!)
    .returning({ id: spec.id })) as { id: string }[]

  if (updated.length > 0) {
    logApiEvent('translation_retry_gave_up', {
      table: spec.name,
      reason,
      rows: updated.length,
      ids: updated.map((row) => row.id),
    })
  }
  return updated.length
}

function groupByFarm<T extends { farmId: string }>(rows: T[]): Map<string, T[]> {
  const byFarm = new Map<string, T[]>()
  for (const row of rows) {
    const bucket = byFarm.get(row.farmId)
    if (bucket) bucket.push(row)
    else byFarm.set(row.farmId, [row])
  }
  return byFarm
}

type RowOutcome = 'translated' | 'stillPending' | 'failed'

/**
 * Count one failed attempt on its own, for when the guarded write could not
 * land. It touches no prose, so it needs no compare-and-set beyond the row
 * still being 'pending'; a row that someone else finished is left alone.
 *
 * Without this, a row whose text keeps moving under us would fail its
 * compare-and-set on every run and never advance towards give-up.
 */
async function recordFailedAttempt(spec: TextTableSpec, id: string): Promise<void> {
  await db
    .update(spec.table)
    .set(updateSet({ translationAttempts: sql`${spec.attempts} + 1` }))
    .where(and(eq(spec.id, id), eq(spec.status, 'pending'))!)
    .returning({ id: spec.id })
}

/** Compare-and-set predicate: the column still holds exactly what we read. */
function stillHolds(field: ProseColumn, value: string | string[]): SQL {
  // json equality is key/format independent, so the round-tripped array is an
  // exact comparison against a concurrent edit.
  return field.array
    ? sql`${field.column} = ${JSON.stringify(value)}::jsonb`
    : eq(field.column, value as string)
}

type FieldAttempt = {
  /** New value for the column, or null when nothing should be written. */
  value: string | string[] | null
  /** Extra columns that must be written with it. */
  derived?: Record<string, string>
  /** The LLM was asked and could not deliver. */
  failed: boolean
  /** We ran out of backfill headroom part-way. Not a failed attempt. */
  starved: boolean
  detectedLocale?: string
}

/**
 * Whether this field is prose on this row at all. A row carries one locale pair
 * for every column on it, so a field can be dragged to 'pending' by a sibling:
 * a bot order whose customer left a French review escalates the whole row while
 * `notes` still holds the delivery address the driver has to read.
 */
function isProseForRow(field: ProseColumn, guard: string | null): boolean {
  if (!field.proseOnlyWhen) return true
  return guard !== null && field.proseOnlyWhen.values.has(guard)
}

/** Prose we are allowed to hand to the translator. */
function isProse(field: ProseColumn, value: unknown): value is string {
  if (typeof value !== 'string' || !isTranslatable(value)) return false
  return !field.sentinels?.has(value.trim())
}

async function translateField(
  field: ProseColumn,
  value: ProseValue,
  row: PendingRow,
  budgetShare: number,
): Promise<FieldAttempt> {
  const out: FieldAttempt = { value: null, failed: false, starved: false }

  const canonical = async (text: string) => {
    const result = await toCanonicalEnglish({
      text,
      // `'en'` on a row this job picked up is not a claim that the text is
      // English. The row is here because canonicalization did not finish, and a
      // write path whose translator threw stores the default locale before it
      // could learn the real one. Passing that through would short-circuit
      // `toCanonicalEnglish`, promote the row to 'done' still holding the
      // worker's own words, and nothing sweeps a 'done' row again.
      sourceLocale: authorLocaleHint(row.sourceLocale),
      farmId: row.farmId,
      // This job is where an undetectable language gets settled. Without this
      // the row is deferred back to the job it is already running in.
      resolveUnknown: true,
    })
    // Null is 'still unknown', not a language worth writing back onto the row.
    if (!out.detectedLocale && result.sourceLocale && result.sourceLocale !== 'en') {
      out.detectedLocale = result.sourceLocale
    }
    return result
  }

  if (field.array) {
    if (!Array.isArray(value) || value.length === 0) return out
    // Rebuilt position by position: a checklist is an ordered list of steps, so
    // an element may be left as it was but never dropped, merged or reordered.
    const translated: string[] = []
    let changed = false
    for (const element of value) {
      if (out.failed || out.starved) {
        translated.push(element)
        continue
      }
      if (!isProse(field, element)) {
        translated.push(element)
        continue
      }
      if (!hasBackfillHeadroom(row.farmId, budgetShare)) {
        out.starved = true
        translated.push(element)
        continue
      }
      const result = await canonical(element)
      if (result.status === 'pending') {
        out.failed = true
        translated.push(element)
        continue
      }
      translated.push(result.english)
      if (result.english !== element) changed = true
    }
    // All-or-nothing per array: saving a half-translated list would re-send the
    // elements that already succeeded on the next run, now tagged with a source
    // locale they are no longer in.
    if (changed && !out.failed && !out.starved) out.value = translated
    return out
  }

  if (!isProse(field, value)) return out
  if (!hasBackfillHeadroom(row.farmId, budgetShare)) {
    out.starved = true
    return out
  }
  const result = await canonical(value)
  if (result.status === 'pending') {
    out.failed = true
    return out
  }
  if (result.english === value) return out

  if (field.derive) {
    const derived = field.derive(result.english)
    if (!derived) {
      out.failed = true
      return out
    }
    out.derived = derived
  }
  out.value = result.english
  return out
}

async function retryTextRow(
  spec: TextTableSpec,
  row: PendingRow,
  opts: ResolvedOptions,
): Promise<RowOutcome> {
  const patch: DynamicSet = {}
  /** Values read before the LLM call, for the compare-and-set. */
  const originals: Record<string, string | string[]> = {}
  const patched: string[] = []
  let failed = false
  let starved = false
  let detectedLocale: string | null = null

  for (const [name, field] of Object.entries(spec.fields)) {
    if (!isProseForRow(field, row.guards[name] ?? null)) continue
    const attempt = await translateField(field, row.text[name] ?? null, row, opts.budgetShare)
    if (!detectedLocale && attempt.detectedLocale) detectedLocale = attempt.detectedLocale
    // Keep going after a failure: a sibling field may still translate, and
    // partial progress is worth saving.
    if (attempt.failed) failed = true
    if (attempt.starved) starved = true
    if (attempt.value === null) continue

    patch[name] = attempt.value
    Object.assign(patch, attempt.derived)
    originals[name] = row.text[name] as string | string[]
    patched.push(name)
  }

  const unresolved = failed || starved
  // Only a real translation failure moves the row towards give-up; a farm that
  // ran out of budget has not been tried, and neither has a row this job could
  // not reach because the process was down.
  const attempts = row.attempts + (failed ? 1 : 0)
  const exhausted = failed && attempts >= opts.giveUpAttempts
  const status = exhausted ? 'failed' : unresolved ? 'pending' : 'done'

  if (patched.length === 0 && starved && !failed) {
    // Nothing tried, nothing to record.
    return 'stillPending'
  }

  const values: DynamicSet = { ...patch, translationStatus: status }
  if (failed) {
    // Read-modify-write would lose a concurrent run's increment, and the whole
    // point of the counter is that it advances.
    values.translationAttempts = sql`${spec.attempts} + 1`
  } else if (status === 'done') {
    // The row owes nothing now, so the next author to leave it 'pending' starts
    // from a clean counter. Only ever reset together with 'done': a field that
    // translated while a sibling still owes work must not buy the row more tries.
    values.translationAttempts = 0
  }
  // Recording the detected language makes the next run skip detection; never
  // overwrite a language the author's own client actually reported. A stored
  // 'en' is not one of those on a pending row, so it is corrected rather than
  // preserved — leaving it would keep the row detecting from scratch forever.
  if (detectedLocale && !authorLocaleHint(row.sourceLocale)) values.sourceLocale = detectedLocale

  const conditions: SQL[] = [eq(spec.id, row.id), eq(spec.status, 'pending')]
  for (const name of patched) conditions.push(stillHolds(spec.fields[name]!, originals[name]!))

  const updated = (await db
    .update(spec.table)
    .set(updateSet(values))
    .where(and(...conditions)!)
    .returning({ id: spec.id })) as { id: string }[]

  if (updated.length === 0) {
    // The row moved under us (another copy of this job, or the author editing
    // their own text). Leaving the prose alone is the safe outcome, but the
    // attempt still happened and has to be counted somewhere.
    logApiEvent('translation_retry_conflict', { table: spec.name, id: row.id })
    if (failed) await recordFailedAttempt(spec, row.id)
    return 'stillPending'
  }

  if (exhausted) {
    logApiEvent('translation_retry_gave_up', {
      table: spec.name,
      reason: 'attempts_exhausted',
      rows: 1,
      ids: [row.id],
    })
    return 'failed'
  }
  return unresolved ? 'stillPending' : 'translated'
}

async function retryTextTable(
  spec: TextTableSpec,
  opts: ResolvedOptions,
  counts: TranslationRetryCounts,
): Promise<void> {
  const rows = await selectPending(spec, opts)
  counts.scanned += rows.length

  for (const [farmId, farmRows] of groupByFarm(rows)) {
    if (!hasBackfillHeadroom(farmId, opts.budgetShare)) {
      // Out of budget is not a failure: the rows keep their original text and
      // stay 'pending' so tomorrow's allowance can finish them.
      counts.budgetSkipped += farmRows.length
      continue
    }

    // Rows already at the threshold: an increment that landed on its own, or a
    // threshold that was lowered. Retiring them before the LLM call keeps the
    // budget for rows that can still be finished.
    const spent = farmRows.filter((row) => row.attempts >= opts.giveUpAttempts)
    counts.failed += await giveUp(
      spec,
      spent.map((row) => row.id),
      'attempts_exhausted',
    )

    for (const row of farmRows) {
      if (spent.includes(row)) continue
      if (!hasBackfillHeadroom(farmId, opts.budgetShare)) {
        counts.budgetSkipped += 1
        continue
      }
      const outcome = await retryTextRow(spec, row, opts)
      counts[outcome] += 1
    }
  }
}

/**
 * `action_drafts.payload` is jsonb holding structured intent, so only the
 * fields the write path itself translated are prose. Reusing
 * `DRAFT_FREE_TEXT_FIELDS` keeps this job from inventing a second, wider
 * allow-list and mistranslating quantities, units or plot codes.
 *
 * A draft that is no longer live (cancelled, expired, or already confirmed and
 * applied) is abandoned immediately rather than translated: nothing downstream
 * can read a better translation of it, and confirmation already had its retry.
 */
async function retryActionDrafts(
  opts: ResolvedOptions,
  counts: TranslationRetryCounts,
  now: Date,
): Promise<void> {
  const rows = await db
    .select({
      id: actionDrafts.id,
      farmId: actionDrafts.farmId,
      actionType: actionDrafts.actionType,
      payload: actionDrafts.payload,
      sourceLocale: actionDrafts.sourceLocale,
      status: actionDrafts.status,
      attempts: actionDrafts.translationAttempts,
      expiresAt: actionDrafts.expiresAt,
      createdAt: actionDrafts.createdAt,
    })
    .from(actionDrafts)
    .where(pendingOnly(actionDrafts.translationStatus, actionDrafts.farmId, opts.farmId))
    .orderBy(asc(actionDrafts.createdAt))
    .limit(opts.limit)

  counts.scanned += rows.length

  const dead = rows.filter((row) => row.status !== 'pending' || row.expiresAt <= now)
  counts.failed += await giveUpDrafts(
    dead.map((row) => row.id),
    'draft_no_longer_live',
  )

  const live = rows.filter((row) => !dead.includes(row))
  for (const [farmId, farmRows] of groupByFarm(live)) {
    if (!hasBackfillHeadroom(farmId, opts.budgetShare)) {
      counts.budgetSkipped += farmRows.length
      continue
    }

    const spent = farmRows.filter((row) => row.attempts >= opts.giveUpAttempts)
    counts.failed += await giveUpDrafts(
      spent.map((row) => row.id),
      'attempts_exhausted',
    )

    for (const row of farmRows) {
      if (spent.includes(row)) continue
      if (!hasBackfillHeadroom(farmId, opts.budgetShare)) {
        counts.budgetSkipped += 1
        continue
      }

      const fields = DRAFT_FREE_TEXT_FIELDS[row.actionType]
      if (!fields?.length) {
        // Unknown action type: the write path never translated its payload, so
        // there is nothing here we are allowed to rewrite.
        counts.stillPending += 1
        continue
      }

      const original = row.payload
      const payload: Record<string, unknown> = { ...original }
      let failed = false
      let starved = false
      let detectedLocale: string | null = null

      for (const field of fields) {
        const value = payload[field]
        if (typeof value !== 'string' || !isTranslatable(value)) continue
        if (!hasBackfillHeadroom(farmId, opts.budgetShare)) {
          starved = true
          break
        }
        const result = await toCanonicalEnglish({
          text: value,
          farmId,
          // Same reasoning as `translateField`: a stored 'en' on a pending row
          // means "nobody established a language", so detect it from the text.
          sourceLocale: authorLocaleHint(row.sourceLocale),
        })
        if (!detectedLocale && result.sourceLocale !== 'en') detectedLocale = result.sourceLocale
        if (result.status === 'pending') {
          failed = true
          continue
        }
        payload[field] = result.english
      }

      const unresolved = failed || starved
      const attempts = row.attempts + (failed ? 1 : 0)
      const exhausted = failed && attempts >= opts.giveUpAttempts
      const status = exhausted ? 'failed' : unresolved ? 'pending' : 'done'

      const values: PgUpdateSetSource<typeof actionDrafts> = {
        payload,
        translationStatus: status,
      }
      if (failed) values.translationAttempts = sql`${actionDrafts.translationAttempts} + 1`
      else if (status === 'done') values.translationAttempts = 0
      if (detectedLocale && !authorLocaleHint(row.sourceLocale)) {
        values.sourceLocale = detectedLocale
      }

      // jsonb equality is key-order independent, so comparing the whole payload
      // is an exact compare-and-set against a concurrent draft edit.
      const updated = await db
        .update(actionDrafts)
        .set(values)
        .where(
          and(
            eq(actionDrafts.id, row.id),
            eq(actionDrafts.translationStatus, 'pending'),
            sql`${actionDrafts.payload} = ${JSON.stringify(original)}::jsonb`,
          )!,
        )
        .returning({ id: actionDrafts.id })

      if (updated.length === 0) {
        logApiEvent('translation_retry_conflict', { table: 'action_drafts', id: row.id })
        if (failed) {
          await db
            .update(actionDrafts)
            .set({ translationAttempts: sql`${actionDrafts.translationAttempts} + 1` })
            .where(
              and(
                eq(actionDrafts.id, row.id),
                eq(actionDrafts.translationStatus, 'pending'),
              )!,
            )
            .returning({ id: actionDrafts.id })
        }
        counts.stillPending += 1
        continue
      }

      if (exhausted) {
        logApiEvent('translation_retry_gave_up', {
          table: 'action_drafts',
          reason: 'attempts_exhausted',
          rows: 1,
          ids: [row.id],
        })
        counts.failed += 1
        continue
      }
      counts[unresolved ? 'stillPending' : 'translated'] += 1
    }
  }
}

async function giveUpDrafts(ids: string[], reason: string): Promise<number> {
  if (ids.length === 0) return 0
  const updated = await db
    .update(actionDrafts)
    .set({ translationStatus: 'failed' })
    .where(and(inArray(actionDrafts.id, ids), eq(actionDrafts.translationStatus, 'pending'))!)
    .returning({ id: actionDrafts.id })

  if (updated.length > 0) {
    logApiEvent('translation_retry_gave_up', {
      table: 'action_drafts',
      reason,
      rows: updated.length,
      ids: updated.map((row) => row.id),
    })
  }
  return updated.length
}

/**
 * One bounded pass over the pending backlog. Safe to run concurrently with
 * itself and safe to run unattended: a table that throws is logged and the run
 * continues with the next one.
 */
export async function runTranslationRetry(
  options: TranslationRetryOptions = {},
): Promise<TranslationRetryCounts> {
  const opts = resolveOptions(options)
  const now = options.now ?? new Date()
  const counts: TranslationRetryCounts = {
    scanned: 0,
    translated: 0,
    stillPending: 0,
    failed: 0,
    budgetSkipped: 0,
  }

  for (const spec of TEXT_TABLES) {
    try {
      await retryTextTable(spec, opts, counts)
    } catch (err) {
      logApiEvent('translation_retry_error', {
        table: spec.name,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    await retryActionDrafts(opts, counts, now)
  } catch (err) {
    logApiEvent('translation_retry_error', {
      table: 'action_drafts',
      message: err instanceof Error ? err.message : String(err),
    })
  }

  logApiEvent('translation_retry', { ...counts, limit: opts.limit, farmId: opts.farmId ?? null })
  return counts
}
