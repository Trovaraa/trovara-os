import { getTableName, is, SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toCanonicalEnglish = vi.fn()
const checkLlmBudget = vi.fn((_farmId: string) => ({ allowed: true, used: 0, limit: 500 }))
const logApiEvent = vi.fn()

vi.mock('./content-locale.js', () => ({
  toCanonicalEnglish: (args: unknown) => toCanonicalEnglish(args),
  // Real behaviour: 'en' is the unset default, so it is not a usable hint.
  authorLocaleHint: (preferred?: string | null) =>
    !preferred || preferred === 'en' ? null : preferred,
  // Close enough to the real guard for these fixtures: prose in, codes out.
  isTranslatable: (text: string | null | undefined) => {
    const trimmed = (text ?? '').trim()
    return trimmed.length >= 2 && /\p{L}/u.test(trimmed) && !/^[A-Z0-9][A-Z0-9-]*$/.test(trimmed)
  },
}))

vi.mock('./llm-budget.js', () => ({
  checkLlmBudget: (farmId: string) => checkLlmBudget(farmId),
  // Unused here, but `customer-inquiry` imports it alongside the budget check.
  consumeLlmBudget: vi.fn(),
}))

vi.mock('./api-log.js', () => ({
  logApiEvent: (type: string, metadata: unknown) => logApiEvent(type, metadata),
}))

/**
 * Rows the fake database holds, keyed by SQL table name. The fake applies the
 * three things the job depends on the database for — the `pending` filter, the
 * batch limit, and the parent join that gives a row its farm — and records every
 * write instead of applying it, so a test can assert exactly which columns the
 * job was willing to overwrite.
 */
type FakeRow = {
  id: string
  farmId: string
  sourceLocale: string | null
  translationStatus: 'done' | 'pending' | 'failed'
  clock: Date
  attempts: number
  fields?: Record<string, string | string[] | null>
  [key: string]: unknown
}

let store: Record<string, FakeRow[]> = {}
const updates: { table: string; values: Record<string, unknown> }[] = []
/** WHERE clauses in call order, rendered on demand to check index and CAS predicates. */
const selectWheres: SQL[] = []
const updateWheres: SQL[] = []
/** Rows each successive UPDATE ... RETURNING reports; defaults to one row. */
let updateResults: unknown[][] = []

const dialect = new PgDialect()

function rendered(where: SQL | undefined): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(where!)
  return { sql: query.sql, params: query.params }
}

/** `"tasks"."translation_attempts" + 1` reads as `translation_attempts + 1`. */
function describeSql(value: SQL): string {
  return rendered(value).sql.replace(/"[^"]+"\./g, '').replace(/"/g, '')
}

/** SQL-valued columns (the atomic attempt increment) rendered for assertions. */
function describeValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    out[key] = is(value, SQL) ? describeSql(value) : value
  }
  return out
}

/** What the job writes to advance the give-up counter without losing a race. */
const INCREMENT = 'translation_attempts + 1'

function project(row: FakeRow, selection: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(selection)) {
    out[key] = key.startsWith('text_') ? (row.fields?.[key.slice(5)] ?? null) : row[key]
  }
  return out
}

vi.mock('../db/index.js', () => {
  type Scan = {
    innerJoin: (table: never, on: SQL) => Scan
    where: (where: SQL) => {
      orderBy: () => { limit: (n: number) => Promise<Record<string, unknown>[]> }
    }
  }

  const scan = (selection: Record<string, unknown>, table: string, parent?: string): Scan => ({
    innerJoin: (joined: never, _on: SQL) => scan(selection, table, getTableName(joined)),
    where: (where: SQL) => ({
      orderBy: () => ({
        limit: async (n: number) => {
          selectWheres.push(where)
          return (store[table] ?? [])
            .filter((row) => row.translationStatus === 'pending')
            .sort((a, b) => a.clock.getTime() - b.clock.getTime())
            .slice(0, n)
            .flatMap((row) => {
              if (!parent) return [project(row, selection)]
              // `inventory_count_lines` is the one joined table: its farm comes
              // from the session it belongs to, and an orphan line is dropped
              // exactly as an inner join would drop it.
              const session = (store[parent] ?? []).find((p) => p.id === row.sessionId)
              if (!session) return []
              return [project({ ...row, farmId: session.farmId }, selection)]
            })
        },
      }),
    }),
  })

  return {
    db: {
      select: (selection: Record<string, unknown>) => ({
        from: (table: never) => scan(selection, getTableName(table)),
      }),
      update: (table: never) => ({
        set: (values: Record<string, unknown>) => ({
          where: (where: SQL) => ({
            returning: async () => {
              updates.push({ table: getTableName(table), values: describeValues(values) })
              updateWheres.push(where)
              return updateResults.shift() ?? [{ id: 'updated' }]
            },
          }),
        }),
      }),
    },
  }
})

const { runTranslationRetry } = await import('./translation-retry.js')
// The real grouping key, so the assertion below fails if the job ever grows its
// own copy of the normalization.
const { normalizeQuestion } = await import('./customer-inquiry.js')

const FARM = 'farm-1'
const OTHER_FARM = 'farm-2'
const NOW = new Date('2026-07-25T12:00:00.000Z')
const FRESH = new Date('2026-07-25T11:50:00.000Z')

/** Options every test shares, so only the behaviour under test varies. */
const RUN = { limit: 10, giveUpAttempts: 3, budgetShare: 0.5, now: NOW }

function row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: 'row-1',
    farmId: FARM,
    sourceLocale: 'fr',
    translationStatus: 'pending',
    clock: FRESH,
    attempts: 0,
    ...overrides,
  }
}

function taskRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return row({
    id: 'task-1',
    fields: { title: 'Nourrir les poules', description: null },
    ...overrides,
  })
}

function done(english: string, sourceLocale = 'fr') {
  return { english, sourceLocale, status: 'done' as const }
}

function pending(original: string, sourceLocale = 'fr') {
  return { english: original, sourceLocale, status: 'pending' as const }
}

/** Translate from a fixture dictionary; anything unlisted fails to translate. */
function dictionary(entries: Record<string, string>) {
  return async ({ text }: { text: string }) =>
    entries[text] ? done(entries[text]!) : pending(text)
}

beforeEach(() => {
  vi.clearAllMocks()
  checkLlmBudget.mockReturnValue({ allowed: true, used: 0, limit: 500 })
  store = {}
  updates.length = 0
  updateWheres.length = 0
  selectWheres.length = 0
  updateResults = []
})

describe('runTranslationRetry', () => {
  it('translates a pending row and marks it done', async () => {
    store.tasks = [taskRow()]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens'))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 1, stillPending: 0, failed: 0 })
    expect(updates).toEqual([
      {
        table: 'tasks',
        values: { title: 'Feed the hens', translationStatus: 'done', translationAttempts: 0 },
      },
    ])
  })

  it('records the attempt and leaves the text untouched when translation fails again', async () => {
    store.tasks = [taskRow()]
    toCanonicalEnglish.mockResolvedValue(pending('Nourrir les poules'))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 0, stillPending: 1, failed: 0 })
    // No prose column is written; only the give-up counter moves.
    expect(updates).toEqual([
      {
        table: 'tasks',
        values: { translationStatus: 'pending', translationAttempts: INCREMENT },
      },
    ])
  })

  it('saves the field that translated and keeps the row pending', async () => {
    store.tasks = [
      taskRow({
        fields: { title: 'Nourrir les poules', description: 'Les poules sont malades' },
      }),
    ]
    toCanonicalEnglish.mockImplementation(dictionary({ 'Nourrir les poules': 'Feed the hens' }))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ translated: 0, stillPending: 1, failed: 0 })
    expect(updates).toEqual([
      {
        table: 'tasks',
        values: {
          title: 'Feed the hens',
          translationStatus: 'pending',
          translationAttempts: INCREMENT,
        },
      },
    ])
  })

  it('respects the batch limit', async () => {
    store.tasks = Array.from({ length: 5 }, (_, i) =>
      taskRow({ id: `task-${i}`, fields: { title: `Note ${i}`, description: null } }),
    )
    toCanonicalEnglish.mockResolvedValue(done('Note'))

    const counts = await runTranslationRetry({ ...RUN, limit: 2 })

    expect(counts.scanned).toBe(2)
    expect(toCanonicalEnglish).toHaveBeenCalledTimes(2)
    expect(updates).toHaveLength(2)
  })

  it('stops work for a farm that is out of backfill budget without marking it failed', async () => {
    // Half of the daily allowance is already spent, so the interactive butler
    // keeps the rest even though this row is one attempt from being abandoned.
    checkLlmBudget.mockReturnValue({ allowed: true, used: 300, limit: 500 })
    store.tasks = [taskRow({ attempts: 2 })]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 0, failed: 0, budgetSkipped: 1 })
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    // A row nobody could try is not a row that failed: the counter stays put.
    expect(updates).toEqual([])
  })

  it('never touches a row that is already done', async () => {
    store.tasks = [taskRow({ translationStatus: 'done' })]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 0, translated: 0, stillPending: 0, failed: 0 })
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('keeps the row pending when a concurrent write moved it under us', async () => {
    store.tasks = [taskRow()]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens'))
    updateResults = [[]]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ translated: 0, stillPending: 1 })
    expect(logApiEvent).toHaveBeenCalledWith(
      'translation_retry_conflict',
      expect.objectContaining({ table: 'tasks', id: 'task-1' }),
    )
  })

  it('records the detected locale when the row never had one', async () => {
    store.tasks = [taskRow({ sourceLocale: null })]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens', 'yo'))

    await runTranslationRetry(RUN)

    expect(updates[0]!.values).toMatchObject({ sourceLocale: 'yo' })
  })

  // A row only reaches this job because canonicalization did not finish, so a
  // stored 'en' is the default a failing write path left behind, not a claim
  // about the text. Forwarding it would short-circuit toCanonicalEnglish and
  // promote the row to 'done' still holding French — and nothing sweeps 'done'.
  it('re-detects a pending row that claims to be English', async () => {
    store.tasks = [taskRow({ sourceLocale: 'en' })]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens', 'fr'))

    await runTranslationRetry(RUN)

    expect(toCanonicalEnglish).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Nourrir les poules', sourceLocale: null }),
    )
    expect(updates[0]!.values).toMatchObject({
      title: 'Feed the hens',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('still trusts a locale the author actually chose', async () => {
    store.tasks = [taskRow({ sourceLocale: 'fr' })]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens', 'fr'))

    await runTranslationRetry(RUN)

    expect(toCanonicalEnglish).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLocale: 'fr' }),
    )
    // Nothing to correct, so the stored locale is left alone.
    expect(updates[0]!.values).not.toHaveProperty('sourceLocale')
  })

  it('translates notes on the other content tables', async () => {
    store.livestock_logs = [
      row({ id: 'log-1', sourceLocale: 'pcm', fields: { notes: 'Bird dey cough' } }),
    ]
    toCanonicalEnglish.mockResolvedValue(done('The birds are coughing', 'pcm'))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 1 })
    expect(updates).toEqual([
      {
        table: 'livestock_logs',
        values: {
          notes: 'The birds are coughing',
          translationStatus: 'done',
          translationAttempts: 0,
        },
      },
    ])
  })
})

describe('tables added by migration 0029', () => {
  it('translates an expense description end to end', async () => {
    store.expenses = [row({ id: 'exp-1', fields: { description: 'Achat de provendes' } })]
    toCanonicalEnglish.mockResolvedValue(done('Feed purchase'))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 1, stillPending: 0, failed: 0 })
    expect(toCanonicalEnglish).toHaveBeenCalledWith({
      text: 'Achat de provendes',
      farmId: FARM,
      sourceLocale: 'fr',
      // This job is the one caller that must settle an unplaceable language
      // rather than deferring it back to itself.
      resolveUnknown: true,
    })
    expect(updates).toEqual([
      {
        table: 'expenses',
        values: {
          description: 'Feed purchase',
          translationStatus: 'done',
          translationAttempts: 0,
        },
      },
    ])
  })

  it('translates both note columns of a harvest lot in one write', async () => {
    store.harvest_lots = [
      row({
        id: 'lot-1',
        fields: { publicNotes: 'Récolté le matin', internalNotes: 'Deux caisses abîmées' },
      }),
    ]
    toCanonicalEnglish.mockImplementation(
      dictionary({
        'Récolté le matin': 'Harvested in the morning',
        'Deux caisses abîmées': 'Two crates damaged',
      }),
    )

    await runTranslationRetry(RUN)

    expect(updates).toEqual([
      {
        table: 'harvest_lots',
        values: {
          publicNotes: 'Harvested in the morning',
          internalNotes: 'Two crates damaged',
          translationStatus: 'done',
          translationAttempts: 0,
        },
      },
    ])
  })
})

describe('task template checklists', () => {
  const CHECKLIST = ['Balayer le sol', 'PPE-01', 'Fermer la porte']

  function templateRow(overrides: Partial<FakeRow> = {}): FakeRow {
    return row({
      id: 'tpl-1',
      fields: { name: 'Nettoyage du poulailler', description: null, checklist: [...CHECKLIST] },
      ...overrides,
    })
  }

  it('translates every element in place and keeps the order', async () => {
    store.task_templates = [templateRow()]
    toCanonicalEnglish.mockImplementation(
      dictionary({
        'Nettoyage du poulailler': 'Coop cleaning',
        'Balayer le sol': 'Sweep the floor',
        'Fermer la porte': 'Close the door',
      }),
    )

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 1 })
    expect(updates).toEqual([
      {
        table: 'task_templates',
        values: {
          name: 'Coop cleaning',
          // Three in, three out, same positions; the bare code is not prose and
          // is carried across untouched rather than dropped.
          checklist: ['Sweep the floor', 'PPE-01', 'Close the door'],
          translationStatus: 'done',
          translationAttempts: 0,
        },
      },
    ])
    expect(toCanonicalEnglish).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'PPE-01' }))
  })

  it('guards the checklist write on the exact array it read', async () => {
    store.task_templates = [templateRow({ fields: { checklist: [...CHECKLIST] } })]
    toCanonicalEnglish.mockImplementation(
      dictionary({ 'Balayer le sol': 'Sweep the floor', 'Fermer la porte': 'Close the door' }),
    )

    await runTranslationRetry(RUN)

    const { sql, params } = rendered(updateWheres[0])
    expect(sql).toContain('::jsonb')
    expect(params).toContain(JSON.stringify(CHECKLIST))
  })

  it('leaves the whole checklist alone when one element cannot be translated', async () => {
    store.task_templates = [templateRow()]
    toCanonicalEnglish.mockImplementation(
      dictionary({
        'Nettoyage du poulailler': 'Coop cleaning',
        'Balayer le sol': 'Sweep the floor',
      }),
    )

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ translated: 0, stillPending: 1 })
    // A half-translated list would come back next run tagged with a source
    // locale its English elements are no longer in, so nothing is written.
    expect(updates).toEqual([
      {
        table: 'task_templates',
        values: {
          name: 'Coop cleaning',
          translationStatus: 'pending',
          translationAttempts: INCREMENT,
        },
      },
    ])
  })
})

describe('inventory movement sentinels', () => {
  it('retires a machine-written reason without translating it', async () => {
    store.inventory_movements = [
      row({ id: 'mov-1', sourceLocale: null, fields: { reason: 'task_consumption' } }),
    ]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 1, failed: 0 })
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(updates).toEqual([
      {
        table: 'inventory_movements',
        values: { translationStatus: 'done', translationAttempts: 0 },
      },
    ])
  })

  it('still translates a reason a worker typed', async () => {
    store.inventory_movements = [
      row({ id: 'mov-2', fields: { reason: 'Sac éventré au magasin' } }),
    ]
    toCanonicalEnglish.mockResolvedValue(done('Bag torn open in the store'))

    await runTranslationRetry(RUN)

    expect(updates).toEqual([
      {
        table: 'inventory_movements',
        values: {
          reason: 'Bag torn open in the store',
          translationStatus: 'done',
          translationAttempts: 0,
        },
      },
    ])
  })
})

describe('inventory count lines', () => {
  function lineFixtures(sessionFarm = OTHER_FARM) {
    // The session is already 'done' so only the line is swept.
    store.inventory_count_sessions = [
      row({ id: 'sess-1', farmId: sessionFarm, translationStatus: 'done' }),
    ]
    store.inventory_count_lines = [
      row({
        id: 'line-1',
        // Never read: the line has no farm_id of its own, so a value here would
        // only mask a missing join.
        farmId: 'unused',
        sessionId: 'sess-1',
        fields: { notes: 'Sac déchiré' },
      }),
    ]
  }

  it('bills the translation to the farm that owns the session', async () => {
    lineFixtures()
    toCanonicalEnglish.mockResolvedValue(done('Torn bag'))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 1 })
    expect(checkLlmBudget).toHaveBeenCalledWith(OTHER_FARM)
    expect(checkLlmBudget).not.toHaveBeenCalledWith('unused')
    expect(toCanonicalEnglish).toHaveBeenCalledWith({
      text: 'Sac déchiré',
      farmId: OTHER_FARM,
      sourceLocale: 'fr',
      // This job is the one caller that must settle an unplaceable language
      // rather than deferring it back to itself.
      resolveUnknown: true,
    })
  })

  it('skips the line when the session owner is out of backfill budget', async () => {
    lineFixtures()
    checkLlmBudget.mockImplementation((farmId: string) =>
      farmId === OTHER_FARM
        ? { allowed: true, used: 400, limit: 500 }
        : { allowed: true, used: 0, limit: 500 },
    )

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, budgetSkipped: 1, translated: 0 })
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('drops a line whose session is gone, as the inner join would', async () => {
    store.inventory_count_lines = [
      row({ id: 'line-1', sessionId: 'sess-missing', fields: { notes: 'Sac déchiré' } }),
    ]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 0 })
    expect(updates).toEqual([])
  })
})

describe('customer inquiries', () => {
  it('recomputes the grouping key from the translated question', async () => {
    store.customer_inquiries = [
      row({
        id: 'inq-1',
        fields: { question: 'Combien coûte le plantain ?' },
        normalized: 'combien coûte le plantain',
      }),
    ]
    toCanonicalEnglish.mockResolvedValue(done('How much is plantain?'))

    await runTranslationRetry(RUN)

    // Without this the "most asked" view counts one question once per language.
    expect(updates).toEqual([
      {
        table: 'customer_inquiries',
        values: {
          question: 'How much is plantain?',
          normalized: 'how much is plantain',
          translationStatus: 'done',
          translationAttempts: 0,
        },
      },
    ])
    expect(updates[0]!.values.normalized).toBe(normalizeQuestion('How much is plantain?'))
  })

  it('leaves the question alone when the translation fails', async () => {
    store.customer_inquiries = [
      row({ id: 'inq-2', fields: { question: 'Combien coûte le plantain ?' } }),
    ]
    toCanonicalEnglish.mockResolvedValue(pending('Combien coûte le plantain ?'))

    await runTranslationRetry(RUN)

    expect(updates[0]!.values).not.toHaveProperty('normalized')
  })
})

describe('give-up counter', () => {
  it('abandons the row on the attempt that reaches the threshold', async () => {
    store.tasks = [taskRow({ attempts: 2 })]
    toCanonicalEnglish.mockResolvedValue(pending('Nourrir les poules'))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 0, stillPending: 0, failed: 1 })
    expect(updates).toEqual([
      {
        table: 'tasks',
        values: { translationStatus: 'failed', translationAttempts: INCREMENT },
      },
    ])
    expect(logApiEvent).toHaveBeenCalledWith(
      'translation_retry_gave_up',
      expect.objectContaining({ table: 'tasks', reason: 'attempts_exhausted' }),
    )
  })

  it('retires a row already past the threshold without spending budget on it', async () => {
    store.tasks = [taskRow({ attempts: 5 })]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, failed: 1, translated: 0 })
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(updates).toEqual([{ table: 'tasks', values: { translationStatus: 'failed' } }])
  })

  it('increments atomically rather than writing back a value it read', async () => {
    store.tasks = [taskRow({ attempts: 1 })]
    toCanonicalEnglish.mockResolvedValue(pending('Nourrir les poules'))

    await runTranslationRetry(RUN)

    // `attempts + 1` in the database, so two concurrent runs count two attempts.
    expect(updates[0]!.values.translationAttempts).toBe(INCREMENT)
  })

  it('counts the attempt even when the guarded write loses the race', async () => {
    store.tasks = [
      taskRow({
        fields: { title: 'Nourrir les poules', description: 'Les poules sont malades' },
      }),
    ]
    toCanonicalEnglish.mockImplementation(dictionary({ 'Nourrir les poules': 'Feed the hens' }))
    updateResults = [[]]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ stillPending: 1, failed: 0 })
    expect(updates).toEqual([
      {
        table: 'tasks',
        values: {
          title: 'Feed the hens',
          translationStatus: 'pending',
          translationAttempts: INCREMENT,
        },
      },
      // The compare-and-set found the text changed, so the attempt is recorded
      // on its own; otherwise a row being edited could never age out.
      { table: 'tasks', values: { translationAttempts: INCREMENT } },
    ])
    // Recorded without touching any prose column.
    expect(rendered(updateWheres[1]).params).toEqual(['task-1', 'pending'])
  })

  it('does not reset the counter when only some fields translated', async () => {
    store.tasks = [
      taskRow({
        attempts: 1,
        fields: { title: 'Nourrir les poules', description: 'Les poules sont malades' },
      }),
    ]
    toCanonicalEnglish.mockImplementation(dictionary({ 'Nourrir les poules': 'Feed the hens' }))

    await runTranslationRetry(RUN)

    // A row that still owes work does not buy itself more tries by succeeding
    // somewhere else.
    expect(updates[0]!.values.translationAttempts).toBe(INCREMENT)
  })

  it('clears the counter only when the row reaches done', async () => {
    store.tasks = [taskRow({ attempts: 2 })]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens'))

    await runTranslationRetry(RUN)

    expect(updates[0]!.values).toMatchObject({ translationStatus: 'done', translationAttempts: 0 })
  })
})

describe('query shape', () => {
  it('spells the partial index predicate so the scan can use it', async () => {
    store.tasks = [taskRow()]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens'))

    await runTranslationRetry(RUN)

    // tasks_translation_status_idx is `WHERE translation_status <> 'done'`.
    const { sql, params } = rendered(selectWheres[0])
    expect(sql).toContain('"translation_status" <> ')
    expect(params).toEqual(['done', 'pending'])
  })

  it('spells it the same way on every table in the registry', async () => {
    store.expenses = [row({ id: 'exp-1', fields: { description: 'Achat de provendes' } })]
    toCanonicalEnglish.mockResolvedValue(done('Feed purchase'))

    await runTranslationRetry(RUN)

    expect(selectWheres.length).toBeGreaterThan(20)
    for (const where of selectWheres) {
      expect(rendered(where).sql).toContain('"translation_status" <> ')
    }
  })

  it('guards each write on the row still holding the text it translated', async () => {
    store.tasks = [taskRow()]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens'))

    await runTranslationRetry(RUN)

    const { params } = rendered(updateWheres[0])
    expect(params).toEqual(['task-1', 'pending', 'Nourrir les poules'])
  })
})

describe('action draft payloads', () => {
  function draftRow(overrides: Partial<FakeRow> = {}): FakeRow {
    return row({
      id: 'draft-1',
      createdAt: FRESH,
      status: 'pending',
      expiresAt: new Date('2026-07-25T12:30:00.000Z'),
      actionType: 'create_task',
      payload: { title: 'Nourrir les poules', quantity: 12, unit: 'crates' },
      ...overrides,
    })
  }

  it('translates only the allow-listed prose fields of a live draft', async () => {
    store.action_drafts = [draftRow()]
    toCanonicalEnglish.mockResolvedValue(done('Feed the hens'))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, translated: 1 })
    expect(toCanonicalEnglish).toHaveBeenCalledTimes(1)
    expect(updates).toEqual([
      {
        table: 'action_drafts',
        values: {
          payload: { title: 'Feed the hens', quantity: 12, unit: 'crates' },
          translationStatus: 'done',
          translationAttempts: 0,
        },
      },
    ])
  })

  it('gives up on a draft that can no longer be confirmed', async () => {
    store.action_drafts = [draftRow({ expiresAt: new Date('2026-07-25T11:00:00.000Z') })]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, failed: 1, translated: 0 })
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(updates).toEqual([{ table: 'action_drafts', values: { translationStatus: 'failed' } }])
  })

  it('leaves payloads of unknown action types alone', async () => {
    store.action_drafts = [draftRow({ actionType: 'settle_invoice' })]

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, stillPending: 1, failed: 0 })
    expect(toCanonicalEnglish).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  it('abandons a draft that has used up its attempts', async () => {
    store.action_drafts = [draftRow({ attempts: 2 })]
    toCanonicalEnglish.mockResolvedValue(pending('Nourrir les poules'))

    const counts = await runTranslationRetry(RUN)

    expect(counts).toMatchObject({ scanned: 1, failed: 1, translated: 0 })
    expect(updates[0]!.values).toMatchObject({
      translationStatus: 'failed',
      translationAttempts: INCREMENT,
    })
  })
})
