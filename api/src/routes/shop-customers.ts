import { zValidator } from '@hono/zod-validator'
import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import { customerAccounts, customerContacts } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

const listSchema = z.object({
  search: z.string().trim().max(200).optional(),
  verified: z.enum(['all', 'yes', 'no']).optional(),
  active: z.enum(['all', 'yes', 'no']).optional(),
})

export const shopCustomerRoutes = new Hono<{ Variables: AppVariables }>()
shopCustomerRoutes.use('*', authMiddleware)

function canViewShopCustomers(role: string): boolean {
  return role === 'owner' || role === 'sales'
}

shopCustomerRoutes.get('/', zValidator('query', listSchema), async (c) => {
  const user = c.get('user')
  if (!canViewShopCustomers(user.role)) return c.json({ error: 'Forbidden' }, 403)

  const query = c.req.valid('query')
  const filters = [eq(customerAccounts.farmId, user.farmId)]

  if (query.verified === 'yes') filters.push(isNotNull(customerAccounts.emailVerifiedAt))
  if (query.verified === 'no') filters.push(isNull(customerAccounts.emailVerifiedAt))
  if (query.active === 'yes') filters.push(eq(customerAccounts.active, true))
  if (query.active === 'no') filters.push(eq(customerAccounts.active, false))

  if (query.search) {
    const term = `%${query.search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    const search = or(
      ilike(customerAccounts.name, term),
      ilike(customerAccounts.email, term),
      ilike(customerAccounts.phone, term),
    )
    if (search) filters.push(search)
  }

  const rows = await db
    .select({
      id: customerAccounts.id,
      email: customerAccounts.email,
      name: customerAccounts.name,
      phone: customerAccounts.phone,
      emailVerifiedAt: customerAccounts.emailVerifiedAt,
      active: customerAccounts.active,
      createdAt: customerAccounts.createdAt,
      updatedAt: customerAccounts.updatedAt,
    })
    .from(customerAccounts)
    .where(and(...filters))
    .orderBy(desc(customerAccounts.createdAt))
    .limit(500)

  const accountIds = rows.map((row) => row.id)
  const contactRows =
    accountIds.length === 0
      ? []
      : await db
          .select({
            customerAccountId: customerContacts.customerAccountId,
            channel: customerContacts.channel,
            name: customerContacts.name,
          })
          .from(customerContacts)
          .where(
            and(
              eq(customerContacts.farmId, user.farmId),
              inArray(customerContacts.customerAccountId, accountIds),
            ),
          )

  const channelsByAccount = new Map<string, { channel: string; name: string | null }[]>()
  for (const contact of contactRows) {
    if (!contact.customerAccountId) continue
    const list = channelsByAccount.get(contact.customerAccountId) ?? []
    list.push({ channel: contact.channel, name: contact.name })
    channelsByAccount.set(contact.customerAccountId, list)
  }

  const customers = rows.map((row) => ({
    ...row,
    channels: channelsByAccount.get(row.id) ?? [],
  }))

  const [totals] = await db
    .select({
      total: count(),
      verified: sql<number>`count(*) filter (where ${customerAccounts.emailVerifiedAt} is not null)`,
      unverified: sql<number>`count(*) filter (where ${customerAccounts.emailVerifiedAt} is null)`,
      inactive: sql<number>`count(*) filter (where ${customerAccounts.active} = false)`,
    })
    .from(customerAccounts)
    .where(eq(customerAccounts.farmId, user.farmId))

  return c.json({
    customers,
    summary: {
      total: Number(totals?.total ?? 0),
      verified: Number(totals?.verified ?? 0),
      unverified: Number(totals?.unverified ?? 0),
      inactive: Number(totals?.inactive ?? 0),
    },
  })
})
