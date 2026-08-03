import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { returning, onConflictDoUpdate, values, deleteReturning, deleteWhere } = vi.hoisted(() => {
  const returning = vi.fn(async () => [{ attemptCount: 1 }])
  const onConflictDoUpdate = vi.fn(() => ({ returning }))
  const values = vi.fn(() => ({ onConflictDoUpdate }))
  const deleteReturning = vi.fn(async () => [] as { rateKey: string }[])
  const deleteWhere = vi.fn(() => ({ returning: deleteReturning }))
  return { returning, onConflictDoUpdate, values, deleteReturning, deleteWhere }
})

vi.mock('../db/index.js', () => ({
  db: {
    insert: () => ({ values }),
    delete: () => ({ where: deleteWhere }),
  },
}))

vi.mock('../db/schema.js', () => ({
  loginRateLimits: {
    rateKey: 'rate_key',
    attemptCount: 'attempt_count',
    windowStartsAt: 'window_starts_at',
  },
}))

const {
  checkDurableRateLimit,
  checkLoginRateLimit,
  resetDurableRateLimit,
  resetLoginRateLimit,
  hashedRateKey,
  staffLoginRateKey,
  shopLoginRateKey,
  shopEmailIpRateKey,
  shopEmailAddrRateKey,
  purgeExpiredLoginRateLimits,
  LOGIN_RATE_MAX_ATTEMPTS,
  SHOP_EMAIL_IP_MAX_ATTEMPTS,
  SHOP_EMAIL_ADDR_MAX_ATTEMPTS,
} = await import('./login-rate-limit.js')

describe('hashedRateKey helpers', () => {
  it('hashes scope and identity with a null separator', () => {
    const expected = createHash('sha256')
      .update(`staff:login${'\0'}1.2.3.4`)
      .digest('hex')
    expect(hashedRateKey('staff:login', '1.2.3.4')).toBe(expected)
  })

  it('normalizes shop email address keys', () => {
    expect(shopEmailAddrRateKey('  User@Example.COM ')).toBe(
      hashedRateKey('shop:email:addr', 'user@example.com'),
    )
  })

  it('namespaces staff and shop login keys differently', () => {
    expect(staffLoginRateKey('1.2.3.4')).not.toBe(shopLoginRateKey('1.2.3.4'))
  })

  it('namespaces shop email IP and address keys', () => {
    expect(shopEmailIpRateKey('1.2.3.4')).not.toBe(shopEmailAddrRateKey('user@example.com'))
  })

  it('uses unknown for blank IPs', () => {
    expect(staffLoginRateKey('')).toBe(hashedRateKey('staff:login', 'unknown'))
  })
})

describe('checkDurableRateLimit', () => {
  beforeEach(() => {
    returning.mockReset()
    onConflictDoUpdate.mockClear()
    values.mockClear()
    deleteWhere.mockClear()
  })

  it('allows attempts within the window', async () => {
    returning.mockResolvedValueOnce([{ attemptCount: 3 }])
    await expect(checkDurableRateLimit('abc123')).resolves.toBe(true)
    expect(values).toHaveBeenCalled()
  })

  it('blocks when attempts exceed the default max', async () => {
    returning.mockResolvedValueOnce([{ attemptCount: LOGIN_RATE_MAX_ATTEMPTS + 1 }])
    await expect(checkDurableRateLimit('abc123')).resolves.toBe(false)
  })

  it('respects a custom maxAttempts', async () => {
    returning.mockResolvedValueOnce([{ attemptCount: SHOP_EMAIL_ADDR_MAX_ATTEMPTS }])
    await expect(
      checkDurableRateLimit('addr-key', SHOP_EMAIL_ADDR_MAX_ATTEMPTS),
    ).resolves.toBe(true)
    returning.mockResolvedValueOnce([{ attemptCount: SHOP_EMAIL_ADDR_MAX_ATTEMPTS + 1 }])
    await expect(
      checkDurableRateLimit('addr-key', SHOP_EMAIL_ADDR_MAX_ATTEMPTS),
    ).resolves.toBe(false)
  })

  it('uses shop email IP max constant', () => {
    expect(SHOP_EMAIL_IP_MAX_ATTEMPTS).toBe(10)
    expect(SHOP_EMAIL_ADDR_MAX_ATTEMPTS).toBe(3)
  })

  it('resets by deleting the rate key', async () => {
    await resetDurableRateLimit('abc123')
    expect(deleteWhere).toHaveBeenCalled()
  })

  it('keeps deprecated aliases working', async () => {
    returning.mockResolvedValueOnce([{ attemptCount: 2 }])
    await expect(checkLoginRateLimit('legacy')).resolves.toBe(true)
    await resetLoginRateLimit('legacy')
    expect(deleteWhere).toHaveBeenCalled()
  })
})

describe('purgeExpiredLoginRateLimits', () => {
  beforeEach(() => {
    deleteReturning.mockReset()
  })

  it('returns the number of deleted rows', async () => {
    deleteReturning.mockResolvedValueOnce([{ rateKey: 'a' }, { rateKey: 'b' }])
    await expect(purgeExpiredLoginRateLimits()).resolves.toBe(2)
  })
})
