import type { SessionUser } from './session.js'
import { users } from '../db/schema.js'
import type { PreferredLocale } from '../db/schema.js'
import { canManageOrders } from './rbac.js'
import {
  setUserPreferredLocale,
  transitionOrderFromCallback,
} from './order-fulfillment.js'
import {
  languageSavedMessage,
  orderCommandHelp,
} from './order-messages.js'
import { transitionTaskFromCallback } from './staff-ops.js'
import {
  cancelActionDraft,
  confirmActionDraft,
} from './task-drafts.js'
import { canonicalDraftPayload, unhandledDraftMessage } from './draft-canonical.js'
import {
  buildLotQrPng,
  findPrintableLotById,
  type PrintableLot,
} from './lot-print.js'
import {
  answerTelegramCallbackQuery,
  sendTelegramMessage,
  sendTelegramPhoto,
  type TelegramUpdate,
} from './telegram.js'
import {
  executeConfirmedCropCycle,
  executeConfirmedLivestockBatch,
} from './action-draft-farm.js'
import { applyConfirmedOpsDraft } from './action-draft-ops.js'
import { applyConfirmedInventoryDraft } from './action-draft-inventory.js'
import { applyConfirmedZoneDraft } from './action-draft-zones.js'
import { applyConfirmedLivestockLogDraft } from './action-draft-livestock-log.js'
import { applyConfirmedLotDraft } from './lot-enrich.js'

type DbUser = typeof users.$inferSelect

function toSessionUser(u: DbUser): SessionUser {
  return {
    id: u.id,
    farmId: u.farmId,
    email: u.email,
    name: u.name,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
  }
}

function toActor(u: DbUser) {
  return {
    id: u.id,
    farmId: u.farmId,
    role: u.role,
    name: u.name,
    preferredLocale: u.preferredLocale,
  }
}

export async function deliverPrintQr(chatId: number, lot: PrintableLot): Promise<void> {
  const { png, publicUrl, labelUrl } = await buildLotQrPng(lot)
  const caption = [
    `📦 Box label · ${lot.lotCode}`,
    `${lot.productName} · ${lot.quantityKg} ${lot.unit === 'crates' ? 'crates' : 'kg'}`,
    'Print this QR on the delivery box.',
    `Printable label: ${labelUrl}`,
    `(Scan opens: ${publicUrl})`,
  ].join('\n')

  await sendTelegramPhoto(chatId, png, {
    caption,
    filename: `${lot.lotCode}-qr.png`,
  })
}

export async function handleCallbackQuery(
  dbUser: DbUser,
  callback: NonNullable<TelegramUpdate['callback_query']>,
) {
  const chatId = callback.message?.chat.id
  if (!chatId || !callback.data) return

  await answerTelegramCallbackQuery(callback.id)

  const user = toSessionUser(dbUser)
  const parts = callback.data.split(':')

  if (parts[0] === 'lang' && parts[1]) {
    const locale = parts[1] as PreferredLocale
    if (!['en', 'yo', 'pcm', 'fr'].includes(locale)) {
      await sendTelegramMessage(chatId, 'Unknown language.')
      return
    }
    await setUserPreferredLocale(dbUser.id, locale)
    await sendTelegramMessage(chatId, languageSavedMessage(locale))
    await sendTelegramMessage(chatId, orderCommandHelp(locale))
    return
  }

  if (parts[0] === 'task' && parts[1] && parts[2]) {
    const action = parts[1]
    const taskId = parts[2]
    if (!['start', 'done', 'approve', 'reject'].includes(action)) {
      await sendTelegramMessage(chatId, 'Unknown task action.')
      return
    }
    const result = await transitionTaskFromCallback({
      actor: toActor(dbUser),
      taskId,
      action: action as 'start' | 'done' | 'approve' | 'reject',
    })
    await sendTelegramMessage(chatId, result.reply ?? 'Done.')
    return
  }

  if (parts[0] === 'label' && parts[1]) {
    if (!canManageOrders(user)) {
      await sendTelegramMessage(chatId, 'Only Admin, Supervisor, or Sales can print box QR labels.')
      return
    }
    const lot = await findPrintableLotById(user.farmId, parts[1])
    if (!lot) {
      await sendTelegramMessage(chatId, 'Lot not found.')
      return
    }
    try {
      await deliverPrintQr(chatId, lot)
    } catch (err) {
      await sendTelegramMessage(
        chatId,
        err instanceof Error ? err.message : 'Could not send QR label.',
      )
    }
    return
  }

  if (parts[0] === 'order' && parts[1] && parts[2]) {
    const action = parts[1]
    const orderId = parts[2]
    if (!['confirm', 'cancel', 'dispatch', 'deliver'].includes(action)) {
      await sendTelegramMessage(chatId, 'Unknown order action.')
      return
    }
    if (!canManageOrders(user)) {
      await sendTelegramMessage(chatId, 'You are not allowed to update orders.')
      return
    }
    const result = await transitionOrderFromCallback({
      actor: toActor(dbUser),
      orderId,
      action: action as 'confirm' | 'cancel' | 'dispatch' | 'deliver',
    })
    await sendTelegramMessage(chatId, result.reply)
    return
  }

  // Telegram confirms drafts through the inline keyboard, so `action` comes from
  // the button's own callback_data (`confirm:<draftId>` / `cancel:<draftId>`) and
  // never from anything the worker typed. That is why the English-only keyword
  // problem on the WhatsApp side does not exist here, in any language: there is
  // no keyword to type. `telegram-inbound` has no text confirm path either.
  const [action, draftId] = parts
  if (!draftId || (action !== 'confirm' && action !== 'cancel')) {
    await sendTelegramMessage(chatId, 'Unknown button action.')
    return
  }

  if (action === 'cancel') {
    const ok = await cancelActionDraft(draftId, user.id)
    await sendTelegramMessage(chatId, ok ? 'Cancelled. Nothing was written.' : 'Draft already resolved or expired.')
    return
  }

  const confirmed = await confirmActionDraft(draftId, user.id)
  if (!confirmed) {
    await sendTelegramMessage(chatId, 'Draft expired or already used. Please create it again.')
    return
  }

  if (confirmed.farmId !== user.farmId) {
    await sendTelegramMessage(chatId, 'Draft is not valid for this farm.')
    return
  }

  // Same last-chance normalize WhatsApp does: a draft created while the LLM was
  // down still holds the worker's own words, and this is the final moment before
  // they land in a content row.
  const { payload, locale } = await canonicalDraftPayload(confirmed)

  try {
    const opsResult = await applyConfirmedOpsDraft(
      user,
      confirmed.actionType,
      payload,
      'telegram_confirm',
      locale,
    )
    if (opsResult != null) {
      await sendTelegramMessage(chatId, opsResult)
      return
    }

    const invResult = await applyConfirmedInventoryDraft(
      user,
      confirmed.actionType,
      payload,
      'telegram_confirm',
      locale,
    )
    if (invResult != null) {
      await sendTelegramMessage(chatId, invResult)
      return
    }

    const zoneResult = await applyConfirmedZoneDraft(
      user,
      confirmed.actionType,
      payload,
      'telegram_confirm',
    )
    if (zoneResult != null) {
      await sendTelegramMessage(chatId, zoneResult)
      return
    }

    const logResult = await applyConfirmedLivestockLogDraft(
      user,
      confirmed.actionType,
      payload,
      'telegram_confirm',
      locale,
    )
    if (logResult != null) {
      await sendTelegramMessage(chatId, logResult)
      return
    }

    const lotResult = await applyConfirmedLotDraft(
      user,
      confirmed.actionType,
      payload,
      locale,
    )
    if (lotResult != null) {
      await sendTelegramMessage(chatId, lotResult)
      return
    }

    if (confirmed.actionType === 'create_crop_cycle') {
      const result = await executeConfirmedCropCycle(user, payload)
      await sendTelegramMessage(chatId, result)
      return
    }

    if (confirmed.actionType === 'create_livestock_batch') {
      const result = await executeConfirmedLivestockBatch(user, payload)
      await sendTelegramMessage(chatId, result)
      return
    }

    await sendTelegramMessage(chatId, unhandledDraftMessage(confirmed.actionType))
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to apply draft'
    await sendTelegramMessage(chatId, `Could not apply draft: ${message}`)
  }
}
