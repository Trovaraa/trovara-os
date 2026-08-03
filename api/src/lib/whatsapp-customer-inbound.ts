import { checkButlerChatRateLimit } from './butler-rate-limit.js'
import {
  advanceOrderConversation,
  customerConversationIsActive,
  resolveCustomerFarm,
  upsertCustomerContact,
} from './customer-orders.js'
import { isCustomerConversationCommand } from './customer-message-routing.js'
import {
  customerChannelsRequireOwnerTotp,
  farmHasOwnerTotpEnabled,
  OWNER_TOTP_REQUIRED_CUSTOMER_MSG,
} from './owner-totp-gate.js'
import { sendWhatsAppText } from './whatsapp-meta.js'

const RATE_LIMIT_MSG = 'Too many messages - please wait a moment and try again.'

type InboundMessage = {
  from: string
  id: string
  timestamp: string
  type: string
  text?: { body: string }
}

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

/** Handle inbound messages on the customer WhatsApp number (no staff phone match). */
export async function handleInboundCustomerWhatsApp(
  payload: unknown,
): Promise<{ handled: number }> {
  const body = payload as {
    entry?: {
      changes?: {
        value?: {
          messages?: InboundMessage[]
        }
      }[]
    }[]
  }

  let handled = 0

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      if (!value?.messages?.length) continue

      for (const msg of value.messages) {
        const phone = normalizePhone(msg.from)

        if (!checkButlerChatRateLimit(`wa-customer:${phone}`)) {
          await sendWhatsAppText(phone, RATE_LIMIT_MSG, { kind: 'customer' }).catch(() => undefined)
          continue
        }

        const farm = await resolveCustomerFarm()
        if (!farm) {
          await sendWhatsAppText(
            phone,
            'Online ordering is not available yet. Please check back soon.',
            { kind: 'customer' },
          ).catch(() => undefined)
          continue
        }

        if (
          customerChannelsRequireOwnerTotp() &&
          !(await farmHasOwnerTotpEnabled(farm.id))
        ) {
          console.error(
            'Customer WhatsApp blocked: no owner TOTP enabled for farm',
            farm.id,
          )
          await sendWhatsAppText(phone, OWNER_TOTP_REQUIRED_CUSTOMER_MSG, {
            kind: 'customer',
          }).catch(() => undefined)
          continue
        }

        const text = msg.type === 'text' ? msg.text?.body?.trim() ?? '' : ''
        if (!text) {
          await sendWhatsAppText(
            phone,
            'Please send a text message. Reply "hi" to begin.',
            { kind: 'customer' },
          ).catch(() => undefined)
          continue
        }

        try {
          const contact = await upsertCustomerContact(farm.id, 'whatsapp', phone)

          const belongsToConversation =
            isCustomerConversationCommand(text) ||
            (await customerConversationIsActive(farm.id, 'whatsapp', phone))
          if (!belongsToConversation) {
            const { recordCustomerFeedback } = await import('./order-fulfillment.js')
            const feedback = await recordCustomerFeedback({
              farmId: farm.id,
              contactId: contact.id,
              text,
            })
            if (feedback.handled) {
              await sendWhatsAppText(phone, feedback.message ?? 'Thanks!', {
                kind: 'customer',
              }).catch(() => undefined)
              handled++
              continue
            }
          }

          const reply = await advanceOrderConversation({
            farmId: farm.id,
            farmName: farm.name,
            farmLocation: farm.location,
            channel: 'whatsapp',
            externalId: phone,
            contactId: contact.id,
            contactName: contact.name,
            text,
          })
          await sendWhatsAppText(phone, reply, { kind: 'customer' })
          handled++
        } catch (err) {
          console.error(
            'Customer WhatsApp order flow error:',
            err instanceof Error ? err.message : err,
          )
          await sendWhatsAppText(
            phone,
            'Sorry, something went wrong. Please try again shortly.',
            { kind: 'customer' },
          ).catch(() => undefined)
        }
      }
    }
  }

  return { handled }
}
