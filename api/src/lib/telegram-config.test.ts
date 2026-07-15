import { afterEach, describe, expect, it } from 'vitest'
import { getTelegramConfig, isTelegramConfigured } from './telegram.js'

const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CUSTOMER_BOT_TOKEN'] as const

afterEach(() => {
  for (const k of KEYS) delete process.env[k]
})

describe('getTelegramConfig is token-aware', () => {
  it('resolves the staff token by default', () => {
    process.env.TELEGRAM_BOT_TOKEN = 'staff-token'
    expect(isTelegramConfigured()).toBe(true)
    expect(getTelegramConfig()?.apiBase).toContain('staff-token')
  })

  it('resolves the customer token independently of staff', () => {
    process.env.TELEGRAM_CUSTOMER_BOT_TOKEN = 'customer-token'
    expect(isTelegramConfigured('staff')).toBe(false)
    expect(isTelegramConfigured('customer')).toBe(true)
    expect(getTelegramConfig('customer')?.apiBase).toContain('customer-token')
  })

  it('is not configured when the relevant token is blank', () => {
    process.env.TELEGRAM_BOT_TOKEN = '   '
    expect(isTelegramConfigured('staff')).toBe(false)
    expect(getTelegramConfig('staff')).toBeNull()
  })
})
