import { Hono } from 'hono'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { customerInquiries } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requirePermission } from '../lib/rbac.js'
import { topQuestions } from '../lib/customer-inquiry.js'

export const customerInsightsRoutes = new Hono<{ Variables: AppVariables }>()

customerInsightsRoutes.use('*', authMiddleware)

/**
 * Founder view of what customers ask the order bot: most-asked questions,
 * channel breakdown, and recent questions. Owner-only.
 */
customerInsightsRoutes.get('/', async (c) => {
  const user = c.get('user')
  try {
    requirePermission(user, 'farm.manage')
  } catch {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const farmId = user.farmId
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const farmFilter = eq(customerInquiries.farmId, farmId)

  const [top, [totals], [last7Row], recent, byChannel] = await Promise.all([
    topQuestions(farmId, 15),
    db
      .select({
        total: sql<number>`COUNT(*)`.mapWith(Number),
        unique: sql<number>`COUNT(DISTINCT ${customerInquiries.normalized})`.mapWith(Number),
      })
      .from(customerInquiries)
      .where(farmFilter),
    db
      .select({
        last7: sql<number>`COUNT(*)`.mapWith(Number),
      })
      .from(customerInquiries)
      .where(and(farmFilter, gte(customerInquiries.createdAt, sevenDaysAgo))),
    db
      .select({
        id: customerInquiries.id,
        question: customerInquiries.question,
        channel: customerInquiries.channel,
        answeredVia: customerInquiries.answeredVia,
        createdAt: customerInquiries.createdAt,
      })
      .from(customerInquiries)
      .where(farmFilter)
      .orderBy(desc(customerInquiries.createdAt))
      .limit(25),
    db
      .select({
        channel: customerInquiries.channel,
        count: sql<number>`COUNT(*)`.mapWith(Number),
      })
      .from(customerInquiries)
      .where(farmFilter)
      .groupBy(customerInquiries.channel),
  ])

  return c.json({
    summary: {
      total: totals?.total ?? 0,
      unique: totals?.unique ?? 0,
      last7: last7Row?.last7 ?? 0,
    },
    topQuestions: top,
    byChannel,
    recent,
  })
})
