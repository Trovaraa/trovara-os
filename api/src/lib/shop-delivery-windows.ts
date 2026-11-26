export const SHOP_DELIVERY_TIME_ZONE = 'Africa/Lagos'

const HOUR_MS = 60 * 60 * 1000
const WEEK_DAYS = 7
// Lagos uses West Africa Time (UTC+01:00) year-round for current deliveries.
const LAGOS_OFFSET_MS = HOUR_MS
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

type WeeklyDeliverySlot = {
  dayOfWeek: number
  startTime: string
  endTime: string
  cutoffHours: number
}

type DeliveryWindow = {
  deliveryDate: string
  startsAt: Date
  orderCutoffAt: Date
}

function validSlot(slot: WeeklyDeliverySlot): boolean {
  return Number.isInteger(slot.dayOfWeek) && slot.dayOfWeek >= 0 && slot.dayOfWeek < WEEK_DAYS
    && TIME.test(slot.startTime) && TIME.test(slot.endTime)
    && Number.isInteger(slot.cutoffHours) && slot.cutoffHours >= 0 && slot.cutoffHours <= 336
}

function deliveryWindow(slot: WeeklyDeliverySlot, wallStart: Date): DeliveryWindow {
  const startsAt = new Date(wallStart.getTime() - LAGOS_OFFSET_MS)
  return {
    deliveryDate: wallStart.toISOString().slice(0, 10),
    startsAt,
    orderCutoffAt: new Date(startsAt.getTime() - slot.cutoffHours * HOUR_MS),
  }
}

export function shopDeliveryWindowOn(slot: WeeklyDeliverySlot, deliveryDate: string): DeliveryWindow | null {
  if (!validSlot(slot) || !DATE.test(deliveryDate)) return null

  // Parse the wall-clock components in UTC for calendar calculations only.
  const wallStart = new Date(`${deliveryDate}T${slot.startTime}:00Z`)
  if (Number.isNaN(wallStart.getTime()) || wallStart.getUTCDay() !== slot.dayOfWeek || wallStart.toISOString().slice(0, 10) !== deliveryDate) return null
  return deliveryWindow(slot, wallStart)
}

export function nextShopDeliveryWindow(slot: WeeklyDeliverySlot, now: Date): DeliveryWindow | null {
  const earliestWallStart = new Date(now.getTime() + slot.cutoffHours * HOUR_MS + LAGOS_OFFSET_MS)
  if (!validSlot(slot) || Number.isNaN(earliestWallStart.getTime())) return null

  const wallStart = new Date(earliestWallStart)
  const daysUntilSlot = (slot.dayOfWeek - wallStart.getUTCDay() + WEEK_DAYS) % WEEK_DAYS
  const [hour, minute] = slot.startTime.split(':').map(Number)
  wallStart.setUTCDate(wallStart.getUTCDate() + daysUntilSlot)
  wallStart.setUTCHours(hour, minute, 0, 0)
  if (wallStart < earliestWallStart) wallStart.setUTCDate(wallStart.getUTCDate() + WEEK_DAYS)
  return deliveryWindow(slot, wallStart)
}

/** Advance scheduled deliveries on the Lagos calendar, including slots just after local midnight. */
export function nextShopRecurringCheckout(
  date: Date,
  frequency: 'weekly' | 'fortnightly' | 'monthly',
  timeZone: typeof SHOP_DELIVERY_TIME_ZONE | 'UTC',
): Date {
  const offset = timeZone === SHOP_DELIVERY_TIME_ZONE ? LAGOS_OFFSET_MS : 0
  const next = new Date(date.getTime() + offset)
  if (frequency === 'monthly') {
    next.setUTCMonth(next.getUTCMonth() + 1)
  } else {
    next.setUTCDate(next.getUTCDate() + (frequency === 'weekly' ? 7 : 14))
  }
  return new Date(next.getTime() - offset)
}
