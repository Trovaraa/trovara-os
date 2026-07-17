import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  customerChatSessions,
  customerContacts,
  farms,
  orderItems,
  orders,
  products,
} from '../db/schema.js'
import { recordFarmEvent } from './farm-events.js'
import { notifyOwnerTelegram } from './farm-notify.js'
import {
  answerCustomerInquiry,
  logInquiry,
  suggestedQuestions,
} from './customer-inquiry.js'
import {
  addToCart,
  cartTotalKobo,
  formatCart,
  formatCatalog,
  orderReference,
  orderStatusLabel,
  parseChoice,
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

export { resolveCustomerFarm, upsertCustomerContact, advanceOrderConversation }

type Channel = 'telegram' | 'whatsapp'

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
    '3 - Ask about our farm & produce',
    '',
    'Or just type your question. Type "cancel" any time to start over.',
  ].join('\n')
}

/** Build the "ask a question" prompt with popular/suggested questions. */
async function askPrompt(farmId: string): Promise<{ text: string; suggestions: string[] }> {
  const suggestions = await suggestedQuestions(farmId, 3)
  const lines = ['Ask me anything about our farm and produce 🌱', '']
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

/** Which farm the customer bot sells for (single-farm pilot; slug-pinned). */
async function resolveCustomerFarm(): Promise<{
  id: string
  name: string
  location: string
} | null> {
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
  }))
}

async function upsertCustomerContact(
  farmId: string,
  channel: Channel,
  externalId: string,
  name?: string | null,
  phone?: string | null,
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
    const [row] = await db
      .update(customerContacts)
      .set(updates)
      .where(eq(customerContacts.id, existing.id))
      .returning()
    return row
  }

  const [row] = await db
    .insert(customerContacts)
    .values({ farmId, channel, externalId, name: name ?? null, phone: phone ?? null })
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

async function createOrderFromCart(params: {
  farmId: string
  channel: Channel
  contactId: string
  contactName?: string | null
  cart: CartLine[]
  draft: OrderDraft
  catalog: CatalogItem[]
}): Promise<{ reference: string } | { error: string }> {
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
    },
    metadata: { source: params.channel, itemCount: items.length, totalKobo },
  })

  // Best-effort alert to the Founder via the staff butler bot; never block the order.
  try {
    const itemLines = items.map((i) => `• ${i.quantity} × ${i.productName}`).join('\n')
    await notifyOwnerTelegram(
      params.farmId,
      `🛒 New order ${reference} (${params.channel})\n${itemLines}\n\nCustomer: ${customerName}\nPhone: ${
        params.draft.phone?.trim() || 'n/a'
      }\nDeliver to: ${address || 'n/a'}\n\nConfirm/dispatch it in Trovara OS → Sales.`,
      { reason: 'new_customer_order' },
    )
  } catch (err) {
    console.error('Order owner-notify failed:', err instanceof Error ? err.message : err)
  }

  return { reference }
}

async function trackOrders(farmId: string, contactId: string): Promise<string> {
  const rows = await db
    .select({
      id: orders.id,
      status: orders.status,
      totalAmount: orders.totalAmount,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(eq(orders.farmId, farmId), eq(orders.customerContactId, contactId)))
    .orderBy(desc(orders.createdAt))
    .limit(5)

  if (!rows.length) return 'You have no orders yet. Reply "1" to place one.'

  const lines = rows.map((o) => {
    const when = new Date(o.createdAt).toLocaleDateString('en-NG')
    return `${orderReference(o.id)} - ${orderStatusLabel(o.status)} (${when})`
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

  // Answer a free-text question, log it for Founder insights, then return to menu.
  const handleInquiry = async (
    question: string,
    via?: 'suggested',
  ): Promise<string> => {
    const { reply, answeredVia } = await answerCustomerInquiry({
      farmName: params.farmName,
      farmLocation: params.farmLocation,
      catalog,
      question,
      farmId,
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

    case 'ordering': {
      if (['done', 'checkout', 'pay'].includes(lower)) {
        if (!state.cart.length) {
          return 'Your cart is empty. Reply with an item number to add something first.'
        }
        await saveSession(farmId, channel, externalId, { ...state, step: 'need_name' })
        return `Great.\n\n${formatCart(
          state.cart,
          catalog,
        )}\n\nWhat name should we put on the order?`
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
      return [
        'Please confirm your order:',
        '',
        formatCart(state.cart, catalog),
        '',
        `Name: ${draft.name ?? '-'}`,
        `Phone: ${draft.phone ?? '-'}`,
        `Deliver to: ${draft.address ?? '-'}`,
        '',
        'Reply YES to place the order (pay on delivery), or "cancel".',
      ].join('\n')
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
