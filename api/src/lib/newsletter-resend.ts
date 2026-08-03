import { Resend, type WebhookEventPayload } from 'resend'

export type NewsletterContact = {
  id: string
  email: string
  fullName: string
  status: 'pending' | 'confirmed' | 'unsubscribed' | 'suppressed'
}

type EmailSubscriber = NewsletterContact & {
  confirmationTokenHash?: string | null
  unsubscribeToken: string
}

let client: Resend | null = null

function resendClient(): Resend {
  const key = process.env.RESEND_API_KEY?.trim()
  if (!key) throw new Error('RESEND_API_KEY is not configured')
  client ??= new Resend(key)
  return client
}

function requiredConfig(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function marketingUrl(): string {
  return requiredConfig('PUBLIC_MARKETING_URL').replace(/\/+$/, '')
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function firstAndLastName(fullName: string): { firstName: string; lastName?: string } {
  const parts = fullName.trim().split(/\s+/)
  return {
    firstName: parts.shift() ?? fullName.trim(),
    lastName: parts.length ? parts.join(' ') : undefined,
  }
}

function emailFrame(preheader: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Trovara</title></head>
<body style="margin:0;background:#f4f7f2;color:#18311f;font-family:Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>
  <main style="max-width:600px;margin:0 auto;padding:32px 16px">
    <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #dfe8dc">
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-collapse:collapse">
        <tr>
          <td style="padding:0 12px 0 0;vertical-align:middle">
            <img src="https://trovara.farm/brand/trovara-mark.png" width="52" height="52" alt="" style="display:block;width:52px;height:52px;border:0;border-radius:10px">
          </td>
          <td style="padding:0;vertical-align:middle">
            <span style="display:block;color:#28382f;font-size:21px;font-weight:800;letter-spacing:1.5px;line-height:1.1">TROVARA</span>
            <span style="display:block;margin-top:4px;color:#889058;font-size:10px;font-weight:700;letter-spacing:4px;line-height:1">FARM</span>
          </td>
        </tr>
      </table>
      ${body}
      <p style="margin:32px 0 0;color:#617064;font-size:13px">Fresh farm stories and seasonal updates from Trovara.</p>
    </div>
  </main>
</body>
</html>`
}

function button(link: string, label: string): string {
  return `<p style="margin:28px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#2f6b3b;color:#fff;text-decoration:none;padding:13px 22px;border-radius:7px;font-weight:700">${escapeHtml(label)}</a></p>`
}

export function newsletterConsentVersion(): string {
  return process.env.NEWSLETTER_CONSENT_VERSION?.trim() || '1.0'
}

export function newsletterConfigMissing(): string[] {
  return [
    'RESEND_API_KEY',
    'RESEND_FROM',
    'RESEND_NEWSLETTER_SEGMENT_ID',
    'RESEND_WEBHOOK_SECRET',
    'PUBLIC_MARKETING_URL',
  ].filter((name) => !process.env[name]?.trim())
}

export async function sendConfirmationEmail(
  subscriber: Omit<EmailSubscriber, 'unsubscribeToken'>,
  confirmationToken: string,
): Promise<string> {
  const link = `${marketingUrl()}/newsletter/confirm?token=${encodeURIComponent(confirmationToken)}`
  const name = escapeHtml(subscriber.fullName)
  const response = await resendClient().emails.send(
    {
      from: requiredConfig('RESEND_FROM'),
      to: subscriber.email,
      subject: 'Confirm your Trovara newsletter subscription',
      html: emailFrame(
        'Confirm your subscription to Trovara updates.',
        `<h1 style="font-size:28px;line-height:1.2">One last step, ${name}</h1>
        <p style="font-size:16px;line-height:1.6">Please confirm that you want to receive Trovara farm stories and seasonal updates.</p>
        ${button(link, 'Confirm subscription')}
        <p style="font-size:14px;line-height:1.5">This link expires in 48 hours. If you did not request this, you can ignore this email.</p>`,
      ),
      text: `Hi ${subscriber.fullName},\n\nConfirm your Trovara newsletter subscription:\n${link}\n\nThis link expires in 48 hours. If you did not request this, ignore this email.`,
      tags: [{ name: 'category', value: 'newsletter-confirmation' }],
    },
    { idempotencyKey: `newsletter-confirm-${subscriber.id}-${subscriber.confirmationTokenHash?.slice(0, 20)}` },
  )
  if (response.error) throw new Error(response.error.message)
  return response.data.id
}

export async function sendWelcomeEmail(
  subscriber: EmailSubscriber,
  idempotencyVersion: string,
): Promise<string> {
  const link = `${marketingUrl()}/newsletter/unsubscribe?token=${encodeURIComponent(subscriber.unsubscribeToken)}`
  const response = await resendClient().emails.send(
    {
      from: requiredConfig('RESEND_FROM'),
      to: subscriber.email,
      subject: 'Welcome to the Trovara newsletter',
      html: emailFrame(
        'Welcome to Trovara farm stories and seasonal updates.',
        `<h1 style="font-size:28px;line-height:1.2">Welcome, ${escapeHtml(subscriber.fullName)}</h1>
        <p style="font-size:16px;line-height:1.6">Your subscription is confirmed. We look forward to sharing what is growing, what is in season, and life around the farm.</p>
        <p style="font-size:13px;line-height:1.5;color:#617064">You can <a href="${escapeHtml(link)}">unsubscribe at any time</a>.</p>`,
      ),
      text: `Hi ${subscriber.fullName},\n\nYour Trovara newsletter subscription is confirmed.\n\nUnsubscribe at any time: ${link}`,
      tags: [{ name: 'category', value: 'newsletter-welcome' }],
    },
    { idempotencyKey: `newsletter-welcome-${subscriber.id}-${idempotencyVersion}` },
  )
  if (response.error) throw new Error(response.error.message)
  return response.data.id
}

export async function upsertResendContact(subscriber: NewsletterContact): Promise<string> {
  const resend = resendClient()
  const segmentId = requiredConfig('RESEND_NEWSLETTER_SEGMENT_ID')
  const { firstName, lastName } = firstAndLastName(subscriber.fullName)
  const unsubscribed = subscriber.status !== 'confirmed'
  const existing = await resend.contacts.get({ email: subscriber.email })

  let contactId: string
  if (existing.data) {
    contactId = existing.data.id
    const updated = await resend.contacts.update({
      id: contactId,
      firstName,
      lastName: lastName ?? null,
      unsubscribed,
    })
    if (updated.error) throw new Error(updated.error.message)
  } else if (existing.error?.name === 'not_found') {
    const created = await resend.contacts.create({
      email: subscriber.email,
      firstName,
      lastName,
      unsubscribed,
    })
    if (created.error) throw new Error(created.error.message)
    contactId = created.data.id
  } else {
    throw new Error(existing.error?.message ?? 'Unable to read Resend contact')
  }

  const segmentAction =
    subscriber.status === 'confirmed'
      ? resend.contacts.segments.add({ contactId, segmentId })
      : resend.contacts.segments.remove({ contactId, segmentId })
  const segmentResponse = await segmentAction
  if (segmentResponse.error && segmentResponse.error.name !== 'not_found') {
    throw new Error(segmentResponse.error.message)
  }
  return contactId
}

export function verifyResendWebhook(
  payload: string,
  headers: { id: string; timestamp: string; signature: string },
): WebhookEventPayload {
  const verifier = client ?? new Resend(process.env.RESEND_API_KEY?.trim())
  return verifier.webhooks.verify({
    payload,
    headers,
    webhookSecret: requiredConfig('RESEND_WEBHOOK_SECRET'),
  })
}

