import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { customerContacts, customerSupportTickets } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canManageOrders } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { createSupportTicket } from '../lib/support-tickets.js'

const createSchema = z.object({
  description: z.string().trim().min(3).max(4000),
  contactId: z.string().uuid().nullable().optional(),
  orderId: z.string().uuid().nullable().optional(),
  category: z.enum(['complaint', 'delivery', 'quality', 'payment', 'other']).default('complaint'),
  priority: z.enum(['low', 'normal', 'urgent']).default('normal'),
})

const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved', 'closed']),
  priority: z.enum(['low', 'normal', 'urgent']).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
})

export const supportRoutes = new Hono<{ Variables: AppVariables }>()
supportRoutes.use('*', authMiddleware)

supportRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)
  const tickets = await db
    .select({
      id: customerSupportTickets.id,
      reference: customerSupportTickets.reference,
      category: customerSupportTickets.category,
      priority: customerSupportTickets.priority,
      status: customerSupportTickets.status,
      description: customerSupportTickets.description,
      channel: customerSupportTickets.channel,
      contactId: customerSupportTickets.contactId,
      customerName: customerContacts.name,
      customerPhone: customerContacts.phone,
      orderId: customerSupportTickets.orderId,
      assignedToId: customerSupportTickets.assignedToId,
      resolvedAt: customerSupportTickets.resolvedAt,
      createdAt: customerSupportTickets.createdAt,
      updatedAt: customerSupportTickets.updatedAt,
    })
    .from(customerSupportTickets)
    .leftJoin(customerContacts, eq(customerSupportTickets.contactId, customerContacts.id))
    .where(eq(customerSupportTickets.farmId, user.farmId))
    .orderBy(desc(customerSupportTickets.createdAt))
    .limit(200)
  return c.json({ tickets })
})

supportRoutes.post('/', zValidator('json', createSchema), async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const ticket = await createSupportTicket({
    farmId: user.farmId,
    description: body.description,
    contactId: body.contactId,
    orderId: body.orderId,
    category: body.category,
    priority: body.priority,
    actorUserId: user.id,
  })
  return c.json({ ticket }, 201)
})

supportRoutes.patch('/:id', zValidator('json', updateSchema), async (c) => {
  const user = c.get('user')
  if (!canManageOrders(user)) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const resolved = body.status === 'resolved' || body.status === 'closed'
  const [ticket] = await db
    .update(customerSupportTickets)
    .set({
      status: body.status,
      priority: body.priority,
      assignedToId: body.assignedToId,
      resolvedById: resolved ? user.id : null,
      resolvedAt: resolved ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(customerSupportTickets.id, c.req.param('id')),
        eq(customerSupportTickets.farmId, user.farmId),
      ),
    )
    .returning()
  if (!ticket) return c.json({ error: 'Not found' }, 404)

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'customer_support_ticket',
    entityId: ticket.id,
    metadata: { status: ticket.status, priority: ticket.priority },
  })
  return c.json({ ticket })
})
