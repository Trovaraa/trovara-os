import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { customerDraftBaskets } from '../db/schema.js'

export type CustomerDraftBasketItem = {
  productId: string
  quantity: number
}

export type CustomerDraftBasket = {
  items: CustomerDraftBasketItem[]
  familyBasketActive: boolean
  updatedAt: Date | null
}

export async function getCustomerDraftBasket(
  accountId: string,
  farmId: string,
): Promise<CustomerDraftBasket> {
  const [row] = await db
    .select({
      items: customerDraftBaskets.items,
      familyBasketActive: customerDraftBaskets.familyBasketActive,
      updatedAt: customerDraftBaskets.updatedAt,
    })
    .from(customerDraftBaskets)
    .where(
      and(
        eq(customerDraftBaskets.accountId, accountId),
        eq(customerDraftBaskets.farmId, farmId),
      ),
    )
    .limit(1)

  return row ?? { items: [], familyBasketActive: false, updatedAt: null }
}

export async function saveCustomerDraftBasket(params: {
  accountId: string
  farmId: string
  items: CustomerDraftBasketItem[]
  familyBasketActive: boolean
}): Promise<CustomerDraftBasket> {
  const now = new Date()
  const [row] = await db
    .insert(customerDraftBaskets)
    .values({ ...params, updatedAt: now })
    .onConflictDoUpdate({
      target: customerDraftBaskets.accountId,
      set: {
        farmId: params.farmId,
        items: params.items,
        familyBasketActive: params.familyBasketActive,
        updatedAt: now,
      },
    })
    .returning({
      items: customerDraftBaskets.items,
      familyBasketActive: customerDraftBaskets.familyBasketActive,
      updatedAt: customerDraftBaskets.updatedAt,
    })

  return row!
}

export async function clearCustomerDraftBasket(accountId: string, farmId: string): Promise<void> {
  await saveCustomerDraftBasket({
    accountId,
    farmId,
    items: [],
    familyBasketActive: false,
  })
}
