import { afterEach, describe, expect, it } from 'vitest'
import { cronFarmIdAllowed, requestHasCronSecret } from './cron-auth.js'

const originalSecret = process.env.CRON_SECRET
const originalFarm = process.env.CRON_FARM_ID
const originalEnv = process.env.NODE_ENV

afterEach(() => {
  if (originalSecret === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = originalSecret
  if (originalFarm === undefined) delete process.env.CRON_FARM_ID
  else process.env.CRON_FARM_ID = originalFarm
  if (originalEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalEnv
})

describe('cronFarmIdAllowed', () => {
  it('rejects a missing farm id', () => {
    process.env.CRON_FARM_ID = 'farm-1'
    expect(cronFarmIdAllowed(undefined)).toBe(false)
    expect(cronFarmIdAllowed('')).toBe(false)
  })

  it('requires the pinned farm in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.CRON_FARM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    expect(cronFarmIdAllowed('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe(true)
    expect(cronFarmIdAllowed('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false)
  })

  it('allows any farm id in non-production when CRON_FARM_ID is unset', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.CRON_FARM_ID
    expect(cronFarmIdAllowed('farm-local')).toBe(true)
  })
})

describe('requestHasCronSecret', () => {
  it('compares the header in constant time', () => {
    process.env.CRON_SECRET = 'cron-secret-value'
    expect(
      requestHasCronSecret({ req: { header: (name) => (name === 'x-cron-secret' ? 'cron-secret-value' : undefined) } }),
    ).toBe(true)
    expect(
      requestHasCronSecret({ req: { header: (name) => (name === 'x-cron-secret' ? 'wrong' : undefined) } }),
    ).toBe(false)
  })
})
