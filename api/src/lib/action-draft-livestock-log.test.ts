import { beforeEach, describe, expect, it, vi } from 'vitest'

const logAudit = vi.fn(async () => undefined)

/** Values passed to the livestock_logs insert. */
const inserted: Record<string, unknown>[] = []
const batch = {
  id: 'batch-1',
  farmId: 'farm-1',
  name: 'Noiler A',
  headCount: 200,
  active: true,
}

const tx = {
  insert: () => ({
    values: (values: Record<string, unknown>) => {
      inserted.push(values)
      return { returning: async () => [{ id: 'log-1', ...values }] }
    },
  }),
  update: () => ({ set: () => ({ where: async () => undefined }) }),
}

/** Rows every select returns; the batch lookups are the only reads here. */
let selectRows: Record<string, unknown>[] = [batch]

vi.mock('../db/index.js', () => {
  const selectChain = () => {
    const self: Record<string, unknown> = {}
    const same = () => self
    Object.assign(self, {
      from: same,
      where: same,
      limit: same,
      then: (resolve: (rows: Record<string, unknown>[]) => unknown, reject?: unknown) =>
        Promise.resolve(selectRows).then(resolve, reject as never),
    })
    return self
  }

  return {
    db: {
      select: selectChain,
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  }
})

vi.mock('./audit.js', () => ({ logAudit }))

const user = {
  id: 'user-1',
  farmId: 'farm-1',
  email: 'worker@farm.test',
  name: 'Worker',
  role: 'field_worker' as const,
  mustChangePassword: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  inserted.length = 0
  selectRows = [batch]
})

describe('executeConfirmedLivestockLog', () => {
  it('carries a pending draft through to the log row', async () => {
    const { executeConfirmedLivestockLog } = await import('./action-draft-livestock-log.js')

    await executeConfirmedLivestockLog(
      user,
      { batchId: 'batch-1', logType: 'feeding', notes: 'stress thermique' },
      'butler',
      { sourceLocale: 'fr', translationStatus: 'pending' },
    )

    expect(inserted[0]).toMatchObject({
      notes: 'stress thermique',
      sourceLocale: 'fr',
      translationStatus: 'pending',
    })
  })

  it('records the author locale of a draft that translated cleanly', async () => {
    const { executeConfirmedLivestockLog } = await import('./action-draft-livestock-log.js')

    await executeConfirmedLivestockLog(
      user,
      { batchId: 'batch-1', logType: 'mortality', headCount: 3, notes: 'heat stress' },
      'butler',
      { sourceLocale: 'pcm', translationStatus: 'done' },
    )

    expect(inserted[0]).toMatchObject({
      headCount: 3,
      sourceLocale: 'pcm',
      translationStatus: 'done',
    })
  })

  it('leaves the schema defaults alone for an English draft', async () => {
    const { executeConfirmedLivestockLog } = await import('./action-draft-livestock-log.js')

    await executeConfirmedLivestockLog(
      user,
      { batchId: 'batch-1', logType: 'feeding', notes: 'morning feed' },
      'butler',
      { sourceLocale: null, translationStatus: 'done' },
    )

    expect(inserted[0]).not.toHaveProperty('sourceLocale')
    expect(inserted[0]).not.toHaveProperty('translationStatus')
  })

  it('leaves the schema defaults alone for callers that pass no metadata', async () => {
    const { executeConfirmedLivestockLog } = await import('./action-draft-livestock-log.js')

    const reply = await executeConfirmedLivestockLog(user, {
      batchId: 'batch-1',
      logType: 'feeding',
      notes: 'morning feed',
    })

    expect(reply).toBe('✅ feeding logged for Noiler A.')
    expect(inserted[0]).not.toHaveProperty('sourceLocale')
    expect(inserted[0]).not.toHaveProperty('translationStatus')
  })
})

describe('resolveLivestockBatchByName', () => {
  async function resolve(query: string) {
    const { resolveLivestockBatchByName } = await import('./action-draft-livestock-log.js')
    return resolveLivestockBatchByName('farm-1', query)
  }

  beforeEach(() => {
    selectRows = [
      { id: 'batch-1', name: 'Poulets-Bloc A', headCount: 200, active: true },
      { id: 'batch-2', name: 'Pondeuses Été', headCount: 120, active: true },
    ]
  })

  it('matches the batch however the worker punctuated or accented it', async () => {
    await expect(resolve('poulets bloc a')).resolves.toMatchObject({ id: 'batch-1' })
    await expect(resolve('POULETS-BLOC A')).resolves.toMatchObject({ id: 'batch-1' })
    await expect(resolve('pondeuses ete')).resolves.toMatchObject({ id: 'batch-2' })
  })

  it('returns the stored spelling for the reply to quote', async () => {
    await expect(resolve('pondeuses ete')).resolves.toMatchObject({ name: 'Pondeuses Été' })
  })

  it('refuses to guess between two batches that fold together', async () => {
    selectRows = [
      { id: 'batch-1', name: 'Poulets-Bloc A', headCount: 200, active: true },
      { id: 'batch-2', name: 'Poulets Bloc A', headCount: 90, active: true },
    ]

    await expect(resolve('poulets bloc a')).resolves.toBeNull()
    await expect(resolve('Poulets Bloc A')).resolves.toMatchObject({ id: 'batch-2' })
  })
})

describe('applyConfirmedLivestockLogDraft', () => {
  it('threads the draft locale into the log write', async () => {
    const { applyConfirmedLivestockLogDraft } = await import('./action-draft-livestock-log.js')

    await applyConfirmedLivestockLogDraft(
      user,
      'livestock_log',
      { batchId: 'batch-1', logType: 'incident', notes: 'wahala for pen' },
      'whatsapp_confirm',
      { sourceLocale: 'pcm', translationStatus: 'pending' },
    )

    expect(inserted[0]).toMatchObject({ sourceLocale: 'pcm', translationStatus: 'pending' })
  })
})
