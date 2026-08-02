import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import { db } from '../db/index.js'
import {
  customerAccounts,
  customerContacts,
  farms,
  harvestLots,
  orderItems,
  orders,
  products,
} from '../db/schema.js'
import {
  CUSTOMER_SESSION_COOKIE,
  createCustomerLinkCode,
  createCustomerSession,
  customerSessionCookieOptions,
  deleteCustomerSession,
  getCustomerFromSession,
} from '../lib/customer-accounts.js'
import {
  createOrderFromCart,
  resolveCustomerFarm,
  upsertCustomerContact,
} from '../lib/customer-orders.js'
import { orderReference } from '../lib/customer-cart.js'
import { generateCsrfToken, setCsrfCookie } from '../lib/csrf.js'
import { getDummyPasswordHash, hashPassword, verifyPassword } from '../lib/session.js'

export const customerShopRoutes = new Hono()

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
})

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(7).max(30).optional(),
})

const orderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1)
    .max(20),
  address: z.string().trim().min(5).max(500),
  phone: z.string().trim().min(7).max(30).optional(),
})

function secureCookies(): boolean {
  return process.env.NODE_ENV === 'production'
}

async function currentCustomer(c: any) {
  return getCustomerFromSession(getCookie(c, CUSTOMER_SESSION_COOKIE))
}

function setCustomerSession(c: any, token: string) {
  setCookie(c, CUSTOMER_SESSION_COOKIE, token, customerSessionCookieOptions(secureCookies()))
}

function publicAppUrl(): string {
  return (process.env.PUBLIC_APP_URL ?? 'https://os.trovara.farm').replace(/\/+$/, '')
}

customerShopRoutes.get('/session', async (c) => {
  const csrfToken = generateCsrfToken()
  setCsrfCookie(c, csrfToken)
  const account = await currentCustomer(c)
  return c.json({ csrfToken, account })
})

customerShopRoutes.get('/catalog', async (c) => {
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'The shop is not available yet.' }, 503)
  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      priceKobo: products.priceKobo,
      currency: products.currency,
    })
    .from(products)
    .where(and(eq(products.farmId, farm.id), eq(products.active, true)))
    .orderBy(asc(products.sortOrder), asc(products.name))
  return c.json({ farm, products: rows })
})

customerShopRoutes.post('/register', zValidator('json', registerSchema), async (c) => {
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'The shop is not available yet.' }, 503)
  const body = c.req.valid('json')
  const email = body.email.toLowerCase()
  const [existing] = await db
    .select({ id: customerAccounts.id })
    .from(customerAccounts)
    .where(and(eq(customerAccounts.farmId, farm.id), eq(customerAccounts.email, email)))
    .limit(1)
  if (existing) return c.json({ error: 'An account already exists for this email.' }, 409)

  const [account] = await db
    .insert(customerAccounts)
    .values({
      farmId: farm.id,
      email,
      name: body.name,
      phone: body.phone || null,
      passwordHash: await hashPassword(body.password),
    })
    .returning({
      id: customerAccounts.id,
      farmId: customerAccounts.farmId,
      email: customerAccounts.email,
      name: customerAccounts.name,
      phone: customerAccounts.phone,
    })
  const token = await createCustomerSession(account.id)
  setCustomerSession(c, token)
  const csrfToken = generateCsrfToken()
  setCsrfCookie(c, csrfToken)
  return c.json({ account, csrfToken }, 201)
})

customerShopRoutes.post('/login', zValidator('json', credentialsSchema), async (c) => {
  const farm = await resolveCustomerFarm()
  if (!farm) return c.json({ error: 'The shop is not available yet.' }, 503)
  const body = c.req.valid('json')
  const [account] = await db
    .select()
    .from(customerAccounts)
    .where(
      and(
        eq(customerAccounts.farmId, farm.id),
        eq(customerAccounts.email, body.email.toLowerCase()),
      ),
    )
    .limit(1)
  const valid = account
    ? await verifyPassword(account.passwordHash, body.password)
    : await verifyPassword(await getDummyPasswordHash(), body.password)
  if (!account || !account.active || !valid) {
    return c.json({ error: 'Email or password is incorrect.' }, 401)
  }
  const token = await createCustomerSession(account.id)
  setCustomerSession(c, token)
  const csrfToken = generateCsrfToken()
  setCsrfCookie(c, csrfToken)
  return c.json({
    account: {
      id: account.id,
      farmId: account.farmId,
      email: account.email,
      name: account.name,
      phone: account.phone,
    },
    csrfToken,
  })
})

customerShopRoutes.post('/logout', async (c) => {
  await deleteCustomerSession(getCookie(c, CUSTOMER_SESSION_COOKIE))
  deleteCookie(c, CUSTOMER_SESSION_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

customerShopRoutes.get('/me', async (c) => {
  const account = await currentCustomer(c)
  if (!account) return c.json({ error: 'Sign in required.' }, 401)
  const channels = await db
    .select({ channel: customerContacts.channel, name: customerContacts.name })
    .from(customerContacts)
    .where(eq(customerContacts.customerAccountId, account.id))
  return c.json({ account, channels: channels.filter((row) => row.channel !== 'web') })
})

customerShopRoutes.post('/link-code', async (c) => {
  const account = await currentCustomer(c)
  if (!account) return c.json({ error: 'Sign in required.' }, 401)
  const link = await createCustomerLinkCode(account.id)
  return c.json({
    ...link,
    instruction: `Send "link ${link.code}" to the Trovara bot on WhatsApp or Telegram.`,
  })
})

customerShopRoutes.get('/orders', async (c) => {
  const account = await currentCustomer(c)
  if (!account) return c.json({ error: 'Sign in required.' }, 401)
  const contacts = await db
    .select({ id: customerContacts.id })
    .from(customerContacts)
    .where(eq(customerContacts.customerAccountId, account.id))
  const contactIds = contacts.map((row) => row.id)
  if (!contactIds.length) return c.json({ orders: [] })

  const rows = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      totalAmount: orders.totalAmount,
      currency: orders.currency,
      source: orders.source,
      createdAt: orders.createdAt,
      publicToken: harvestLots.publicToken,
      lotCode: harvestLots.lotCode,
      farmSlug: farms.slug,
    })
    .from(orders)
    .innerJoin(farms, eq(orders.farmId, farms.id))
    .leftJoin(harvestLots, eq(harvestLots.orderId, orders.id))
    .where(and(eq(orders.farmId, account.farmId), inArray(orders.customerContactId, contactIds)))
    .orderBy(desc(orders.createdAt))

  const ids = rows.map((row) => row.id)
  const items = ids.length
    ? await db
        .select({
          orderId: orderItems.orderId,
          productName: orderItems.productName,
          quantity: orderItems.quantity,
          unit: orderItems.unit,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, ids))
    : []

  return c.json({
    orders: rows.map((row) => ({
      ...row,
      reference: orderReference(row.id),
      items: items.filter((item) => item.orderId === row.id),
      traceabilityUrl:
        row.publicToken && row.farmSlug
          ? `${publicAppUrl()}/lot/${row.farmSlug}/${row.publicToken}`
          : null,
    })),
  })
})

customerShopRoutes.post('/orders', zValidator('json', orderSchema), async (c) => {
  const account = await currentCustomer(c)
  if (!account) return c.json({ error: 'Sign in required.' }, 401)
  const body = c.req.valid('json')
  const ids = [...new Set(body.items.map((item) => item.productId))]
  const catalog = await db
    .select({
      id: products.id,
      name: products.name,
      unit: products.unit,
      priceKobo: products.priceKobo,
      currency: products.currency,
    })
    .from(products)
    .where(
      and(
        eq(products.farmId, account.farmId),
        eq(products.active, true),
        inArray(products.id, ids),
      ),
    )
  if (catalog.length !== ids.length) return c.json({ error: 'One or more products are unavailable.' }, 400)

  const contact = await upsertCustomerContact(
    account.farmId,
    'web',
    account.id,
    account.name,
    body.phone || account.phone,
  )
  await db
    .update(customerContacts)
    .set({ customerAccountId: account.id, updatedAt: new Date() })
    .where(eq(customerContacts.id, contact.id))

  const result = await createOrderFromCart({
    farmId: account.farmId,
    channel: 'web',
    contactId: contact.id,
    contactName: account.name,
    cart: body.items.map((item) => ({ productId: item.productId, qty: item.quantity })),
    draft: {
      name: account.name,
      phone: body.phone || account.phone || undefined,
      address: body.address,
    },
    catalog,
  })
  if ('error' in result) return c.json({ error: result.error }, 400)

  return c.json(result, 201)
})
