import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import type { SessionUser } from './session.js'
import {
  downloadWhatsAppMedia,
  downloadWhatsAppMediaBuffer,
  sendWhatsAppText,
} from './whatsapp-meta.js'
import { answerPhoto, answerText, recordChatMessage, transcribeVoice } from './butler-core.js'
import { checkButlerRateLimit } from './butler-rate-limit.js'
import { deliverButlerReply } from './butler-reply.js'
import { looksUrgent, notifyOwner } from './farm-notify.js'
import { voiceNotUnderstoodMessage } from './reply-locale.js'

const ENTITY = 'whatsapp_message'
const BUTLER_RATE_LIMIT_MSG = 'You have reached the hourly Butler limit. Please try again later.'

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

async function handleText(dbUser: DbUser, msg: InboundMessage, text: string): Promise<void> {
  const user = toSessionUser(dbUser)
  const phone = normalizePhone(msg.from)

  if (!checkButlerRateLimit(user.id)) {
    await sendWhatsAppText(phone, BUTLER_RATE_LIMIT_MSG).catch(() => undefined)
    return
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

  const reply = await answerText(user, text, ENTITY)
  await deliverButlerReply({
    user,
    target: { channel: 'whatsapp', to: phone },
    text: reply,
    inboundWasVoice: false,
    entityType: ENTITY,
  })

  if (dbUser.role !== 'owner' && looksUrgent(text)) {
    await notifyOwner(
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

  let reply: string
  try {
    const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
    reply = await answerPhoto(caption, dataUrl)
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

  if (dbUser.role !== 'owner' && caption && looksUrgent(caption)) {
    await notifyOwner(
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
      text: voiceNotUnderstoodMessage('en'),
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

  const reply = await answerText(user, transcript, ENTITY)
  await deliverButlerReply({
    user,
    target: { channel: 'whatsapp', to: phone },
    text: `🗣️ "${transcript}"\n\n${reply}`,
    inboundWasVoice: true,
    entityType: ENTITY,
  })

  if (dbUser.role !== 'owner' && looksUrgent(transcript)) {
    await notifyOwner(
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
