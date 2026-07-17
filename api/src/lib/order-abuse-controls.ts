import { and, eq, gte, sql } from 'drizzle-orm'
import { orders } from '../db/schema.js'
import { cartTotalKobo, type CartLine, type CatalogItem } from './customer-cart.js'

export const MAX_CART_LINES = 20
export const MAX_QTY_PER_LINE = 100
/** Max order value in kobo (default ₦500,000). */
export const MAX_ORDER_VALUE_KOBO = Number.parseInt(
  process.env.MAX_CUSTOMER_ORDER_VALUE_KOBO?.trim() || '50000000',
  10,
)
export const MAX_ORDERS_PER_CONTACT_PER_DAY = Number.parseInt(
  process.env.MAX_CUSTOMER_ORDERS_PER_DAY?.trim() || '5',
  10,
)

export type OrderAbuseCheck =
  | { ok: true }
  | { ok: false; code: string; message: string; flagged?: boolean }

export function validateCartLines(cart: CartLine[]): OrderAbuseCheck {
  if (cart.length > MAX_CART_LINES) {
    return {
      ok: false,
      code: 'CART_TOO_MANY_LINES',
      message: `Cart cannot exceed ${MAX_CART_LINES} items. Please split into separate orders.`,
      flagged: true,
    }
  }
  for (const line of cart) {
    if (line.qty > MAX_QTY_PER_LINE) {
      return {
        ok: false,
        code: 'QTY_TOO_HIGH',
        message: `Maximum quantity per item is ${MAX_QTY_PER_LINE}. Contact the farm for bulk orders.`,
        flagged: true,
      }
    }
  }
  return { ok: true }
}

export function validateOrderValue(cart: CartLine[], catalog: CatalogItem[]): OrderAbuseCheck {
  const total = cartTotalKobo(cart, catalog)
  if (total > MAX_ORDER_VALUE_KOBO) {
    return {
      ok: false,
      code: 'ORDER_VALUE_TOO_HIGH',
      message: 'This order exceeds our online limit. Please contact the farm directly for large orders.',
      flagged: true,
    }
  }
  return { ok: true }
}

/** Heuristic flags for suspiciously large carts even within hard caps. */
export function flagAbsurdOrder(cart: CartLine[], catalog: CatalogItem[]): boolean {
  const total = cartTotalKobo(cart, catalog)
  const lineCount = cart.length
  const maxQty = cart.reduce((m, l) => Math.max(m, l.qty), 0)
  return lineCount >= 15 || maxQty >= 80 || total >= MAX_ORDER_VALUE_KOBO * 0.8
}

export async function checkDailyOrderVelocity(
  farmId: string,
  contactId: string,
): Promise<OrderAbuseCheck> {
  const { db } = await import('../db/index.js')
  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)

  const [{ count } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(
      and(
        eq(orders.farmId, farmId),
        eq(orders.customerContactId, contactId),
        gte(orders.createdAt, startOfDay),
      ),
    )

  if (count >= MAX_ORDERS_PER_CONTACT_PER_DAY) {
    return {
      ok: false,
      code: 'DAILY_ORDER_LIMIT',
      message: `You have reached the daily order limit (${MAX_ORDERS_PER_CONTACT_PER_DAY}). Try again tomorrow or contact the farm.`,
      flagged: true,
    }
  }
  return { ok: true }
}

export async function validateCustomerOrder(params: {
  farmId: string
  contactId: string
  cart: CartLine[]
  catalog: CatalogItem[]
}): Promise<OrderAbuseCheck & { flagged?: boolean }> {
  for (const check of [
    validateCartLines(params.cart),
    validateOrderValue(params.cart, params.catalog),
  ]) {
    if (!check.ok) return check
  }

  const velocity = await checkDailyOrderVelocity(params.farmId, params.contactId)
  if (!velocity.ok) return velocity

  return { ok: true, flagged: flagAbsurdOrder(params.cart, params.catalog) }
}
