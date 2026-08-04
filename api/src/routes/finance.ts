import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { expenses, invoices, orders, paymentAttempts, paymentRefunds, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAccessFinance, hasPermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import type { SessionUser } from '../lib/session.js'
import {
  authorLocaleForUserId,
  authorLocaleHint,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { resolveStaffReplyLocale } from '../lib/reply-locale.js'

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

/**
 * The only prose on an expense, and the one column its `translation_status`
 * covers. `vendor` is a supplier's name, `receiptRef` is the identifier printed
 * on the paper receipt an auditor matches the row against, `category` is an
 * enum the client renders, and `amount` / `currency` are money — none of them
 * ever reach a translator.
 */
const EXPENSE_TEXT_FIELDS = ['description'] as const

/**
 * The viewer's language. A failed lookup degrades to English rather than
 * failing the request it only decorates.
 */
async function preferredLocaleForUser(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ preferredLocale: users.preferredLocale })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
    return row?.preferredLocale ?? null
  } catch {
    return null
  }
}

/**
 * Render expense prose in the viewer's language with ONE batched translation
 * call per response: every string across every row is collected first,
 * translated together (the service deduplicates and reads its cache in a single
 * query), then mapped back by position. An English viewer short-circuits before
 * any of this work.
 */
async function localizeRows<T extends object>(
  rows: T[],
  fields: readonly (keyof T & string)[],
  farmId: string,
  targetLocale: string | null,
): Promise<T[]> {
  if (resolveStaffReplyLocale(targetLocale) === 'en') return rows
  if (rows.length === 0 || fields.length === 0) return rows

  const texts: string[] = []
  for (const row of rows) {
    for (const field of fields) {
      const value = row[field]
      if (typeof value === 'string' && value !== '') texts.push(value)
    }
  }
  if (texts.length === 0) return rows

  const translated = await toViewerLocaleMany({ texts, targetLocale, farmId })

  let cursor = 0
  return rows.map((row) => {
    const out = { ...row }
    for (const field of fields) {
      const value = row[field]
      if (typeof value === 'string' && value !== '') {
        ;(out as Record<string, unknown>)[field] = translated[cursor++]
      }
    }
    return out
  })
}

type CanonicalDescription = {
  /** English text to store; absent when there was nothing to normalize. */
  english?: string
  sourceLocale: string | null
  translationStatus: 'done' | 'pending'
}

/**
 * Normalize an expense description to English for storage.
 *
 * A translation failure stores the author's own words at 'pending' so recording
 * a cost never fails on a translator, and `lib/translation-retry.ts` repairs the
 * row later.
 *
 * `source_locale` stays null on that path rather than falling back to 'en': it is
 * the hint the retry job feeds back into `toCanonicalEnglish`, and an 'en' hint
 * short-circuits there, which would mark the row 'done' still holding French.
 */
async function canonicalDescription(
  text: string | null | undefined,
  farmId: string,
  authorLocale: string | null,
): Promise<CanonicalDescription> {
  if (typeof text !== 'string' || text.trim() === '') {
    return { sourceLocale: null, translationStatus: 'done' }
  }
  try {
    const result = await toCanonicalEnglish({ text, farmId, sourceLocale: authorLocale })
    return {
      english: result.english,
      sourceLocale: result.sourceLocale,
      translationStatus: result.status,
    }
  } catch {
    return { english: text, sourceLocale: authorLocale, translationStatus: 'pending' }
  }
}

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

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(rows, EXPENSE_TEXT_FIELDS, user.farmId, viewerLocale)

  return c.json({ expenses: localized })
})

// Money, counts and category enums only — no prose leaves this endpoint, so
// nothing on it is localized.
financeRoutes.get('/summary', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const [orderRows, expenseRows, paidAttempts, unpaidOrders, refundRows, invoiceCountRow] =
    await Promise.all([
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
      db
        .select({
          totalKobo: sql<number>`coalesce(sum(${paymentAttempts.amountKobo}), 0)`,
        })
        .from(paymentAttempts)
        .where(
          and(eq(paymentAttempts.farmId, user.farmId), eq(paymentAttempts.status, 'success')),
        ),
      db
        .select({
          totalAmount: orders.totalAmount,
        })
        .from(orders)
        .where(and(eq(orders.farmId, user.farmId), eq(orders.paymentStatus, 'unpaid'))),
      db
        .select({
          amountKobo: paymentRefunds.amountKobo,
          status: paymentRefunds.status,
        })
        .from(paymentRefunds)
        .where(eq(paymentRefunds.farmId, user.farmId)),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(invoices)
        .where(eq(invoices.farmId, user.farmId)),
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

  // Payment metrics are independent of fulfilment revenue (kobo → Naira major units).
  const paidRevenue = Math.round(Number(paidAttempts[0]?.totalKobo ?? 0) / 100)
  const outstandingInvoices = unpaidOrders.reduce((sum, o) => sum + o.totalAmount, 0)
  const refunds = Math.round(
    refundRows
      .filter((r) => r.status === 'success')
      .reduce((sum, r) => sum + r.amountKobo, 0) / 100,
  )
  const refundsPending = Math.round(
    refundRows
      .filter((r) => r.status === 'pending')
      .reduce((sum, r) => sum + r.amountKobo, 0) / 100,
  )

  return c.json({
    summary: {
      generatedAt: new Date().toISOString(),
      currency: 'NGN',
      revenue,
      deliveredRevenue,
      paidRevenue,
      outstandingInvoices,
      refunds,
      refundsPending,
      invoiceCount: Number(invoiceCountRow[0]?.total ?? 0),
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

  const canonical = await canonicalDescription(
    body.description,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  const [expense] = await db
    .insert(expenses)
    .values({
      farmId: user.farmId,
      category: body.category,
      description: canonical.english ?? body.description,
      sourceLocale: canonical.sourceLocale,
      translationStatus: canonical.translationStatus,
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

  // The author reads back their own words; the row holds the English.
  return c.json({ expense: { ...expense, description: body.description } }, 201)
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

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)

  const updates: Partial<typeof existing> = {}
  if (body.category !== undefined) updates.category = body.category
  if (body.amount !== undefined) updates.amount = body.amount
  if (body.currency !== undefined) updates.currency = body.currency
  if (body.vendor !== undefined) updates.vendor = body.vendor
  if (body.receiptRef !== undefined) updates.receiptRef = body.receiptRef
  if (body.expenseDate !== undefined) updates.expenseDate = new Date(body.expenseDate)

  if (body.description !== undefined) {
    const canonical = await canonicalDescription(body.description, user.farmId, authorLocale)
    updates.description = canonical.english ?? body.description
    if (canonical.english !== undefined) {
      // Never downgrade a row the retry job still owes work on, and keep it
      // labelled with the locale of the text that failed: `source_locale` is the
      // hint that retry uses.
      if (existing.translationStatus === 'done' || canonical.translationStatus === 'pending') {
        updates.sourceLocale = canonical.sourceLocale ?? existing.sourceLocale
      }
      if (canonical.translationStatus === 'pending') updates.translationStatus = 'pending'
    }
  }

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

  // A description this author just wrote is echoed in their own words; one they
  // did not touch is the stored English, rendered for the viewer.
  if (body.description !== undefined) {
    return c.json({ expense: { ...expense, description: body.description } })
  }
  const [localized] = await localizeRows(
    [expense],
    EXPENSE_TEXT_FIELDS,
    user.farmId,
    viewerLocale,
  )
  return c.json({ expense: localized })
})

financeRoutes.delete('/:id', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)
  // Destructive money ops require finance.delete; sales may create/update expenses.
  if (!hasPermission(user, 'finance.delete')) return c.json({ error: 'Forbidden' }, 403)

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
