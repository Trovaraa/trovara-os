import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

let sessionUser: Row = {
  id: 'user-worker',
  farmId: 'farm-1',
  role: 'field_worker',
  name: 'Ade',
  email: 'ade@trovara.farm',
}

/** Rows the fake db returns, queued per table so query order does not matter. */
const selectQueue = new Map<string, Row[][]>()
const selectLog: string[] = []
const inserted: { table: string; values: Row }[] = []
const updates: { table: string; patch: Row }[] = []
let updatedRow: Row = {}

function queueSelect(table: string, rows: Row[]) {
  const queued = selectQueue.get(table) ?? []
  queued.push(rows)
  selectQueue.set(table, queued)
}

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    let rows: Row[] = []
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: (table: unknown) => {
        const name = nameOf(table)
        selectLog.push(name)
        rows = selectQueue.get(name)?.shift() ?? []
        return self
      },
      leftJoin: same,
      innerJoin: same,
      where: same,
      orderBy: same,
      limit: same,
      then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    })
    return self
  }

  return {
    db: {
      select: selectChain,
      insert: (table: unknown) => ({
        values: (values: Row) => {
          inserted.push({ table: nameOf(table), values })
          return {
            returning: async () => [{ id: 'sess-new', ...values }],
            onConflictDoNothing: async () => undefined,
          }
        },
      }),
      update: (table: unknown) => ({
        set: (patch: Row) => {
          updates.push({ table: nameOf(table), patch })
          return { where: () => ({ returning: async () => [{ ...updatedRow, ...patch }] }) }
        },
      }),
    },
  }
})

const completeChat = vi.fn()
const isLlmConfigured = vi.fn(() => true)

vi.mock('../lib/llm.js', () => ({
  completeChat: (...args: unknown[]) => completeChat(...args),
  isLlmConfigured: () => isLlmConfigured(),
}))

vi.mock('../lib/llm-budget.js', () => ({
  checkLlmBudget: () => ({ allowed: true, used: 0, limit: 500 }),
  consumeLlmBudget: vi.fn(),
}))

/**
 * The real canonical-English service runs, with only the LLM and db faked, so
 * the tests see its real short-circuits. The spies count how often the write and
 * read paths enter the service at all, and `canonicalThrows` covers the one
 * failure the service cannot report through its own status: an exception.
 */
const canonicalCalls = vi.fn()
const viewerBatchCalls = vi.fn()
let canonicalThrows = false

vi.mock('../lib/content-locale.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/content-locale.js')>()
  return {
    ...actual,
    toCanonicalEnglish: (args: Parameters<typeof actual.toCanonicalEnglish>[0]) => {
      canonicalCalls(args)
      if (canonicalThrows) throw new Error('translation service down')
      return actual.toCanonicalEnglish(args)
    },
    toViewerLocaleMany: (args: Parameters<typeof actual.toViewerLocaleMany>[0]) => {
      viewerBatchCalls(args)
      return actual.toViewerLocaleMany(args)
    },
  }
})

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))

vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
const notifyWorkerClockIn = vi.fn(async (_params: unknown) => undefined)

vi.mock('../lib/farm-notify.js', () => ({
  notifyWorkerClockIn: (params: unknown) => notifyWorkerClockIn(params),
}))

const FRENCH_NOTE = 'La pompe du forage fuit depuis ce matin'
const ENGLISH_NOTE = 'The borehole pump has been leaking since this morning'
const PIDGIN_NOTE = 'Di borehole pump dey leak since morning, e no good'

const FRENCH_TO_ENGLISH: Record<string, string> = {
  [FRENCH_NOTE]: ENGLISH_NOTE,
  [PIDGIN_NOTE]: ENGLISH_NOTE,
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  [ENGLISH_NOTE]: FRENCH_NOTE,
}

function sessionRow(overrides: Row = {}): Row {
  return {
    id: 'sess-1',
    farmId: 'farm-1',
    userId: 'user-worker',
    userName: 'Ade',
    clockInAt: new Date('2026-07-20T07:00:00Z'),
    clockOutAt: null,
    monthlyWageSnapshotNgn: 220_000,
    plotId: null,
    plotName: null,
    taskId: null,
    taskTitle: null,
    notes: ENGLISH_NOTE,
    sourceLocale: null,
    translationStatus: 'done',
    correctedById: null,
    correctedAt: null,
    createdAt: new Date('2026-07-20T07:00:00Z'),
    rangeStart: new Date('2026-07-20T00:00:00Z'),
    rangeEnd: new Date('2026-07-21T00:00:00Z'),
    ...overrides,
  }
}

async function app() {
  const { attendanceRoutes } = await import('./attendance.js')
  const instance = new Hono()
  instance.route('/attendance', attendanceRoutes)
  return instance
}

/** Everything a clock-in reads before it inserts: any open session, then the profile. */
function queueClockInReads(preferredLocale: string) {
  queueSelect('attendance_sessions', [])
  queueSelect('users', [{ monthlyWageNgn: 220_000, preferredLocale }])
}

async function clockIn(body: unknown) {
  return (await app()).request('/attendance/clock-in', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function clockOut(body: unknown = {}) {
  return (await app()).request('/attendance/clock-out', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function submitHours(body: unknown) {
  return (await app()).request('/attendance/submit-hours', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function reviewHours(body: unknown) {
  return (await app()).request('/attendance/sess-1/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function correct(body: unknown) {
  return (await app()).request('/attendance/sess-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedSession(): Row {
  const row = inserted.find((entry) => entry.table === 'attendance_sessions')
  expect(row).toBeDefined()
  return row!.values
}

function sessionPatch(): Row {
  const patch = updates.find((entry) => entry.table === 'attendance_sessions')
  expect(patch).toBeDefined()
  return patch!.patch
}

/** Every string the translator was actually handed, in call order. */
function translatedTexts(): string[] {
  return completeChat.mock.calls.map((call) => call[1] as string)
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updates.length = 0
  updatedRow = sessionRow()
  canonicalThrows = false
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
  sessionUser = {
    id: 'user-worker',
    farmId: 'farm-1',
    role: 'field_worker',
    name: 'Ade',
    email: 'ade@trovara.farm',
  }
})

describe('self-attendance role access', () => {
  it.each(['owner', 'supervisor', 'sales', 'field_worker'])(
    'allows %s to clock in',
    async (role) => {
      sessionUser = { ...sessionUser, role }
      queueSelect('attendance_sessions', [])
      queueSelect('users', [
        {
          monthlyWageNgn: role === 'field_worker' ? 220_000 : null,
          preferredLocale: 'en',
        },
      ])

      const res = await clockIn({})

      expect(res.status).toBe(201)
      expect(insertedSession()).toMatchObject({ userId: 'user-worker' })
      expect(notifyWorkerClockIn).toHaveBeenCalledTimes(role === 'field_worker' ? 1 : 0)
    },
  )

  it.each(['owner', 'supervisor', 'sales', 'field_worker'])(
    'allows %s to clock out',
    async (role) => {
      sessionUser = { ...sessionUser, role }

      const res = await clockOut()

      expect(res.status).toBe(200)
      expect(sessionPatch().clockOutAt).toBeInstanceOf(Date)
    },
  )
})

describe('submitted hours workflow', () => {
  it('requires a work summary and submits a worker entry for approval', async () => {
    queueSelect('users', [{ monthlyWageNgn: 220_000, preferredLocale: 'en' }])
    const res = await submitHours({ workDate: '2026-08-15', submittedMinutes: 450, workSummary: 'Weeded Block 1 and checked irrigation.' })
    expect(res.status).toBe(201)
    expect(insertedSession()).toMatchObject({ workDate: '2026-08-15', submittedMinutes: 450, approvalStatus: 'pending', workSummary: 'Weeded Block 1 and checked irrigation.' })
  })

  it('auto-approves an admin entry but still records the work summary', async () => {
    sessionUser = { ...sessionUser, role: 'owner' }
    queueSelect('users', [{ monthlyWageNgn: null, preferredLocale: 'en' }])
    const res = await submitHours({ workDate: '2026-08-15', submittedMinutes: 120, workSummary: 'Reviewed finance controls.' })
    expect(res.status).toBe(201)
    expect(insertedSession()).toMatchObject({ approvalStatus: 'approved', approvedById: 'user-worker', workSummary: 'Reviewed finance controls.' })
  })

  it('lets an admin approve another person pending entry', async () => {
    sessionUser = { ...sessionUser, id: 'owner-1', role: 'owner' }
    queueSelect('attendance_sessions', [sessionRow({ workDate: '2026-08-15', approvalStatus: 'pending', userId: 'worker-1' })])
    updatedRow = sessionRow({ workDate: '2026-08-15', approvalStatus: 'pending', userId: 'worker-1' })
    const res = await reviewHours({ decision: 'approved' })
    expect(res.status).toBe(200)
    expect(sessionPatch()).toMatchObject({ approvalStatus: 'approved', approvedById: 'owner-1' })
  })
})

describe('POST /attendance/clock-in - canonical English on write', () => {
  it('stores the note in English with the author locale for a French worker', async () => {
    queueClockInReads('fr')

    const res = await clockIn({ notes: FRENCH_NOTE })

    expect(res.status).toBe(201)
    expect(insertedSession()).toMatchObject({
      notes: ENGLISH_NOTE,
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('detects the language of a worker who never chose one', async () => {
    queueClockInReads('en')

    const res = await clockIn({ notes: PIDGIN_NOTE })

    expect(res.status).toBe(201)
    // The default 'en' preference means "nobody chose a language", so it must
    // not reach the service: a stored 'en'/'done' would hold Pidgin forever.
    expect(canonicalCalls).toHaveBeenCalledWith(expect.objectContaining({ sourceLocale: null }))
    expect(insertedSession()).toMatchObject({
      notes: ENGLISH_NOTE,
      sourceLocale: 'pcm',
      translationStatus: 'done',
    })
  })

  it('leaves the wage snapshot and the allocation ids verbatim', async () => {
    queueClockInReads('fr')

    await clockIn({ notes: FRENCH_NOTE })

    expect(insertedSession()).toMatchObject({
      farmId: 'farm-1',
      userId: 'user-worker',
      monthlyWageSnapshotNgn: 220_000,
    })
    // The note is the only prose; nothing else reaches the translator.
    expect(translatedTexts()).toEqual([FRENCH_NOTE])
  })

  it('stores the original as pending and still clocks the worker in when the LLM is off', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueClockInReads('fr')

    const res = await clockIn({ notes: FRENCH_NOTE })

    expect(res.status).toBe(201)
    expect(insertedSession()).toMatchObject({
      notes: FRENCH_NOTE,
      // Detected rather than dropped: the retry job gets a usable hint, and a
      // pending row must never claim to be English.
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('stores the original at pending with a null locale when the translator throws', async () => {
    canonicalThrows = true
    queueClockInReads('en')

    const res = await clockIn({ notes: FRENCH_NOTE })

    expect(res.status).toBe(201)
    expect(insertedSession()).toMatchObject({
      notes: FRENCH_NOTE,
      sourceLocale: null,
      translationStatus: 'pending',
    })
  })

  it('makes no translation call at all for an English note', async () => {
    queueClockInReads('en')

    const res = await clockIn({ notes: ENGLISH_NOTE })

    expect(res.status).toBe(201)
    expect(completeChat).not.toHaveBeenCalled()
    expect(insertedSession()).toMatchObject({
      notes: ENGLISH_NOTE,
      sourceLocale: 'en',
      translationStatus: 'done',
    })
  })

  it('does not enter the translation service for a clock-in with no note', async () => {
    queueClockInReads('fr')

    const res = await clockIn({})

    expect(res.status).toBe(201)
    expect(canonicalCalls).not.toHaveBeenCalled()
    // No prose, no claim about a language: the row keeps the schema defaults.
    expect(insertedSession()).toMatchObject({ notes: null })
    expect(insertedSession()).not.toHaveProperty('sourceLocale')
  })

  it('returns the worker their own words while storing the English', async () => {
    queueClockInReads('fr')

    const res = await clockIn({ notes: FRENCH_NOTE })
    const body = (await res.json()) as { session: Row }

    expect(body.session.notes).toBe(FRENCH_NOTE)
    expect(insertedSession().notes).toBe(ENGLISH_NOTE)
  })
})

describe('PATCH /attendance/:id - canonical English on correction', () => {
  beforeEach(() => {
    sessionUser = {
      id: 'user-sup',
      farmId: 'farm-1',
      role: 'supervisor',
      name: 'Bola',
      email: 'sup@trovara.farm',
    }
  })

  it("stores a supervisor's French correction in English with the author locale", async () => {
    queueSelect('attendance_sessions', [sessionRow({ notes: null })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await correct({ notes: FRENCH_NOTE })

    expect(res.status).toBe(200)
    expect(sessionPatch()).toMatchObject({
      notes: ENGLISH_NOTE,
      sourceLocale: 'fr',
      translationStatus: 'done',
      correctedById: 'user-sup',
    })
  })

  it('keeps a correction that cannot be translated out of the done state', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('attendance_sessions', [sessionRow({ notes: null })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await correct({ notes: FRENCH_NOTE })

    expect(res.status).toBe(200)
    expect(sessionPatch()).toMatchObject({
      notes: FRENCH_NOTE,
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('never relabels a row the retry job still owes work on', async () => {
    queueSelect('attendance_sessions', [
      sessionRow({ notes: PIDGIN_NOTE, sourceLocale: 'pcm', translationStatus: 'pending' }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await correct({ notes: FRENCH_NOTE })

    expect(res.status).toBe(200)
    const patch = sessionPatch()
    expect(patch.notes).toBe(ENGLISH_NOTE)
    expect(patch).not.toHaveProperty('translationStatus')
  })

  it('touches neither the translator nor the locale pair when only times are fixed', async () => {
    queueSelect('attendance_sessions', [sessionRow()])

    const res = await correct({ clockOutAt: '2026-07-20T15:00:00Z' })

    expect(res.status).toBe(200)
    expect(canonicalCalls).not.toHaveBeenCalled()
    const patch = sessionPatch()
    expect(patch.notes).toBe(ENGLISH_NOTE)
    expect(patch).not.toHaveProperty('sourceLocale')
    expect(patch).not.toHaveProperty('translationStatus')
  })
})

describe('GET /attendance/today - viewer locale on read', () => {
  it('renders notes for a French viewer in one batched call', async () => {
    queueSelect('attendance_sessions', [sessionRow(), sessionRow({ id: 'sess-2', notes: null })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/attendance/today')
    const body = (await res.json()) as { sessions: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.sessions[0].notes).toBe(FRENCH_NOTE)
    expect(body.sessions[1].notes).toBeNull()
  })

  it('never sends names, wages or task titles to the translator', async () => {
    queueSelect('attendance_sessions', [sessionRow({ plotName: 'Block A', taskTitle: 'Weeding' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/attendance/today')
    const session = ((await res.json()) as { sessions: Row[] }).sessions[0]

    expect(session).toMatchObject({
      userName: 'Ade',
      plotName: 'Block A',
      taskTitle: 'Weeding',
      monthlyWageSnapshotNgn: 220_000,
    })
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({ texts: [ENGLISH_NOTE] }),
    )
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('attendance_sessions', [sessionRow(), sessionRow({ id: 'sess-2' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await (await app()).request('/attendance/today')
    const body = (await res.json()) as { sessions: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.sessions[0].notes).toBe(ENGLISH_NOTE)
  })

  it('reads a full shift with one batched call and one call per distinct note', async () => {
    queueSelect(
      'attendance_sessions',
      Array.from({ length: 20 }, (_, index) => sessionRow({ id: `sess-${index}` })),
    )
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/attendance/today')
    const body = (await res.json()) as { sessions: Row[] }

    expect(body.sessions).toHaveLength(20)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(1)
    expect(body.sessions[19].notes).toBe(FRENCH_NOTE)
  })

  it('spends nothing on a response with no notes in it', async () => {
    queueSelect('attendance_sessions', [sessionRow({ notes: null })])

    const res = await (await app()).request('/attendance/today')

    expect(res.status).toBe(200)
    expect(selectLog).not.toContain('users')
    expect(viewerBatchCalls).not.toHaveBeenCalled()
  })
})
