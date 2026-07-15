import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { recordChatMessage } from './butler-core.js'
import { synthesizeSpeech } from './llm.js'
import { sendTelegramMessage, sendTelegramVoice } from './telegram.js'
import { sendWhatsAppAudio, sendWhatsAppText } from './whatsapp-meta.js'

export type ButlerTtsMode = 'off' | 'voice_replies' | 'always'

/**
 * Telegram/WhatsApp render plain text, so any markdown the model still emits
 * (bold, code, headings, pipe tables) shows literally and looks broken. Strip the
 * markers and flatten pipe tables into " · " lines so replies read cleanly.
 */
export function toPlainChatText(input: string): string {
  const outLines: string[] = []
  for (const raw of input.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const bars = (line.match(/\|/g) ?? []).length
    if (bars >= 2) {
      const compact = line.replace(/[|\s:]/g, '')
      // Skip markdown table separator rows like | --- | --- |
      if (compact.length > 0 && /^-+$/.test(compact)) continue
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter((c) => c.length > 0)
      if (cells.length > 0) {
        outLines.push(cells.join(' · '))
        continue
      }
    }
    outLines.push(line)
  }
  return outLines
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^(\s*)[*+]\s+/gm, '$1- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const VALID_TTS_MODES: ButlerTtsMode[] = ['off', 'voice_replies', 'always']

function parseTtsMode(raw: string | null | undefined): ButlerTtsMode | null {
  const candidate = (raw ?? '').trim().toLowerCase()
  return VALID_TTS_MODES.includes(candidate as ButlerTtsMode)
    ? (candidate as ButlerTtsMode)
    : null
}

function envDefaultMode(): ButlerTtsMode {
  return parseTtsMode(process.env.BUTLER_TTS_MODE) ?? 'voice_replies'
}

export async function getButlerTtsMode(userId: string): Promise<ButlerTtsMode> {
  const [user] = await db.select({ mode: users.butlerTtsMode }).from(users).where(eq(users.id, userId)).limit(1)
  return parseTtsMode(user?.mode) ?? envDefaultMode()
}

export async function setButlerTtsMode(userId: string, mode: ButlerTtsMode): Promise<void> {
  await db.update(users).set({ butlerTtsMode: mode }).where(eq(users.id, userId))
}

export async function handleTelegramVoiceCommand(
  user: SessionUser,
  chatId: number,
  text: string,
): Promise<boolean> {
  const match = text.trim().toLowerCase().match(/^\/voice\s+(off|voice|always)$/)
  if (!match) return false

  const value = match[1] as 'off' | 'voice' | 'always'
  const mode: ButlerTtsMode = value === 'voice' ? 'voice_replies' : value
  await setButlerTtsMode(user.id, mode)

  const labels: Record<ButlerTtsMode, string> = {
    off: 'off',
    voice_replies: 'voice replies only when you send voice notes',
    always: 'voice replies for all Butler answers',
  }
  await sendTelegramMessage(chatId, `Voice replies set to: ${labels[mode]}.`)
  return true
}

function shouldSendVoice(mode: ButlerTtsMode, inboundWasVoice: boolean): boolean {
  if (mode === 'off') return false
  if (mode === 'always') return true
  return inboundWasVoice
}

type ButlerReplyTarget =
  | { channel: 'telegram'; chatId: number | string }
  | { channel: 'whatsapp'; to: string }

export async function deliverButlerReply(params: {
  user: SessionUser
  target: ButlerReplyTarget
  text: string
  inboundWasVoice: boolean
  entityType: string
}): Promise<void> {
  const { user, target, inboundWasVoice, entityType } = params
  const text = toPlainChatText(params.text)

  try {
    if (target.channel === 'telegram') {
      await sendTelegramMessage(target.chatId, text)
    } else {
      await sendWhatsAppText(target.to, text)
    }
    await recordChatMessage({
      farmId: user.farmId,
      userId: user.id,
      entityType,
      messageId: `${target.channel}-out-${Date.now()}`,
      text,
      role: 'assistant',
      direction: 'outbound',
    })
  } catch {
    return
  }

  let mode = envDefaultMode()
  try {
    mode = await getButlerTtsMode(user.id)
  } catch {
    mode = envDefaultMode()
  }
  if (!shouldSendVoice(mode, inboundWasVoice)) return

  try {
    const audio = await synthesizeSpeech(text)
    if (target.channel === 'telegram') {
      await sendTelegramVoice(target.chatId, audio)
    } else {
      await sendWhatsAppAudio(target.to, audio)
    }
  } catch {
    // TTS is optional; text reply already sent.
  }
}
