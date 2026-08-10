import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  expenseLabelLinks,
  expenseLabels,
  expenses,
  invoices,
  orders,
  paymentAttempts,
  paymentRefunds,
  users,
} from '../db/schema.js'
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
import { createReadStream } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { getEvidenceStorageRoot } from '../lib/evidence-store.js'
import { filterAndGroupExpensesByLabel } from '../lib/expense-label-report.js'
import { extractInvoiceFields } from '../lib/invoice-extract.js'

const EXPENSE_CATEGORIES = [
  'inputs',
  'labour',
  'equipment',
  'transport',
  'utilities',
  'feed',
  'medicine',
  'other',
] as const

const createExpenseSchema = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(1).max(500),
  amount: z.number().int().min(0),
  currency: z.string().max(10).optional(),
  vendor: z.string().max(200).optional().nullable(),
  receiptRef: z.string().max(200).optional().nullable(),
  expenseDate: z.string().datetime(),
  labelIds: z.array(z.string().uuid()).max(20).optional(),
  approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
})

const updateExpenseSchema = createExpenseSchema.partial()

const EXPENSE_TEXT_FIELDS = ['description'] as const

const DEFAULT_LABELS = [
  { name: 'Salary', slug: 'salary' },
  { name: 'Consultant', slug: 'consultant' },
  { name: 'Capex', slug: 'capex' },
  { name: 'Opex', slug: 'opex' },
  { name: 'Recurring', slug: 'recurring' },
] as const

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
  english?: string
  sourceLocale: string | null
  translationStatus: 'done' | 'pending'
}

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

async function ensureDefaultLabels(farmId: string) {
  for (const label of DEFAULT_LABELS) {
    await db
      .insert(expenseLabels)
      .values({ farmId, name: label.name, slug: label.slug })
      .onConflictDoNothing()
  }
}

async function labelsForExpenses(expenseIds: string[]) {
  if (expenseIds.length === 0) return new Map<string, Array<{ id: string; name: string; slug: string }>>()
  const rows = await db
    .select({
      expenseId: expenseLabelLinks.expenseId,
      id: expenseLabels.id,
      name: expenseLabels.name,
      slug: expenseLabels.slug,
    })
    .from(expenseLabelLinks)
    .innerJoin(expenseLabels, eq(expenseLabelLinks.labelId, expenseLabels.id))
    .where(inArray(expenseLabelLinks.expenseId, expenseIds))

  const map = new Map<string, Array<{ id: string; name: string; slug: string }>>()
  for (const row of rows) {
    const list = map.get(row.expenseId) ?? []
    list.push({ id: row.id, name: row.name, slug: row.slug })
    map.set(row.expenseId, list)
  }
  return map
}

async function setExpenseLabels(farmId: string, expenseId: string, labelIds: string[]) {
  const unique = [...new Set(labelIds)]
  if (unique.length) {
    const valid = await db
      .select({ id: expenseLabels.id })
      .from(expenseLabels)
      .where(and(eq(expenseLabels.farmId, farmId), inArray(expenseLabels.id, unique)))
    if (valid.length !== unique.length) throw new Error('INVALID_LABEL')
  }
  await db.delete(expenseLabelLinks).where(eq(expenseLabelLinks.expenseId, expenseId))
  if (unique.length) {
    await db.insert(expenseLabelLinks).values(unique.map((labelId) => ({ expenseId, labelId })))
  }
}

export const financeRoutes = new Hono<{ Variables: AppVariables }>()

financeRoutes.use('*', authMiddleware)

function requireFinanceAccess(user: SessionUser): SessionUser | null {
  return canAccessFinance(user) ? user : null
}

financeRoutes.get('/labels', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)
  await ensureDefaultLabels(user.farmId)
  const labels = await db
    .select()
    .from(expenseLabels)
    .where(eq(expenseLabels.farmId, user.farmId))
    .orderBy(expenseLabels.name)
  return c.json({ labels })
})

financeRoutes.post(
  '/labels',
  zValidator(
    'json',
    z.object({
      name: z.string().trim().min(1).max(80),
      slug: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        .optional(),
    }),
  ),
  async (c) => {
    const user = requireFinanceAccess(c.get('user'))
    if (!user) return c.json({ error: 'Forbidden' }, 403)
    if (!hasPermission(user, 'finance.write')) return c.json({ error: 'Forbidden' }, 403)
    const body = c.req.valid('json')
    const slug =
      body.slug ??
      body.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
    const [label] = await db
      .insert(expenseLabels)
      .values({ farmId: user.farmId, name: body.name, slug })
      .onConflictDoNothing()
      .returning()
    if (!label) {
      const [existing] = await db
        .select()
        .from(expenseLabels)
        .where(and(eq(expenseLabels.farmId, user.farmId), eq(expenseLabels.slug, slug)))
        .limit(1)
      return c.json({ label: existing }, 200)
    }
    return c.json({ label }, 201)
  },
)

financeRoutes.get('/', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const labelFilter = c.req.query('labelId')
  let expenseIdsFilter: string[] | null = null
  if (labelFilter) {
    const links = await db
      .select({ expenseId: expenseLabelLinks.expenseId })
      .from(expenseLabelLinks)
      .innerJoin(expenseLabels, eq(expenseLabelLinks.labelId, expenseLabels.id))
      .where(and(eq(expenseLabels.farmId, user.farmId), eq(expenseLabelLinks.labelId, labelFilter)))
    expenseIdsFilter = links.map((row) => row.expenseId)
    if (expenseIdsFilter.length === 0) return c.json({ expenses: [] })
  }

  const rows = await db
    .select()
    .from(expenses)
    .where(
      expenseIdsFilter
        ? and(eq(expenses.farmId, user.farmId), inArray(expenses.id, expenseIdsFilter))
        : eq(expenses.farmId, user.farmId),
    )
    .orderBy(desc(expenses.expenseDate))

  const viewerLocale = await preferredLocaleForUser(user.id)
  const localized = await localizeRows(rows, EXPENSE_TEXT_FIELDS, user.farmId, viewerLocale)
  const labelMap = await labelsForExpenses(localized.map((row) => row.id))

  return c.json({
    expenses: localized.map((row) => ({
      ...row,
      labels: labelMap.get(row.id) ?? [],
      hasAttachment: Boolean(row.attachmentStorageKey),
    })),
  })
})

financeRoutes.get('/summary', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)

  const labelFilter = c.req.query('labelId')

  const [orderRows, expenseRows, paidAttempts, unpaidOrders, refundRows, invoiceCountRow, labelAgg] =
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
      db
        .select({
          expenseId: expenseLabelLinks.expenseId,
          labelId: expenseLabels.id,
          labelName: expenseLabels.name,
          labelSlug: expenseLabels.slug,
        })
        .from(expenseLabelLinks)
        .innerJoin(expenseLabels, eq(expenseLabelLinks.labelId, expenseLabels.id))
        .innerJoin(expenses, eq(expenseLabelLinks.expenseId, expenses.id))
        .where(and(eq(expenses.farmId, user.farmId), eq(expenseLabels.farmId, user.farmId))),
    ])

  const { expenses: filteredExpenses, expensesByLabel } = filterAndGroupExpensesByLabel(
    expenseRows,
    labelAgg,
    labelFilter,
  )

  const revenue = orderRows.reduce((sum, o) => sum + o.totalAmount, 0)
  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0)

  const expensesByCategory = filteredExpenses.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + e.amount
    return acc
  }, {})

  const deliveredRevenue = orderRows
    .filter((o) => o.status === 'delivered')
    .reduce((sum, o) => sum + o.totalAmount, 0)

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
      expenseCount: filteredExpenses.length,
      expensesByCategory,
      expensesByLabel,
    },
  })
})

financeRoutes.get('/:id/attachment', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)
  const expenseId = c.req.param('id')
  const [expense] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
    .limit(1)
  if (!expense?.attachmentStorageKey) return c.json({ error: 'Not found' }, 404)

  const root = getEvidenceStorageRoot()
  const filePath = path.resolve(root, expense.attachmentStorageKey)
  if (!filePath.startsWith(path.resolve(root) + path.sep) && filePath !== path.resolve(root)) {
    return c.json({ error: 'Not found' }, 404)
  }
  try {
    await access(filePath)
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }

  c.header('Content-Type', expense.attachmentMimeType ?? 'application/octet-stream')
  c.header(
    'Content-Disposition',
    `inline; filename="${(expense.attachmentFilename ?? 'attachment').replace(/"/g, '')}"`,
  )
  return c.body(createReadStream(filePath) as unknown as ReadableStream)
})

financeRoutes.post('/:id/retry-extraction', async (c) => {
  const user = c.get('user')
  if (user.role !== 'owner' && user.role !== 'supervisor') {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const expenseId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (
    existing.source !== 'inbound_email' ||
    !existing.attachmentStorageKey ||
    !existing.attachmentMimeType
  ) {
    return c.json({ error: 'Inbound expense attachment not found' }, 409)
  }

  const root = path.resolve(getEvidenceStorageRoot())
  const filePath = path.resolve(root, existing.attachmentStorageKey)
  if (!filePath.startsWith(root + path.sep)) return c.json({ error: 'Not found' }, 404)

  let method: 'heuristic' | 'pdf_text' | 'llm_text' | 'llm_vision' | 'none' = 'none'
  let status: 'success' | 'failed' = 'failed'
  const updates: Partial<typeof existing> = {
    extractionMethod: method,
    extractionStatus: status,
  }
  const updatedFields: string[] = []

  try {
    const buffer = await readFile(filePath)
    const extracted = await extractInvoiceFields({
      farmId: user.farmId,
      subject: existing.description,
      bodyText: '',
      fromVendorHint: null,
      mime: existing.attachmentMimeType,
      buffer,
    })
    method = extracted.method
    status = method === 'none' ? 'failed' : 'success'
    updates.extractionMethod = method
    updates.extractionStatus = status

    if (extracted.amount >= 1) {
      updates.amount = extracted.amount
      updates.currency = extracted.currency
      updatedFields.push('amount', 'currency')
    }
    if (method !== 'none' && extracted.vendor?.trim()) {
      updates.vendor = extracted.vendor.trim().slice(0, 200)
      updatedFields.push('vendor')
    }
    if (method !== 'none' && extracted.expenseDate) {
      updates.expenseDate = extracted.expenseDate
      updatedFields.push('expenseDate')
    }
  } catch {
    // A retry is an operator action, not a new expense write. Record the failed
    // attempt without disturbing the draft values or pending-review state.
  }

  const [expense] = await db
    .update(expenses)
    .set(updates)
    .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'retry_extraction',
    entityType: 'expense',
    entityId: expenseId,
    metadata: { method, status, updatedFields },
  })

  return c.json({
    expense,
    extractionMethod: method,
    extractionStatus: status,
    updatedFields,
  })
})

financeRoutes.post('/', zValidator('json', createExpenseSchema), async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)
  if (!hasPermission(user, 'finance.write')) return c.json({ error: 'Forbidden' }, 403)

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
      vendor: body.vendor ?? null,
      receiptRef: body.receiptRef ?? null,
      recordedById: user.id,
      expenseDate: new Date(body.expenseDate),
      approvalStatus: body.approvalStatus ?? 'approved',
      source: 'manual',
    })
    .returning()

  try {
    if (body.labelIds?.length) await setExpenseLabels(user.farmId, expense.id, body.labelIds)
  } catch {
    return c.json({ error: 'Invalid label' }, 400)
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'expense',
    entityId: expense.id,
    metadata: { category: expense.category, amount: expense.amount },
  })

  const labelMap = await labelsForExpenses([expense.id])
  return c.json(
    {
      expense: {
        ...expense,
        description: body.description,
        labels: labelMap.get(expense.id) ?? [],
        hasAttachment: false,
      },
    },
    201,
  )
})

financeRoutes.patch('/:id', zValidator('json', updateExpenseSchema), async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)
  if (!hasPermission(user, 'finance.write')) return c.json({ error: 'Forbidden' }, 403)

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
  if (body.approvalStatus !== undefined) updates.approvalStatus = body.approvalStatus

  if (body.description !== undefined) {
    const canonical = await canonicalDescription(body.description, user.farmId, authorLocale)
    updates.description = canonical.english ?? body.description
    if (canonical.english !== undefined) {
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

  if (body.labelIds !== undefined) {
    try {
      await setExpenseLabels(user.farmId, expenseId, body.labelIds)
    } catch {
      return c.json({ error: 'Invalid label' }, 400)
    }
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'expense',
    entityId: expenseId,
  })

  const labelMap = await labelsForExpenses([expense.id])
  if (body.description !== undefined) {
    return c.json({
      expense: {
        ...expense,
        description: body.description,
        labels: labelMap.get(expense.id) ?? [],
        hasAttachment: Boolean(expense.attachmentStorageKey),
      },
    })
  }
  const [localized] = await localizeRows([expense], EXPENSE_TEXT_FIELDS, user.farmId, viewerLocale)
  return c.json({
    expense: {
      ...localized,
      labels: labelMap.get(expense.id) ?? [],
      hasAttachment: Boolean(expense.attachmentStorageKey),
    },
  })
})

financeRoutes.delete('/:id', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)
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
