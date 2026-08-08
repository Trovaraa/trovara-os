import { createHash, randomBytes, randomInt } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  customerAccountLinkCodes,
  customerAccountSessions,
  customerAccounts,
  customerContacts,
  customerPasswordResetTokens,
  customerEmailVerificationTokens,
} from '../db/schema.js'

const CUSTOMER_SESSION_DAYS = 30
const LINK_CODE_MINUTES = 15
const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export const CUSTOMER_SESSION_COOKIE = 'trovara_customer_session'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function customerSessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'Strict' as const,
    path: '/',
    maxAge: CUSTOMER_SESSION_DAYS * 24 * 60 * 60,
  }
}

export async function createCustomerSession(accountId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  await db.insert(customerAccountSessions).values({
    accountId,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + CUSTOMER_SESSION_DAYS * 24 * 60 * 60 * 1000),
  })
  return token
}

export async function deleteCustomerSession(token?: string): Promise<void> {
  if (!token) return
  await db
    .delete(customerAccountSessions)
    .where(eq(customerAccountSessions.tokenHash, sha256(token)))
}

export async function getCustomerFromSession(token?: string) {
  if (!token) return null
  const [row] = await db
    .select({
      id: customerAccounts.id,
      farmId: customerAccounts.farmId,
      email: customerAccounts.email,
      name: customerAccounts.name,
      phone: customerAccounts.phone,
      active: customerAccounts.active,
    })
    .from(customerAccountSessions)
    .innerJoin(customerAccounts, eq(customerAccountSessions.accountId, customerAccounts.id))
    .where(
      and(
        eq(customerAccountSessions.tokenHash, sha256(token)),
        gt(customerAccountSessions.expiresAt, new Date()),
      ),
    )
    .limit(1)
  return row?.active ? row : null
}

function generateLinkCode(): string {
  let code = ''
  for (let i = 0; i < 8; i++) code += LINK_ALPHABET[randomInt(LINK_ALPHABET.length)]!
  return `TRV-${code}`
}

export async function createCustomerLinkCode(accountId: string): Promise<{
  code: string
  expiresAt: Date
}> {
  await db
    .delete(customerAccountLinkCodes)
    .where(eq(customerAccountLinkCodes.accountId, accountId))
  const code = generateLinkCode()
  const expiresAt = new Date(Date.now() + LINK_CODE_MINUTES * 60 * 1000)
  await db.insert(customerAccountLinkCodes).values({
    accountId,
    codeHash: sha256(code.toUpperCase()),
    expiresAt,
  })
  return { code, expiresAt }
}

export async function linkCustomerContactWithCode(params: {
  farmId: string
  contactId: string
  code: string
}): Promise<{ ok: true; accountName: string } | { ok: false; error: string }> {
  const [match] = await db
    .select({
      id: customerAccountLinkCodes.id,
      accountId: customerAccountLinkCodes.accountId,
      accountName: customerAccounts.name,
      accountFarmId: customerAccounts.farmId,
    })
    .from(customerAccountLinkCodes)
    .innerJoin(customerAccounts, eq(customerAccountLinkCodes.accountId, customerAccounts.id))
    .where(
      and(
        eq(customerAccountLinkCodes.codeHash, sha256(params.code.toUpperCase())),
        gt(customerAccountLinkCodes.expiresAt, new Date()),
        isNull(customerAccountLinkCodes.usedAt),
      ),
    )
    .limit(1)

  if (!match || match.accountFarmId !== params.farmId) {
    return { ok: false, error: 'That link code is invalid or has expired. Create a new one in your Trovara shop account.' }
  }

  const [contact] = await db
    .select({ id: customerContacts.id })
    .from(customerContacts)
    .where(and(eq(customerContacts.id, params.contactId), eq(customerContacts.farmId, params.farmId)))
    .limit(1)
  if (!contact) return { ok: false, error: 'We could not link this chat. Please try again.' }

  await db.transaction(async (tx) => {
    await tx
      .update(customerContacts)
      .set({ customerAccountId: match.accountId, updatedAt: new Date() })
      .where(eq(customerContacts.id, params.contactId))
    await tx
      .update(customerAccountLinkCodes)
      .set({ usedAt: new Date() })
      .where(eq(customerAccountLinkCodes.id, match.id))
  })

  return { ok: true, accountName: match.accountName }
}

export async function revokeAllCustomerSessions(accountId: string): Promise<number> {
  const deleted = await db
    .delete(customerAccountSessions)
    .where(eq(customerAccountSessions.accountId, accountId))
  return deleted.length ?? 0
}

function hashCustomerToken(token: string): string {
  return sha256(token)
}

export async function createCustomerPasswordResetToken(accountId: string): Promise<{
  rawToken: string
  expiresAt: Date
}> {
  const now = new Date()
  await db
    .update(customerPasswordResetTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(customerPasswordResetTokens.accountId, accountId),
        isNull(customerPasswordResetTokens.usedAt),
        gt(customerPasswordResetTokens.expiresAt, now),
      ),
    )

  const rawToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000)
  await db.insert(customerPasswordResetTokens).values({
    accountId,
    tokenHash: hashCustomerToken(rawToken),
    expiresAt,
  })

  return { rawToken, expiresAt }
}

export async function consumeCustomerPasswordResetToken(token: string): Promise<{
  accountId: string
  farmId: string
} | null> {
  const now = new Date()
  const [tokenRow] = await db
    .select({
      id: customerPasswordResetTokens.id,
      accountId: customerPasswordResetTokens.accountId,
      farmId: customerAccounts.farmId,
    })
    .from(customerPasswordResetTokens)
    .innerJoin(customerAccounts, eq(customerPasswordResetTokens.accountId, customerAccounts.id))
    .where(
      and(
        eq(customerPasswordResetTokens.tokenHash, hashCustomerToken(token)),
        gt(customerPasswordResetTokens.expiresAt, now),
        isNull(customerPasswordResetTokens.usedAt),
      ),
    )
    .limit(1)

  if (!tokenRow) return null

  await db
    .update(customerPasswordResetTokens)
    .set({ usedAt: now })
    .where(eq(customerPasswordResetTokens.id, tokenRow.id))

  return { accountId: tokenRow.accountId, farmId: tokenRow.farmId }
}

export async function createCustomerEmailVerificationToken(accountId: string): Promise<{
  rawToken: string
  expiresAt: Date
}> {
  const now = new Date()
  await db
    .update(customerEmailVerificationTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(customerEmailVerificationTokens.accountId, accountId),
        isNull(customerEmailVerificationTokens.usedAt),
        gt(customerEmailVerificationTokens.expiresAt, now),
      ),
    )

  const rawToken = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000)
  await db.insert(customerEmailVerificationTokens).values({
    accountId,
    tokenHash: hashCustomerToken(rawToken),
    expiresAt,
  })

  return { rawToken, expiresAt }
}

export async function consumeCustomerEmailVerificationToken(token: string): Promise<{
  accountId: string
  farmId: string
  email: string
} | null> {
  const now = new Date()
  const [tokenRow] = await db
    .select({
      id: customerEmailVerificationTokens.id,
      accountId: customerEmailVerificationTokens.accountId,
      farmId: customerAccounts.farmId,
      email: customerAccounts.email,
    })
    .from(customerEmailVerificationTokens)
    .innerJoin(customerAccounts, eq(customerEmailVerificationTokens.accountId, customerAccounts.id))
    .where(
      and(
        eq(customerEmailVerificationTokens.tokenHash, hashCustomerToken(token)),
        gt(customerEmailVerificationTokens.expiresAt, now),
        isNull(customerEmailVerificationTokens.usedAt),
      ),
    )
    .limit(1)

  if (!tokenRow) return null

  await db.transaction(async (tx) => {
    await tx
      .update(customerEmailVerificationTokens)
      .set({ usedAt: now })
      .where(eq(customerEmailVerificationTokens.id, tokenRow.id))
    await tx
      .update(customerAccounts)
      .set({ emailVerifiedAt: now })
      .where(eq(customerAccounts.id, tokenRow.accountId))
  })

  return { accountId: tokenRow.accountId, farmId: tokenRow.farmId, email: tokenRow.email }
}
