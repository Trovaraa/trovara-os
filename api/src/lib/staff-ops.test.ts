import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseStaffOpsCommand,
  taskReference,
  transitionTaskFromCallback,
  tryHandleStaffOpsCommand,
} from './staff-ops.js'

/** The single task the mocked db knows about, and every `set(...)` applied to it. */
const taskRows: Record<string, unknown>[] = []
const taskUpdates: Record<string, unknown>[] = []

function selectResult() {
  const result = Promise.resolve(taskRows) as Promise<Record<string, unknown>[]> & {
    limit: (n?: number) => Promise<Record<string, unknown>[]>
  }
  result.limit = async () => taskRows
  return result
}

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => selectResult() }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            taskUpdates.push(values)
            return [{ ...taskRows[0], ...values }]
          },
        }),
      }),
    }),
  },
}))

vi.mock('./audit.js', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('./farm-notify.js', () => ({
  notifyTaskSubmittedForApproval: vi.fn(async () => undefined),
  notifyTaskRejected: vi.fn(async () => undefined),
}))

const clockIn = vi.fn()
const clockOut = vi.fn()
vi.mock('./attendance-service.js', () => ({
  clockIn: (...args: unknown[]) => clockIn(...args),
  clockOut: (...args: unknown[]) => clockOut(...args),
}))

const TASK_ID = '11111111-1111-1111-1111-111111111111'

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    farmId: 'farm-1',
    title: 'Weed Block 2',
    status: 'in_progress',
    assignedToId: 'user-1',
    completionNote: null,
    rejectionReason: null,
    sourceLocale: null,
    translationStatus: 'done',
    ...overrides,
  }
}

const worker = {
  id: 'user-1',
  farmId: 'farm-1',
  role: 'field_worker' as const,
  name: 'Ade',
  preferredLocale: 'fr',
}

const supervisor = {
  id: 'user-2',
  farmId: 'farm-1',
  role: 'supervisor' as const,
  name: 'Bola',
  preferredLocale: 'en',
}

beforeEach(() => {
  taskRows.length = 0
  taskUpdates.length = 0
  clockIn.mockReset()
  clockOut.mockReset()
})

describe('parseStaffOpsCommand', () => {
  it('parses clock and task commands', () => {
    expect(parseStaffOpsCommand('/clockin')).toEqual({ action: 'clock_in' })
    expect(parseStaffOpsCommand('clock out')).toEqual({ action: 'clock_out' })
    expect(parseStaffOpsCommand('/tasks')).toEqual({ action: 'tasks' })
    expect(parseStaffOpsCommand('/taskstart')).toEqual({ action: 'start' })
    expect(parseStaffOpsCommand('/done TSK-ABCDEF weeded plot')).toEqual({
      action: 'done',
      ref: 'TSK-ABCDEF',
      note: 'weeded plot',
    })
    expect(parseStaffOpsCommand('/approve')).toEqual({ action: 'approve' })
    expect(parseStaffOpsCommand('/start')).toEqual({ action: 'help' })
  })
})

describe('clock commands for non-field staff', () => {
  it('clocks in supervisors via staff ops', async () => {
    clockIn.mockResolvedValueOnce({ idempotent: false, session: { id: 's1' } })
    const result = await tryHandleStaffOpsCommand({
      actor: supervisor,
      text: '/clockin',
    })
    expect(result.handled).toBe(true)
    expect(result.reply).toContain('Clocked in')
    expect(clockIn).toHaveBeenCalledOnce()
  })

  it('clocks out owners via staff ops', async () => {
    clockOut.mockResolvedValueOnce({ idempotent: false, session: { id: 's1' } })
    const result = await tryHandleStaffOpsCommand({
      actor: { ...supervisor, role: 'owner', name: 'Owner' },
      text: '/clockout',
    })
    expect(result.handled).toBe(true)
    expect(result.reply).toContain('Clocked out')
    expect(clockOut).toHaveBeenCalledOnce()
  })

  it('clocks sales staff in and out via staff ops', async () => {
    const sales = { ...supervisor, role: 'sales' as const, name: 'Sales' }
    clockIn.mockResolvedValueOnce({ idempotent: false, session: { id: 's1' } })
    clockOut.mockResolvedValueOnce({ idempotent: false, session: { id: 's1' } })

    const clockedIn = await tryHandleStaffOpsCommand({ actor: sales, text: '/clockin' })
    const clockedOut = await tryHandleStaffOpsCommand({ actor: sales, text: '/clockout' })

    expect(clockedIn.reply).toContain('Clocked in')
    expect(clockedOut.reply).toContain('Clocked out')
    expect(clockIn).toHaveBeenCalledWith(expect.objectContaining({ role: 'sales' }))
    expect(clockOut).toHaveBeenCalledWith(expect.objectContaining({ role: 'sales' }))
  })
})

describe('taskReference', () => {
  it('builds short task refs', () => {
    expect(taskReference('abcdef12-3456-7890-abcd-ef1234567890')).toBe('TSK-ABCDEF')
  })
})

describe('direct note commands', () => {
  it('marks the task pending when the caller could not translate the note', async () => {
    taskRows.push(task())

    const result = await tryHandleStaffOpsCommand({
      actor: worker,
      text: `done ${taskReference(TASK_ID)} sarclage termine`,
      noteLocale: { sourceLocale: 'fr', translationStatus: 'pending' },
    })

    expect(result.handled).toBe(true)
    expect(taskUpdates[0]).toMatchObject({
      status: 'awaiting_approval',
      completionNote: 'sarclage termine',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('behaves exactly as before when the caller passes no metadata', async () => {
    taskRows.push(task())

    await tryHandleStaffOpsCommand({
      actor: worker,
      text: `done ${taskReference(TASK_ID)} weeding finished`,
    })

    expect(taskUpdates[0]).toMatchObject({ completionNote: 'weeding finished' })
    expect(taskUpdates[0]).not.toHaveProperty('sourceLocale')
    expect(taskUpdates[0]).not.toHaveProperty('translationStatus')
  })

  it('leaves a task that already owes a translation pending', async () => {
    taskRows.push(task({ sourceLocale: 'fr', translationStatus: 'pending' }))

    await tryHandleStaffOpsCommand({
      actor: worker,
      text: `done ${taskReference(TASK_ID)} weeding finished`,
      noteLocale: { sourceLocale: null, translationStatus: 'done' },
    })

    expect(taskUpdates[0]).not.toHaveProperty('sourceLocale')
    expect(taskUpdates[0]).not.toHaveProperty('translationStatus')
  })

  it('does not touch the locale columns when the command carries no note', async () => {
    taskRows.push(task({ status: 'pending' }))

    await tryHandleStaffOpsCommand({
      actor: worker,
      text: `start ${taskReference(TASK_ID)}`,
      noteLocale: { sourceLocale: 'fr', translationStatus: 'pending' },
    })

    expect(taskUpdates[0]).toMatchObject({ status: 'in_progress' })
    expect(taskUpdates[0]).not.toHaveProperty('completionNote')
    expect(taskUpdates[0]).not.toHaveProperty('translationStatus')
  })
})

describe('transitionTaskFromCallback', () => {
  it('marks the task pending for an untranslated rejection reason', async () => {
    taskRows.push(task({ status: 'awaiting_approval', assignedToId: 'user-1' }))

    await transitionTaskFromCallback({
      actor: supervisor,
      taskId: TASK_ID,
      action: 'reject',
      note: 'travail incomplet',
      noteLocale: { sourceLocale: 'fr', translationStatus: 'pending' },
    })

    expect(taskUpdates[0]).toMatchObject({
      status: 'rejected',
      rejectionReason: 'travail incomplet',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('keeps the schema default for an English rejection reason', async () => {
    taskRows.push(task({ status: 'awaiting_approval', assignedToId: 'user-1' }))

    await transitionTaskFromCallback({
      actor: supervisor,
      taskId: TASK_ID,
      action: 'reject',
      note: 'work incomplete',
    })

    expect(taskUpdates[0]).toMatchObject({ rejectionReason: 'work incomplete' })
    expect(taskUpdates[0]).not.toHaveProperty('translationStatus')
  })
})
