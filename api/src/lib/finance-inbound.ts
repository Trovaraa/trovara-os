import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { Resend } from 'resend'
import { db } from '../db/index.js'
import { expenses, financeInboundEvents, farms, users } from '../db/schema.js'
import { resolveCustomerFarm } from './customer-orders.js'
import { getEvidenceStorageRoot } from './evidence-store.js'
import { verifyResendWebhook, resendInboundWebhookSecret } from './newsletter-resend.js'
import { extractInvoiceFields } from './invoice-extract.js'
import { logAudit } from './audit.js'

const ALLOWED_ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])
const DEFAULT_FINANCE_INBOUND_RECIPIENT = 'finance@trovara.farm'

function normalizeEmailAddress(value: string): string | null {
  const angle = value.match(/<([^>]+)>/)
  const email = (angle?.[1] ?? value).trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
}

export function financeInboundRecipients(): string[] {
  const configured = process.env.FINANCE_INBOUND_RECIPIENTS?.trim()
  const recipients = (configured || DEFAULT_FINANCE_INBOUND_RECIPIENT)
    .split(',')
    .map(normalizeEmailAddress)
    .filter((recipient): recipient is string => Boolean(recipient))
  return [...new Set(recipients)]
}

export function isFinanceInboundRecipient(toAddresses: string[]): boolean {
  const allowed = financeInboundRecipients()
  return toAddresses.some((value) => {
    const candidate = normalizeEmailAddress(value)
    if (!candidate) return false
    const [candidateLocal, candidateDomain] = candidate.split('@')
    return allowed.some((recipient) => {
      const [allowedLocal, allowedDomain] = recipient.split('@')
      return (
        candidate === recipient ||
        (candidateLocal === allowedLocal && candidateDomain.endsWith(`.${allowedDomain}`))
      )
    })
  })
}

function resendClient(): Resend {
  const key = process.env.RESEND_API_KEY?.trim()
  if (!key) throw new Error('RESEND_API_KEY is not configured')
  return new Resend(key)
}

function extractVendor(from: string | null | undefined): string | null {
  if (!from) return null
  const angle = from.match(/<([^>]+)>/)
  const email = (angle?.[1] ?? from).trim()
  const local = email.split('@')[0]?.replace(/[._+-]+/g, ' ').trim()
  return local ? local.slice(0, 200) : email.slice(0, 200)
}

async function resolveInboundFarmId(): Promise<string | null> {
  const farm = await resolveCustomerFarm()
  if (farm) return farm.id
  const [first] = await db.select({ id: farms.id }).from(farms).orderBy(asc(farms.createdAt)).limit(1)
  return first?.id ?? null
}

async function resolveRecorderUserId(farmId: string): Promise<string | null> {
  const [owner] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.role, 'owner'), eq(users.active, true)))
    .orderBy(asc(users.createdAt))
    .limit(1)
  if (owner) return owner.id
  const [any] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.farmId, farmId), eq(users.active, true)))
    .orderBy(asc(users.createdAt))
    .limit(1)
  return any?.id ?? null
}

async function storeInboundAttachment(
  farmId: string,
  filename: string,
  mime: string,
  buffer: Buffer,
): Promise<{ storageKey: string; safeName: string }> {
  const ext =
    mime === 'application/pdf'
      ? 'pdf'
      : mime === 'image/png'
        ? 'png'
        : mime === 'image/webp'
          ? 'webp'
          : 'jpg'
  const safeBase = filename
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/\.\.+/g, '_')
    .replace(/^\.+/, '')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .slice(0, 80)
  const safeName = safeBase.toLowerCase().endsWith(`.${ext}`)
    ? safeBase
    : `${safeBase || 'invoice'}.${ext}`
  const stored = `${randomBytes(12).toString('base64url')}-${safeName}`
  const dir = join(getEvidenceStorageRoot(), 'finance-inbound', farmId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, stored), buffer)
  return { storageKey: `finance-inbound/${farmId}/${stored}`, safeName }
}

export async function processFinanceInboundWebhook(params: {
  rawBody: string
  svixId: string
  svixTimestamp: string
  svixSignature: string
}): Promise<{ ok: true; expenseId?: string; duplicate?: boolean; ignored?: boolean }> {
  const event = verifyResendWebhook(
    params.rawBody,
    {
      id: params.svixId,
      timestamp: params.svixTimestamp,
      signature: params.svixSignature,
    },
    { webhookSecret: resendInboundWebhookSecret() },
  )

  const inserted = await db
    .insert(financeInboundEvents)
    .values({
      svixId: params.svixId,
      status: 'received',
      detail: event.type,
    })
    .onConflictDoNothing({ target: financeInboundEvents.svixId })
    .returning()

  if (!inserted.length) {
    return { ok: true, duplicate: true }
  }

  const eventRow = inserted[0]!

  if (event.type !== 'email.received') {
    await db
      .update(financeInboundEvents)
      .set({ status: 'ignored', detail: `Unhandled event ${event.type}` })
      .where(eq(financeInboundEvents.id, eventRow.id))
    return { ok: true, ignored: true }
  }

  const data = event.data as {
    email_id?: string
    from?: string
    to?: string[]
    subject?: string
    message_id?: string
    attachments?: Array<{ id: string; filename?: string; content_type?: string }>
  }

  const emailId = data.email_id
  if (!isFinanceInboundRecipient(data.to ?? [])) {
    await db
      .update(financeInboundEvents)
      .set({
        status: 'ignored',
        detail: 'Recipient is not configured for finance inbound',
        resendEmailId: emailId,
      })
      .where(eq(financeInboundEvents.id, eventRow.id))
    return { ok: true, ignored: true }
  }

  if (!emailId) {
    await db
      .update(financeInboundEvents)
      .set({ status: 'error', detail: 'Missing email_id' })
      .where(eq(financeInboundEvents.id, eventRow.id))
    throw new Error('Missing email_id')
  }

  const farmId = await resolveInboundFarmId()
  if (!farmId) {
    await db
      .update(financeInboundEvents)
      .set({ status: 'error', detail: 'No farm configured', resendEmailId: emailId })
      .where(eq(financeInboundEvents.id, eventRow.id))
    throw new Error('No farm configured')
  }

  const recorderId = await resolveRecorderUserId(farmId)
  if (!recorderId) {
    await db
      .update(financeInboundEvents)
      .set({ status: 'error', detail: 'No staff user to attribute expense', resendEmailId: emailId })
      .where(eq(financeInboundEvents.id, eventRow.id))
    throw new Error('No staff user')
  }

  // Idempotent on Resend email id as well as Svix id.
  const [existingExpense] = await db
    .select({ id: expenses.id })
    .from(expenses)
    .where(and(eq(expenses.farmId, farmId), eq(expenses.inboundMessageId, emailId)))
    .limit(1)
  if (existingExpense) {
    await db
      .update(financeInboundEvents)
      .set({ status: 'duplicate', expenseId: existingExpense.id, resendEmailId: emailId })
      .where(eq(financeInboundEvents.id, eventRow.id))
    return { ok: true, expenseId: existingExpense.id, duplicate: true }
  }

  const resend = resendClient()
  const received = await resend.emails.receiving.get(emailId)
  if (received.error) throw new Error(received.error.message)
  const receivedData = received.data as {
    subject?: string | null
    from?: string | null
    text?: string | null
    html?: string | null
    created_at?: string
  } | null

  const subject = (receivedData?.subject ?? data.subject ?? 'Inbound invoice').trim()
  const from = receivedData?.from ?? data.from ?? null
  const bodyText = (receivedData?.text ?? '').trim() || (receivedData?.html ?? '').replace(/<[^>]+>/g, ' ')
  const fromVendorHint = extractVendor(from)

  let attachmentFilename: string | null = null
  let attachmentStorageKey: string | null = null
  let attachmentMimeType: string | null = null
  let attachmentBuffer: Buffer | null = null

  const attachments = await resend.emails.receiving.attachments.list({ emailId })
  if (!attachments.error) {
    const list = (attachments.data as { data?: Array<{
      id: string
      filename?: string
      content_type?: string
      download_url?: string
    }> })?.data ?? (Array.isArray(attachments.data) ? (attachments.data as Array<{
      id: string
      filename?: string
      content_type?: string
      download_url?: string
    }>) : [])

    for (const attachment of list) {
      const mime = (attachment.content_type ?? '').toLowerCase()
      if (!ALLOWED_ATTACHMENT_TYPES.has(mime)) continue
      if (!attachment.download_url) continue
      const response = await fetch(attachment.download_url)
      if (!response.ok) continue
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0 || buffer.length > 25 * 1024 * 1024) continue
      const stored = await storeInboundAttachment(
        farmId,
        attachment.filename ?? 'invoice.pdf',
        mime,
        buffer,
      )
      attachmentFilename = stored.safeName
      attachmentStorageKey = stored.storageKey
      attachmentMimeType = mime
      attachmentBuffer = buffer
      break
    }
  }

  if (!attachmentStorageKey || !attachmentMimeType || !attachmentBuffer) {
    await db
      .update(financeInboundEvents)
      .set({
        status: 'ignored',
        detail: 'No supported PDF, JPEG, PNG, or WebP attachment was available',
        resendEmailId: emailId,
      })
      .where(eq(financeInboundEvents.id, eventRow.id))
    return { ok: true, ignored: true }
  }

  const extracted = await extractInvoiceFields({
    farmId,
    subject,
    bodyText,
    fromVendorHint,
    mime: attachmentMimeType,
    buffer: attachmentBuffer,
  })

  const description = attachmentFilename
    ? `Inbound invoice: ${subject}`
    : `Inbound email (no PDF): ${subject}`

  const [expense] = await db
    .insert(expenses)
    .values({
      farmId,
      category: 'other',
      description: description.slice(0, 500),
      amount: extracted.amount,
      currency: extracted.currency,
      vendor: extracted.vendor,
      receiptRef: data.message_id?.slice(0, 200) ?? emailId.slice(0, 200),
      source: 'inbound_email',
      inboundMessageId: emailId,
      attachmentFilename,
      attachmentStorageKey,
      attachmentMimeType,
      extractionMethod: extracted.method,
      extractionStatus: extracted.method === 'none' ? 'failed' : 'success',
      approvalStatus: 'pending',
      recordedById: recorderId,
      expenseDate:
        extracted.expenseDate ??
        (receivedData?.created_at ? new Date(receivedData.created_at) : new Date()),
    })
    .returning()

  await db
    .update(financeInboundEvents)
    .set({
      status: 'processed',
      expenseId: expense.id,
      resendEmailId: emailId,
      detail: attachmentStorageKey
        ? `stored_attachment:${extracted.method}`
        : `no_attachment:${extracted.method}`,
    })
    .where(eq(financeInboundEvents.id, eventRow.id))

  await logAudit({
    farmId,
    userId: recorderId,
    action: 'create',
    entityType: 'expense',
    entityId: expense.id,
    metadata: {
      source: 'inbound_email',
      emailId,
      amount: extracted.amount,
      currency: extracted.currency,
      extractMethod: extracted.method,
    },
  })

  return { ok: true, expenseId: expense.id }
}
