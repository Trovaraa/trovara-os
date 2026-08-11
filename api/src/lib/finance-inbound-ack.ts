import { and, eq, isNull } from 'drizzle-orm'
import { Resend } from 'resend'
import { db } from '../db/index.js'
import { expenses } from '../db/schema.js'
import { financeInboundApprovalAckEmailContent } from './email-template.js'
import { sendEmail } from './notifications.js'
import { financeInboundRecipients, parseInboundFromHeader } from './finance-inbound.js'

const AUTO_REPLY_BLOCKLIST =
  /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|bounce)([+._-]|$)/i

export function shouldAutoAckInboundSender(email: string | null | undefined): boolean {
  if (!email) return false
  const local = email.split('@')[0] ?? ''
  if (AUTO_REPLY_BLOCKLIST.test(local)) return false
  const own = new Set(financeInboundRecipients())
  if (own.has(email)) return false
  if (email.endsWith('@trovara.farm') || email.endsWith('@inbound.trovara.farm')) return false
  return true
}

function financeAckReplyTo(): string | undefined {
  return financeInboundRecipients()[0] || undefined
}

function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value?.trim()) return null
  const trimmed = value.trim().slice(0, 200)
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed
  return `<${trimmed.replace(/^<|>$/g, '')}>`
}

async function backfillSenderFromResend(expense: typeof expenses.$inferSelect): Promise<{
  email: string | null
  name: string | null
  messageId: string | null
}> {
  if (!expense.inboundMessageId) {
    return {
      email: expense.inboundSenderEmail,
      name: expense.inboundSenderName,
      messageId: expense.receiptRef,
    }
  }
  const apiKey = process.env.RESEND_API_KEY?.trim()
  if (!apiKey) {
    return {
      email: expense.inboundSenderEmail,
      name: expense.inboundSenderName,
      messageId: expense.receiptRef,
    }
  }
  try {
    const resend = new Resend(apiKey)
    const received = await resend.emails.receiving.get(expense.inboundMessageId)
    const data = received.data as { from?: string | null; message_id?: string | null } | null
    const parsed = parseInboundFromHeader(data?.from)
    const messageId = normalizeMessageId(data?.message_id) ?? expense.receiptRef
    if (parsed.email || messageId) {
      await db
        .update(expenses)
        .set({
          ...(parsed.email ? { inboundSenderEmail: parsed.email } : {}),
          ...(parsed.name ? { inboundSenderName: parsed.name } : {}),
          ...(messageId && !expense.receiptRef ? { receiptRef: messageId.slice(0, 200) } : {}),
        })
        .where(and(eq(expenses.id, expense.id), eq(expenses.farmId, expense.farmId)))
    }
    return {
      email: parsed.email ?? expense.inboundSenderEmail,
      name: parsed.name ?? expense.inboundSenderName,
      messageId: messageId ?? expense.receiptRef,
    }
  } catch (error) {
    console.error(
      '[finance-inbound-ack] backfill failed:',
      error instanceof Error ? error.message : error,
    )
    return {
      email: expense.inboundSenderEmail,
      name: expense.inboundSenderName,
      messageId: expense.receiptRef,
    }
  }
}

/**
 * After an inbound draft is approved, email the original sender once.
 * Never blocks approval — failures are logged and left retryable via unset ack timestamp.
 */
export async function maybeSendInboundApprovalAck(params: {
  expense: typeof expenses.$inferSelect
  previousStatus: string
}): Promise<{ sent: boolean; skipped?: string; to?: string }> {
  const { expense, previousStatus } = params
  if (expense.source !== 'inbound_email') return { sent: false, skipped: 'not_inbound' }
  if (expense.approvalStatus !== 'approved') return { sent: false, skipped: 'not_approved' }
  if (previousStatus === 'approved') return { sent: false, skipped: 'already_approved' }
  if (expense.inboundAckSentAt) return { sent: false, skipped: 'already_acked' }

  let email = expense.inboundSenderEmail
  let name = expense.inboundSenderName
  let messageId = expense.receiptRef
  if (!email || !shouldAutoAckInboundSender(email)) {
    const backfilled = await backfillSenderFromResend(expense)
    email = backfilled.email
    name = backfilled.name
    messageId = backfilled.messageId
  }

  if (!shouldAutoAckInboundSender(email)) {
    return { sent: false, skipped: 'no_sender' }
  }

  // Claim the ack slot so concurrent approvals do not double-send.
  const [claimed] = await db
    .update(expenses)
    .set({ inboundAckSentAt: new Date() })
    .where(
      and(
        eq(expenses.id, expense.id),
        eq(expenses.farmId, expense.farmId),
        isNull(expenses.inboundAckSentAt),
      ),
    )
    .returning({ id: expenses.id })
  if (!claimed) return { sent: false, skipped: 'already_acked' }

  const mail = financeInboundApprovalAckEmailContent({
    senderName: name,
    subject: expense.description?.replace(/^Inbound invoice:\s*/i, '') || null,
  })
  const headers: Record<string, string> = {}
  const replyMessageId = normalizeMessageId(messageId)
  if (replyMessageId) {
    headers['In-Reply-To'] = replyMessageId
    headers['References'] = replyMessageId
  }

  const result = await sendEmail({
    to: email!,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    replyTo: financeAckReplyTo(),
    headers: Object.keys(headers).length ? headers : undefined,
  })

  if (result.status !== 'delivered') {
    await db
      .update(expenses)
      .set({ inboundAckSentAt: null })
      .where(and(eq(expenses.id, expense.id), eq(expenses.farmId, expense.farmId)))
    console.error(`[finance-inbound-ack] send failed status=${result.status} to=${email}`)
    return { sent: false, skipped: `send_${result.status}`, to: email! }
  }

  return { sent: true, to: email! }
}
