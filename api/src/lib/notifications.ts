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
  return (
    process.env.EMAIL_FROM?.trim() ||
    process.env.RESEND_FROM?.trim() ||
    undefined
  )
}

/** Preferred transactional provider (same API key as newsletter). */
function resendConfigured(): { apiKey: string; from: string } | null {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = emailFromAddress()
  if (!apiKey || !from) return null
  return { apiKey, from }
}

function emailProviderReady(): boolean {
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
    return {
      channel: 'email',
      status: response.ok ? 'delivered' : 'failed',
      required,
    }
  } catch {
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
  if (resendConfigured()) {
    return sendViaResend(message)
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
    deliveries.push(
      sendEmail({
        to: email,
        subject: 'Reset your Trovara OS password',
        text: `Use this link to reset your password. It expires in one hour:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this message.`,
        html: `<p>Use the link below to reset your password. It expires in one hour.</p><p><a href="${resetUrl}">Reset password</a></p><p>If you did not request this, you can ignore this message.</p>`,
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
  for (const recipient of recipients) {
    deliveries.push(sendEmail({ to: recipient.email, subject, text: message }))
    if (recipient.phone) {
      deliveries.push(sendSms({ to: recipient.phone, message: `${subject}\n${message}` }))
    }
  }
  return Promise.all(deliveries)
}
