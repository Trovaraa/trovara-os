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
  storageCleanupJobs,
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
import { access, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getEvidenceStorageRoot } from '../lib/evidence-store.js'
import { filterAndGroupExpensesByLabel } from '../lib/expense-label-report.js'
import { extractInvoiceFields } from '../lib/invoice-extract.js'
import { convertToNgn, FxAmountOverflowError } from '../lib/currency-fx.js'
import { maybeSendInboundApprovalAck } from '../lib/finance-inbound-ack.js'

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

function slugifyExpenseLabel(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  if (ascii) return ascii.slice(0, 80)

  const unicode = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
  if (unicode) return unicode.slice(0, 80)

  return `label-${randomUUID().slice(0, 8)}`
}

async function convertExtractedAmount(amount: number, currency: string, asOfDate: Date) {
  try {
    return await convertToNgn(amount, currency, asOfDate)
  } catch (error) {
    if (error instanceof FxAmountOverflowError) return null
    throw error
  }
}

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

type FinanceDbExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function validateExpenseLabels(
  executor: FinanceDbExecutor,
  farmId: string,
  labelIds: string[],
): Promise<string[]> {
  const unique = [...new Set(labelIds)]
  if (unique.length) {
    const valid = await executor
      .select({ id: expenseLabels.id })
      .from(expenseLabels)
      .where(and(eq(expenseLabels.farmId, farmId), inArray(expenseLabels.id, unique)))
    if (valid.length !== unique.length) throw new Error('INVALID_LABEL')
  }
  return unique
}

async function setExpenseLabels(
  executor: FinanceDbExecutor,
  farmId: string,
  expenseId: string,
  labelIds: string[],
) {
  const unique = await validateExpenseLabels(executor, farmId, labelIds)
  await executor.delete(expenseLabelLinks).where(eq(expenseLabelLinks.expenseId, expenseId))
  if (unique.length) {
    await executor
      .insert(expenseLabelLinks)
      .values(unique.map((labelId) => ({ farmId, expenseId, labelId })))
  }
}

function isInvalidLabelError(error: unknown): boolean {
  return error instanceof Error && error.message === 'INVALID_LABEL'
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
    const slug = body.slug ?? slugifyExpenseLabel(body.name)
    if (!slug) return c.json({ error: 'Label name must include a letter or number' }, 400)
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
          currency: orders.currency,
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

  const statusScopedExpenses = filterAndGroupExpensesByLabel(
    expenseRows,
    labelAgg,
    labelFilter,
  ).expenses
  const reportableExpenses = statusScopedExpenses.filter(
    (expense) => expense.approvalStatus === 'approved' && expense.currency === 'NGN',
  )
  const { expenses: filteredExpenses, expensesByLabel } = filterAndGroupExpensesByLabel(
    reportableExpenses,
    labelAgg,
    labelFilter,
  )

  const ngnOrders = orderRows.filter((order) => order.currency === 'NGN')
  const revenue = ngnOrders.reduce((sum, o) => sum + o.totalAmount, 0)
  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0)

  const expensesByCategory = filteredExpenses.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + e.amount
    return acc
  }, {})

  const deliveredRevenue = ngnOrders
    .filter((o) => o.status === 'delivered')
    .reduce((sum, o) => sum + o.totalAmount, 0)

  const paidRevenue = Math.round(Number(paidAttempts[0]?.totalKobo ?? 0) / 100)
  const outstandingInvoices = unpaidOrders
    .filter((order) => order.currency === 'NGN')
    .reduce((sum, o) => sum + o.totalAmount, 0)
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
      pendingExpenseCount: statusScopedExpenses.filter(
        (expense) => expense.approvalStatus === 'pending',
      ).length,
      rejectedExpenseCount: statusScopedExpenses.filter(
        (expense) => expense.approvalStatus === 'rejected',
      ).length,
      unconvertedForeignCount: statusScopedExpenses.filter(
        (expense) => expense.approvalStatus === 'approved' && expense.currency !== 'NGN',
      ).length,
      orderCount: ngnOrders.length,
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
      const conversionDate = extracted.expenseDate ?? existing.expenseDate
      const converted = await convertExtractedAmount(
        extracted.amount,
        extracted.currency,
        conversionDate,
      )
      const isForeign = extracted.currency.toUpperCase() !== 'NGN'
      updates.amount = converted?.amount ?? Math.round(extracted.amount)
      updates.currency = converted?.currency ?? extracted.currency
      updates.originalAmount =
        converted?.originalAmount ?? (isForeign ? String(extracted.amount) : null)
      updates.originalCurrency =
        converted?.originalCurrency ?? (isForeign ? extracted.currency : null)
      updates.fxRate = converted?.fxRate ?? null
      updates.fxConvertedAt = converted?.fxConvertedAt ?? null
      updates.fxRateDate = converted?.fxRateDate ?? null
      updates.fxRateSource = converted?.fxRateSource ?? null
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

financeRoutes.post('/:id/convert-currency', async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)
  if (!hasPermission(user, 'finance.write')) return c.json({ error: 'Forbidden' }, 403)

  const expenseId = c.req.param('id')
  const [existing] = await db
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
    .limit(1)
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (existing.currency === 'NGN') return c.json({ expense: existing })

  const sourceAmount = Number(existing.originalAmount ?? existing.amount)
  const sourceCurrency = existing.originalCurrency ?? existing.currency
  let converted
  try {
    converted = await convertToNgn(sourceAmount, sourceCurrency, existing.expenseDate)
  } catch (error) {
    if (error instanceof FxAmountOverflowError) {
      return c.json(
        {
          error:
            'Converted naira amount is too large to store. Enter the NGN amount manually instead.',
        },
        422,
      )
    }
    throw error
  }
  if (!converted) {
    return c.json(
      { error: `Could not get a ${sourceCurrency} to NGN exchange rate. Try again later.` },
      503,
    )
  }

  const [expense] = await db
    .update(expenses)
    .set(converted)
    .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'convert_currency',
    entityType: 'expense',
    entityId: expenseId,
    metadata: {
      originalAmount: converted.originalAmount,
      originalCurrency: converted.originalCurrency,
      fxRate: converted.fxRate,
      amount: converted.amount,
      currency: converted.currency,
    },
  })

  return c.json({ expense })
})

financeRoutes.post('/', zValidator('json', createExpenseSchema), async (c) => {
  const user = requireFinanceAccess(c.get('user'))
  if (!user) return c.json({ error: 'Forbidden' }, 403)
  if (!hasPermission(user, 'finance.write')) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  if (body.currency && body.currency.toUpperCase() !== 'NGN') {
    return c.json({ error: 'Manual expenses must be entered in NGN' }, 400)
  }

  const canonical = await canonicalDescription(
    body.description,
    user.farmId,
    await authorLocaleForUserId(user.id),
  )

  let expense: typeof expenses.$inferSelect
  try {
    expense = await db.transaction(async (tx) => {
      if (body.labelIds?.length) await validateExpenseLabels(tx, user.farmId, body.labelIds)
      const [created] = await tx
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
      if (body.labelIds?.length) {
        await setExpenseLabels(tx, user.farmId, created.id, body.labelIds)
      }
      return created
    })
  } catch (error) {
    if (!isInvalidLabelError(error)) throw error
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
  if (
    body.approvalStatus === 'approved' &&
    (body.currency ?? existing.currency).toUpperCase() !== 'NGN'
  ) {
    return c.json({ error: 'Convert this expense to NGN before approving it' }, 409)
  }

  const viewerLocale = await preferredLocaleForUser(user.id)
  const authorLocale = authorLocaleHint(viewerLocale)

  const updates: Partial<typeof existing> = {}
  if (body.category !== undefined) updates.category = body.category
  if (body.amount !== undefined) updates.amount = body.amount
  if (body.currency !== undefined) {
    if (body.currency.toUpperCase() !== 'NGN') {
      return c.json({ error: 'Expense updates must be entered in NGN' }, 400)
    }
    updates.currency = 'NGN'
  }
  if ((body.amount !== undefined || body.currency !== undefined) && existing.originalCurrency) {
    updates.originalAmount = null
    updates.originalCurrency = null
    updates.fxRate = null
    updates.fxConvertedAt = null
    updates.fxRateDate = null
    updates.fxRateSource = null
  }
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

  let expense: typeof expenses.$inferSelect
  try {
    expense = await db.transaction(async (tx) => {
      if (body.labelIds !== undefined) {
        await validateExpenseLabels(tx, user.farmId, body.labelIds)
      }
      const [changed] = await tx
        .update(expenses)
        .set(updates)
        .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
        .returning()
      if (body.labelIds !== undefined) {
        await setExpenseLabels(tx, user.farmId, expenseId, body.labelIds)
      }
      return changed
    })
  } catch (error) {
    if (!isInvalidLabelError(error)) throw error
    return c.json({ error: 'Invalid label' }, 400)
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'update',
    entityType: 'expense',
    entityId: expenseId,
  })

  let inboundAck: { sent: boolean; skipped?: string; to?: string } | undefined
  if (
    body.approvalStatus === 'approved' &&
    existing.approvalStatus !== 'approved' &&
    expense.source === 'inbound_email'
  ) {
    inboundAck = await maybeSendInboundApprovalAck({
      expense,
      previousStatus: existing.approvalStatus,
    })
    if (inboundAck.sent) {
      expense = { ...expense, inboundAckSentAt: new Date() }
    }
  }

  const labelMap = await labelsForExpenses([expense.id])
  if (body.description !== undefined) {
    return c.json({
      expense: {
        ...expense,
        description: body.description,
        labels: labelMap.get(expense.id) ?? [],
        hasAttachment: Boolean(expense.attachmentStorageKey),
      },
      ...(inboundAck ? { inboundAck } : {}),
    })
  }
  const [localized] = await localizeRows([expense], EXPENSE_TEXT_FIELDS, user.farmId, viewerLocale)
  return c.json({
    expense: {
      ...localized,
      labels: labelMap.get(expense.id) ?? [],
      hasAttachment: Boolean(expense.attachmentStorageKey),
    },
    ...(inboundAck ? { inboundAck } : {}),
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

  const root = path.resolve(getEvidenceStorageRoot())
  const filePath = existing.attachmentStorageKey
    ? path.resolve(root, existing.attachmentStorageKey)
    : null
  if (filePath && !filePath.startsWith(root + path.sep)) {
    return c.json({ error: 'Attachment path is invalid' }, 500)
  }

  const cleanupJobId = await db.transaction(async (tx) => {
    let jobId: string | null = null
    if (existing.attachmentStorageKey) {
      const [job] = await tx
        .insert(storageCleanupJobs)
        .values({ storageRoot: 'evidence', storageKey: existing.attachmentStorageKey })
        .onConflictDoUpdate({
          target: [storageCleanupJobs.storageRoot, storageCleanupJobs.storageKey],
          set: { status: 'pending', lastError: null, completedAt: null },
        })
        .returning({ id: storageCleanupJobs.id })
      jobId = job.id
    }
    await tx
      .delete(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.farmId, user.farmId)))
    return jobId
  })

  let cleanupPending = false
  if (filePath && cleanupJobId) {
    try {
      await unlink(filePath)
      await db
        .update(storageCleanupJobs)
        .set({ status: 'completed', completedAt: new Date(), lastError: null })
        .where(eq(storageCleanupJobs.id, cleanupJobId))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        await db
          .update(storageCleanupJobs)
          .set({ status: 'completed', completedAt: new Date(), lastError: null })
          .where(eq(storageCleanupJobs.id, cleanupJobId))
      } else {
        cleanupPending = true
        await db
          .update(storageCleanupJobs)
          .set({
            status: 'pending',
            attemptCount: sql`${storageCleanupJobs.attemptCount} + 1`,
            lastError: error instanceof Error ? error.message.slice(0, 500) : 'File cleanup failed',
          })
          .where(eq(storageCleanupJobs.id, cleanupJobId))
      }
    }
  }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'delete',
    entityType: 'expense',
    entityId: expenseId,
  })

  return c.json({ ok: true, cleanupPending })
})
