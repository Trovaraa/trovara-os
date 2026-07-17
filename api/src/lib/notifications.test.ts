import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deliverCriticalAlert,
  deliverPasswordReset,
  passwordResetUrl,
  requiredDeliveryFailed,
  sendEmail,
  sendSms,
} from './notifications.js'

const ENV_KEYS = [
  'PUBLIC_APP_URL',
  'EMAIL_WEBHOOK_URL',
  'EMAIL_WEBHOOK_TOKEN',
  'EMAIL_FROM',
  'EMAIL_DELIVERY_REQUIRED',
  'ZEPTOMAIL_SEND_TOKEN',
  'ZEPTOMAIL_FROM',
  'ZEPTOMAIL_API_URL',
  'SMS_WEBHOOK_URL',
  'SMS_WEBHOOK_TOKEN',
  'SMS_FROM',
  'SMS_DELIVERY_REQUIRED',
] as const

describe('notification delivery', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('is disabled when channel credentials are absent', async () => {
    await expect(
      sendEmail({ to: 'owner@example.com', subject: 'Test', text: 'Hello' }),
    ).resolves.toEqual({ channel: 'email', status: 'disabled', required: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('posts provider-neutral email and SMS webhook payloads', async () => {
    process.env.EMAIL_WEBHOOK_URL = 'https://notify.example/email'
    process.env.EMAIL_WEBHOOK_TOKEN = 'email-secret'
    process.env.EMAIL_FROM = 'alerts@trovara.farm'
    process.env.SMS_WEBHOOK_URL = 'https://notify.example/sms'
    process.env.SMS_WEBHOOK_TOKEN = 'sms-secret'
    process.env.SMS_FROM = 'Trovara'
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 202 }))

    await expect(
      sendEmail({ to: 'owner@example.com', subject: 'Critical', text: 'Low stock' }),
    ).resolves.toMatchObject({ status: 'delivered' })
    await expect(
      sendSms({ to: '+2348000000000', message: 'Critical: low stock' }),
    ).resolves.toMatchObject({ status: 'delivered' })

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://notify.example/email',
      expect.objectContaining({
        method: 'POST',
        headers: {
          authorization: 'Bearer email-secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: 'owner@example.com',
          subject: 'Critical',
          text: 'Low stock',
          from: 'alerts@trovara.farm',
        }),
      }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://notify.example/sms',
      expect.objectContaining({
        body: JSON.stringify({
          to: '+2348000000000',
          message: 'Critical: low stock',
          from: 'Trovara',
        }),
      }),
    )
  })

  it('sends via Zoho ZeptoMail when ZEPTOMAIL_SEND_TOKEN is set', async () => {
    process.env.ZEPTOMAIL_SEND_TOKEN = 'zepto-token'
    process.env.EMAIL_FROM = 'Trovara OS <no-reply@trovara.farm>'
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))

    await expect(
      sendEmail({ to: 'owner@example.com', subject: 'Reset', text: 'Click here' }),
    ).resolves.toMatchObject({ status: 'delivered' })

    expect(fetch).toHaveBeenCalledWith(
      'https://api.zeptomail.com/v1.1/email',
      expect.objectContaining({
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: 'Zoho-enczapikey zepto-token',
        },
      }),
    )
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))
    expect(body.from).toEqual({ address: 'no-reply@trovara.farm', name: 'Trovara OS' })
    expect(body.to[0].email_address.address).toBe('owner@example.com')
    expect(body.subject).toBe('Reset')
    expect(body.textbody).toBe('Click here')
  })

  it('builds and delivers a reset link from PUBLIC_APP_URL', async () => {
    process.env.PUBLIC_APP_URL = 'https://os.example.com/base'
    process.env.EMAIL_WEBHOOK_URL = 'https://notify.example/email'
    process.env.EMAIL_WEBHOOK_TOKEN = 'secret'
    process.env.EMAIL_FROM = 'security@example.com'
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))

    expect(passwordResetUrl('raw+/token')).toBe(
      'https://os.example.com/reset-password?token=raw%2B%2Ftoken',
    )
    await deliverPasswordReset('owner@example.com', 'raw-token')

    const request = vi.mocked(fetch).mock.calls[0]?.[1]
    const body = JSON.parse(String(request?.body))
    expect(body.to).toBe('owner@example.com')
    expect(body.text).toContain('https://os.example.com/reset-password?token=raw-token')
  })

  it('delivers reset links by SMS and fails a required SMS channel without a phone', async () => {
    process.env.PUBLIC_APP_URL = 'https://os.example.com'
    process.env.SMS_WEBHOOK_URL = 'https://notify.example/sms'
    process.env.SMS_WEBHOOK_TOKEN = 'secret'
    process.env.SMS_FROM = 'Trovara'
    process.env.SMS_DELIVERY_REQUIRED = 'true'
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))

    const delivered = await deliverPasswordReset(
      'owner@example.com',
      'raw-token',
      '+2348000000000',
    )
    expect(delivered).toContainEqual({ channel: 'sms', status: 'delivered', required: true })

    const missingRecipient = await deliverPasswordReset('owner@example.com', 'raw-token')
    expect(missingRecipient).toContainEqual({
      channel: 'sms',
      status: 'failed',
      required: true,
    })
    expect(requiredDeliveryFailed(missingRecipient)).toBe(true)
  })

  it('marks non-success responses as failed and detects required failure', async () => {
    process.env.SMS_WEBHOOK_URL = 'https://notify.example/sms'
    process.env.SMS_WEBHOOK_TOKEN = 'secret'
    process.env.SMS_FROM = 'Trovara'
    process.env.SMS_DELIVERY_REQUIRED = 'true'
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }))

    const result = await sendSms({ to: '+2348000000000', message: 'Critical' })
    expect(result).toEqual({ channel: 'sms', status: 'failed', required: true })
    expect(requiredDeliveryFailed([result])).toBe(true)
  })

  it('fans critical alerts out by email and available phone number', async () => {
    process.env.EMAIL_WEBHOOK_URL = 'https://notify.example/email'
    process.env.EMAIL_WEBHOOK_TOKEN = 'email-secret'
    process.env.EMAIL_FROM = 'alerts@example.com'
    process.env.SMS_WEBHOOK_URL = 'https://notify.example/sms'
    process.env.SMS_WEBHOOK_TOKEN = 'sms-secret'
    process.env.SMS_FROM = 'Trovara'
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 200 }))

    const results = await deliverCriticalAlert(
      [
        { email: 'one@example.com', phone: '+2348000000001' },
        { email: 'two@example.com', phone: null },
      ],
      'Critical alert',
      'Mortality spike',
    )

    expect(results).toHaveLength(3)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      'https://notify.example/email',
      'https://notify.example/sms',
      'https://notify.example/email',
    ])
  })
})
