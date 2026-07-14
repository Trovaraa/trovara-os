import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { expenses, orders } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAccessFinance } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import type { SessionUser } from '../lib/session.js'

const createExpenseSchema = z.object({
  category: z.enum(['inputs', 'labour', 'equipment', 'transport', 'utilities', 'feed', 'medicine', 'other']),
  description: z.string().min(1).max(500),
  amount: z.number().int().min(1),
  currency: z.string().max(10).optional(),
  vendor: z.string().max(200).optional(),
  receiptRef: z.string().max(200).optional(),
  expenseDate: z.string().datetime(),
})

const updateExpenseSchema = createExpenseSchema.partial()

export const financeRoutes = new Hono<{ Variables: AppVariables }>()

financeRoutes.use('*', authMiddleware)

function requireFinanceAccess(user: SessionUser): SessionUser | null {
  return canAccessFinance(user) ? user : null
}

financeRoutes.get('/', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const rows = await db
    .select()
    .from(expenses)
    .where(eq(expenses.farmId, user.farmId))
    .orderBy(desc(expenses.expenseDate))

  return c.json({ expenses: rows })
})

financeRoutes.get('/summary', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const [orderRows, expenseRows] = await Promise.all([
    db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.farmId, user.farmId),
          inArray(orders.status, ['confirmed', 'dispatched', 'delivered']),
        ),
      ),
    db.select().from(expenses).where(eq(expenses.farmId, user.farmId)),
  ])

  const revenue = orderRows.reduce((sum, o) => sum + o.totalAmount, 0)
  const totalExpenses = expenseRows.reduce((sum, e) => sum + e.amount, 0)

  const expensesByCategory = expenseRows.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + e.amount
    return acc
  }, {})

  const deliveredRevenue = orderRows
    .filter((o) => o.status === 'delivered')
    .reduce((sum, o) => sum + o.totalAmount, 0)

  return c.json({
    summary: {
      generatedAt: new Date().toISOString(),
      currency: 'NGN',
      revenue,
      deliveredRevenue,
      totalExpenses,
      netProfit: revenue - totalExpenses,
      orderCount: orderRows.length,
      expenseCount: expenseRows.length,
      expensesByCategory,
    },
  })
})

financeRoutes.post('/', zValidator('json', createExpenseSchema), async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')

  const [expense] = await db
    .insert(expenses)
    .values({
      farmId: user.farmId,
      category: body.category,
      description: body.description,
      amount: body.amount,
      currency: body.currency,
      vendor: body.vendor,
      receiptRef: body.receiptRef,
      recordedById: user.id,
      expenseDate: new Date(body.expenseDate),
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'expense',
    entityId: expense.id,
    metadata: { category: expense.category, amount: expense.amount },
  })

  return c.json({ expense }, 201)
})

financeRoutes.patch('/:id', zValidator('json', updateExpenseSchema), async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const expenseId = c.req.param('id')
  const body = c.req.valid('json')

  const [existing] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  const updates: Partial<typeof existing> = {}
  if (body.category !== undefined) updates.category = body.category
  if (body.description !== undefined) updates.description = body.description
  if (body.amount !== undefined) updates.amount = body.amount
  if (body.currency !== undefined) updates.currency = body.currency
  if (body.vendor !== undefined) updates.vendor = body.vendor
  if (body.receiptRef !== undefined) updates.receiptRef = body.receiptRef
  if (body.expenseDate !== undefined) updates.expenseDate = new Date(body.expenseDate)

  const [expense] = await db
    .update(expenses)
    .set(updates)
    .where(eq(expenses.id, expenseId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'expense',
    entityId: expenseId,
  })

  return c.json({ expense })
})

financeRoutes.delete('/:id', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const expenseId = c.req.param('id')

  const [existing] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
    .limit(1)

  if (!existing) return c.json({ error: 'Not found' }, 404)

  await db.delete(expenses).where(eq(expenses.id, expenseId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'expense',
    entityId: expenseId,
  })

  return c.json({ ok: true })
})
