import { checkRateLimit } from './rate-limit.js'

const BUTLER_USER_MAX = 60
const BUTLER_USER_WINDOW_MS = 60 * 60 * 1000

const BUTLER_CHAT_MAX = 20
const BUTLER_CHAT_WINDOW_MS = 60 * 60 * 1000

/** 60 LLM butler invocations per hour for a linked user. */
export function checkButlerRateLimit(userId: string): boolean {
  return checkRateLimit(`butler:${userId}`, BUTLER_USER_MAX, BUTLER_USER_WINDOW_MS).allowed
}

/** 20 messages per hour for an unlinked chat (Telegram chat id, etc.). */
export function checkButlerChatRateLimit(chatKey: string): boolean {
  return checkRateLimit(`butler-chat:${chatKey}`, BUTLER_CHAT_MAX, BUTLER_CHAT_WINDOW_MS).allowed
}
