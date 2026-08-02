import { randomBytes } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { customerSupportTickets } from '../db/schema.js'
import { logAudit } from './audit.js'
import { notifyOrderAlertStaff, notifyOrderAlertStaffTelegram } from './farm-notify.js'

function supportReference(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `TRV-SUP-${day}-${randomBytes(3).toString('hex').toUpperCase()}`
}

export async function createSupportTicket(params: {
  farmId: string
  description: string
  contactId?: string | null
  orderId?: string | null
  channel?: string
  category?: string
  priority?: string
  actorUserId?: string | null
}) {
  let reference = supportReference()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [existing] = await db
      .select({ id: customerSupportTickets.id })
      .from(customerSupportTickets)
      .where(
        and(
          eq(customerSupportTickets.farmId, params.farmId),
          eq(customerSupportTickets.reference, reference),
        ),
      )
      .limit(1)
    if (!existing) break
    reference = supportReference()
  }

  const [ticket] = await db
    .insert(customerSupportTickets)
    .values({
      farmId: params.farmId,
      reference,
      contactId: params.contactId ?? null,
      orderId: params.orderId ?? null,
      channel: params.channel ?? 'staff',
      category: params.category ?? 'complaint',
      priority: params.priority ?? 'normal',
      description: params.description.trim(),
    })
    .returning()

  await logAudit({
    farmId: params.farmId,
    userId: params.actorUserId ?? undefined,
    action: 'create',
    entityType: 'customer_support_ticket',
    entityId: ticket.id,
    metadata: { reference, channel: ticket.channel, priority: ticket.priority },
  })

  const message = `Customer support ticket ${reference}\n${ticket.description.slice(0, 500)}`
  void Promise.all([
    notifyOrderAlertStaff(params.farmId, message, {
      actorUserId: params.actorUserId ?? undefined,
      reason: 'customer_support_ticket',
    }),
    notifyOrderAlertStaffTelegram(params.farmId, message, {
      actorUserId: params.actorUserId ?? undefined,
      reason: 'customer_support_ticket',
    }),
  ]).catch(() => undefined)

  return ticket
}
