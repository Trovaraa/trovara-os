import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmEvents } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { recordFarmEvent } from './farm-events.js'
import { buildFarmContext } from './farm-context.js'
import { buildButlerPrompt, buildVisualDiagnosisPrompt } from './ai-advisor.js'
import { ensureAdvisoryClose } from './advisory-close.js'
import { sanitizeForLlm } from './sanitize-input.js'
import {
  completeChatHistory,
  completeChatVision,
  isLlmConfigured,
  transcribeAudio,
  type ChatMessage,
} from './llm.js'
import {
  butlerAnswerFailedMessage,
  butlerBriefFailedMessage,
  butlerHelpText,
  butlerLlmOffMessage,
  butlerPhotoFailedMessage,
  butlerPhotoLlmOffMessage,
  resolveStaffReplyLocale,
  type ReplyLocale,
} from './reply-locale.js'
import { staffLocale } from './order-messages.js'
import { roleCommandHelp } from './role-menus.js'

/** @deprecated Prefer butlerHelpText(locale) - kept for callers that need English. */
export const HELP_TEXT = butlerHelpText('en')

/** Recent chat turns for this user on a given channel, oldest-first. */
export async function loadConversation(
  userId: string,
  entityType: string,
): Promise<ChatMessage[]> {
  const since = new Date(Date.now() - 2 * 60 * 60 * 1000)
  const rows = await db
    .select()
    .from(farmEvents)
    .where(
      and(
        eq(farmEvents.actorUserId, userId),
        eq(farmEvents.entityType, entityType),
        gte(farmEvents.createdAt, since),
      ),
    )
    .orderBy(desc(farmEvents.createdAt))
    .limit(8)

  const history: ChatMessage[] = []
  for (const row of rows.reverse()) {
    const v = row.afterValue as { text?: string; role?: string } | null
    if (!v?.text) continue
    history.push({
      role: v.role === 'assistant' ? 'assistant' : 'user',
      content: sanitizeForLlm(v.text),
    })
  }
  return history
}

export async function recordChatMessage(params: {
  farmId: string
  userId?: string
  entityType: string
  messageId: string
  text: string
  role: 'user' | 'assistant'
  direction: 'inbound' | 'outbound'
  extra?: Record<string, unknown>
}): Promise<void> {
  await recordFarmEvent({
    farmId: params.farmId,
    actorUserId: params.userId,
    entityType: params.entityType,
    entityId: params.messageId,
    eventType: 'other',
    source: params.entityType.startsWith('telegram') ? 'telegram' : 'whatsapp',
    afterValue: { text: sanitizeForLlm(params.text), role: params.role },
    metadata: { direction: params.direction, ...(params.extra ?? {}) },
  })
}

async function buildBriefReply(user: SessionUser, locale: ReplyLocale): Promise<string> {
  const context = await buildFarmContext(
    user,
    locale,
    'urgent work, risks, operating guidelines and actions needed today',
  )
  const { text } = await completeChatHistory(
    buildButlerPrompt(context, { plainText: true, replyLocale: locale }),
    [],
    'Give me a very short briefing of what needs attention today. Max 5 short lines, use "-" bullets.',
  )
  return text
}

/**
 * Channel-agnostic text reply. Handles help/brief commands and otherwise runs the
 * butler with farm context + recent conversation memory. Does NOT record or send.
 * When `localeHint` is the staff preferred_locale, all replies stay in that language.
 */
export async function answerText(
  user: SessionUser,
  text: string,
  entityType: string,
  localeHint?: string | null,
): Promise<string> {
  const lower = text.toLowerCase().trim()
  // Staff preferred language wins for the whole butler lifecycle (not message heuristics).
  const locale: ReplyLocale = resolveStaffReplyLocale(localeHint)

  if (!isLlmConfigured()) {
    return butlerLlmOffMessage(locale, user.name.split(' ')[0], text.slice(0, 160))
  }
  if (['help', 'menu', 'hi', 'hello', '/start', 'start', 'bonjour', 'salut', '/help'].includes(lower)) {
    return roleCommandHelp(staffLocale(localeHint), user.role)
  }
  if (['brief', 'briefing', 'today', 'bref'].includes(lower)) {
    try {
      return await buildBriefReply(user, locale)
    } catch {
      return butlerBriefFailedMessage(locale)
    }
  }
  try {
    const context = await buildFarmContext(user, locale, text)
    const history = await loadConversation(user.id, entityType)
    const sanitized = sanitizeForLlm(text)
    const userPrompt = `User message (untrusted): ${sanitized || '[empty after sanitization]'}`
    const { text: aiText } = await completeChatHistory(
      buildButlerPrompt(context, { plainText: true, replyLocale: locale }),
      history,
      userPrompt,
    )
    return aiText
  } catch {
    return butlerAnswerFailedMessage(locale)
  }
}

/**
 * Transcribe a voice note (Yoruba / Pidgin / French / English auto-detected). Returns the
 * transcript text, or null if transcription is unavailable/empty. The caller
 * then routes the transcript through answerText like a normal message.
 */
export async function transcribeVoice(
  audio: Buffer,
  filename: string,
): Promise<string | null> {
  if (!isLlmConfigured()) return null
  try {
    const text = await transcribeAudio(audio, filename)
    return text.trim() || null
  } catch (err) {
    console.error('Transcription error:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Channel-agnostic photo diagnosis. Does NOT record or send. */
export async function answerPhoto(
  caption: string,
  imageDataUrl: string,
  localeHint?: string | null,
): Promise<string> {
  const locale = resolveStaffReplyLocale(localeHint)
  if (!isLlmConfigured()) {
    return butlerPhotoLlmOffMessage(locale)
  }
  try {
    const safeCaption = sanitizeForLlm(caption)
    const { text } = await completeChatVision(
      buildVisualDiagnosisPrompt(locale),
      `Farmer note: ${safeCaption || 'none'}. Diagnose what you see in this photo.`,
      [imageDataUrl],
    )
    return ensureAdvisoryClose(text, locale, 'general')
  } catch {
    return butlerPhotoFailedMessage(locale)
  }
}
