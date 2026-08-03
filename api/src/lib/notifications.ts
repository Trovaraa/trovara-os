import {
  emailLayout,
  escapeEmailHtml,
  staffPasswordResetEmailContent,
} from './email-template.js'

type Channel = 'email' | 'sms'

type DeliveryResult = {
  channel: Channel
  status: 'delivered' | 'disabled' | 'failed'
  required: boolean
}

type EmailMessage = {
  to: string
  subject: string
  text: string
  html?: string
  replyTo?: string
}

type SmsMessage = {
  to: string
  message: string
}

type CriticalAlertRecipient = {
  email: string
  phone?: string | null
}

type SmsConfig = {
  url?: string
  token?: string
  from?: string
  required: boolean
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

function smsConfig(): SmsConfig {
  return {
    url: process.env.SMS_WEBHOOK_URL?.trim(),
    token: process.env.SMS_WEBHOOK_TOKEN?.trim(),
    from: process.env.SMS_FROM?.trim(),
    required: enabled(process.env.SMS_DELIVERY_REQUIRED),
  }
}

function emailFromAddress(): string | undefined {
  const raw =
    process.env.EMAIL_FROM?.trim() ||
    process.env.RESEND_FROM?.trim() ||
    undefined
  if (!raw) return undefined
  // Strip accidental surrounding quotes from .env editors / shell exports.
  return raw.replace(/^['"]|['"]$/g, '').trim() || undefined
}

/** Preferred transactional provider (same API key as newsletter). */
function resendConfigured(): { apiKey: string; from: string } | null {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = emailFromAddress()
  if (!apiKey || !from) return null
  return { apiKey, from }
}

export function emailProviderReady(): boolean {
  return Boolean(resendConfigured())
}

async function sendViaResend(message: EmailMessage): Promise<DeliveryResult> {
  const config = resendConfigured()
  const required = enabled(process.env.EMAIL_DELIVERY_REQUIRED)
  if (!config) {
    return { channel: 'email', status: 'disabled', required }
  }

  const html =
    message.html?.trim() ||
    `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(message.text)}</pre>`

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      console.error(
        `Resend email failed (${response.status}) to=${message.to} subject=${JSON.stringify(message.subject)}: ${detail.slice(0, 400)}`,
      )
    }
    return {
      channel: 'email',
      status: response.ok ? 'delivered' : 'failed',
      required,
    }
  } catch (err) {
    console.error(
      `Resend email request error to=${message.to}:`,
      err instanceof Error ? err.message : err,
    )
    return { channel: 'email', status: 'failed', required }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function sendViaSmsWebhook(payload: { to: string; message: string }): Promise<DeliveryResult> {
  const config = smsConfig()
  if (!config.url || !config.token || !config.from) {
    return { channel: 'sms', status: 'disabled', required: config.required }
  }

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...payload, from: config.from }),
      signal: AbortSignal.timeout(10_000),
    })
    return {
      channel: 'sms',
      status: response.ok ? 'delivered' : 'failed',
      required: config.required,
    }
  } catch {
    return { channel: 'sms', status: 'failed', required: config.required }
  }
}

export function sendEmail(message: EmailMessage): Promise<DeliveryResult> {
  const html =
    message.html ??
    emailLayout({
      preheader: message.subject,
      documentTitle: message.subject,
      badge: 'TROVARA',
      headline: message.subject,
      body: `<p style="margin:0;color:#28382f;font-size:15px;line-height:1.65;white-space:pre-wrap">${escapeEmailHtml(message.text)}</p>`,
    })
  if (resendConfigured()) {
    return sendViaResend({ ...message, html })
  }
  return Promise.resolve({
    channel: 'email',
    status: 'disabled',
    required: enabled(process.env.EMAIL_DELIVERY_REQUIRED),
  })
}

export function sendSms(message: SmsMessage): Promise<DeliveryResult> {
  return sendViaSmsWebhook(message)
}

export function requiredDeliveryFailed(results: DeliveryResult[]): boolean {
  return results.some((result) => result.required && result.status !== 'delivered')
}

export function passwordResetUrl(rawToken: string): string {
  const appUrl = process.env.PUBLIC_APP_URL?.trim()
  if (!appUrl) throw new Error('PUBLIC_APP_URL is not configured')
  const url = new URL('/reset-password', appUrl)
  url.searchParams.set('token', rawToken)
  return url.toString()
}

export async function deliverPasswordReset(
  email: string,
  rawToken: string,
  phone?: string | null,
): Promise<DeliveryResult[]> {
  const emailRequired = enabled(process.env.EMAIL_DELIVERY_REQUIRED)
  const sms = smsConfig()
  const emailReady = emailProviderReady()
  const smsReady = !!(sms.url && sms.token && sms.from)

  if (!emailReady && !smsReady) {
    return [
      { channel: 'email', status: 'disabled', required: emailRequired },
      { channel: 'sms', status: 'disabled', required: sms.required },
    ]
  }

  let resetUrl: string
  try {
    resetUrl = passwordResetUrl(rawToken)
  } catch {
    return [
      {
        channel: 'email',
        status: emailReady ? 'failed' : 'disabled',
        required: emailRequired,
      },
      {
        channel: 'sms',
        status: smsReady ? 'failed' : 'disabled',
        required: sms.required,
      },
    ]
  }

  const deliveries: Promise<DeliveryResult>[] = []
  if (emailReady) {
    const mail = staffPasswordResetEmailContent(resetUrl)
    deliveries.push(
      sendEmail({
        to: email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
    )
  } else {
    deliveries.push(
      Promise.resolve<DeliveryResult>({
        channel: 'email',
        status: 'disabled',
        required: emailRequired,
      }),
    )
  }

  if (smsReady && phone) {
    deliveries.push(
      sendSms({
        to: phone,
        message: `Reset your Trovara OS password within one hour: ${resetUrl}`,
      }),
    )
  } else {
    deliveries.push(
      Promise.resolve<DeliveryResult>({
        channel: 'sms',
        status: smsReady ? 'failed' : 'disabled',
        required: sms.required,
      }),
    )
  }

  return Promise.all(deliveries)
}

export async function deliverCriticalAlert(
  recipients: CriticalAlertRecipient[],
  subject: string,
  message: string,
): Promise<DeliveryResult[]> {
  const deliveries: Promise<DeliveryResult>[] = []
  const html = emailLayout({
    preheader: subject,
    documentTitle: subject,
    badge: 'CRITICAL ALERT',
    headline: subject,
    intro: 'Immediate attention may be required.',
    body: `<p style="margin:0;color:#28382f;font-size:15px;line-height:1.65;white-space:pre-wrap">${escapeEmailHtml(message)}</p>`,
    footer: 'Sent by Trovara OS monitoring. Review the farm dashboard when you can.',
  })
  for (const recipient of recipients) {
    deliveries.push(sendEmail({ to: recipient.email, subject, text: message, html }))
    if (recipient.phone) {
      deliveries.push(sendSms({ to: recipient.phone, message: `${subject}\n${message}` }))
    }
  }
  return Promise.all(deliveries)
}
