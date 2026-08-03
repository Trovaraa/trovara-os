import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { selectLimit } = vi.hoisted(() => ({
  selectLimit: vi.fn(async (_limit: number) => [] as { id: string }[]),
}))

vi.mock('../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (n: number) => selectLimit(n),
        }),
      }),
    }),
  },
}))

const {
  customerChannelsRequireOwnerTotp,
  farmHasOwnerTotpEnabled,
} = await import('./owner-totp-gate.js')

describe('farmHasOwnerTotpEnabled', () => {
  beforeEach(() => {
    selectLimit.mockReset()
  })

  it('is true when an active owner with TOTP exists', async () => {
    selectLimit.mockResolvedValueOnce([{ id: 'owner-1' }])
    await expect(farmHasOwnerTotpEnabled('farm-1')).resolves.toBe(true)
    expect(selectLimit).toHaveBeenCalledWith(1)
  })

  it('is false when no matching owner row exists', async () => {
    selectLimit.mockResolvedValueOnce([])
    await expect(farmHasOwnerTotpEnabled('farm-1')).resolves.toBe(false)
  })
})

describe('customerChannelsRequireOwnerTotp', () => {
  const prevEnv = process.env.NODE_ENV
  const prevFlag = process.env.ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP

  afterEach(() => {
    process.env.NODE_ENV = prevEnv
    if (prevFlag === undefined) delete process.env.ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP
    else process.env.ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP = prevFlag
  })

  it('is off outside production', () => {
    process.env.NODE_ENV = 'development'
    delete process.env.ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP
    expect(customerChannelsRequireOwnerTotp()).toBe(false)
  })

  it('is on in production by default', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP
    expect(customerChannelsRequireOwnerTotp()).toBe(true)
  })

  it('can be bypassed with ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOW_CUSTOMER_CHANNELS_WITHOUT_TOTP = 'true'
    expect(customerChannelsRequireOwnerTotp()).toBe(false)
  })
})
