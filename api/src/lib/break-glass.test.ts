import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const selectLimit = vi.fn()
const selectWhere = vi.fn(() => ({ limit: selectLimit }))
const selectFrom = vi.fn(() => ({ where: selectWhere, limit: selectLimit }))
const select = vi.fn(() => ({ from: selectFrom }))
const insertValues = vi.fn()
const insert = vi.fn(() => ({ values: insertValues }))
const updateWhere = vi.fn()
const updateSet = vi.fn(() => ({ where: updateWhere }))
const update = vi.fn(() => ({ set: updateSet }))

vi.mock('../db/index.js', () => ({
  db: { select, insert, update },
}))

vi.mock('./session.js', () => ({
  hashPassword: vi.fn(async () => 'hashed-placeholder'),
}))

describe('ensureBreakGlassOwner', () => {
  const prevPassword = process.env.BREAK_GLASS_PASSWORD
  const prevEmail = process.env.BREAK_GLASS_EMAIL
  const prevFarm = process.env.CRON_FARM_ID

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.BREAK_GLASS_PASSWORD = 'test-break-glass'
    delete process.env.BREAK_GLASS_EMAIL
    delete process.env.CRON_FARM_ID
    selectLimit.mockReset()
    selectWhere.mockImplementation(() => ({ limit: selectLimit }))
    selectFrom.mockImplementation(() => ({ where: selectWhere, limit: selectLimit }))
    insertValues.mockResolvedValue(undefined)
    updateWhere.mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (prevPassword === undefined) delete process.env.BREAK_GLASS_PASSWORD
    else process.env.BREAK_GLASS_PASSWORD = prevPassword
    if (prevEmail === undefined) delete process.env.BREAK_GLASS_EMAIL
    else process.env.BREAK_GLASS_EMAIL = prevEmail
    if (prevFarm === undefined) delete process.env.CRON_FARM_ID
    else process.env.CRON_FARM_ID = prevFarm
  })

  it('skips when BREAK_GLASS_PASSWORD is unset', async () => {
    delete process.env.BREAK_GLASS_PASSWORD
    const { ensureBreakGlassOwner } = await import('./break-glass.js')
    await expect(ensureBreakGlassOwner()).resolves.toBe('skipped')
    expect(select).not.toHaveBeenCalled()
  })

  it('returns exists when the break-glass user is already present', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'u1', active: true }])
    const { ensureBreakGlassOwner } = await import('./break-glass.js')
    await expect(ensureBreakGlassOwner()).resolves.toBe('exists')
    expect(insert).not.toHaveBeenCalled()
  })

  it('creates the break-glass owner when a farm exists', async () => {
    selectLimit
      .mockResolvedValueOnce([]) // no user
      .mockResolvedValueOnce([{ id: 'farm-1' }]) // first farm
    const { ensureBreakGlassOwner } = await import('./break-glass.js')
    await expect(ensureBreakGlassOwner()).resolves.toBe('created')
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        farmId: 'farm-1',
        email: 'owner@trovara.farm',
        role: 'owner',
        active: true,
      }),
    )
  })
})
