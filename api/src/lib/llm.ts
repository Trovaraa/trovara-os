import { logApiEvent } from './api-log.js'

export type LlmConfig = {
  apiKey: string
  baseUrl: string
  model: string
}

/** Private/reserved hostnames blocked for LLM_BASE_URL in production. */
const BLOCKED_LLM_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
])

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase()
  return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
}

/**
 * Validates LLM_BASE_URL. In production: HTTPS only, blocks localhost/private IPs
 * and link-local/metadata hostnames to reduce SSRF risk.
 */
export function validateLlmBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: 'LLM_BASE_URL is empty' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'LLM_BASE_URL is not a valid URL' }
  }

  const isProd = process.env.NODE_ENV === 'production'
  if (isProd && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'LLM_BASE_URL must use https in production' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'LLM_BASE_URL must be http or https' }
  }

  const host = parsed.hostname.toLowerCase()
  if (BLOCKED_LLM_HOSTS.has(host)) {
    return { ok: false, reason: `LLM_BASE_URL host "${host}" is not allowed` }
  }
  if (isPrivateIpv4(host) || isPrivateIpv6(host)) {
    return { ok: false, reason: `LLM_BASE_URL host "${host}" resolves to a private address` }
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: `LLM_BASE_URL host "${host}" is not allowed` }
  }

  const normalized = trimmed.replace(/\/+$/, '')
  return { ok: true, url: normalized }
}

function readEnvKey(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  return null
}

export function getLlmConfig(): LlmConfig | null {
  const apiKey = readEnvKey('OPENAI_API_KEY', 'LLM_API_KEY')
  if (!apiKey) return null
  const rawBase = process.env.LLM_BASE_URL?.trim() || 'https://api.openai.com/v1'
  const validated = validateLlmBaseUrl(rawBase)
  if (!validated.ok) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`FATAL: ${validated.reason}`)
      process.exit(1)
    }
    console.warn(`WARNING: ${validated.reason} - using OpenAI default`)
    return {
      apiKey,
      baseUrl: 'https://api.openai.com/v1',
      model: process.env.LLM_MODEL?.trim() || 'gpt-4o-mini',
    }
  }
  return {
    apiKey,
    baseUrl: validated.url,
    model: process.env.LLM_MODEL?.trim() || 'gpt-4o-mini',
  }
}

export function isLlmConfigured(): boolean {
  return getLlmConfig() !== null
}

type ChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function prepareTextForTts(text: string): string {
  return stripMarkdown(text).slice(0, 4000)
}

/**
 * Newer reasoning models (gpt-5 family, o-series) only accept the default
 * temperature, and reject an explicit `temperature` value. Older chat models
 * (gpt-4o, gpt-4, gpt-3.5) accept a custom one for steadier, factual output.
 */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/i.test(model.trim())
}

/**
 * Reasoning models "think" before answering, which is slow for a chat butler.
 * `reasoning_effort` (minimal | low | medium | high) trades depth for speed.
 * Default to "low" for snappy replies; override with LLM_REASONING_EFFORT.
 */
function reasoningEffort(): string {
  const v = process.env.LLM_REASONING_EFFORT?.trim().toLowerCase()
  return ['minimal', 'low', 'medium', 'high'].includes(v ?? '') ? (v as string) : 'low'
}

async function callChat(
  config: LlmConfig,
  messages: unknown[],
): Promise<{ text: string; model: string }> {
  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
  }
  if (isReasoningModel(config.model)) {
    payload.reasoning_effort = reasoningEffort()
  } else {
    payload.temperature = 0.2
  }

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error('LLM request failed:', { status: res.status, body: body.slice(0, 500) })
    logApiEvent('llm_error', { status: res.status, endpoint: 'chat/completions' })
    throw new Error(`LLM request failed (${res.status})`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('LLM returned empty response')
  return { text, model: config.model }
}

export async function completeChat(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string; model: string }> {
  const config = getLlmConfig()
  if (!config) {
    throw new Error('LLM not configured - set OPENAI_API_KEY or LLM_API_KEY in .env')
  }
  return callChat(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ])
}

/** Multi-turn chat with optional prior history (for conversational copilot/butler). */
export async function completeChatHistory(
  systemPrompt: string,
  history: ChatMessage[],
  userPrompt: string,
): Promise<{ text: string; model: string }> {
  const config = getLlmConfig()
  if (!config) {
    throw new Error('LLM not configured - set OPENAI_API_KEY or LLM_API_KEY in .env')
  }
  return callChat(config, [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userPrompt },
  ])
}

/**
 * Vision chat - pass one or more images (data URLs or https URLs) plus text.
 * Requires a vision-capable model (gpt-4o-mini and gpt-4o both support it).
 */
export async function completeChatVision(
  systemPrompt: string,
  userPrompt: string,
  imageUrls: string[],
): Promise<{ text: string; model: string }> {
  const config = getLlmConfig()
  if (!config) {
    throw new Error('LLM not configured - set OPENAI_API_KEY or LLM_API_KEY in .env')
  }

  const content: unknown[] = [{ type: 'text', text: userPrompt }]
  for (const url of imageUrls) {
    content.push({ type: 'image_url', image_url: { url } })
  }

  return callChat(config, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content },
  ])
}

/**
 * Transcribe a voice note to text. Auto-detects language so Yoruba, Nigerian
 * Pidgin, French and English all work (no language hint forced). Returns plain text.
 * Uses the OpenAI audio/transcriptions endpoint (gpt-4o-transcribe by default).
 */
export async function transcribeAudio(audio: Buffer, filename: string): Promise<string> {
  const config = getLlmConfig()
  if (!config) {
    throw new Error('LLM not configured - set OPENAI_API_KEY or LLM_API_KEY in .env')
  }

  const model = process.env.LLM_TRANSCRIBE_MODEL?.trim() || 'gpt-4o-transcribe'

  // The API accepts a fixed set of extensions. Telegram voice notes arrive as
  // ".oga" (Ogg/Opus) which is rejected even though ".ogg" - the same container -
  // is supported, so normalise known aliases.
  const safeName = filename.replace(/\.oga$/i, '.ogg').replace(/\.opus$/i, '.ogg')

  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(audio)]), safeName)
  form.append('model', model)
  // A short prompt nudges the model to keep Yoruba/Pidgin/French words rather than
  // "correcting" them into English.
  form.append('prompt', 'Farm voice note from Nigeria or francophone West Africa. May be in Yoruba, Nigerian Pidgin, French, or English.')

  const res = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  })

  if (!res.ok) {
    const body = await res.text()
    console.error('Transcription failed:', { status: res.status, body: body.slice(0, 500) })
    logApiEvent('llm_error', { status: res.status, endpoint: 'audio/transcriptions' })
    throw new Error(`Transcription failed (${res.status})`)
  }

  const data = (await res.json()) as { text?: string }
  return (data.text ?? '').trim()
}

/**
 * Synthesize speech from plain text using OpenAI's /audio/speech endpoint.
 * Markdown is stripped and text is capped to 4k chars for predictable latency/cost.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const config = getLlmConfig()
  if (!config) {
    throw new Error('LLM not configured - set OPENAI_API_KEY or LLM_API_KEY in .env')
  }

  const model = process.env.LLM_TTS_MODEL?.trim() || 'tts-1'
  const voice = process.env.LLM_TTS_VOICE?.trim() || 'alloy'
  const format = process.env.LLM_TTS_FORMAT?.trim() || 'mp3'
  const input = prepareTextForTts(text)
  if (!input) throw new Error('No text available for speech synthesis')

  const res = await fetch(`${config.baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      voice,
      response_format: format,
      input,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    console.error('TTS failed:', { status: res.status, body: body.slice(0, 500) })
    logApiEvent('llm_error', { status: res.status, endpoint: 'audio/speech' })
    throw new Error(`TTS failed (${res.status})`)
  }

  return Buffer.from(await res.arrayBuffer())
}

export type { ChatMessage }

/** Extract and parse JSON even when the model wraps it in markdown fences. */
export function parseJsonFromLlm<T>(raw: string): T {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced?.[1] ?? trimmed).trim()
  try {
    return JSON.parse(candidate) as T
  } catch {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1)) as T
    }
    throw new Error('LLM response was not valid JSON')
  }
}
