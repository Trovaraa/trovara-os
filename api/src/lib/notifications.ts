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
}

type SmsMessage = {
  to: string
  message: string
}

type CriticalAlertRecipient = {
  email: string
  phone?: string | null
}

type ChannelConfig = {
  url?: string
  token?: string
  from?: string
  required: boolean
}

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

function channelConfig(channel: Channel): ChannelConfig {
  const prefix = channel.toUpperCase()
  return {
    url: process.env[`${prefix}_WEBHOOK_URL`]?.trim(),
    token: process.env[`${prefix}_WEBHOOK_TOKEN`]?.trim(),
    from: process.env[`${prefix}_FROM`]?.trim(),
    required: enabled(process.env[`${prefix}_DELIVERY_REQUIRED`]),
  }
}

function parseFromAddress(from: string): { address: string; name?: string } {
  const match = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (match) {
    const name = match[1]?.replace(/^["']|["']$/g, '').trim()
    return { address: match[2].trim(), ...(name ? { name } : {}) }
  }
  return { address: from.trim() }
}

function zeptoMailConfigured(): { token: string; from: string; baseUrl: string } | null {
  const token = process.env.ZEPTOMAIL_SEND_TOKEN?.trim()
  const from = process.env.EMAIL_FROM?.trim() || process.env.ZEPTOMAIL_FROM?.trim()
  if (!token || !from) return null
  const baseUrl =
    process.env.ZEPTOMAIL_API_URL?.trim() || 'https://api.zeptomail.com/v1.1/email'
  return { token, from, baseUrl }
}

async function sendViaZeptoMail(message: EmailMessage): Promise<DeliveryResult> {
  const config = zeptoMailConfigured()
  const required = enabled(process.env.EMAIL_DELIVERY_REQUIRED)
  if (!config) {
    return { channel: 'email', status: 'disabled', required }
  }

  const from = parseFromAddress(config.from)
  const htmlbody = message.html?.trim() || `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(message.text)}</pre>`

  try {
    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Zoho-enczapikey ${config.token}`,
      },
      body: JSON.stringify({
        from,
        to: [{ email_address: { address: message.to } }],
        subject: message.subject,
        htmlbody,
        textbody: message.text,
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

async function postWebhook(
  channel: Channel,
  payload: Record<string, string>,
): Promise<DeliveryResult> {
  const config = channelConfig(channel)
  if (!config.url || !config.token || !config.from) {
    return { channel, status: 'disabled', required: config.required }
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
      channel,
      status: response.ok ? 'delivered' : 'failed',
      required: config.required,
    }
  } catch {
    return { channel, status: 'failed', required: config.required }
  }
}

export function sendEmail(message: EmailMessage): Promise<DeliveryResult> {
  // Prefer Zoho ZeptoMail when configured; otherwise use the generic webhook adapter.
  if (zeptoMailConfigured()) {
    return sendViaZeptoMail(message)
  }
  return postWebhook('email', {
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  })
}

export function sendSms(message: SmsMessage): Promise<DeliveryResult> {
  return postWebhook('sms', {
    to: message.to,
    message: message.message,
  })
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
  const emailConfig = channelConfig('email')
  const smsConfig = channelConfig('sms')
  const emailReady = !!(emailConfig.url && emailConfig.token && emailConfig.from)
  const smsReady = !!(smsConfig.url && smsConfig.token && smsConfig.from)

  if (!emailReady && !smsReady) {
    return [
      { channel: 'email', status: 'disabled', required: emailConfig.required },
      { channel: 'sms', status: 'disabled', required: smsConfig.required },
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
        required: emailConfig.required,
      },
      {
        channel: 'sms',
        status: smsReady ? 'failed' : 'disabled',
        required: smsConfig.required,
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
        required: emailConfig.required,
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
        required: smsConfig.required,
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
