import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  customerAccountLinkCodes,
  customerAccountSessions,
  customerAccounts,
  customerContacts,
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
  const bytes = randomBytes(8)
  let code = ''
  for (let i = 0; i < 8; i++) code += LINK_ALPHABET[bytes[i]! % LINK_ALPHABET.length]
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
