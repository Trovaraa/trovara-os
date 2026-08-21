import { afterEach, describe, expect, it } from 'vitest'
import { getWhatsAppConfig, isWhatsAppCustomerConfigured } from './whatsapp-meta.js'

const envKeys = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_CUSTOMER_ACCESS_TOKEN',
  'WHATSAPP_CUSTOMER_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
] as const

const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('customer WhatsApp configuration', () => {
  it('requires the phone number ID, an access token, and the verify token', () => {
    process.env.WHATSAPP_CUSTOMER_PHONE_NUMBER_ID = 'customer-number-id'
    delete process.env.WHATSAPP_ACCESS_TOKEN
    delete process.env.WHATSAPP_CUSTOMER_ACCESS_TOKEN
    delete process.env.WHATSAPP_VERIFY_TOKEN

    expect(getWhatsAppConfig('customer')).toBeNull()
    expect(isWhatsAppCustomerConfigured()).toBe(false)
  })

  it('can use a dedicated customer access token', () => {
    process.env.WHATSAPP_CUSTOMER_PHONE_NUMBER_ID = 'customer-number-id'
    process.env.WHATSAPP_CUSTOMER_ACCESS_TOKEN = 'customer-token'
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token'

    expect(getWhatsAppConfig('customer')).toMatchObject({
      accessToken: 'customer-token',
      phoneNumberId: 'customer-number-id',
      verifyToken: 'verify-token',
    })
    expect(isWhatsAppCustomerConfigured()).toBe(true)
  })

  it('falls back to the shared staff access token', () => {
    process.env.WHATSAPP_CUSTOMER_PHONE_NUMBER_ID = 'customer-number-id'
    delete process.env.WHATSAPP_CUSTOMER_ACCESS_TOKEN
    process.env.WHATSAPP_ACCESS_TOKEN = 'shared-token'
    process.env.WHATSAPP_VERIFY_TOKEN = 'verify-token'

    expect(getWhatsAppConfig('customer')?.accessToken).toBe('shared-token')
    expect(isWhatsAppCustomerConfigured()).toBe(true)
  })
})
