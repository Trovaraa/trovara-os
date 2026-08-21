/**
 * Pure helpers for the customer order flow - cart math and message formatting.
 * No DB / IO imports so these stay trivially unit-testable and channel-agnostic
 * (shared by the Telegram and WhatsApp customer bots).
 */

export type CartLine = { productId: string; qty: number }

export type OrderDraft = {
  name?: string
  phone?: string
  address?: string
  /** Product awaiting a quantity reply (transient, between messages). */
  pendingProductId?: string
  /** Suggested questions last shown, so a numeric reply can pick one. */
  suggestions?: string[]
}

export type CatalogItem = {
  id: string
  name: string
  unit: string
  priceKobo: number
  currency: string
  provenance?: 'trovara_grown' | 'trovara_sourced'
}

export type OrderStep =
  | 'idle'
  | 'asking'
  | 'support'
  | 'ordering'
  | 'awaiting_qty'
  | 'confirm_details'
  | 'need_name'
  | 'need_phone'
  | 'need_address'
  | 'confirm'

export function formatNaira(kobo: number, currency = 'NGN'): string {
  const amount = (kobo / 100).toLocaleString('en-NG', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
  return currency === 'NGN' ? `₦${amount}` : `${currency} ${amount}`
}

/** Short, human-friendly reference derived from the order id (for tracking). */
export function orderReference(orderId: string): string {
  return `TRV-ORD-${orderId.replace(/-/g, '').slice(0, 6).toUpperCase()}`
}

export function addToCart(cart: CartLine[], productId: string, qty: number): CartLine[] {
  if (qty <= 0) return cart
  const next = cart.map((line) => ({ ...line }))
  const existing = next.find((line) => line.productId === productId)
  if (existing) existing.qty += qty
  else next.push({ productId, qty })
  return next
}

export function cartTotalKobo(cart: CartLine[], catalog: CatalogItem[]): number {
  return cart.reduce((sum, line) => {
    const item = catalog.find((p) => p.id === line.productId)
    return sum + (item ? item.priceKobo * line.qty : 0)
  }, 0)
}

/** True if any cart line has no price yet (priced on request). */
export function cartHasUnpriced(cart: CartLine[], catalog: CatalogItem[]): boolean {
  return cart.some((line) => {
    const item = catalog.find((p) => p.id === line.productId)
    return !item || item.priceKobo === 0
  })
}

export function formatCatalog(catalog: CatalogItem[]): string {
  if (!catalog.length) return 'Our catalogue is being updated. Please check back soon.'
  return catalog
    .map((p, i) => {
      const price =
        p.priceKobo > 0 ? `${formatNaira(p.priceKobo, p.currency)} / ${p.unit}` : 'price on request'
      return `${i + 1}. ${p.name} - ${price}`
    })
    .join('\n')
}

export function formatCart(cart: CartLine[], catalog: CatalogItem[]): string {
  if (!cart.length) return 'Your cart is empty.'
  const lines = cart.map((line) => {
    const item = catalog.find((p) => p.id === line.productId)
    const name = item?.name ?? 'Item'
    const unit = item?.unit ?? 'unit'
    const lineTotal =
      item && item.priceKobo > 0 ? ` = ${formatNaira(item.priceKobo * line.qty, item.currency)}` : ''
    return `• ${line.qty} × ${name} (${unit})${lineTotal}`
  })
  const total = cartTotalKobo(cart, catalog)
  const totalLine =
    total > 0
      ? `\nSubtotal: ${formatNaira(total)}${
          cartHasUnpriced(cart, catalog) ? ' (+ items priced on request)' : ''
        }`
      : '\nTotal: price on request'
  return `${lines.join('\n')}${totalLine}`
}

/** Parse a 1-based menu/catalog choice; returns null if not a valid integer. */
export function parseChoice(text: string): number | null {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const n = Number.parseInt(trimmed, 10)
  return Number.isInteger(n) ? n : null
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Received - awaiting confirmation',
  confirmed: 'Confirmed',
  dispatched: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

export function orderStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  not_required: 'COD',
  refund_pending: 'Refund pending',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
}

export function paymentStatusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status] ?? status
}

/** Parse `Delivery: …` from staff/order notes. */
export function parseDeliveryAddress(notes: string | null | undefined): string | null {
  if (!notes?.trim()) return null
  const match = notes.match(/Delivery:\s*(.+)/i)
  const address = match?.[1]?.trim()
  return address || null
}

export function hasCompleteDeliveryDetails(draft: OrderDraft): boolean {
  return Boolean(draft.name?.trim() && draft.phone?.trim() && draft.address?.trim())
}

export function formatSavedDetailsPrompt(draft: OrderDraft, cartSummary: string): string {
  return [
    'Great.',
    '',
    cartSummary,
    '',
    'We still have your last delivery details:',
    `Name: ${draft.name?.trim() || '-'}`,
    `Phone: ${draft.phone?.trim() || '-'}`,
    `Deliver to: ${draft.address?.trim() || '-'}`,
    '',
    'Reply YES to use these, or CHANGE to update them.',
  ].join('\n')
}

export function formatOrderConfirmPrompt(draft: OrderDraft, cartSummary: string): string {
  return [
    'Please confirm your order:',
    '',
    cartSummary,
    '',
    `Name: ${draft.name ?? '-'}`,
    `Phone: ${draft.phone ?? '-'}`,
    `Deliver to: ${draft.address ?? '-'}`,
    '',
    'Reply YES to place the order, or "cancel".',
  ].join('\n')
}

export function firstMissingDetailStep(draft: OrderDraft): 'need_name' | 'need_phone' | 'need_address' {
  if (!draft.name?.trim()) return 'need_name'
  if (!draft.phone?.trim()) return 'need_phone'
  return 'need_address'
}

export function isChangeDetailsIntent(lower: string): boolean {
  return (
    lower === 'change' ||
    lower === 'edit' ||
    lower === 'update' ||
    lower === 'no' ||
    lower === 'n' ||
    lower === 'wrong' ||
    lower.startsWith('change ') ||
    lower.startsWith('edit ')
  )
}
