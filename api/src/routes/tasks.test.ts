import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const nameOf = (table: unknown) => getTableName(table as never)

let sessionUser: Row = {
  id: 'user-owner',
  farmId: 'farm-1',
  role: 'owner',
  name: 'Owner',
  email: 'owner@trovara.farm',
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
            returning: async () => [{ id: 'task-new', ...values }],
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
/** Highest number of translation calls in flight at once. */
let maxInFlight = 0
let inFlight = 0

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
 * the tests see its real short-circuits. The spies count how often the routes
 * enter the service at all.
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
      // The service swallows LLM errors internally, so the only way to reach the
      // route's own catch is for something around it to throw.
      if (canonicalThrows) throw new Error('budget module exploded')
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
vi.mock('../lib/farm-events.js', () => ({ recordFarmEvent: vi.fn() }))
vi.mock('../lib/farm-notify.js', () => ({ notifyTaskSubmittedForApproval: vi.fn(async () => undefined) }))
vi.mock('../lib/security-log.js', () => ({ logSecurityEvent: vi.fn() }))
vi.mock('../lib/evidence-store.js', () => ({
  processEvidenceValue: vi.fn(async (_farmId: string, value: string) => value),
  validateEvidenceRef: vi.fn(() => true),
}))

const FRENCH_TO_ENGLISH: Record<string, string> = {
  'Arroser les bananiers du bloc A': 'Water the plantains in block A',
  'Vérifier le goutte-à-goutte avant midi': 'Check the drip line before noon',
  'Trois plants sont malades, feuilles jaunes': 'Three plants are sick with yellow leaves',
}

const ENGLISH_TO_FRENCH: Record<string, string> = {
  'Water the plantains in block A': 'Arroser les bananiers du bloc A',
  'Check the drip line before noon': 'Vérifier le goutte-à-goutte avant midi',
  'Feed the layers': 'Nourrir les pondeuses',
  'Morning irrigation for Block A': 'Irrigation matinale pour le bloc A',
}

function taskRow(overrides: Row = {}): Row {
  return {
    id: 'task-1',
    farmId: 'farm-1',
    title: 'Water the plantains in block A',
    description: 'Morning irrigation for Block A',
    status: 'in_progress',
    plotId: 'plot-1',
    plotName: 'Block A',
    templateId: null,
    actionType: 'crop_census',
    actionPayload: { crops: ['plantain'], systemTemplateKey: 'handover_crop_census' },
    photoUrl: 'evidence://farm-1/photo-1',
    voiceUrl: null,
    latitude: '6.5244',
    longitude: '3.3792',
    assignedToId: 'user-worker',
    assignedToName: 'Awa Diallo',
    dueDate: null,
    completionNote: null,
    rejectionReason: null,
    approvedById: null,
    sourceLocale: null,
    translationStatus: 'done',
    createdAt: new Date('2026-07-01T08:00:00Z'),
    updatedAt: new Date('2026-07-01T08:00:00Z'),
    ...overrides,
  }
}

async function app() {
  const { taskRoutes } = await import('./tasks.js')
  const instance = new Hono()
  instance.route('/tasks', taskRoutes)
  return instance
}

async function createTask(body: unknown) {
  return (await app()).request('/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function patchTask(id: string, body: unknown) {
  return (await app()).request(`/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function listTasks() {
  return (await app()).request('/tasks')
}

function insertedTask(): Row {
  const row = inserted.find((entry) => entry.table === 'tasks')
  expect(row).toBeDefined()
  return row!.values
}

function taskPatch(): Row {
  const row = updates.find((entry) => entry.table === 'tasks')
  expect(row).toBeDefined()
  return row!.patch
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.clear()
  selectLog.length = 0
  inserted.length = 0
  updates.length = 0
  updatedRow = taskRow()
  maxInFlight = 0
  inFlight = 0
  canonicalThrows = false
  isLlmConfigured.mockReturnValue(true)
  completeChat.mockImplementation(async (system: string, text: string) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise((resolve) => setImmediate(resolve))
    inFlight -= 1
    const table = /into English/i.test(system) ? FRENCH_TO_ENGLISH : ENGLISH_TO_FRENCH
    return { text: table[text] ?? `[${text}]`, model: 'test' }
  })
  sessionUser = {
    id: 'user-owner',
    farmId: 'farm-1',
    role: 'supervisor',
    name: 'Sup',
    email: 'sup@trovara.farm',
  }
})

describe('POST /tasks - canonical English on write', () => {
  it('stores English and the author locale for a French create', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await createTask({
      title: 'Arroser les bananiers du bloc A',
      description: 'Vérifier le goutte-à-goutte avant midi',
    })

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Water the plantains in block A',
      description: 'Check the drip line before noon',
      sourceLocale: 'fr',
      translationStatus: 'done',
    })
  })

  it('translates title and description concurrently, not one after the other', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    await createTask({
      title: 'Arroser les bananiers du bloc A',
      description: 'Vérifier le goutte-à-goutte avant midi',
    })

    expect(completeChat).toHaveBeenCalledTimes(2)
    expect(maxInFlight).toBe(2)
  })

  it('returns the author their own words while storing the English', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await createTask({ title: 'Arroser les bananiers du bloc A' })
    const body = (await res.json()) as { task: Row }

    expect(body.task.title).toBe('Arroser les bananiers du bloc A')
    expect(insertedTask().title).toBe('Water the plantains in block A')
  })

  it('stores an English create unchanged without any translation call', async () => {
    queueSelect('users', [{ preferredLocale: 'en' }])

    const res = await createTask({
      title: 'Water the plantains in block A',
      description: 'Morning irrigation for Block A',
    })

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Water the plantains in block A',
      description: 'Morning irrigation for Block A',
      sourceLocale: 'en',
      translationStatus: 'done',
    })
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('succeeds with the original text marked pending when the LLM is unavailable', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await createTask({
      title: 'Arroser les bananiers du bloc A',
      description: 'Vérifier le goutte-à-goutte avant midi',
    })

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Arroser les bananiers du bloc A',
      description: 'Vérifier le goutte-à-goutte avant midi',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  // A worker losing their task because a module around the translator threw is
  // strictly worse than a row the retry job will come back to.
  it('still saves the task when canonicalization throws outright', async () => {
    canonicalThrows = true
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await createTask({
      title: 'Arroser les bananiers du bloc A',
      description: 'Vérifier le goutte-à-goutte avant midi',
    })

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Arroser les bananiers du bloc A',
      description: 'Vérifier le goutte-à-goutte avant midi',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('marks the row pending when only one of the two fields fails', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    completeChat.mockImplementation(async (_system: string, text: string) => {
      if (text === 'Vérifier le goutte-à-goutte avant midi') throw new Error('upstream 503')
      return { text: FRENCH_TO_ENGLISH[text], model: 'test' }
    })

    const res = await createTask({
      title: 'Arroser les bananiers du bloc A',
      description: 'Vérifier le goutte-à-goutte avant midi',
    })

    expect(res.status).toBe(201)
    expect(insertedTask()).toMatchObject({
      title: 'Water the plantains in block A',
      description: 'Vérifier le goutte-à-goutte avant midi',
      translationStatus: 'pending',
    })
  })

  it('leaves the structured action payload alone', async () => {
    queueSelect('users', [{ preferredLocale: 'fr' }])
    const actionPayload = { crops: ['plantain', 'coconut'], systemTemplateKey: 'handover_crop_census' }

    await createTask({
      title: 'Arroser les bananiers du bloc A',
      actionType: 'crop_census',
      actionPayload,
    })

    expect(insertedTask()).toMatchObject({ actionType: 'crop_census', actionPayload })
  })
})

describe('PATCH /tasks/:id - canonical English on write', () => {
  beforeEach(() => {
    sessionUser = {
      id: 'user-worker',
      farmId: 'farm-1',
      role: 'field_worker',
      name: 'Awa Diallo',
      email: 'awa@trovara.farm',
    }
  })

  it('stores a French completion note in English with the author locale', async () => {
    queueSelect('tasks', [taskRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patchTask('task-1', {
      status: 'awaiting_approval',
      completionNote: 'Trois plants sont malades, feuilles jaunes',
    })

    expect(res.status).toBe(200)
    expect(taskPatch()).toMatchObject({
      completionNote: 'Three plants are sick with yellow leaves',
      sourceLocale: 'fr',
      status: 'awaiting_approval',
    })
  })

  it('persists a pending completion note as the original text and still succeeds', async () => {
    isLlmConfigured.mockReturnValue(false)
    queueSelect('tasks', [taskRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patchTask('task-1', {
      status: 'awaiting_approval',
      completionNote: 'Trois plants sont malades, feuilles jaunes',
    })

    expect(res.status).toBe(200)
    expect(taskPatch()).toMatchObject({
      completionNote: 'Trois plants sont malades, feuilles jaunes',
      translationStatus: 'pending',
      sourceLocale: 'fr',
    })
  })

  it('stores a French rejection reason in English', async () => {
    sessionUser = {
      id: 'user-sup',
      farmId: 'farm-1',
      role: 'supervisor',
      name: 'Sup',
      email: 'sup@trovara.farm',
    }
    queueSelect('tasks', [taskRow({ status: 'awaiting_approval', assignedToId: 'user-worker' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await patchTask('task-1', {
      status: 'rejected',
      rejectionReason: 'Trois plants sont malades, feuilles jaunes',
    })

    expect(res.status).toBe(200)
    expect(taskPatch()).toMatchObject({
      rejectionReason: 'Three plants are sick with yellow leaves',
      status: 'rejected',
    })
  })

  it('does not clear a pending row when a later English write succeeds', async () => {
    queueSelect('tasks', [taskRow({ translationStatus: 'pending', sourceLocale: 'fr' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    await patchTask('task-1', {
      status: 'awaiting_approval',
      completionNote: 'Finished the irrigation round',
    })

    const patch = taskPatch()
    expect(patch.translationStatus).toBeUndefined()
    expect(patch.sourceLocale).toBeUndefined()
    expect(patch.completionNote).toBe('Finished the irrigation round')
  })
})

describe('GET /tasks - viewer locale on read', () => {
  it('translates a French viewer list in one batched call', async () => {
    queueSelect('tasks', [
      taskRow(),
      taskRow({ id: 'task-2', title: 'Feed the layers', description: null }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await listTasks()
    const body = (await res.json()) as { tasks: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(selectLog.filter((table) => table === 'content_translations')).toHaveLength(1)
    expect(body.tasks[0].title).toBe('Arroser les bananiers du bloc A')
    expect(body.tasks[0].description).toBe('Irrigation matinale pour le bloc A')
    expect(body.tasks[1].title).toBe('Nourrir les pondeuses')
  })

  it('leaves ids, enums, names, evidence URLs and coordinates untouched', async () => {
    queueSelect('tasks', [taskRow()])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const body = (await (await listTasks()).json()) as { tasks: Row[] }
    const task = body.tasks[0]

    expect(task).toMatchObject({
      id: 'task-1',
      status: 'in_progress',
      actionType: 'crop_census',
      actionPayload: { crops: ['plantain'], systemTemplateKey: 'handover_crop_census' },
      assignedToId: 'user-worker',
      assignedToName: 'Awa Diallo',
      plotName: 'Block A',
      photoUrl: 'evidence://farm-1/photo-1',
      latitude: '6.5244',
      longitude: '3.3792',
    })
    // Only the prose columns are ever handed to the translator.
    expect(viewerBatchCalls).toHaveBeenCalledWith(
      expect.objectContaining({
        texts: ['Water the plantains in block A', 'Morning irrigation for Block A'],
      }),
    )
  })

  it('makes one batched call and one call per distinct string for 50 tasks', async () => {
    const rows = Array.from({ length: 50 }, (_, index) =>
      taskRow({
        id: `task-${index}`,
        title: index % 2 === 0 ? 'Water the plantains in block A' : 'Feed the layers',
        description: null,
      }),
    )
    queueSelect('tasks', rows)
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const body = (await (await listTasks()).json()) as { tasks: Row[] }

    expect(body.tasks).toHaveLength(50)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(completeChat).toHaveBeenCalledTimes(2)
    expect(body.tasks[0].title).toBe('Arroser les bananiers du bloc A')
    expect(body.tasks[1].title).toBe('Nourrir les pondeuses')
  })

  it('does no translation work at all for an English viewer', async () => {
    queueSelect('tasks', [taskRow(), taskRow({ id: 'task-2', title: 'Feed the layers' })])
    queueSelect('users', [{ preferredLocale: 'en' }])

    const body = (await (await listTasks()).json()) as { tasks: Row[] }

    expect(viewerBatchCalls).not.toHaveBeenCalled()
    expect(completeChat).not.toHaveBeenCalled()
    expect(selectLog).not.toContain('content_translations')
    expect(body.tasks[0].title).toBe('Water the plantains in block A')
  })

  it('translates the pending-approvals list in one batched call', async () => {
    queueSelect('tasks', [
      taskRow({ status: 'awaiting_approval' }),
      taskRow({ id: 'task-2', status: 'awaiting_approval', title: 'Feed the layers' }),
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/tasks/pending-approvals')
    const body = (await res.json()) as { tasks: Row[] }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.tasks[0].title).toBe('Arroser les bananiers du bloc A')
    expect(body.tasks[1].status).toBe('awaiting_approval')
  })

  it('does not translate another worker text it is masking away', async () => {
    sessionUser = {
      id: 'user-other',
      farmId: 'farm-1',
      role: 'field_worker',
      name: 'Other',
      email: 'other@trovara.farm',
    }
    queueSelect('tasks', [taskRow({ assignedToId: 'user-other', completionNote: 'Feed the layers' })])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const body = (await (await listTasks()).json()) as { tasks: Row[] }

    expect(body.tasks[0].completionNote).toBe('Nourrir les pondeuses')
  })
})

describe('GET /tasks/post-approval-changes - viewer locale on read', () => {
  it('translates the task title and reopen reason only', async () => {
    queueSelect('audit_events', [
      {
        id: 'audit-1',
        taskId: 'task-1',
        taskTitle: 'Water the plantains in block A',
        changedByName: 'Awa Diallo',
        changedByRole: 'field_worker',
        changedAt: new Date('2026-07-02T09:00:00Z'),
        metadata: { fromStatus: 'completed', toStatus: 'pending', reason: 'Feed the layers' },
      },
    ])
    queueSelect('users', [{ preferredLocale: 'fr' }])

    const res = await (await app()).request('/tasks/post-approval-changes')
    const body = (await res.json()) as {
      changes: { taskTitle: string; changedByName: string; after: Row }[]
    }

    expect(res.status).toBe(200)
    expect(viewerBatchCalls).toHaveBeenCalledTimes(1)
    expect(body.changes[0].taskTitle).toBe('Arroser les bananiers du bloc A')
    expect(body.changes[0].after.reason).toBe('Nourrir les pondeuses')
    expect(body.changes[0].after.status).toBe('pending')
    expect(body.changes[0].changedByName).toBe('Awa Diallo')
  })
})
