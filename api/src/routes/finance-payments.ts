import { Hono, type MiddlewareHandler } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assets, expensePayments, expenses, expenseLabelLinks, expenseLabels } from '../db/schema.js'
import { type AppVariables } from '../middleware/auth.js'
import { canAccessFinance, hasPermission } from '../lib/rbac.js'
import { validateExpensePayment } from '../lib/expense-payments.js'

// Mounted inside financeRoutes, after its authentication middleware.
export const financePaymentRoutes = new Hono<{ Variables: AppVariables }>()
const financeAccess: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  if (!canAccessFinance(c.get('user'))) return c.json({ error: 'Forbidden' }, 403)
  await next()
}
financePaymentRoutes.use('/capex', financeAccess)
financePaymentRoutes.use('/:id/payments', financeAccess)
financePaymentRoutes.use('/historical-settlements', financeAccess)

const settlementSchema = z.object({
  confirmed: z.literal(true),
  invoices: z.array(z.object({
    id: z.string().uuid(), requestId: z.string().uuid(),
    amount: z.number().int().positive().max(2147483647),
    amountPaid: z.number().int().nonnegative().max(2147483647),
    currency: z.string().min(1).max(10),
  }).strict()).min(1).max(100)
    .refine(rows => new Set(rows.map(r => r.id)).size === rows.length, 'Duplicate invoices')
    .refine(rows => new Set(rows.map(r => r.requestId)).size === rows.length, 'Duplicate request IDs'),
}).strict()

financePaymentRoutes.post('/historical-settlements', zValidator('json', settlementSchema), async c => {
  const user = c.get('user')
  if (!hasPermission(user, 'finance.write')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const result = await db.transaction(async tx => {
    // Lock request keys, then invoice rows in stable order, including across overlapping batches.
    for (const key of body.invoices.map(r => r.requestId).sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${user.farmId}:${key}`}, 0))`)
    }
    const additions: (typeof expensePayments.$inferInsert)[] = []
    for (const item of [...body.invoices].sort((a, b) => a.id.localeCompare(b.id))) {
      const [expense] = await tx.select().from(expenses)
        .where(and(eq(expenses.id, item.id), eq(expenses.farmId, user.farmId))).for('update')
      if (!expense) return { error: 'One or more invoices were not found.', status: 404 as const }
      const [prior] = await tx.select().from(expensePayments)
        .where(and(eq(expensePayments.farmId, user.farmId), eq(expensePayments.requestId, item.requestId)))
      if (prior) {
        if (prior.kind !== 'historical_settlement' || prior.expenseId !== item.id || prior.currency !== item.currency ||
          expense.amount !== item.amount || prior.amount !== item.amount - item.amountPaid) {
          return { error: 'A request ID was already used for another settlement.', status: 409 as const }
        }
        continue
      }
      if (expense.approvalStatus !== 'approved' || expense.amount !== item.amount ||
        expense.amountPaid !== item.amountPaid || expense.currency !== item.currency || expense.amountPaid >= expense.amount) {
        return { error: 'An invoice changed or is not eligible. Refresh and review your selection; no invoices were changed.', status: 409 as const }
      }
      additions.push({ farmId: user.farmId, expenseId: item.id, amount: expense.amount - expense.amountPaid,
        currency: expense.currency, kind: 'historical_settlement', paidOn: null, reference: null,
        requestId: item.requestId, recordedById: user.id })
    }
    // Validate the entire batch before any writes; triggers preserve append-only history and update balances.
    if (additions.length) await tx.insert(expensePayments).values(additions)
    return { settled: additions.length, alreadyRecorded: body.invoices.length - additions.length }
  })
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result)
})

financePaymentRoutes.get('/capex', async (c) => {
  const { farmId } = c.get('user')
  const register = await db.select({
    id: assets.id, name: assets.name, assetTag: assets.assetTag, category: assets.category,
    quantityOwned: assets.quantityOwned, acquisitionDate: assets.acquisitionDate,
    acquisitionCostMinor: assets.acquisitionCostMinor, currency: assets.currency,
    operationalStatus: assets.operationalStatus, active: assets.active, disposedAt: assets.disposedAt,
  }).from(assets).where(eq(assets.farmId, farmId)).orderBy(desc(assets.createdAt))
  const rows = await db.select({ expense: expenses }).from(expenses)
    .innerJoin(expenseLabelLinks, and(eq(expenseLabelLinks.expenseId, expenses.id), eq(expenseLabelLinks.farmId, farmId)))
    .innerJoin(expenseLabels, and(eq(expenseLabels.id, expenseLabelLinks.labelId), eq(expenseLabels.farmId, farmId)))
    .where(and(eq(expenses.farmId, farmId), eq(expenseLabels.slug, 'capex')))
    .orderBy(desc(expenses.expenseDate))
  return c.json({ assets: register, expenses: rows.map(({ expense }) => ({
    id: expense.id, description: expense.description, amount: expense.amount,
    currency: expense.currency, entityCode: expense.entityCode, approvalStatus: expense.approvalStatus,
    paymentStatus: expense.paymentStatus, amountPaid: expense.amountPaid, paymentDueDate: expense.paymentDueDate,
  })) })
})

financePaymentRoutes.get('/:id/payments', async (c) => {
  if (!z.string().uuid().safeParse(c.req.param('id')).success) return c.json({ error: 'Invalid invoice ID' }, 400)
  const { farmId } = c.get('user')
  const [expense] = await db.select().from(expenses)
    .where(and(eq(expenses.farmId, farmId), eq(expenses.id, c.req.param('id')))).limit(1)
  if (!expense) return c.json({ error: 'Not found' }, 404)
  const payments = await db.select().from(expensePayments)
    .where(and(eq(expensePayments.farmId, farmId), eq(expensePayments.expenseId, expense.id)))
    .orderBy(desc(expensePayments.createdAt))
  return c.json({ payments })
})

const paymentSchema = z.object({
  amount: z.number().int().positive().max(2147483647),
  currency: z.string().trim().min(1).max(10),
  paidOn: z.string().date().refine(value => value <= new Date().toISOString().slice(0, 10), 'Payment date cannot be in the future'),
  reference: z.string().trim().min(1).max(200),
  requestId: z.string().uuid(),
}).strict()

financePaymentRoutes.post('/:id/payments', zValidator('json', paymentSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'finance.write')) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid invoice ID' }, 400)
  const body = c.req.valid('json')
  const result = await db.transaction(async tx => {
    // Serialize reuse of a request ID even when competing requests name different invoices.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${user.farmId}:${body.requestId}`}, 0))`)
    const [expense] = await tx.select().from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.farmId, user.farmId))).for('update')
    if (!expense) return { error: 'Not found', status: 404 as const }
    const [prior] = await tx.select().from(expensePayments)
      .where(and(eq(expensePayments.farmId, user.farmId), eq(expensePayments.requestId, body.requestId)))
    if (prior) {
      if (prior.expenseId !== id || prior.amount !== body.amount || prior.currency !== body.currency || prior.paidOn !== body.paidOn || prior.reference !== body.reference) {
        return { error: 'This request ID was already used for another payment.', status: 409 as const }
      }
      return { payment: prior, duplicate: true }
    }
    if (expense.currency !== body.currency) return { error: 'Invoice currency changed. Reload before recording payment.', status: 409 as const }
    const error = validateExpensePayment(expense, body.amount)
    if (error) return { error, status: 409 as const }
    const [payment] = await tx.insert(expensePayments).values({
      ...body, expenseId: id, farmId: user.farmId, currency: expense.currency, recordedById: user.id,
    }).returning()
    // The database trigger atomically updates the balance and status, including for concurrent requests.
    return { payment, duplicate: false }
  })
  if ('error' in result) return c.json({ error: result.error }, result.status)
  return c.json(result, result.duplicate ? 200 : 201)
})
