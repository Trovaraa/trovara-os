import { Resend, type WebhookEventPayload } from 'resend'
import {
  newsletterConfirmEmailContent,
  newsletterWelcomeEmailContent,
} from './email-template.js'

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

function firstAndLastName(fullName: string): { firstName: string; lastName?: string } {
  const parts = fullName.trim().split(/\s+/)
  return {
    firstName: parts.shift() ?? fullName.trim(),
    lastName: parts.length ? parts.join(' ') : undefined,
  }
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
  const mail = newsletterConfirmEmailContent(subscriber.fullName, link)
  const response = await resendClient().emails.send(
    {
      from: requiredConfig('RESEND_FROM'),
      to: subscriber.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
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
  const mail = newsletterWelcomeEmailContent(subscriber.fullName, link)
  const response = await resendClient().emails.send(
    {
      from: requiredConfig('RESEND_FROM'),
      to: subscriber.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
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

