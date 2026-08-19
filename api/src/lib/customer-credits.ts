import { createHash, randomBytes } from 'node:crypto'
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  customerAccountSessions,
  customerAccounts,
  customerCreditInvitations,
  customerCreditLedger,
  customerReferralAttributions,
  customerReferralCodes,
  customerContacts,
  orders,
} from '../db/schema.js'
import { publicMarketingUrlOrDefault } from './public-app-url.js'
import {
  isQualifyingReferralPurchase,
  REFERRAL_QUALIFYING_PAYMENT_STATUSES,
  referralRefundWindowDays,
  referralRewardEligibleAt,
} from './customer-credit-policy.js'

export const TROVARA_WELCOME_CREDITS = 2_000
export const TROVARA_REFERRAL_CREDITS = 1_000
const INVITATION_DAYS = 14

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cleanName(name: string | null | undefined): string {
  return name?.trim() || 'Trovara customer'
}

function newReferralCode(): string {
  return `TRV${randomBytes(6).toString('hex').toUpperCase()}`
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0 || at === email.length - 1) return '***'
  const local = email.slice(0, at)
  const domain = email.slice(at + 1)
  return `${local.charAt(0)}***@${domain}`
}

export function creditClaimPreservesExistingPassword(existing: {
  emailVerifiedAt: Date | null
} | null): boolean {
  return Boolean(existing?.emailVerifiedAt)
}

export async function ensureCustomerReferralCode(params: {
  farmId: string
  accountId: string
}): Promise<{ id: string; code: string }> {
  const [existing] = await db
    .select({ id: customerReferralCodes.id, code: customerReferralCodes.code })
    .from(customerReferralCodes)
    .where(eq(customerReferralCodes.accountId, params.accountId))
    .limit(1)
  if (existing) return existing

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [created] = await db
      .insert(customerReferralCodes)
      .values({ ...params, code: newReferralCode() })
      .onConflictDoNothing()
      .returning({ id: customerReferralCodes.id, code: customerReferralCodes.code })
    if (created) return created

    const [raced] = await db
      .select({ id: customerReferralCodes.id, code: customerReferralCodes.code })
      .from(customerReferralCodes)
      .where(eq(customerReferralCodes.accountId, params.accountId))
      .limit(1)
    if (raced) return raced
  }
  throw new Error('REFERRAL_CODE_CREATION_FAILED')
}

export async function linkReferralAttributionsToCustomerAccount(params: {
  farmId: string
  accountId: string
  email: string
}): Promise<void> {
  const normalizedEmail = params.email.trim().toLowerCase()
  if (!normalizedEmail) return

  await db
    .update(customerReferralAttributions)
    .set({ referredAccountId: params.accountId })
    .where(
      and(
        eq(customerReferralAttributions.farmId, params.farmId),
        eq(
          customerReferralAttributions.referredNormalizedContact,
          `email:${normalizedEmail}`,
        ),
        isNull(customerReferralAttributions.referredAccountId),
      ),
    )
}

async function awardCredits(params: {
  farmId: string
  accountId: string
  amount: number
  eventType: 'welcome' | 'survey_referral'
  sourceId: string
  description: string
}): Promise<{ id: string; awarded: boolean }> {
  const [created] = await db
    .insert(customerCreditLedger)
    .values(params)
    .onConflictDoNothing()
    .returning({ id: customerCreditLedger.id })
  if (created) return { id: created.id, awarded: true }

  const [existing] = await db
    .select({ id: customerCreditLedger.id })
    .from(customerCreditLedger)
    .where(
      params.eventType === 'welcome'
        ? and(
            eq(customerCreditLedger.accountId, params.accountId),
            eq(customerCreditLedger.eventType, 'welcome'),
          )
        : and(
            eq(customerCreditLedger.accountId, params.accountId),
            eq(customerCreditLedger.eventType, params.eventType),
            eq(customerCreditLedger.sourceId, params.sourceId),
          ),
    )
    .limit(1)
  if (!existing) throw new Error('CREDIT_LEDGER_WRITE_FAILED')
  return { id: existing.id, awarded: false }
}

export type CreditInvitationResult =
  | {
      kind: 'invitation'
      id: string
      rawToken: string
      email: string
      name: string
      expiresAt: Date
    }
  | {
      kind: 'account_ready'
      accountId: string
      email: string
      name: string
      awarded: boolean
    }
  | {
      kind: 'already_invited'
      id: string
      email: string
      name: string
      expiresAt: Date
    }

export async function createOrRefreshCreditInvitation(params: {
  farmId: string
  email: string
  name?: string | null
  surveyResponseId?: string | null
  marketingLeadId?: string | null
  createdById?: string | null
  resendExisting?: boolean
}): Promise<CreditInvitationResult> {
  const normalizedEmail = params.email.trim().toLowerCase()
  const name = cleanName(params.name)
  const [account] = await db
    .select({
      id: customerAccounts.id,
      email: customerAccounts.email,
      name: customerAccounts.name,
      emailVerifiedAt: customerAccounts.emailVerifiedAt,
    })
    .from(customerAccounts)
    .where(
      and(
        eq(customerAccounts.farmId, params.farmId),
        eq(customerAccounts.email, normalizedEmail),
        eq(customerAccounts.active, true),
      ),
    )
    .limit(1)

  if (account?.emailVerifiedAt) {
    const award = await awardCredits({
      farmId: params.farmId,
      accountId: account.id,
      amount: TROVARA_WELCOME_CREDITS,
      eventType: 'welcome',
      sourceId: `survey-eligibility:${normalizedEmail}`,
      description: 'Trovara Credits survey welcome award',
    })
    await ensureCustomerReferralCode({ farmId: params.farmId, accountId: account.id })
    return {
      kind: 'account_ready',
      accountId: account.id,
      email: account.email,
      name: account.name,
      awarded: award.awarded,
    }
  }

  if (!params.resendExisting) {
    const [existingInvitation] = await db
      .select({
        id: customerCreditInvitations.id,
        email: customerCreditInvitations.email,
        name: customerCreditInvitations.name,
        expiresAt: customerCreditInvitations.expiresAt,
      })
      .from(customerCreditInvitations)
      .where(
        and(
          eq(customerCreditInvitations.farmId, params.farmId),
          eq(customerCreditInvitations.normalizedEmail, normalizedEmail),
          gt(customerCreditInvitations.expiresAt, new Date()),
          isNull(customerCreditInvitations.claimedAt),
          sql`${customerCreditInvitations.sentAt} is not null`,
        ),
      )
      .limit(1)
    if (existingInvitation) return { kind: 'already_invited', ...existingInvitation }
  }

  const rawToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITATION_DAYS * 24 * 60 * 60 * 1000)
  const [invitation] = await db
    .insert(customerCreditInvitations)
    .values({
      farmId: params.farmId,
      surveyResponseId: params.surveyResponseId ?? null,
      marketingLeadId: params.marketingLeadId ?? null,
      email: normalizedEmail,
      normalizedEmail,
      name,
      tokenHash: sha256(rawToken),
      expiresAt,
      createdById: params.createdById ?? null,
    })
    .onConflictDoUpdate({
      target: [customerCreditInvitations.farmId, customerCreditInvitations.normalizedEmail],
      set: {
        surveyResponseId: params.surveyResponseId ?? null,
        marketingLeadId: params.marketingLeadId ?? null,
        email: normalizedEmail,
        name,
        tokenHash: sha256(rawToken),
        expiresAt,
        sentAt: null,
        claimedAt: null,
        claimedByAccountId: null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: customerCreditInvitations.id })
  if (!invitation) throw new Error('CREDIT_INVITATION_CREATION_FAILED')
  return { kind: 'invitation', id: invitation.id, rawToken, email: normalizedEmail, name, expiresAt }
}

export async function markCreditInvitationSent(id: string): Promise<void> {
  await db
    .update(customerCreditInvitations)
    .set({ sentAt: new Date(), updatedAt: new Date() })
    .where(eq(customerCreditInvitations.id, id))
}

export async function inspectCreditInvitation(token: string) {
  const [row] = await db
    .select({
      name: customerCreditInvitations.name,
      email: customerCreditInvitations.email,
      expiresAt: customerCreditInvitations.expiresAt,
    })
    .from(customerCreditInvitations)
    .where(
      and(
        eq(customerCreditInvitations.tokenHash, sha256(token)),
        gt(customerCreditInvitations.expiresAt, new Date()),
        isNull(customerCreditInvitations.claimedAt),
      ),
    )
    .limit(1)
  if (!row) return null
  return {
    name: row.name,
    email: maskEmail(row.email),
    expiresAt: row.expiresAt,
  }
}

export type ClaimedCreditAccount = {
  id: string
  farmId: string
  email: string
  name: string
  phone: string | null
}

export type ClaimCreditInvitationResult =
  | { status: 'ok'; account: ClaimedCreditAccount }
  | { status: 'needs_sign_in' }

export async function claimCreditInvitation(params: { token: string; passwordHash: string }) {
  const now = new Date()
  const claimed = await db.transaction(async (tx) => {
    const [invitation] = await tx
      .update(customerCreditInvitations)
      .set({ claimedAt: now, updatedAt: now })
      .where(
        and(
          eq(customerCreditInvitations.tokenHash, sha256(params.token)),
          gt(customerCreditInvitations.expiresAt, now),
          isNull(customerCreditInvitations.claimedAt),
        ),
      )
      .returning()
    if (!invitation) return null

    const [existing] = await tx
      .select({
        id: customerAccounts.id,
        emailVerifiedAt: customerAccounts.emailVerifiedAt,
      })
      .from(customerAccounts)
      .where(
        and(
          eq(customerAccounts.farmId, invitation.farmId),
          eq(customerAccounts.email, invitation.normalizedEmail),
        ),
      )
      .limit(1)

    const attachCredits = async (accountId: string) => {
      await tx
        .update(customerCreditInvitations)
        .set({ claimedByAccountId: accountId })
        .where(eq(customerCreditInvitations.id, invitation.id))
      await tx
        .update(customerReferralAttributions)
        .set({ referredAccountId: accountId })
        .where(
          and(
            eq(customerReferralAttributions.farmId, invitation.farmId),
            eq(
              customerReferralAttributions.referredNormalizedContact,
              `email:${invitation.normalizedEmail}`,
            ),
            isNull(customerReferralAttributions.referredAccountId),
          ),
        )
      await tx
        .insert(customerCreditLedger)
        .values({
          farmId: invitation.farmId,
          accountId,
          amount: TROVARA_WELCOME_CREDITS,
          eventType: 'welcome',
          sourceId: `invitation:${invitation.id}`,
          description: 'Trovara Credits survey welcome award',
        })
        .onConflictDoNothing()
    }

    if (creditClaimPreservesExistingPassword(existing ?? null)) {
      await attachCredits(existing!.id)
      return { status: 'needs_sign_in' as const }
    }

    const [account] = existing
      ? await tx
          .update(customerAccounts)
          .set({
            name: invitation.name,
            passwordHash: params.passwordHash,
            emailVerifiedAt: now,
            active: true,
            updatedAt: now,
          })
          .where(eq(customerAccounts.id, existing.id))
          .returning({
            id: customerAccounts.id,
            farmId: customerAccounts.farmId,
            email: customerAccounts.email,
            name: customerAccounts.name,
            phone: customerAccounts.phone,
          })
      : await tx
          .insert(customerAccounts)
          .values({
            farmId: invitation.farmId,
            email: invitation.normalizedEmail,
            name: invitation.name,
            passwordHash: params.passwordHash,
            emailVerifiedAt: now,
          })
          .returning({
            id: customerAccounts.id,
            farmId: customerAccounts.farmId,
            email: customerAccounts.email,
            name: customerAccounts.name,
            phone: customerAccounts.phone,
          })
    if (!account) throw new Error('CREDIT_ACCOUNT_CREATION_FAILED')

    await attachCredits(account.id)
    await tx.delete(customerAccountSessions).where(eq(customerAccountSessions.accountId, account.id))
    return { status: 'ok' as const, account }
  })
  if (!claimed) return null
  if (claimed.status === 'ok') {
    await ensureCustomerReferralCode({ farmId: claimed.account.farmId, accountId: claimed.account.id })
  }
  return claimed
}

async function attachFirstQualifyingOrder(params: {
  attributionId: string
  farmId: string
  referredAccountId: string
  attributedAt: Date
}): Promise<void> {
  const [order] = await db
    .select({ id: orders.id, deliveredAt: orders.deliveredAt })
    .from(orders)
    .innerJoin(customerContacts, eq(orders.customerContactId, customerContacts.id))
    .where(
      and(
        eq(orders.farmId, params.farmId),
        eq(customerContacts.customerAccountId, params.referredAccountId),
        eq(orders.status, 'delivered'),
        inArray(orders.paymentStatus, REFERRAL_QUALIFYING_PAYMENT_STATUSES),
        gt(orders.totalAmount, 0),
        isNotNull(orders.deliveredAt),
        gte(orders.createdAt, params.attributedAt),
      ),
    )
    .orderBy(asc(orders.deliveredAt), asc(orders.createdAt))
    .limit(1)
  if (!order?.deliveredAt) return

  await db
    .update(customerReferralAttributions)
    .set({
      qualifyingOrderId: order.id,
      rewardEligibleAt: referralRewardEligibleAt(order.deliveredAt),
    })
    .where(
      and(
        eq(customerReferralAttributions.id, params.attributionId),
        isNull(customerReferralAttributions.qualifyingOrderId),
        isNull(customerReferralAttributions.ledgerEntryId),
      ),
    )
}

/**
 * Records the referred customer's first delivered purchase. The reward remains
 * pending until its refund window expires and is never added to usable balance
 * merely because a survey was submitted.
 */
export async function recordReferralQualifyingPurchase(params: {
  farmId: string
  orderId: string
}): Promise<void> {
  const [purchase] = await db
    .select({
      accountId: customerContacts.customerAccountId,
      deliveredAt: orders.deliveredAt,
      paymentStatus: orders.paymentStatus,
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .innerJoin(customerContacts, eq(orders.customerContactId, customerContacts.id))
    .where(
      and(
        eq(orders.id, params.orderId),
        eq(orders.farmId, params.farmId),
        eq(orders.status, 'delivered'),
      ),
    )
    .limit(1)
  if (
    !purchase?.accountId ||
    !isQualifyingReferralPurchase({
      status: 'delivered',
      paymentStatus: purchase.paymentStatus,
      totalAmount: purchase.totalAmount,
      deliveredAt: purchase.deliveredAt,
    })
  ) {
    return
  }

  const [attribution] = await db
    .select({ id: customerReferralAttributions.id })
    .from(customerReferralAttributions)
    .where(
      and(
        eq(customerReferralAttributions.farmId, params.farmId),
        eq(customerReferralAttributions.referredAccountId, purchase.accountId),
        lte(customerReferralAttributions.createdAt, purchase.createdAt),
        isNull(customerReferralAttributions.qualifyingOrderId),
        isNull(customerReferralAttributions.ledgerEntryId),
      ),
    )
    .orderBy(asc(customerReferralAttributions.createdAt))
    .limit(1)
  if (!attribution) return

  await db
    .update(customerReferralAttributions)
    .set({
      qualifyingOrderId: params.orderId,
      rewardEligibleAt: referralRewardEligibleAt(purchase.deliveredAt!),
    })
    .where(
      and(
        eq(customerReferralAttributions.id, attribution.id),
        isNull(customerReferralAttributions.qualifyingOrderId),
        isNull(customerReferralAttributions.ledgerEntryId),
      ),
    )
}

async function matureReferralRewards(farmId: string, referrerAccountId: string): Promise<void> {
  const pending = await db
    .select({
      id: customerReferralAttributions.id,
      referredAccountId: customerReferralAttributions.referredAccountId,
      qualifyingOrderId: customerReferralAttributions.qualifyingOrderId,
      attributedAt: customerReferralAttributions.createdAt,
    })
    .from(customerReferralAttributions)
    .where(
      and(
        eq(customerReferralAttributions.farmId, farmId),
        eq(customerReferralAttributions.referrerAccountId, referrerAccountId),
        isNull(customerReferralAttributions.ledgerEntryId),
      ),
    )

  for (const attribution of pending) {
    if (!attribution.qualifyingOrderId && attribution.referredAccountId) {
      await attachFirstQualifyingOrder({
        attributionId: attribution.id,
        farmId,
        referredAccountId: attribution.referredAccountId,
        attributedAt: attribution.attributedAt,
      })
    }
  }

  const due = await db
    .select({
      id: customerReferralAttributions.id,
      orderStatus: orders.status,
      paymentStatus: orders.paymentStatus,
      totalAmount: orders.totalAmount,
      deliveredAt: orders.deliveredAt,
    })
    .from(customerReferralAttributions)
    .innerJoin(orders, eq(customerReferralAttributions.qualifyingOrderId, orders.id))
    .where(
      and(
        eq(customerReferralAttributions.farmId, farmId),
        eq(customerReferralAttributions.referrerAccountId, referrerAccountId),
        isNull(customerReferralAttributions.ledgerEntryId),
        isNotNull(customerReferralAttributions.rewardEligibleAt),
        lte(customerReferralAttributions.rewardEligibleAt, new Date()),
      ),
    )

  for (const attribution of due) {
    if (
      !isQualifyingReferralPurchase({
        status: attribution.orderStatus,
        paymentStatus: attribution.paymentStatus,
        totalAmount: attribution.totalAmount,
        deliveredAt: attribution.deliveredAt,
      })
    ) {
      continue
    }
    const award = await awardCredits({
      farmId,
      accountId: referrerAccountId,
      amount: TROVARA_REFERRAL_CREDITS,
      eventType: 'survey_referral',
      sourceId: `referral:${attribution.id}`,
      description: 'Referral purchase cleared its refund period',
    })
    await db
      .update(customerReferralAttributions)
      .set({ ledgerEntryId: award.id, creditedAt: new Date() })
      .where(
        and(
          eq(customerReferralAttributions.id, attribution.id),
          isNull(customerReferralAttributions.ledgerEntryId),
        ),
      )
  }
}

export async function customerCreditsSnapshot(accountId: string, farmId: string) {
  await matureReferralRewards(farmId, accountId)
  const referral = await ensureCustomerReferralCode({ farmId, accountId })
  const [balanceRow] = await db
    .select({
      balance: sql<number>`coalesce(sum(${customerCreditLedger.amount}), 0)`,
      welcomeCreditAwarded: sql<boolean>`coalesce(bool_or(${customerCreditLedger.eventType} = 'welcome'), false)`,
    })
    .from(customerCreditLedger)
    .where(and(eq(customerCreditLedger.accountId, accountId), eq(customerCreditLedger.farmId, farmId)))
  const [referralCountRow] = await db
    .select({
      count: sql<number>`count(*)`,
      pendingCount: sql<number>`count(*) filter (where ${customerReferralAttributions.ledgerEntryId} is null)`,
      activatedCount: sql<number>`count(*) filter (where ${customerReferralAttributions.ledgerEntryId} is not null)`,
    })
    .from(customerReferralAttributions)
    .where(eq(customerReferralAttributions.referrerAccountId, accountId))
  const transactions = await db
    .select({
      id: customerCreditLedger.id,
      amount: customerCreditLedger.amount,
      eventType: customerCreditLedger.eventType,
      description: customerCreditLedger.description,
      createdAt: customerCreditLedger.createdAt,
    })
    .from(customerCreditLedger)
    .where(and(eq(customerCreditLedger.accountId, accountId), eq(customerCreditLedger.farmId, farmId)))
    .orderBy(desc(customerCreditLedger.createdAt))
    .limit(100)
  const surveyUrl = new URL('/survey', publicMarketingUrlOrDefault())
  surveyUrl.searchParams.set('ref', referral.code)
  return {
    balance: Number(balanceRow?.balance ?? 0),
    referralCode: referral.code,
    referralUrl: surveyUrl.toString(),
    referralCount: Number(referralCountRow?.count ?? 0),
    referralPendingCount: Number(referralCountRow?.pendingCount ?? 0),
    referralActivatedCount: Number(referralCountRow?.activatedCount ?? 0),
    welcomeCredits: TROVARA_WELCOME_CREDITS,
    welcomeCreditAwarded: Boolean(balanceRow?.welcomeCreditAwarded),
    referralCredits: TROVARA_REFERRAL_CREDITS,
    referralRefundWindowDays: referralRefundWindowDays(),
    transactions,
  }
}

export async function processSurveyReferral(params: {
  farmId: string
  surveyResponseId: string
  referralCode: string
  referredEmail: string
}): Promise<{ rewarded: boolean; pending?: boolean; reason?: string }> {
  const email = params.referredEmail.trim().toLowerCase()
  const [referral] = await db
    .select({
      id: customerReferralCodes.id,
      accountId: customerReferralCodes.accountId,
      accountEmail: customerAccounts.email,
    })
    .from(customerReferralCodes)
    .innerJoin(customerAccounts, eq(customerReferralCodes.accountId, customerAccounts.id))
    .where(
      and(
        eq(customerReferralCodes.farmId, params.farmId),
        eq(customerReferralCodes.code, params.referralCode.toUpperCase()),
        eq(customerReferralCodes.active, true),
        eq(customerAccounts.active, true),
      ),
    )
    .limit(1)
  if (!referral) return { rewarded: false, reason: 'invalid_code' }
  if (referral.accountEmail.toLowerCase() === email) return { rewarded: false, reason: 'self_referral' }

  const [referredAccount] = await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(
      and(
        eq(customerAccounts.farmId, params.farmId),
        eq(customerAccounts.email, email),
        eq(customerAccounts.active, true),
      ),
    )
    .limit(1)

  return db.transaction(async (tx) => {
    const [attribution] = await tx
      .insert(customerReferralAttributions)
      .values({
        farmId: params.farmId,
        referralCodeId: referral.id,
        referrerAccountId: referral.accountId,
        surveyResponseId: params.surveyResponseId,
        referredNormalizedContact: `email:${email}`,
        referredAccountId: referredAccount?.id ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: customerReferralAttributions.id })
    if (!attribution) return { rewarded: false, reason: 'already_attributed' }

    return { rewarded: false, pending: true, reason: 'pending_purchase' }
  })
}
