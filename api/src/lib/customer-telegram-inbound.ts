import {
  sendTelegramMessage,
  startTelegramPollLoop,
  type TelegramUpdate,
} from './telegram.js'
import { checkButlerChatRateLimit } from './butler-rate-limit.js'
import {
  advanceOrderConversation,
  customerConversationIsActive,
  resolveCustomerFarm,
  upsertCustomerContact,
} from './customer-orders.js'
import { isCustomerConversationCommand } from './customer-message-routing.js'

const RATE_LIMIT_MSG = 'Too many messages - please wait a moment and try again.'

/** Handle one update from the customer order bot (separate token from staff). */
export async function handleCustomerTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message
  if (!msg) return
  const chatId = msg.chat.id
  const text = msg.text?.trim() ?? ''

  if (!checkButlerChatRateLimit(String(chatId))) {
    await sendTelegramMessage(chatId, RATE_LIMIT_MSG, { kind: 'customer' })
    return
  }

  const farm = await resolveCustomerFarm()
  if (!farm) {
    await sendTelegramMessage(
      chatId,
      'Online ordering is not available yet. Please check back soon.',
      { kind: 'customer' },
    )
    return
  }

  if (!text) {
    await sendTelegramMessage(chatId, 'Please send a text message. Reply "hi" to begin.', {
      kind: 'customer',
    })
    return
  }

  try {
    const contact = await upsertCustomerContact(farm.id, 'telegram', String(chatId), msg.from?.first_name)

    const belongsToConversation =
      isCustomerConversationCommand(text) ||
      (await customerConversationIsActive(farm.id, 'telegram', String(chatId)))
    if (!belongsToConversation) {
      const { recordCustomerFeedback } = await import('./order-fulfillment.js')
      const feedback = await recordCustomerFeedback({
        farmId: farm.id,
        contactId: contact.id,
        text,
      })
      if (feedback.handled) {
        await sendTelegramMessage(chatId, feedback.message ?? 'Thanks!', { kind: 'customer' })
        return
      }
    }

    const reply = await advanceOrderConversation({
      farmId: farm.id,
      farmName: farm.name,
      farmLocation: farm.location,
      channel: 'telegram',
      externalId: String(chatId),
      contactId: contact.id,
      contactName: contact.name,
      text,
    })
    await sendTelegramMessage(chatId, reply, { kind: 'customer' })
  } catch (err) {
    console.error('Customer order flow error:', err instanceof Error ? err.message : err)
    await sendTelegramMessage(chatId, 'Sorry, something went wrong. Please try again shortly.', {
      kind: 'customer',
    })
  }
}

export function startCustomerTelegramPolling(): void {
  startTelegramPollLoop('customer', handleCustomerTelegramUpdate)
}
