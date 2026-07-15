import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farmEvents } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { recordFarmEvent } from './farm-events.js'
import { buildFarmContext } from './farm-context.js'
import { buildButlerPrompt, VISUAL_DIAGNOSIS_PROMPT } from './ai-advisor.js'
import { sanitizeForLlm } from './sanitize-input.js'
import {
  completeChatHistory,
  completeChatVision,
  isLlmConfigured,
  transcribeAudio,
  type ChatMessage,
} from './llm.js'

export const HELP_TEXT = [
  'Trovara Butler - how I can help:',
  '• Ask anything: "How many birds are alive?", "What needs restocking?", "Revenue today?"',
  '• Report a problem: "3 broilers are weak with green droppings"',
  '• Send a photo of a sick plant or animal and I will diagnose it',
  '• Type "brief" for today\'s summary',
].join('\n')

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

async function buildBriefReply(user: SessionUser): Promise<string> {
  const context = await buildFarmContext(user)
  const { text } = await completeChatHistory(
    buildButlerPrompt(context, { plainText: true }),
    [],
    'Give me a very short briefing of what needs attention today. Max 5 short lines, use "-" bullets.',
  )
  return text
}

/**
 * Channel-agnostic text reply. Handles help/brief commands and otherwise runs the
 * butler with farm context + recent conversation memory. Does NOT record or send.
 */
export async function answerText(
  user: SessionUser,
  text: string,
  entityType: string,
): Promise<string> {
  const lower = text.toLowerCase().trim()

  if (!isLlmConfigured()) {
    return `Hi ${user.name.split(' ')[0]}, I received: "${text.slice(0, 160)}". The AI assistant is not switched on yet - a supervisor will follow up.`
  }
  if (['help', 'menu', 'hi', 'hello', '/start', 'start'].includes(lower)) {
    return HELP_TEXT
  }
  if (['brief', 'briefing', 'today'].includes(lower)) {
    try {
      return await buildBriefReply(user)
    } catch {
      return 'Could not build the briefing right now. Please try again shortly.'
    }
  }
  try {
    const context = await buildFarmContext(user)
    const history = await loadConversation(user.id, entityType)
    const sanitized = sanitizeForLlm(text)
    const userPrompt = `User message (untrusted): ${sanitized || '[empty after sanitization]'}`
    const { text: aiText } = await completeChatHistory(
      buildButlerPrompt(context, { plainText: true }),
      history,
      userPrompt,
    )
    return aiText
  } catch {
    return 'I had trouble answering that just now. Please try again in a moment.'
  }
}

/**
 * Transcribe a voice note (Yoruba / Pidgin / English auto-detected). Returns the
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
export async function answerPhoto(caption: string, imageDataUrl: string): Promise<string> {
  if (!isLlmConfigured()) {
    return 'Photo received. The AI diagnosis service is not switched on yet - a supervisor will review it.'
  }
  try {
    const safeCaption = sanitizeForLlm(caption)
    const { text } = await completeChatVision(
      VISUAL_DIAGNOSIS_PROMPT,
      `Farmer note: ${safeCaption || 'none'}. Diagnose what you see in this photo.`,
      [imageDataUrl],
    )
    return text
  } catch {
    return 'I could not open that photo. Please resend a clear, well-lit picture of the plant or animal.'
  }
}
