import { and, eq } from 'drizzle-orm'
import { customerContacts, users } from '../db/schema.js'

/** Normalize phone to digits-only for comparison (keeps leading country code). */
export function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

function phonesMatch(a: string, b: string): boolean {
  const na = normalizePhone(a)
  const nb = normalizePhone(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // Match local suffix when one side omits country code (e.g. 080… vs 23480…).
  const minLen = 10
  if (na.length >= minLen && nb.length >= minLen) {
    return na.endsWith(nb.slice(-minLen)) || nb.endsWith(na.slice(-minLen))
  }
  return false
}

/** True when `to` matches an active staff phone or customer contact on the farm. */
export async function isAllowedWhatsAppRecipient(farmId: string, to: string): Promise<boolean> {
  const { db } = await import('../db/index.js')
  const target = normalizePhone(to)
  if (target.length < 8) return false

  const [staffRows, contactRows] = await Promise.all([
    db
      .select({ phone: users.phone })
      .from(users)
      .where(and(eq(users.farmId, farmId), eq(users.active, true))),
    db
      .select({ phone: customerContacts.phone })
      .from(customerContacts)
      .where(eq(customerContacts.farmId, farmId)),
  ])

  for (const row of staffRows) {
    if (row.phone && phonesMatch(row.phone, to)) return true
  }
  for (const row of contactRows) {
    if (row.phone && phonesMatch(row.phone, to)) return true
  }
  return false
}
