import { config } from 'dotenv'
import { resolve, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
config({ path: resolve(rootDir, '.env') })

if (process.env.NODE_ENV === 'production') {
  const configurationErrors: string[] = []
  const isRequired = (name: string) => process.env[name]?.trim().toLowerCase() === 'true'
  const validateDeliveryChannel = (channel: 'SMS') => {
    const required = isRequired(`${channel}_DELIVERY_REQUIRED`)
    const values = [
      `${channel}_WEBHOOK_URL`,
      `${channel}_WEBHOOK_TOKEN`,
      `${channel}_FROM`,
    ] as const
    const configured = values.filter((name) => process.env[name]?.trim())

    if (required && configured.length !== values.length) {
      configurationErrors.push(
        `${channel}_DELIVERY_REQUIRED=true requires ${values.join(', ')}`,
      )
    } else if (configured.length > 0 && configured.length !== values.length) {
      configurationErrors.push(`${channel} delivery must configure ${values.join(', ')} together`)
    }

    const webhookUrl = process.env[`${channel}_WEBHOOK_URL`]?.trim()
    if (webhookUrl) {
      try {
        const parsed = new URL(webhookUrl)
        if (parsed.protocol !== 'https:') throw new Error('not HTTPS')
      } catch {
        configurationErrors.push(`${channel}_WEBHOOK_URL must be a valid HTTPS URL`)
      }
    }
  }

  const validateEmailDelivery = () => {
    const required = isRequired('EMAIL_DELIVERY_REQUIRED')
    const providerFrom =
      process.env.EMAIL_FROM?.trim() ||
      process.env.RESEND_FROM?.trim()
    const resendKey = process.env.RESEND_API_KEY?.trim()
    const resendReady = Boolean(resendKey && providerFrom)

    if (resendKey && !providerFrom) {
      configurationErrors.push('RESEND_API_KEY requires EMAIL_FROM or RESEND_FROM')
    }
    if (required && !resendReady) {
      configurationErrors.push(
        'EMAIL_DELIVERY_REQUIRED=true requires RESEND_API_KEY and EMAIL_FROM or RESEND_FROM',
      )
    }
  }

  if (!process.env.CRON_SECRET?.trim()) {
    configurationErrors.push('CRON_SECRET is required in production')
  }

  if (!process.env.CRON_FARM_ID?.trim()) {
    configurationErrors.push('CRON_FARM_ID is required in production so cron jobs cannot target another farm')
  }

  if (!process.env.FORM_PROXY_SIGNING_SECRET?.trim()) {
    configurationErrors.push('FORM_PROXY_SIGNING_SECRET is required in production for public-form rate limits')
  }

  if (!process.env.BREAK_GLASS_PASSWORD?.trim()) {
    configurationErrors.push('BREAK_GLASS_PASSWORD is required in production for emergency owner login')
  }

  if (!process.env.TOTP_ENCRYPTION_KEY?.trim() && !process.env.TOTP_KEY_DERIVATION_SECRET?.trim()) {
    configurationErrors.push(
      'TOTP_ENCRYPTION_KEY (32-byte hex/base64) or TOTP_KEY_DERIVATION_SECRET is required in production',
    )
  }

  if (!process.env.VAULT_ENCRYPTION_KEY?.trim()) {
    configurationErrors.push(
      'VAULT_ENCRYPTION_KEY (32-byte hex/base64) is required in production for the portal vault',
    )
  }

  const evidenceRoot = process.env.EVIDENCE_STORAGE_ROOT?.trim()
  if (!evidenceRoot || !isAbsolute(evidenceRoot)) {
    configurationErrors.push('EVIDENCE_STORAGE_ROOT must be an absolute persistent path in production')
  }

  const trustedProxyHops = process.env.TRUSTED_PROXY_HOPS?.trim()
  if (
    trustedProxyHops &&
    (!/^\d+$/.test(trustedProxyHops) || Number(trustedProxyHops) < 0)
  ) {
    configurationErrors.push('TRUSTED_PROXY_HOPS must be a non-negative integer')
  }

  if (process.env.TELEGRAM_BOT_TOKEN?.trim() && !process.env.TELEGRAM_WEBHOOK_SECRET?.trim()) {
    if ((process.env.TELEGRAM_MODE?.trim() || 'polling') === 'webhook') {
      configurationErrors.push('TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_MODE=webhook')
    }
  }

  if (
    process.env.TELEGRAM_CUSTOMER_BOT_TOKEN?.trim() &&
    !process.env.TELEGRAM_CUSTOMER_WEBHOOK_SECRET?.trim()
  ) {
    if ((process.env.TELEGRAM_MODE?.trim() || 'polling') === 'webhook') {
      configurationErrors.push('TELEGRAM_CUSTOMER_WEBHOOK_SECRET is required when TELEGRAM_MODE=webhook')
    }
  }

  if (
    (process.env.WHATSAPP_ACCESS_TOKEN?.trim() || process.env.WHATSAPP_CUSTOMER_ACCESS_TOKEN?.trim()) &&
    !process.env.META_APP_SECRET?.trim()
  ) {
    configurationErrors.push('META_APP_SECRET is required when WhatsApp is configured')
  }

  for (const name of ['BRAND_UPLOAD_MAX_BYTES', 'BRAND_MAX_FARM_STORAGE_BYTES']) {
    const value = process.env[name]?.trim()
    if (value && (!/^\d+$/.test(value) || Number(value) < 1)) {
      configurationErrors.push(`${name} must be a positive integer`)
    }
  }

  validateEmailDelivery()
  validateDeliveryChannel('SMS')

  const marketingLeadRecipients = process.env.MARKETING_LEAD_NOTIFICATION_EMAILS?.trim()
  if (marketingLeadRecipients) {
    const invalidRecipients = marketingLeadRecipients
      .split(',')
      .map((email) => email.trim())
      .filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    if (invalidRecipients.length > 0) {
      configurationErrors.push(
        'MARKETING_LEAD_NOTIFICATION_EMAILS must be a comma-separated list of valid email addresses',
      )
    }
  }

  const publicAppUrl = process.env.PUBLIC_APP_URL?.trim()
  if (isRequired('EMAIL_DELIVERY_REQUIRED') && !publicAppUrl) {
    configurationErrors.push('PUBLIC_APP_URL is required when EMAIL_DELIVERY_REQUIRED=true')
  } else if (publicAppUrl) {
    try {
      const parsed = new URL(publicAppUrl)
      if (parsed.protocol !== 'https:') throw new Error('not HTTPS')
    } catch {
      configurationErrors.push('PUBLIC_APP_URL must be a valid HTTPS URL')
    }
  }

  if (configurationErrors.length > 0) {
    throw new Error(`Invalid production configuration:\n- ${configurationErrors.join('\n- ')}`)
  }
}
