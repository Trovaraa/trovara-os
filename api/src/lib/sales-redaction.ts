import type { SessionUser } from './session.js'

const REDACTED = '[redacted]'

/** True when customer PII must be stripped from sales API responses. */
export function shouldRedactSalesPii(user: SessionUser): boolean {
  return user.role === 'field_worker'
}

export function redactCustomerName(name: string | null | undefined): string {
  return REDACTED
}

export function redactOrderForRole<T extends {
  customerName?: string | null
  customerPhone?: string | null
  notes?: string | null
  customerContactId?: string | null
}>(
  order: T,
  user: SessionUser,
): T {
  if (!shouldRedactSalesPii(user)) return order
  return {
    ...order,
    customerName: REDACTED,
    customerPhone: null,
    notes: null,
    customerContactId: null,
  }
}

export function redactContactForRole<T extends {
  name?: string | null
  phone?: string | null
  externalId?: string | null
  channel?: string | null
}>(
  contact: T,
  user: SessionUser,
): T {
  if (!shouldRedactSalesPii(user)) return contact
  return {
    ...contact,
    name: null,
    phone: null,
    externalId: contact.channel ? '[redacted]' : null,
  }
}
