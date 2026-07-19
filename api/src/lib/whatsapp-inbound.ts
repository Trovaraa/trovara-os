import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import type { SessionUser } from './session.js'
import {
  downloadWhatsAppMedia,
  downloadWhatsAppMediaBuffer,
  sendWhatsAppImage,
  sendWhatsAppText,
} from './whatsapp-meta.js'
import {
  buildLotQrPng,
  findPrintableLotByCode,
  listRecentPrintableLots,
} from './lot-print.js'
import { answerPhoto, answerText, recordChatMessage, transcribeVoice } from './butler-core.js'
import { checkButlerRateLimit } from './butler-rate-limit.js'
import { deliverButlerReply } from './butler-reply.js'
import { looksUrgent, notifyWorkerAlertChannels } from './farm-notify.js'
import { voiceNotUnderstoodMessage } from './reply-locale.js'
import { canAssignTasks, canManageOrders } from './rbac.js'
import {
  setUserPreferredLocale,
  tryHandleStaffOrderCommand,
} from './order-fulfillment.js'
import {
  languagePromptMessage,
  languageSavedMessage,
  orderCommandHelp,
  staffLocale,
} from './order-messages.js'
import { tryHandleStaffOpsCommand } from './staff-ops.js'
import { roleCommandHelp } from './role-menus.js'
import {
  cancelActionDraft,
  confirmActionDraft,
  getLatestPendingDraftAny,
  storeActionDraft,
} from './task-drafts.js'
import {
  executeConfirmedCropCycle,
  executeConfirmedLivestockBatch,
  parseCropCycleIntent,
  parseLivestockBatchIntent,
  resolvePlotByName,
} from './action-draft-farm.js'
import {
  applyConfirmedOpsDraft,
  parseAssetCountIntent,
  parseCensusIntent,
  parseCreateTaskIntent,
  prepareAssetCountDraft,
  prepareCensusDraft,
  prepareCreateTaskDraft,
} from './action-draft-ops.js'
import {
  applyConfirmedInventoryDraft,
  parseLowStockAckIntent,
  parseOpeningCountIntent,
  parseStockMoveIntent,
  prepareLowStockAckDraft,
  prepareOpeningCountDraft,
  prepareStockMoveDraft,
} from './action-draft-inventory.js'
import {
  applyConfirmedZoneDraft,
  parseCreatePlotIntent,
  parseCreateZoneIntent,
  prepareCreatePlotDraft,
  prepareCreateZoneDraft,
} from './action-draft-zones.js'
import {
  applyConfirmedLivestockLogDraft,
  parseLivestockLogIntent,
  prepareLivestockLogDraft,
} from './action-draft-livestock-log.js'
import {
  applyConfirmedLotDraft,
  applyLotEnrichText,
  attachPhotoToLotEnrichDraft,
  formatLotsToPackMessage,
  parseVerifyLotIntent,
  prepareVerifyLotDraft,
  startLotEnrichDraft,
} from './lot-enrich.js'
import { formatHandoverProgressText, getHandoverProgress } from './handover-templates.js'
import { processEvidenceValue } from './evidence-store.js'
import type { PreferredLocale } from '../db/schema.js'

const ENTITY = 'whatsapp_message'
const BUTLER_RATE_LIMIT_MSG = 'You have reached the hourly Butler limit. Please try again later.'
const WA_CONFIRM_HINT = 'Reply CONFIRM to save, or CANCEL.'
const CREATE_PLOT_HINT = 'Create plot: Name zone=ZoneName'

function flattenPickerReply(reply: string, replyMarkup?: Record<string, unknown>): string {
  if (!replyMarkup || typeof replyMarkup !== 'object') return reply
  const kb = replyMarkup as {
    inline_keyboard?: Array<Array<{ text?: string }>>
  }
  const lines = (kb.inline_keyboard ?? []).flat().map((b) => b.text).filter(Boolean)
  if (!lines.length) return reply
  return `${reply}\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nReply with the command + id, e.g. /done TSK-ABCDEF`
}

function withCreatePlotHint(error: string): string {
  return /not found/i.test(error) ? `${error}\n\n${CREATE_PLOT_HINT}` : error
}

function voicePrefix(
  opts: { inboundWasVoice?: boolean } | undefined,
  originalText: string,
  reply: string,
): string {
  return opts?.inboundWasVoice ? `🗣️ "${originalText}"\n\n${reply}` : reply
}

type InboundMessage = {
  from: string
  id: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type?: string; caption?: string }
  audio?: { id: string; mime_type?: string; voice?: boolean }
}

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

type DbUser = typeof users.$inferSelect

async function findUserByPhone(phone: string): Promise<DbUser | undefined> {
  const normalized = normalizePhone(phone)
  const allWithPhone = await db
    .select()
    .from(users)
    .where(sql`${users.phone} IS NOT NULL AND ${users.phone} <> '' AND ${users.active} = true`)

  return allWithPhone.find((u) => normalizePhone(u.phone ?? '') === normalized)
}

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

async function handleText(
  dbUser: DbUser,
  msg: InboundMessage,
  text: string,
  opts?: { inboundWasVoice?: boolean; alreadyLogged?: boolean },
): Promise<void> {
  const user = toSessionUser(dbUser)
  const phone = normalizePhone(msg.from)
  const locale = staffLocale(dbUser.preferredLocale)

  if (!checkButlerRateLimit(user.id)) {
    await sendWhatsAppText(phone, BUTLER_RATE_LIMIT_MSG).catch(() => undefined)
    return
  }

  const lower = text.trim().toLowerCase()
  if (lower === 'language' || lower === '/language') {
    await sendWhatsAppText(
      phone,
      `${languagePromptMessage(locale)}\n\nReply: lang en | lang yo | lang pcm | lang fr`,
    ).catch(() => undefined)
    return
  }

  const langMatch = text.trim().match(/^lang(?:uage)?\s+(en|yo|pcm|fr)$/i)
  if (langMatch) {
    const next = langMatch[1]!.toLowerCase() as PreferredLocale
    await setUserPreferredLocale(dbUser.id, next)
    await sendWhatsAppText(phone, languageSavedMessage(next)).catch(() => undefined)
    await sendWhatsAppText(phone, roleCommandHelp(next, dbUser.role)).catch(() => undefined)
    return
  }

  if (lower === 'orders' || lower === '/orders') {
    if (!canManageOrders(user)) {
      await sendWhatsAppText(
        phone,
        `Orders aren't available for your role.\n\n${roleCommandHelp(locale, dbUser.role)}`,
      ).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, orderCommandHelp(locale)).catch(() => undefined)
    return
  }

  if (lower === 'ops' || lower === '/ops' || lower === 'help' || lower === '/help' || lower === 'menu') {
    await sendWhatsAppText(phone, roleCommandHelp(locale, dbUser.role)).catch(() => undefined)
    return
  }

  // WhatsApp draft confirm/cancel (no inline buttons). Bare confirm/cancel only
  // when a pending draft exists — otherwise fall through to order/ops handlers.
  if (/^(?:confirm|cancel)$/i.test(text.trim())) {
    const draft = await getLatestPendingDraftAny(user.id)
    if (draft) {
      if (/^cancel$/i.test(text.trim())) {
        const ok = await cancelActionDraft(draft.id, user.id)
        await sendWhatsAppText(phone, ok ? 'Cancelled. Nothing was written.' : 'Draft already resolved.').catch(
          () => undefined,
        )
        return
      }
      const confirmed = await confirmActionDraft(draft.id, user.id)
      if (!confirmed) {
        await sendWhatsAppText(phone, 'Draft expired. Please create it again.').catch(() => undefined)
        return
      }
      let result = 'Confirmed.'
      try {
        const opsResult = await applyConfirmedOpsDraft(
          user,
          confirmed.actionType,
          confirmed.payload,
          'whatsapp_confirm',
        )
        if (opsResult != null) {
          result = opsResult
        } else {
          const invResult = await applyConfirmedInventoryDraft(
            user,
            confirmed.actionType,
            confirmed.payload,
            'whatsapp_confirm',
          )
          if (invResult != null) {
            result = invResult
          } else {
            const zoneResult = await applyConfirmedZoneDraft(
              user,
              confirmed.actionType,
              confirmed.payload,
              'whatsapp_confirm',
            )
            if (zoneResult != null) {
              result = zoneResult
            } else {
              const logResult = await applyConfirmedLivestockLogDraft(
                user,
                confirmed.actionType,
                confirmed.payload,
                'whatsapp_confirm',
              )
              if (logResult != null) {
                result = logResult
              } else {
                const lotResult = await applyConfirmedLotDraft(
                  user,
                  confirmed.actionType,
                  confirmed.payload,
                )
                if (lotResult != null) {
                  result = lotResult
                } else if (confirmed.actionType === 'create_crop_cycle') {
                  result = await executeConfirmedCropCycle(user, confirmed.payload)
                } else if (confirmed.actionType === 'create_livestock_batch') {
                  result = await executeConfirmedLivestockBatch(user, confirmed.payload)
                } else {
                  result = `Draft type "${confirmed.actionType}" — finish in Telegram (Confirm button) or the web app.`
                }
              }
            }
          }
        }
      } catch (err) {
        result = err instanceof Error ? err.message : 'Could not apply draft'
      }
      await sendWhatsAppText(phone, result).catch(() => undefined)
      return
    }
  }

  const taskIntent = parseCreateTaskIntent(text)
  if (taskIntent) {
    const prepared = await prepareCreateTaskDraft({
      user,
      title: taskIntent.title,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(
      phone,
      `${prepared.preview}\n\n${WA_CONFIRM_HINT}`,
    ).catch(() => undefined)
    return
  }

  const censusIntent = parseCensusIntent(text)
  if (censusIntent) {
    const prepared = await prepareCensusDraft({
      user,
      ...censusIntent,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, withCreatePlotHint(prepared.error)).catch(() => undefined)
      return
    }
    await sendWhatsAppText(
      phone,
      `${prepared.preview}\n\n${WA_CONFIRM_HINT}`,
    ).catch(() => undefined)
    return
  }

  const assetCountIntent = parseAssetCountIntent(text)
  if (assetCountIntent) {
    const prepared = await prepareAssetCountDraft({
      user,
      ...assetCountIntent,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(
      phone,
      `${prepared.preview}\n\n${WA_CONFIRM_HINT}`,
    ).catch(() => undefined)
    return
  }

  const cropIntent = parseCropCycleIntent(text)
  if (cropIntent) {
    if (!canAssignTasks(user)) {
      await sendWhatsAppText(phone, 'Only Admin or Supervisor can create crop cycles.').catch(() => undefined)
      return
    }
    const plot = await resolvePlotByName(user.farmId, cropIntent.plotName)
    if (!plot) {
      await sendWhatsAppText(
        phone,
        withCreatePlotHint(
          `Block "${cropIntent.plotName}" not found. Use the exact plot name from Zones.`,
        ),
      ).catch(() => undefined)
      return
    }
    await storeActionDraft({
      userId: user.id,
      farmId: user.farmId,
      actionType: 'create_crop_cycle',
      payload: {
        plotId: plot.id,
        plotName: plot.name,
        cropType: cropIntent.cropType,
        plantedAt: new Date(cropIntent.plantedAt).toISOString(),
        expectedHarvestAt: cropIntent.expectedHarvestAt
          ? new Date(cropIntent.expectedHarvestAt).toISOString()
          : null,
        expectedYieldKg: cropIntent.expectedYieldKg ?? null,
      },
      channel: 'whatsapp',
      externalChatId: phone,
    })
    await sendWhatsAppText(
      phone,
      [
        'Draft crop cycle ready:',
        `${cropIntent.cropType} on ${plot.name}, planted ${cropIntent.plantedAt}`,
        '',
        WA_CONFIRM_HINT,
      ].join('\n'),
    ).catch(() => undefined)
    return
  }

  const livestockIntent = parseLivestockBatchIntent(text)
  if (livestockIntent) {
    if (!canAssignTasks(user)) {
      await sendWhatsAppText(phone, 'Only Admin or Supervisor can create livestock batches.').catch(
        () => undefined,
      )
      return
    }
    let plotId: string | null = null
    let plotName: string | null = null
    if (livestockIntent.plotName) {
      const plot = await resolvePlotByName(user.farmId, livestockIntent.plotName)
      if (!plot) {
        await sendWhatsAppText(
          phone,
          withCreatePlotHint(
            `Plot "${livestockIntent.plotName}" not found. Omit plot= or use exact name.`,
          ),
        ).catch(() => undefined)
        return
      }
      plotId = plot.id
      plotName = plot.name
    }
    await storeActionDraft({
      userId: user.id,
      farmId: user.farmId,
      actionType: 'create_livestock_batch',
      payload: {
        name: livestockIntent.name,
        species: livestockIntent.species,
        headCount: livestockIntent.headCount,
        plotId,
        plotName,
        acquiredAt: new Date(livestockIntent.acquiredAt).toISOString(),
      },
      channel: 'whatsapp',
      externalChatId: phone,
    })
    await sendWhatsAppText(
      phone,
      [
        'Draft livestock batch ready:',
        `${livestockIntent.name} · ${livestockIntent.species} · ${livestockIntent.headCount} head`,
        '',
        WA_CONFIRM_HINT,
      ].join('\n'),
    ).catch(() => undefined)
    return
  }

  const stockMoveIntent = parseStockMoveIntent(text)
  if (stockMoveIntent) {
    const prepared = await prepareStockMoveDraft({
      user,
      ...stockMoveIntent,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, `${prepared.preview}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  const openingCountIntent = parseOpeningCountIntent(text)
  if (openingCountIntent) {
    const prepared = await prepareOpeningCountDraft({
      user,
      ...openingCountIntent,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, `${prepared.preview}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  const lowStockAckIntent = parseLowStockAckIntent(text)
  if (lowStockAckIntent) {
    const prepared = await prepareLowStockAckDraft({
      user,
      itemQuery: lowStockAckIntent.itemQuery,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, `${prepared.preview}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  const createZoneIntent = parseCreateZoneIntent(text)
  if (createZoneIntent) {
    const prepared = await prepareCreateZoneDraft({
      user,
      ...createZoneIntent,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, `${prepared.preview}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  const createPlotIntent = parseCreatePlotIntent(text)
  if (createPlotIntent) {
    const prepared = await prepareCreatePlotDraft({
      user,
      ...createPlotIntent,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, `${prepared.preview}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  const livestockLogIntent = parseLivestockLogIntent(text)
  if (livestockLogIntent) {
    const prepared = await prepareLivestockLogDraft({
      user,
      ...livestockLogIntent,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, `${prepared.preview}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  if (lower === 'lots' || lower === '/lots') {
    await sendWhatsAppText(phone, await formatLotsToPackMessage(user.farmId)).catch(() => undefined)
    return
  }

  const packMatch = text.match(/^(?:pack|lot)\s+(\S+)/i)
  if (packMatch) {
    const prepared = await startLotEnrichDraft(user, packMatch[1], {
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, `${prepared.preview}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  const enrichApply = await applyLotEnrichText(user, text)
  if (enrichApply.handled) {
    await sendWhatsAppText(phone, `${enrichApply.reply}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  const verifyLotIntent = parseVerifyLotIntent(text)
  if (verifyLotIntent) {
    const prepared = await prepareVerifyLotDraft({
      user,
      ...verifyLotIntent,
      channel: 'whatsapp',
      externalChatId: phone,
    })
    if (!prepared.ok) {
      await sendWhatsAppText(phone, prepared.error).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, `${prepared.preview}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
    return
  }

  const printQrMatch = text.trim().match(/^(?:\/)?(?:printqr|print\s*qr|label)(?:\s+(\S+))?$/i)
  if (printQrMatch) {
    if (!canManageOrders(user)) {
      await sendWhatsAppText(
        phone,
        'Only Admin, Supervisor, or Sales can print box QR labels.',
      ).catch(() => undefined)
      return
    }
    const code = printQrMatch[1]
    if (!code) {
      const lots = await listRecentPrintableLots(user.farmId, 8)
      if (!lots.length) {
        await sendWhatsAppText(phone, 'No harvest lots yet.').catch(() => undefined)
        return
      }
      const lines = lots.map(
        (lot, i) => `${i + 1}. ${lot.lotCode} — ${lot.productName}`,
      )
      await sendWhatsAppText(
        phone,
        `Print box QR — reply:\n/printqr LOT-CODE\n\nRecent lots:\n${lines.join('\n')}`,
      ).catch(() => undefined)
      return
    }
    const lot = await findPrintableLotByCode(user.farmId, code)
    if (!lot) {
      await sendWhatsAppText(phone, `Lot not found: ${code}`).catch(() => undefined)
      return
    }
    try {
      const { png, publicUrl, labelUrl } = await buildLotQrPng(lot)
      await sendWhatsAppImage(phone, png, {
        filename: `${lot.lotCode}-qr.png`,
        caption: [
          `Box label · ${lot.lotCode}`,
          'Print this QR on the delivery box.',
          `Printable: ${labelUrl}`,
          `Scan opens: ${publicUrl}`,
        ].join('\n'),
      })
    } catch {
      await sendWhatsAppText(phone, 'Could not send QR image. Try again.').catch(() => undefined)
    }
    return
  }

  if (lower === 'handover' || lower === '/handover') {
    try {
      const progress = await getHandoverProgress(user.farmId)
      await sendWhatsAppText(phone, formatHandoverProgressText(progress)).catch(() => undefined)
    } catch {
      await sendWhatsAppText(phone, 'Could not load handover progress.').catch(() => undefined)
    }
    return
  }

  const opsCmd = await tryHandleStaffOpsCommand({
    actor: toActor(dbUser),
    text,
  })
  if (opsCmd.handled) {
    await sendWhatsAppText(
      phone,
      voicePrefix(
        opts,
        text,
        flattenPickerReply(opsCmd.reply ?? 'Done.', opsCmd.replyMarkup),
      ),
    ).catch(() => undefined)
    return
  }

  if (canManageOrders(user)) {
    const orderCmd = await tryHandleStaffOrderCommand({
      actor: toActor(dbUser),
      text,
    })
    if (orderCmd.handled) {
      await sendWhatsAppText(
        phone,
        voicePrefix(
          opts,
          text,
          flattenPickerReply(orderCmd.reply ?? 'Done.', orderCmd.replyMarkup),
        ),
      ).catch(() => undefined)
      return
    }
  }

  // First-time language nudge if still default and they haven't set it (soft).
  if (dbUser.preferredLocale === 'en' && /^(hi|hello)$/i.test(text.trim())) {
    await sendWhatsAppText(
      phone,
      `${languagePromptMessage('en')}\n\nReply: lang en | lang yo | lang pcm | lang fr`,
    ).catch(() => undefined)
  }

  if (!opts?.alreadyLogged) {
    await recordChatMessage({
      farmId: user.farmId,
      userId: user.id,
      entityType: ENTITY,
      messageId: msg.id,
      text,
      role: 'user',
      direction: 'inbound',
    })
  }

  const reply = await answerText(user, text, ENTITY, dbUser.preferredLocale)
  await deliverButlerReply({
    user,
    target: { channel: 'whatsapp', to: phone },
    text: voicePrefix(opts, text, reply),
    inboundWasVoice: !!opts?.inboundWasVoice,
    entityType: ENTITY,
  })

  if (dbUser.role === 'field_worker' && looksUrgent(text)) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ Urgent report from ${user.name} (WhatsApp):\n\n"${text.slice(0, 300)}"\n\nButler replied with guidance. Please review in Trovara OS.`,
      { actorUserId: user.id, reason: 'urgent_keyword' },
    )
  }
}

async function handleImage(dbUser: DbUser, msg: InboundMessage): Promise<void> {
  const user = toSessionUser(dbUser)
  const phone = normalizePhone(msg.from)
  const caption = msg.image?.caption?.trim() ?? ''

  if (!checkButlerRateLimit(user.id)) {
    await sendWhatsAppText(phone, BUTLER_RATE_LIMIT_MSG).catch(() => undefined)
    return
  }

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: msg.id,
    text: caption ? `[photo] ${caption}` : '[photo]',
    role: 'user',
    direction: 'inbound',
    extra: { kind: 'image', mediaId: msg.image?.id },
  })

  // Attach to pending enrich_lot draft before diagnostic photo path.
  try {
    const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
    const attached = await attachPhotoToLotEnrichDraft(user, dataUrl)
    if (attached.ok) {
      await sendWhatsAppText(
        phone,
        `Photo attached to lot draft. ${WA_CONFIRM_HINT}`,
      ).catch(() => undefined)
      return
    }
  } catch {
    // Fall through — other caption handlers may still apply.
  }

  if (canManageOrders(user) && /(?:delivered|deliver)\s+\S+/i.test(caption)) {
    try {
      const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
      const photoUrl = await processEvidenceValue(user.farmId, dataUrl)
      const orderCmd = await tryHandleStaffOrderCommand({
        actor: toActor(dbUser),
        text: caption,
        deliveryPhotoUrl: photoUrl,
      })
      if (orderCmd.handled) {
        await sendWhatsAppText(phone, orderCmd.reply ?? 'Done.').catch(() => undefined)
        return
      }
    } catch {
      await sendWhatsAppText(phone, 'Could not save delivery photo. Please resend.').catch(() => undefined)
      return
    }
  }

  if (/^(?:done|complete|finish|start|taskstart)\b/i.test(caption)) {
    try {
      const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
      const photoUrl = await processEvidenceValue(user.farmId, dataUrl)
      const opsCmd = await tryHandleStaffOpsCommand({
        actor: toActor(dbUser),
        text: caption,
        photoUrl,
      })
      if (opsCmd.handled) {
        await sendWhatsAppText(
          phone,
          flattenPickerReply(opsCmd.reply ?? 'Done.', opsCmd.replyMarkup),
        ).catch(() => undefined)
        return
      }
    } catch {
      await sendWhatsAppText(phone, 'Could not save task photo. Please resend.').catch(() => undefined)
      return
    }
  }

  let reply: string
  try {
    const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
    reply = await answerPhoto(caption, dataUrl, dbUser.preferredLocale)
  } catch {
    reply = 'I could not open that photo. Please resend a clear, well-lit picture of the plant or animal.'
  }
  await deliverButlerReply({
    user,
    target: { channel: 'whatsapp', to: phone },
    text: reply,
    inboundWasVoice: false,
    entityType: ENTITY,
  })

  if (dbUser.role === 'field_worker' && caption && looksUrgent(caption)) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ ${user.name} sent a photo on WhatsApp with note: "${caption.slice(0, 200)}". Butler sent a diagnosis. Please review.`,
      { actorUserId: user.id, reason: 'urgent_photo' },
    )
  }
}

async function handleAudio(dbUser: DbUser, msg: InboundMessage): Promise<void> {
  const user = toSessionUser(dbUser)
  const phone = normalizePhone(msg.from)

  if (!checkButlerRateLimit(user.id)) {
    await sendWhatsAppText(phone, BUTLER_RATE_LIMIT_MSG).catch(() => undefined)
    return
  }

  let transcript: string | null = null
  try {
    const { buffer, filename } = await downloadWhatsAppMediaBuffer(msg.audio!.id)
    transcript = await transcribeVoice(buffer, filename)
  } catch {
    transcript = null
  }

  if (!transcript) {
    await deliverButlerReply({
      user,
      target: { channel: 'whatsapp', to: phone },
      text: voiceNotUnderstoodMessage(staffLocale(dbUser.preferredLocale)),
      inboundWasVoice: true,
      entityType: ENTITY,
    })
    return
  }

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: msg.id,
    text: transcript,
    role: 'user',
    direction: 'inbound',
    extra: { kind: 'voice' },
  })

  // Route voice through the same structured command path as text.
  await handleText(dbUser, msg, transcript, {
    inboundWasVoice: true,
    alreadyLogged: true,
  })
}

export async function handleInboundWhatsApp(payload: unknown): Promise<{ handled: number }> {
  const body = payload as {
    entry?: {
      changes?: {
        value?: {
          messages?: InboundMessage[]
          metadata?: { phone_number_id?: string }
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
        const dbUser = await findUserByPhone(phone)

        if (!dbUser) {
          console.log(`WhatsApp inbound from unknown phone ${phone} (type ${msg.type})`)
          continue
        }

        try {
          if (msg.type === 'text' && msg.text?.body) {
            await handleText(dbUser, msg, msg.text.body.trim())
            handled++
          } else if (msg.type === 'image' && msg.image?.id) {
            await handleImage(dbUser, msg)
            handled++
          } else if (msg.type === 'audio' && msg.audio?.id) {
            await handleAudio(dbUser, msg)
            handled++
          } else {
            await sendWhatsAppText(
              phone,
              'I can read text, voice notes and photos. Please send any of those.',
            ).catch(() => undefined)
          }
        } catch (err) {
          console.error('WhatsApp inbound handling error:', err)
        }
      }
    }
  }

  return { handled }
}
