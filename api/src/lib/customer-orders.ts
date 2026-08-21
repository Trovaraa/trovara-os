import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  customerChatSessions,
  customerAccounts,
  customerContacts,
  farms,
  harvestLots,
  orderItems,
  orders,
  products,
} from '../db/schema.js'
import { recordFarmEvent } from './farm-events.js'
import { logAudit } from './audit.js'
import { notifyStaffNewOrder } from './order-fulfillment.js'
import {
  answerCustomerInquiry,
  isCustomerProgrammeQuestion,
  logInquiry,
  suggestedQuestions,
} from './customer-inquiry.js'
import { customerCreditsSnapshot } from './customer-credits.js'
import { publicLotPageUrl, shopAccountUrl } from './public-app-url.js'
import {
  addToCart,
  firstMissingDetailStep,
  formatCart,
  formatCatalog,
  formatNaira,
  formatOrderConfirmPrompt,
  formatSavedDetailsPrompt,
  hasCompleteDeliveryDetails,
  isChangeDetailsIntent,
  orderReference,
  orderStatusLabel,
  paymentStatusLabel,
  parseChoice,
  parseDeliveryAddress,
  type CartLine,
  type CatalogItem,
  type OrderDraft,
  type OrderStep,
} from './customer-cart.js'
import {
  MAX_CART_LINES,
  MAX_QTY_PER_LINE,
  validateCartLines,
  validateOrderValue,
} from './order-abuse-controls.js'
import { validateCustomerOrder } from './order-abuse-controls.js'
import { logSecurityEvent } from './security-log.js'
import { createHarvestLotForOrder } from './harvest-lots.js'
import { createSupportTicket } from './support-tickets.js'
import {
  createPaymentAttemptForOrder,
  requestCustomerCancel,
} from './order-payments.js'
import { isPaystackConfigured } from './paystack.js'
import { linkCustomerContactWithCode } from './customer-accounts.js'
import { sendEmail } from './notifications.js'
import { customerOrderEmailContent } from './email-template.js'

export {
  resolveCustomerFarm,
  upsertCustomerContact,
  advanceOrderConversation,
  customerConversationIsActive,
  createOrderFromCart,
}

type Channel = 'telegram' | 'whatsapp'
type CustomerContactChannel = Channel | 'web'

type ContactRow = typeof customerContacts.$inferSelect

const RESET_WORDS = ['cancel', 'stop', 'reset']
const MENU_WORDS = ['hi', 'hello', 'help', 'menu', 'start', '/start', '']
const YES_WORDS = ['yes', 'y', 'confirm', 'ok', 'okay']

const ASK_WORDS = ['3', 'ask', 'question', 'questions', 'faq', 'info', 'enquiry', 'inquiry']

/**
 * Does this message look like a request to see/track EXISTING orders?
 * Must be checked before ordering intent, because phrases like "status of my
 * order" or "track my order" contain the word "order".
 */
function isTrackingIntent(text: string, lower: string): boolean {
  return (
    lower === '2' ||
    /\btrack\b/.test(lower) ||
    /\bstatus\b/.test(lower) ||
    /\bbacklog\b/.test(lower) ||
    /\bmy\s+orders?\b/.test(lower) ||
    /\border\s*(no\.?|number|status|ref(?:erence)?|id)\b/.test(lower) ||
    /\btrv-ord-[a-z0-9]+/i.test(text)
  )
}

/**
 * Does this message EXPLICITLY ask to start placing a new order? The bare word
 * "order" inside a question (e.g. "any order in backlog?") must NOT trigger this,
 * so we require the "1" shortcut, a buy/checkout verb, or an ordering verb sitting
 * next to the word "order".
 */
function isOrderingIntent(lower: string): boolean {
  if (lower === '1') return true
  if (/\b(buy|purchase|checkout)\b/.test(lower)) return true
  if (/^order( now| food| please)?$/.test(lower)) return true
  return /\b(place|make|start|create|begin|new|want|need|like|take|give)\b[^?]*\border\b/.test(
    lower,
  )
}

function mainMenu(farmName: string): string {
  return [
    `Welcome to ${farmName} 🌱`,
    '',
    'Reply with a number:',
    '1 - Place an order',
    '2 - Track my order',
    '3 - Ask about products, the shop & Trovara Credits',
    '4 - Report a problem',
    '',
    'Or just type your question. Type "cancel" any time to start over.',
  ].join('\n')
}

/** Build the "ask a question" prompt with popular/suggested questions. */
async function askPrompt(farmId: string): Promise<{ text: string; suggestions: string[] }> {
  const suggestions = await suggestedQuestions(farmId, 4)
  const lines = ['Ask about our products, shop, baskets, survey or Trovara Credits 🌱', '']
  if (suggestions.length) {
    lines.push('People often ask:')
    suggestions.forEach((q, i) => lines.push(`${i + 1} - ${q}`))
    lines.push('')
    lines.push('Reply with a number, or type your own question.')
  } else {
    lines.push('Type your question below.')
  }
  return { text: lines.join('\n'), suggestions }
}

async function rewardsForLinkedContact(farmId: string, contactId: string) {
  try {
    const [contact] = await db
      .select({ accountId: customerContacts.customerAccountId })
      .from(customerContacts)
      .where(and(eq(customerContacts.id, contactId), eq(customerContacts.farmId, farmId)))
      .limit(1)
    if (!contact?.accountId) return null
    return customerCreditsSnapshot(contact.accountId, farmId)
  } catch (err) {
    // An account lookup must never prevent public product/help answers.
    console.error(
      'Customer rewards lookup failed:',
      err instanceof Error ? err.message : err,
    )
    return null
  }
}

/** Which farm the customer bot sells for (single-farm pilot; slug-pinned). */
async function resolveCustomerFarm(): Promise<{
  id: string
  name: string
  location: string
} | null> {
  const configuredId = process.env.CUSTOMER_FARM_ID?.trim()
  if (configuredId) {
    const [f] = await db.select().from(farms).where(eq(farms.id, configuredId)).limit(1)
    if (f) return { id: f.id, name: f.name, location: f.location }
  }
  const slug = process.env.TELEGRAM_CUSTOMER_FARM_SLUG?.trim()
  if (slug) {
    const [f] = await db.select().from(farms).where(eq(farms.slug, slug)).limit(1)
    if (f) return { id: f.id, name: f.name, location: f.location }
  }
  const [first] = await db.select().from(farms).orderBy(asc(farms.createdAt)).limit(1)
  return first ? { id: first.id, name: first.name, location: first.location } : null
}

async function loadCatalog(farmId: string): Promise<CatalogItem[]> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.farmId, farmId), eq(products.active, true)))
    .orderBy(asc(products.sortOrder), asc(products.name))
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    unit: p.unit,
    priceKobo: p.priceKobo,
    currency: p.currency,
    provenance: p.provenance as 'trovara_grown' | 'trovara_sourced',
  }))
}

async function upsertCustomerContact(
  farmId: string,
  channel: CustomerContactChannel,
  externalId: string,
  name?: string | null,
  phone?: string | null,
  customerAccountId?: string | null,
): Promise<ContactRow> {
  const [existing] = await db
    .select()
    .from(customerContacts)
    .where(
      and(
        eq(customerContacts.farmId, farmId),
        eq(customerContacts.channel, channel),
        eq(customerContacts.externalId, externalId),
      ),
    )
    .limit(1)

  if (existing) {
    const updates: Partial<typeof customerContacts.$inferInsert> = { updatedAt: new Date() }
    if (name) updates.name = name
    if (phone) updates.phone = phone
    if (customerAccountId) updates.customerAccountId = customerAccountId
    const [row] = await db
      .update(customerContacts)
      .set(updates)
      .where(eq(customerContacts.id, existing.id))
      .returning()
    return row
  }

  const [row] = await db
    .insert(customerContacts)
    .values({
      farmId,
      channel,
      externalId,
      name: name ?? null,
      phone: phone ?? null,
      customerAccountId: customerAccountId ?? null,
    })
    .returning()
  return row
}

type SessionState = { step: OrderStep; cart: CartLine[]; draft: OrderDraft }

async function loadSession(
  farmId: string,
  channel: Channel,
  externalId: string,
): Promise<SessionState> {
  const [row] = await db
    .select()
    .from(customerChatSessions)
    .where(
      and(
        eq(customerChatSessions.farmId, farmId),
        eq(customerChatSessions.channel, channel),
        eq(customerChatSessions.externalId, externalId),
      ),
    )
    .limit(1)

  return {
    step: (row?.step as OrderStep) ?? 'idle',
    cart: (row?.cart as CartLine[] | null) ?? [],
    draft: (row?.draft as OrderDraft | null) ?? {},
  }
}

async function customerConversationIsActive(
  farmId: string,
  channel: Channel,
  externalId: string,
): Promise<boolean> {
  const state = await loadSession(farmId, channel, externalId)
  return state.step !== 'idle'
}

async function saveSession(
  farmId: string,
  channel: Channel,
  externalId: string,
  state: SessionState,
): Promise<void> {
  const [existing] = await db
    .select({ id: customerChatSessions.id })
    .from(customerChatSessions)
    .where(
      and(
        eq(customerChatSessions.farmId, farmId),
        eq(customerChatSessions.channel, channel),
        eq(customerChatSessions.externalId, externalId),
      ),
    )
    .limit(1)

  if (existing) {
    await db
      .update(customerChatSessions)
      .set({
        step: state.step,
        cart: state.cart,
        draft: state.draft,
        updatedAt: new Date(),
      })
      .where(eq(customerChatSessions.id, existing.id))
    return
  }

  await db.insert(customerChatSessions).values({
    farmId,
    channel,
    externalId,
    step: state.step,
    cart: state.cart,
    draft: state.draft,
    updatedAt: new Date(),
  })
}

async function loadSavedDeliveryDetails(contactId: string): Promise<OrderDraft> {
  const [contact] = await db
    .select()
    .from(customerContacts)
    .where(eq(customerContacts.id, contactId))
    .limit(1)

  const [lastOrder] = await db
    .select({
      customerName: orders.customerName,
      customerPhone: orders.customerPhone,
      notes: orders.notes,
    })
    .from(orders)
    .where(eq(orders.customerContactId, contactId))
    .orderBy(desc(orders.createdAt))
    .limit(1)

  return {
    name: contact?.name?.trim() || lastOrder?.customerName?.trim() || undefined,
    phone: contact?.phone?.trim() || lastOrder?.customerPhone?.trim() || undefined,
    address: parseDeliveryAddress(lastOrder?.notes) ?? undefined,
  }
}

async function beginCheckout(params: {
  farmId: string
  channel: Channel
  externalId: string
  contactId: string
  state: SessionState
  catalog: CatalogItem[]
}): Promise<string> {
  const { farmId, channel, externalId, contactId, state, catalog } = params
  const cartSummary = formatCart(state.cart, catalog)
  const saved = await loadSavedDeliveryDetails(contactId)
  const draft: OrderDraft = {
    ...state.draft,
    name: saved.name,
    phone: saved.phone,
    address: saved.address,
    pendingProductId: undefined,
    suggestions: undefined,
  }

  if (hasCompleteDeliveryDetails(draft)) {
    await saveSession(farmId, channel, externalId, { ...state, step: 'confirm_details', draft })
    return formatSavedDetailsPrompt(draft, cartSummary)
  }

  const nextStep = firstMissingDetailStep(draft)
  await saveSession(farmId, channel, externalId, { ...state, step: nextStep, draft })
  if (nextStep === 'need_name') {
    return `Great.\n\n${cartSummary}\n\nWhat name should we put on the order?`
  }
  if (nextStep === 'need_phone') {
    return `Great.\n\n${cartSummary}\n\nThanks ${draft.name}. What phone number should we call for delivery?`
  }
  return `Great.\n\n${cartSummary}\n\nAnd what’s the delivery address?`
}

async function createOrderFromCart(params: {
  farmId: string
  channel: CustomerContactChannel
  contactId: string
  contactName?: string | null
  cart: CartLine[]
  draft: OrderDraft
  catalog: CatalogItem[]
}): Promise<
  | {
      reference: string
      orderId: string
      payment?: { authorizationUrl: string; amountKobo: number }
    }
  | { error: string }
> {
  const abuse = await validateCustomerOrder({
    farmId: params.farmId,
    contactId: params.contactId,
    cart: params.cart,
    catalog: params.catalog,
  })
  if (!abuse.ok) {
    if (abuse.flagged) {
      logSecurityEvent('customer_order_abuse', {
        farmId: params.farmId,
        contactId: params.contactId,
        code: abuse.code,
        channel: params.channel,
      })
    }
    return { error: abuse.message }
  }

  const items = params.cart.map((line) => {
    const item = params.catalog.find((p) => p.id === line.productId)
    const unitPriceKobo = item?.priceKobo ?? 0
    return {
      productId: item?.id,
      productName: item?.name ?? 'Item',
      unit: item?.unit ?? 'unit',
      unitPriceKobo,
      quantity: line.qty,
      lineTotalKobo: unitPriceKobo * line.qty,
    }
  })
  const totalKobo = items.reduce((sum, i) => sum + i.lineTotalKobo, 0)
  const address = params.draft.address?.trim()
  const customerName = params.draft.name?.trim() || params.contactName || 'Customer'

  const [order] = await db
    .insert(orders)
    .values({
      farmId: params.farmId,
      customerName,
      customerPhone: params.draft.phone?.trim() || null,
      status: 'pending',
      totalAmount: Math.round(totalKobo / 100),
      currency: 'NGN',
      customerContactId: params.contactId,
      source: params.channel,
      notes: address ? `Delivery: ${address}` : null,
    })
    .returning()

  if (items.length) {
    await db.insert(orderItems).values(items.map((i) => ({ ...i, orderId: order.id })))
  }

  // Persist name/phone on the contact for the next checkout.
  await db
    .update(customerContacts)
    .set({
      name: customerName,
      phone: params.draft.phone?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(customerContacts.id, params.contactId))

  if (abuse.flagged) {
    logSecurityEvent('customer_order_flagged', {
      farmId: params.farmId,
      contactId: params.contactId,
      orderId: order.id,
      itemCount: items.length,
      totalKobo,
    })
  }

  const reference = orderReference(order.id)

  let lotCode: string | undefined
  let lotPublicToken: string | undefined
  try {
    const traceableItems = items.filter((item) => {
      const catalogItem = params.catalog.find((product) => product.id === item.productId)
      return catalogItem?.provenance !== 'trovara_sourced'
    })
    const lot = traceableItems.length ? await createHarvestLotForOrder({
      farmId: params.farmId,
      orderId: order.id,
      lines: traceableItems.map((i) => ({
        productId: i.productId,
        productName: i.productName,
        unit: i.unit,
        quantity: i.quantity,
      })),
    }) : null
    lotCode = lot?.lotCode
    lotPublicToken = lot?.publicToken
  } catch (err) {
    console.error('Auto harvest lot failed:', err instanceof Error ? err.message : err)
  }

  await recordFarmEvent({
    farmId: params.farmId,
    entityType: 'order',
    entityId: order.id,
    eventType: 'other',
    source: params.channel,
    afterValue: {
      text: `New ${params.channel} order ${reference} from ${customerName}`,
      reference,
      status: 'pending',
      lotCode,
    },
    metadata: { source: params.channel, itemCount: items.length, totalKobo, lotCode },
  })

  await logAudit({
    farmId: params.farmId,
    action: 'create',
    entityType: 'order',
    entityId: order.id,
    metadata: {
      channel: params.channel,
      reference,
      contactId: params.contactId,
      itemCount: items.length,
      totalKobo,
      lotCode,
      status: 'pending',
    },
  })

  // Best-effort alert to owner + supervisor + sales (Telegram + WhatsApp).
  try {
    const itemLines = items
      .map((i) => {
        const unitLabel = i.unit ? ` (${i.unit})` : ''
        if (i.unitPriceKobo > 0) {
          return `• ${i.quantity} × ${i.productName}${unitLabel} @ ${formatNaira(i.unitPriceKobo)} = ${formatNaira(i.lineTotalKobo)}`
        }
        return `• ${i.quantity} × ${i.productName}${unitLabel} — price on request`
      })
      .join('\n')
    const hasUnpriced = items.some((i) => i.unitPriceKobo <= 0)
    const totalLine =
      totalKobo > 0
        ? `Total: ${formatNaira(totalKobo)}${hasUnpriced ? ' (+ items priced on request)' : ''}`
        : 'Total: price on request'
    await notifyStaffNewOrder({
      farmId: params.farmId,
      orderId: order.id,
      reference,
      channel: params.channel,
      customerName,
      phone: params.draft.phone?.trim() || 'n/a',
      address: address || 'n/a',
      lotCode,
      itemLines,
      totalLine,
    })
  } catch (err) {
    console.error('Order staff-notify failed:', err instanceof Error ? err.message : err)
  }

  // A linked web account receives the same confirmation regardless of whether
  // checkout happened on the website, WhatsApp, or Telegram.
  try {
    const [recipient] = await db
      .select({
        email: customerAccounts.email,
        name: customerAccounts.name,
        farmSlug: farms.slug,
      })
      .from(customerContacts)
      .innerJoin(customerAccounts, eq(customerContacts.customerAccountId, customerAccounts.id))
      .innerJoin(farms, eq(customerContacts.farmId, farms.id))
      .where(eq(customerContacts.id, params.contactId))
      .limit(1)
    if (recipient) {
      const accountUrl = shopAccountUrl()
      const traceabilityUrl = lotPublicToken
        ? publicLotPageUrl(recipient.farmSlug, lotPublicToken)
        : null
      const mail = customerOrderEmailContent({
        name: recipient.name,
        reference,
        accountUrl,
        traceabilityUrl,
      })
      void sendEmail({
        to: recipient.email,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }).catch((err) =>
        console.error('Customer order email failed:', err instanceof Error ? err.message : err),
      )
    }
  } catch (err) {
    console.error('Customer order email lookup failed:', err instanceof Error ? err.message : err)
  }

  const allPriced = items.length > 0 && items.every((i) => i.unitPriceKobo > 0) && totalKobo > 0
  if (isPaystackConfigured() && allPriced) {
    const pay = await createPaymentAttemptForOrder({
      farmId: params.farmId,
      orderId: order.id,
      phone: params.draft.phone?.trim() || undefined,
    })
    if (!('error' in pay)) {
      return {
        reference,
        orderId: order.id,
        payment: { authorizationUrl: pay.authorizationUrl, amountKobo: totalKobo },
      }
    }
    console.error('Paystack payment link failed:', pay.error)
  }

  return { reference, orderId: order.id }
}

async function trackOrders(farmId: string, contactId: string): Promise<string> {
  const [contact] = await db
    .select({ customerAccountId: customerContacts.customerAccountId })
    .from(customerContacts)
    .where(eq(customerContacts.id, contactId))
    .limit(1)

  const linkedToShop = Boolean(contact?.customerAccountId)
  let contactIds = [contactId]
  if (contact?.customerAccountId) {
    const linked = await db
      .select({ id: customerContacts.id })
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.farmId, farmId),
          eq(customerContacts.customerAccountId, contact.customerAccountId),
        ),
      )
    contactIds = linked.map((row) => row.id)
  }

  const rows = await db
    .select({
      id: orders.id,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
      publicToken: harvestLots.publicToken,
      farmSlug: farms.slug,
    })
    .from(orders)
    .innerJoin(farms, eq(orders.farmId, farms.id))
    .leftJoin(harvestLots, eq(harvestLots.orderId, orders.id))
    .where(and(eq(orders.farmId, farmId), inArray(orders.customerContactId, contactIds)))
    .orderBy(desc(orders.createdAt))
    .limit(5)

  if (!rows.length) {
    if (!linkedToShop) {
      return [
        'No orders on this chat yet.',
        '',
        'If you ordered on the website, link your Trovara shop account first:',
        '1. Open the shop → Connect Chat',
        '2. Create a secure link code',
        '3. Send that code here exactly like: link ABCD1234',
        '',
        'Then reply "2" again. Or reply "1" to place a new order here.',
      ].join('\n')
    }
    return 'You have no orders yet. Reply "1" to place one.'
  }

  const lines = rows.map((o) => {
    const when = new Date(o.createdAt).toLocaleDateString('en-NG')
    const trace =
      o.publicToken && o.farmSlug
        ? `\nTrace this order: ${publicLotPageUrl(o.farmSlug, o.publicToken)}`
        : ''
    return `${orderReference(o.id)} - ${orderStatusLabel(o.status)} · ${paymentStatusLabel(o.paymentStatus)} (${when})${trace}`
  })
  return `Your recent orders:\n\n${lines.join('\n')}`
}

/** Prior-order summary used to recognise a returning customer by their contact. */
async function customerHistory(
  farmId: string,
  contactId: string,
): Promise<{ count: number; last?: { reference: string; status: string; when: string } }> {
  const [last] = await db
    .select({ id: orders.id, status: orders.status, createdAt: orders.createdAt })
    .from(orders)
    .where(and(eq(orders.farmId, farmId), eq(orders.customerContactId, contactId)))
    .orderBy(desc(orders.createdAt))
    .limit(1)

  if (!last) return { count: 0 }

  const [{ count } = { count: 1 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.farmId, farmId), eq(orders.customerContactId, contactId)))

  return {
    count,
    last: {
      reference: orderReference(last.id),
      status: orderStatusLabel(last.status),
      when: new Date(last.createdAt).toLocaleDateString('en-NG'),
    },
  }
}

/** Main menu, personalised with a "welcome back" line for returning customers. */
async function welcomeMessage(params: {
  farmId: string
  farmName: string
  contactId: string
  contactName?: string | null
}): Promise<string> {
  const menu = mainMenu(params.farmName)
  const history = await customerHistory(params.farmId, params.contactId)
  if (!history.count || !history.last) return menu

  const name = params.contactName?.trim()
  const greeting = name ? `Welcome back, ${name}! 🌱` : 'Welcome back! 🌱'
  const orderWord = history.count === 1 ? 'order' : 'orders'
  return [
    greeting,
    `You've placed ${history.count} ${orderWord} with us. Latest: ${history.last.reference} — ${history.last.status} (${history.last.when}).`,
    'Reply "2" any time to track it.',
    '',
    menu,
  ].join('\n')
}

/**
 * Advance a customer's deterministic order conversation by one message and
 * return the reply to send. Channel-agnostic: the Telegram/WhatsApp inbound
 * handlers only do transport + contact upsert, then call this.
 */
async function advanceOrderConversation(params: {
  farmId: string
  farmName: string
  farmLocation: string
  channel: Channel
  externalId: string
  contactId: string
  contactName?: string | null
  text: string
}): Promise<string> {
  const { farmId, channel, externalId } = params
  const text = params.text.trim()
  const lower = text.toLowerCase()
  const catalog = await loadCatalog(farmId)
  const state = await loadSession(farmId, channel, externalId)

  const reset = async () => {
    await saveSession(farmId, channel, externalId, { step: 'idle', cart: [], draft: {} })
  }

  // Customer cancel: "cancel TRV-ORD-…" or "cancel <uuid>" — before bare "cancel" reset.
  const cancelMatch = text.match(
    /^cancel\s+(TRV-ORD-[A-Fa-f0-9]{6}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  )
  if (cancelMatch) {
    const result = await requestCustomerCancel({
      farmId,
      contactId: params.contactId,
      orderIdOrRef: cancelMatch[1]!,
    })
    if (result.ok) {
      await reset()
      return result.message
    }
    return result.error
  }

  // Answer a free-text question, log it for Founder insights, then return to menu.
  const handleInquiry = async (
    question: string,
    via?: 'suggested',
  ): Promise<string> => {
    const rewards = isCustomerProgrammeQuestion(question)
      ? await rewardsForLinkedContact(farmId, params.contactId)
      : null
    const { reply, answeredVia } = await answerCustomerInquiry({
      farmName: params.farmName,
      farmLocation: params.farmLocation,
      catalog,
      question,
      farmId,
      rewards,
    })
    await logInquiry({
      farmId,
      contactId: params.contactId,
      channel,
      question,
      answeredVia: via ?? answeredVia,
    })
    await saveSession(farmId, channel, externalId, { ...state, step: 'idle', draft: { ...state.draft, suggestions: undefined } })
    return `${reply}\n\nType another question, "1" to order, or "menu".`
  }

  if (RESET_WORDS.includes(lower)) {
    await reset()
    return 'No problem - I’ve cleared that. Type "hi" to start again.'
  }
  if (MENU_WORDS.includes(lower)) {
    await reset()
    return welcomeMessage({
      farmId,
      farmName: params.farmName,
      contactId: params.contactId,
      contactName: params.contactName,
    })
  }

  const linkMatch = text.match(/^link\s+([A-Z0-9-]{6,20})$/i)
  if (state.step === 'idle' && linkMatch) {
    const linked = await linkCustomerContactWithCode({
      farmId,
      contactId: params.contactId,
      code: linkMatch[1]!,
    })
    if (!linked.ok) return `${linked.error}\n\nType "menu" to continue.`
    const channelName = channel === 'telegram' ? 'Telegram' : 'WhatsApp'
    return `Your ${channelName} is now linked to ${linked.accountName}'s Trovara account. Your orders will stay together across the website and chat.\n\nType "2" to see your orders.`
  }

  const supportMatch = text.match(/^(?:4|complaint|support|problem|issue)(?:\s*[:-]?\s*(.*))?$/i)
  if (state.step === 'idle' && supportMatch) {
    const description = supportMatch[1]?.trim()
    if (!description) {
      await saveSession(farmId, channel, externalId, { ...state, step: 'support' })
      return 'Please tell us what went wrong. Include your order reference if you have one.'
    }
    const ticket = await createSupportTicket({
      farmId,
      contactId: params.contactId,
      channel,
      description,
      priority: /urgent|unsafe|spoilt|damaged|missing/i.test(description) ? 'urgent' : 'normal',
    })
    return `Thanks — we’ve logged this as ${ticket.reference}. Our team will follow up.\n\nType "menu" to continue.`
  }

  switch (state.step) {
    case 'idle': {
      if (isTrackingIntent(text, lower)) {
        return trackOrders(farmId, params.contactId)
      }
      if (isOrderingIntent(lower)) {
        await saveSession(farmId, channel, externalId, { ...state, step: 'ordering' })
        return `Here’s what we have:\n\n${formatCatalog(
          catalog,
        )}\n\nReply with the item number to add it to your order.`
      }
      if (ASK_WORDS.includes(lower)) {
        const { text: prompt, suggestions } = await askPrompt(farmId)
        await saveSession(farmId, channel, externalId, {
          ...state,
          step: 'asking',
          draft: { ...state.draft, suggestions },
        })
        return prompt
      }
      // Anything else that isn't a menu command is treated as a question.
      return handleInquiry(text)
    }

    case 'asking': {
      const suggestions = state.draft.suggestions ?? []
      const choice = parseChoice(lower)
      if (choice && choice >= 1 && choice <= suggestions.length) {
        return handleInquiry(suggestions[choice - 1]!, 'suggested')
      }
      return handleInquiry(text)
    }

    case 'support': {
      if (text.length < 3) return 'Please add a little more detail so our team can help.'
      const ticket = await createSupportTicket({
        farmId,
        contactId: params.contactId,
        channel,
        description: text,
        priority: /urgent|unsafe|spoilt|damaged|missing/i.test(text) ? 'urgent' : 'normal',
      })
      await reset()
      return `Thanks — we’ve logged this as ${ticket.reference}. Our team will follow up.\n\nType "menu" to continue.`
    }

    case 'ordering': {
      if (['done', 'checkout', 'pay'].includes(lower)) {
        if (!state.cart.length) {
          return 'Your cart is empty. Reply with an item number to add something first.'
        }
        return beginCheckout({
          farmId,
          channel,
          externalId,
          contactId: params.contactId,
          state,
          catalog,
        })
      }
      const choice = parseChoice(lower)
      if (choice && choice >= 1 && choice <= catalog.length) {
        const product = catalog[choice - 1]!
        const draft: OrderDraft = { ...state.draft, pendingProductId: product.id }
        await saveSession(farmId, channel, externalId, { ...state, step: 'awaiting_qty', draft })
        return `How many ${product.unit} of ${product.name}? Reply with a number.`
      }
      // Don't trap a customer who hasn't added anything yet: if they ask to track
      // or ask a question instead of picking an item, honour that intent.
      if (!state.cart.length) {
        if (isTrackingIntent(text, lower)) {
          await reset()
          return trackOrders(farmId, params.contactId)
        }
        if (!isOrderingIntent(lower)) {
          return handleInquiry(text)
        }
      }
      return `Please reply with an item number (1–${catalog.length}), or "done" to check out. (Max ${MAX_CART_LINES} items per order.)`
    }

    case 'awaiting_qty': {
      const qty = parseChoice(lower)
      if (!qty || qty <= 0) return 'Please reply with a quantity, e.g. 3.'
      if (qty > MAX_QTY_PER_LINE) {
        return `Maximum quantity per item is ${MAX_QTY_PER_LINE}. Contact the farm for bulk orders.`
      }
      const pendingId = state.draft.pendingProductId
      const cart = pendingId ? addToCart(state.cart, pendingId, qty) : state.cart
      const lineCheck = validateCartLines(cart)
      if (!lineCheck.ok) return lineCheck.message
      const valueCheck = validateOrderValue(cart, catalog)
      if (!valueCheck.ok) return valueCheck.message
      const draft: OrderDraft = { ...state.draft, pendingProductId: undefined }
      await saveSession(farmId, channel, externalId, { step: 'ordering', cart, draft })
      return `Added.\n\n${formatCart(
        cart,
        catalog,
      )}\n\nReply another item number to add more, or "done" to check out.`
    }

    case 'confirm_details': {
      if (YES_WORDS.includes(lower)) {
        await saveSession(farmId, channel, externalId, { ...state, step: 'confirm' })
        return formatOrderConfirmPrompt(state.draft, formatCart(state.cart, catalog))
      }
      if (isChangeDetailsIntent(lower)) {
        const draft: OrderDraft = {
          ...state.draft,
          name: undefined,
          phone: undefined,
          address: undefined,
        }
        await saveSession(farmId, channel, externalId, { ...state, step: 'need_name', draft })
        return 'Okay — let’s update your details.\n\nWhat name should we put on the order?'
      }
      return 'Reply YES to keep these details, or CHANGE to update them.'
    }

    case 'need_name': {
      const draft: OrderDraft = { ...state.draft, name: text.slice(0, 200) }
      await saveSession(farmId, channel, externalId, { ...state, step: 'need_phone', draft })
      return 'Thanks. What phone number should we call for delivery?'
    }

    case 'need_phone': {
      const draft: OrderDraft = { ...state.draft, phone: text.slice(0, 40) }
      await saveSession(farmId, channel, externalId, { ...state, step: 'need_address', draft })
      return 'And what’s the delivery address?'
    }

    case 'need_address': {
      const draft: OrderDraft = { ...state.draft, address: text.slice(0, 500) }
      await saveSession(farmId, channel, externalId, { ...state, step: 'confirm', draft })
      return formatOrderConfirmPrompt(draft, formatCart(state.cart, catalog))
    }

    case 'confirm': {
      if (YES_WORDS.includes(lower)) {
        const result = await createOrderFromCart({
          farmId,
          channel,
          contactId: params.contactId,
          contactName: params.contactName,
          cart: state.cart,
          draft: state.draft,
          catalog,
        })
        if ('error' in result) return result.error
        await reset()
        if (result.payment) {
          return [
            `✅ Order placed! Your reference is ${result.reference}.`,
            `We’ll call ${state.draft.phone ?? 'you'} to confirm delivery.`,
            '',
            `Pay now: ${result.payment.authorizationUrl}`,
            `Amount: ${formatNaira(result.payment.amountKobo)}`,
            `You can cancel within 24 hours with: cancel ${result.reference}`,
            '',
            'Reply "2" any time to track your order.',
          ].join('\n')
        }
        return [
          `✅ Order placed! Your reference is ${result.reference}.`,
          `We’ll call ${state.draft.phone ?? 'you'} to confirm delivery. Payment is on delivery.`,
          '',
          'Reply "2" any time to track your order.',
        ].join('\n')
      }
      return 'Reply YES to confirm your order, or "cancel" to discard it.'
    }

    default: {
      await reset()
      return mainMenu(params.farmName)
    }
  }
}
