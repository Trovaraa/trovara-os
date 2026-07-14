import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { recordFarmEvent } from './farm-events.js'
import { verifyAndConsumeLinkCode, resolveActiveTelegramLink } from './butler-link-codes.js'
import { answerPhoto, answerText, recordChatMessage, transcribeVoice } from './butler-core.js'
import { checkButlerChatRateLimit, checkButlerRateLimit } from './butler-rate-limit.js'
import { deliverButlerReply, handleTelegramVoiceCommand } from './butler-reply.js'
import { looksUrgent, notifyOwnerTelegram } from './farm-notify.js'
import {
  downloadTelegramFile,
  downloadTelegramFileBuffer,
  getTelegramUpdates,
  isTelegramConfigured,
  sendTelegramMessage,
  type TelegramUpdate,
} from './telegram.js'

const ENTITY = 'telegram_message'
const LINK_ENTITY = 'telegram_link'
const BUTLER_RATE_LIMIT_MSG = 'You have reached the hourly Butler limit. Please try again later.'

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

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

async function linkChat(chatId: number, user: DbUser): Promise<void> {
  await recordFarmEvent({
    farmId: user.farmId,
    actorUserId: user.id,
    entityType: LINK_ENTITY,
    entityId: String(chatId),
    eventType: 'other',
    source: 'telegram',
    afterValue: { userId: user.id, chatId },
    metadata: { linkedAt: new Date().toISOString() },
  })
}

async function findUserByPhone(phone: string): Promise<DbUser | undefined> {
  const normalized = normalizePhone(phone)
  const all = await db
    .select()
    .from(users)
    .where(sql`${users.phone} IS NOT NULL AND ${users.phone} <> ''`)
  return all.find((u) => normalizePhone(u.phone ?? '') === normalized)
}

const LINK_PROMPT = [
  'Welcome to Trovara Butler 👋',
  '',
  'To connect your farm account, either:',
  '• Tap "Share my phone number" below (if your number is on your Trovara profile), or',
  '• Generate a link code in Trovara Settings → Connect Telegram, then send: /link CODE',
].join('\n')

const LINK_CODE_FAIL_MSG =
  'Invalid or expired link code. Generate a new code in Trovara Settings → Connect Telegram.'

async function handleLinkedText(dbUser: DbUser, chatId: number, messageId: number, text: string) {
  if (!checkButlerRateLimit(dbUser.id)) {
    await sendTelegramMessage(chatId, BUTLER_RATE_LIMIT_MSG)
    return
  }

  const user = toSessionUser(dbUser)
  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: `tg-${messageId}`,
    text,
    role: 'user',
    direction: 'inbound',
  })

  if (await handleTelegramVoiceCommand(user, chatId, text)) return

  const reply = await answerText(user, text, ENTITY)
  await deliverButlerReply({
    user,
    target: { channel: 'telegram', chatId },
    text: reply,
    inboundWasVoice: false,
    entityType: ENTITY,
  })

  if (dbUser.role !== 'owner' && looksUrgent(text)) {
    await notifyOwnerTelegram(
      user.farmId,
      `⚠️ Urgent report from ${user.name} (Telegram):\n\n"${text.slice(0, 300)}"\n\nButler replied with guidance. Please review in Trovara OS.`,
      { actorUserId: user.id, reason: 'urgent_keyword' },
    )
  }
}

async function handlePhoto(dbUser: DbUser, chatId: number, msg: NonNullable<TelegramUpdate['message']>) {
  if (!checkButlerRateLimit(dbUser.id)) {
    await sendTelegramMessage(chatId, BUTLER_RATE_LIMIT_MSG)
    return
  }

  const user = toSessionUser(dbUser)
  const caption = msg.caption?.trim() ?? ''
  const fileId = msg.photo?.[msg.photo.length - 1]?.file_id
  if (!fileId) return

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: `tg-${msg.message_id}`,
    text: caption ? `[photo] ${caption}` : '[photo]',
    role: 'user',
    direction: 'inbound',
    extra: { kind: 'image' },
  })

  let reply: string
  try {
    const dataUrl = await downloadTelegramFile(fileId)
    reply = await answerPhoto(caption, dataUrl)
  } catch {
    reply = 'I could not open that photo. Please resend a clear, well-lit picture of the plant or animal.'
  }
  await deliverButlerReply({
    user,
    target: { channel: 'telegram', chatId },
    text: reply,
    inboundWasVoice: false,
    entityType: ENTITY,
  })

  if (dbUser.role !== 'owner' && caption && looksUrgent(caption)) {
    await notifyOwnerTelegram(
      user.farmId,
      `⚠️ ${user.name} sent a photo on Telegram with note: "${caption.slice(0, 200)}". Butler sent a diagnosis. Please review.`,
      { actorUserId: user.id, reason: 'urgent_photo' },
    )
  }
}

async function handleVoice(dbUser: DbUser, chatId: number, msg: NonNullable<TelegramUpdate['message']>) {
  if (!checkButlerRateLimit(dbUser.id)) {
    await sendTelegramMessage(chatId, BUTLER_RATE_LIMIT_MSG)
    return
  }

  const user = toSessionUser(dbUser)
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id
  if (!fileId) return

  let transcript: string | null = null
  try {
    const { buffer, filename } = await downloadTelegramFileBuffer(fileId)
    transcript = await transcribeVoice(buffer, filename)
  } catch {
    transcript = null
  }

  if (!transcript) {
    await sendTelegramMessage(
      chatId,
      "I couldn't understand that voice note. Please try again, speak clearly, or type your message.",
    )
    return
  }

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: `tg-${msg.message_id}`,
    text: transcript,
    role: 'user',
    direction: 'inbound',
    extra: { kind: 'voice' },
  })

  const reply = await answerText(user, transcript, ENTITY)
  await deliverButlerReply({
    user,
    target: { channel: 'telegram', chatId },
    text: `🗣️ "${transcript}"\n\n${reply}`,
    inboundWasVoice: true,
    entityType: ENTITY,
  })

  if (dbUser.role !== 'owner' && looksUrgent(transcript)) {
    await notifyOwnerTelegram(
      user.farmId,
      `⚠️ Urgent voice note from ${user.name} (Telegram):\n\n"${transcript.slice(0, 300)}"\n\nButler replied with guidance. Please review in Trovara OS.`,
      { actorUserId: user.id, reason: 'urgent_voice' },
    )
  }
}

/** Process a single Telegram update (used by both webhook and polling). */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const msg = update.message
  if (!msg) return
  const chatId = msg.chat.id

  const linkedUser = await resolveActiveTelegramLink(chatId)

  if (!linkedUser) {
    if (!checkButlerChatRateLimit(String(chatId))) {
      await sendTelegramMessage(chatId, 'Too many messages — please wait before trying again.')
      return
    }

    if (msg.contact?.phone_number) {
      if (msg.contact.user_id !== msg.from?.id) {
        await sendTelegramMessage(
          chatId,
          'Please share your own phone number using the button below, not someone else\'s contact.',
        )
        await sendTelegramMessage(chatId, LINK_PROMPT, { withContactButton: true })
        return
      }

      const u = await findUserByPhone(msg.contact.phone_number)
      if (u) {
        await linkChat(chatId, u)
        await sendTelegramMessage(chatId, '✅ Connected successfully. Ask me anything, or type "help".')
      } else {
        await sendTelegramMessage(
          chatId,
          'That number is not on any Trovara profile. Ask the owner to add your phone, or use a link code from Settings.',
        )
      }
      return
    }

    const text = msg.text?.trim() ?? ''
    if (text.toLowerCase().startsWith('/link')) {
      const code = text.slice(5).trim()
      if (!code) {
        await sendTelegramMessage(chatId, LINK_CODE_FAIL_MSG)
        return
      }

      const u = await verifyAndConsumeLinkCode(code)
      if (u) {
        await linkChat(chatId, u)
        await sendTelegramMessage(chatId, '✅ Connected successfully. Ask me anything, or type "help".')
      } else {
        await sendTelegramMessage(chatId, LINK_CODE_FAIL_MSG)
      }
      return
    }

    await sendTelegramMessage(chatId, LINK_PROMPT, { withContactButton: true })
    return
  }

  try {
    if (msg.voice || msg.audio) {
      await handleVoice(linkedUser, chatId, msg)
    } else if (msg.photo?.length) {
      await handlePhoto(linkedUser, chatId, msg)
    } else if (msg.text) {
      await handleLinkedText(linkedUser, chatId, msg.message_id, msg.text.trim())
    } else {
      await sendTelegramMessage(chatId, 'I can read text, voice notes and photos. Send any of those.')
    }
  } catch (err) {
    console.error('Telegram update handling error:', err)
  }
}

export async function handleTelegramWebhook(payload: unknown): Promise<{ handled: number }> {
  await handleTelegramUpdate(payload as TelegramUpdate)
  return { handled: 1 }
}

let polling = false

export function startTelegramPolling(): void {
  if (polling || !isTelegramConfigured()) return
  if ((process.env.TELEGRAM_MODE ?? 'polling') !== 'polling') return
  polling = true

  let offset = 0
  console.log('Telegram butler: long-polling started')

  const loop = async () => {
    while (polling) {
      try {
        const updates = await getTelegramUpdates(offset)
        for (const u of updates) {
          offset = u.update_id + 1
          await handleTelegramUpdate(u)
        }
      } catch (err) {
        console.error('Telegram poll error:', err instanceof Error ? err.message : err)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  }
  void loop()
}
