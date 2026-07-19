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
import { canManageOrders } from './rbac.js'
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
import {
  salesOpsHelp,
  staffOpsHelp,
  tryHandleStaffOpsCommand,
} from './staff-ops.js'
import { listIncompleteLots } from './harvest-lots.js'
import { formatHandoverProgressText, getHandoverProgress } from './handover-templates.js'
import { processEvidenceValue } from './evidence-store.js'
import type { PreferredLocale } from '../db/schema.js'

const ENTITY = 'whatsapp_message'
const BUTLER_RATE_LIMIT_MSG = 'You have reached the hourly Butler limit. Please try again later.'

function flattenPickerReply(reply: string, replyMarkup?: Record<string, unknown>): string {
  if (!replyMarkup || typeof replyMarkup !== 'object') return reply
  const kb = replyMarkup as {
    inline_keyboard?: Array<Array<{ text?: string }>>
  }
  const lines = (kb.inline_keyboard ?? []).flat().map((b) => b.text).filter(Boolean)
  if (!lines.length) return reply
  return `${reply}\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nReply with the command + id, e.g. /done TSK-ABCDEF`
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

async function handleText(dbUser: DbUser, msg: InboundMessage, text: string): Promise<void> {
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
    await sendWhatsAppText(phone, orderCommandHelp(next)).catch(() => undefined)
    return
  }

  if (lower === 'orders' || lower === '/orders') {
    await sendWhatsAppText(phone, orderCommandHelp(locale)).catch(() => undefined)
    if (dbUser.role === 'sales') {
      await sendWhatsAppText(phone, salesOpsHelp(locale)).catch(() => undefined)
    }
    return
  }

  if (lower === 'ops' || lower === '/ops' || lower === 'help' || lower === '/help') {
    await sendWhatsAppText(phone, staffOpsHelp(locale, dbUser.role)).catch(() => undefined)
    if (canManageOrders(user)) {
      await sendWhatsAppText(phone, orderCommandHelp(locale)).catch(() => undefined)
    }
    return
  }

  if (lower === 'lots' || lower === '/lots') {
    const lots = await listIncompleteLots(user.farmId)
    if (!lots.length) {
      await sendWhatsAppText(phone, 'No lots waiting for pack details.').catch(() => undefined)
      return
    }
    const lines = lots.map(
      (lot, i) =>
        `${i + 1}. ${lot.lotCode} — ${lot.productName} (${lot.quantityKg} ${lot.unit})`,
    )
    await sendWhatsAppText(
      phone,
      `Lots to pack:\n${lines.join('\n')}\n\nPack/enrich in Telegram staff bot or Traceability in the app.`,
    ).catch(() => undefined)
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
      flattenPickerReply(opsCmd.reply ?? 'Done.', opsCmd.replyMarkup),
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
        flattenPickerReply(orderCmd.reply ?? 'Done.', orderCmd.replyMarkup),
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

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: msg.id,
    text,
    role: 'user',
    direction: 'inbound',
  })

  const reply = await answerText(user, text, ENTITY, dbUser.preferredLocale)
  await deliverButlerReply({
    user,
    target: { channel: 'whatsapp', to: phone },
    text: reply,
    inboundWasVoice: false,
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

  if (/^(?:done|complete|finish)\b/i.test(caption)) {
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

  const opsCmd = await tryHandleStaffOpsCommand({
    actor: toActor(dbUser),
    text: transcript,
  })
  if (opsCmd.handled) {
    await sendWhatsAppText(
      phone,
      `🗣️ "${transcript}"\n\n${flattenPickerReply(opsCmd.reply ?? 'Done.', opsCmd.replyMarkup)}`,
    ).catch(() => undefined)
    return
  }

  if (canManageOrders(user)) {
    const orderCmd = await tryHandleStaffOrderCommand({
      actor: toActor(dbUser),
      text: transcript,
    })
    if (orderCmd.handled) {
      await sendWhatsAppText(
        phone,
        `🗣️ "${transcript}"\n\n${flattenPickerReply(orderCmd.reply ?? 'Done.', orderCmd.replyMarkup)}`,
      ).catch(() => undefined)
      return
    }
  }

  const reply = await answerText(user, transcript, ENTITY, dbUser.preferredLocale)
  await deliverButlerReply({
    user,
    target: { channel: 'whatsapp', to: phone },
    text: `🗣️ "${transcript}"\n\n${reply}`,
    inboundWasVoice: true,
    entityType: ENTITY,
  })

  if (dbUser.role === 'field_worker' && looksUrgent(transcript)) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ Urgent voice note from ${user.name} (WhatsApp):\n\n"${transcript.slice(0, 300)}"\n\nButler replied with guidance. Please review in Trovara OS.`,
      { actorUserId: user.id, reason: 'urgent_voice' },
    )
  }
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
