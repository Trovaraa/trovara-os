import { zValidator } from '@hono/zod-validator'
import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  customerAccounts,
  customerContacts,
  customerCreditLedger,
  customerReferralAttributions,
  customerReferralCodes,
} from '../db/schema.js'
import { hasPermission } from '../lib/rbac.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import type { SessionUser } from '../lib/session.js'

const listSchema = z.object({
  search: z.string().trim().max(200).optional(),
  verified: z.enum(['all', 'yes', 'no']).optional(),
  active: z.enum(['all', 'yes', 'no']).optional(),
})

export const shopCustomerRoutes = new Hono<{ Variables: AppVariables }>()
shopCustomerRoutes.use('*', authMiddleware)

function canViewShopCustomers(user: SessionUser): boolean {
  return (
    hasPermission(user, 'orders.manage') ||
    hasPermission(user, 'finance.read') ||
    hasPermission(user, 'newsletter.manage') ||
    hasPermission(user, 'leads.manage')
  )
}

shopCustomerRoutes.get('/', zValidator('query', listSchema), async (c) => {
  const user = c.get('user')
  if (!canViewShopCustomers(user)) return c.json({ error: 'Forbidden' }, 403)

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
  const [contactRows, creditRows, referralRows, referralCodeRows] =
    accountIds.length === 0
      ? [[], [], [], []]
      : await Promise.all([
          db
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
            ),
          db
            .select({
              accountId: customerCreditLedger.accountId,
              balance: sql<number>`coalesce(sum(${customerCreditLedger.amount}), 0)`,
            })
            .from(customerCreditLedger)
            .where(
              and(
                eq(customerCreditLedger.farmId, user.farmId),
                inArray(customerCreditLedger.accountId, accountIds),
              ),
            )
            .groupBy(customerCreditLedger.accountId),
          db
            .select({
              accountId: customerReferralAttributions.referrerAccountId,
              referralCount: count(),
              rewardsActivated: sql<number>`count(*) filter (where ${customerReferralAttributions.creditedAt} is not null)`,
            })
            .from(customerReferralAttributions)
            .where(
              and(
                eq(customerReferralAttributions.farmId, user.farmId),
                inArray(customerReferralAttributions.referrerAccountId, accountIds),
              ),
            )
            .groupBy(customerReferralAttributions.referrerAccountId),
          db
            .select({
              accountId: customerReferralCodes.accountId,
              code: customerReferralCodes.code,
            })
            .from(customerReferralCodes)
            .where(
              and(
                eq(customerReferralCodes.farmId, user.farmId),
                inArray(customerReferralCodes.accountId, accountIds),
              ),
            ),
        ])

  const channelsByAccount = new Map<string, { channel: string; name: string | null }[]>()
  for (const contact of contactRows) {
    if (!contact.customerAccountId) continue
    const list = channelsByAccount.get(contact.customerAccountId) ?? []
    list.push({ channel: contact.channel, name: contact.name })
    channelsByAccount.set(contact.customerAccountId, list)
  }

  const creditsByAccount = new Map(
    creditRows.map((row) => [row.accountId, Number(row.balance ?? 0)]),
  )
  const referralsByAccount = new Map(
    referralRows.map((row) => [
      row.accountId,
      {
        referralCount: Number(row.referralCount ?? 0),
        rewardsActivated: Number(row.rewardsActivated ?? 0),
      },
    ]),
  )
  const referralCodesByAccount = new Map(
    referralCodeRows.map((row) => [row.accountId, row.code]),
  )

  const customers = rows.map((row) => ({
    ...row,
    channels: channelsByAccount.get(row.id) ?? [],
    creditsBalance: creditsByAccount.get(row.id) ?? 0,
    referralCount: referralsByAccount.get(row.id)?.referralCount ?? 0,
    rewardsActivated: referralsByAccount.get(row.id)?.rewardsActivated ?? 0,
    referralCode: referralCodesByAccount.get(row.id) ?? null,
  }))

  const [[totals], [creditTotals], [referralTotals]] = await Promise.all([
    db
      .select({
        total: count(),
        verified: sql<number>`count(*) filter (where ${customerAccounts.emailVerifiedAt} is not null)`,
        unverified: sql<number>`count(*) filter (where ${customerAccounts.emailVerifiedAt} is null)`,
        inactive: sql<number>`count(*) filter (where ${customerAccounts.active} = false)`,
      })
      .from(customerAccounts)
      .where(eq(customerAccounts.farmId, user.farmId)),
    db
      .select({
        creditsBalance: sql<number>`coalesce(sum(${customerCreditLedger.amount}), 0)`,
      })
      .from(customerCreditLedger)
      .where(eq(customerCreditLedger.farmId, user.farmId)),
    db
      .select({
        referrals: count(),
        rewardsActivated: sql<number>`count(*) filter (where ${customerReferralAttributions.creditedAt} is not null)`,
      })
      .from(customerReferralAttributions)
      .where(eq(customerReferralAttributions.farmId, user.farmId)),
  ])

  return c.json({
    customers,
    summary: {
      total: Number(totals?.total ?? 0),
      verified: Number(totals?.verified ?? 0),
      unverified: Number(totals?.unverified ?? 0),
      inactive: Number(totals?.inactive ?? 0),
      creditsBalance: Number(creditTotals?.creditsBalance ?? 0),
      referrals: Number(referralTotals?.referrals ?? 0),
      rewardsActivated: Number(referralTotals?.rewardsActivated ?? 0),
    },
  })
})
