const MAX_INBOUND_TEXT_LENGTH = 4000
const MAX_FARM_DATA_FIELD_LENGTH = 200

const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignore|bypass|override)\b.{0,40}\b(instruction|system|prompt|policy|rule)s?\b/gi,
  /\b(reveal|show|print|dump|leak)\b.{0,40}\b(system prompt|secret|api key|token|password|chain[- ]of[- ]thought)\b/gi,
  /(^|\n)\s*(system|developer)\s*:\s*/gi,
  /```[\s\S]*?```/g,
  /<\s*\/?\s*(system|assistant|developer|tool)\s*>/gi,
]

/** Matches task evidence image data URLs (jpeg/png/webp base64). */
export const EVIDENCE_IMAGE_DATA_URL_PATTERN =
  /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/

function applyInjectionPatterns(text: string): string {
  let cleaned = text
  for (const pattern of INJECTION_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ')
  }
  return cleaned.replace(/\s+/g, ' ').trim()
}

/**
 * Treat inbound chat content as untrusted input and remove obvious prompt-injection
 * fragments before passing it to the model.
 */
export function sanitizeInboundText(text: string): string {
  return applyInjectionPatterns(text ?? '').slice(0, MAX_INBOUND_TEXT_LENGTH)
}

/** Alias for inbound LLM-bound user text. */
export function sanitizeForLlm(text: string): string {
  return sanitizeInboundText(text)
}

/**
 * Sanitize stored farm-data strings before embedding in LLM context.
 * Strips control chars/newlines, runs injection patterns, truncates to 200 chars.
 */
export function sanitizeFarmDataField(text: string): string {
  const stripped = (text ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return applyInjectionPatterns(stripped).slice(0, MAX_FARM_DATA_FIELD_LENGTH)
}

export function isAllowedEvidenceImageDataUrl(url: string): boolean {
  return EVIDENCE_IMAGE_DATA_URL_PATTERN.test(url)
}

/** Matches browser MediaRecorder / chat voice clips (webm, ogg, mp4, mpeg, wav). */
export const AUDIO_DATA_URL_PATTERN =
  /^data:audio\/[\w.+-]+(?:;[\w.=+-]+)*;base64,[A-Za-z0-9+/=]+$/i

export function isAllowedAudioDataUrl(url: string): boolean {
  return AUDIO_DATA_URL_PATTERN.test(url)
}

/** Parse a data:audio/...;base64,... URL into bytes + a safe filename for OpenAI. */
export function parseAudioDataUrl(dataUrl: string): { buffer: Buffer; filename: string; mime: string } | null {
  const match = dataUrl.match(/^data:(audio\/[\w.+-]+(?:;[\w.=+-]+)*);base64,([A-Za-z0-9+/=]+)$/i)
  if (!match) return null
  const mimeFull = match[1].toLowerCase()
  const mime = mimeFull.split(';')[0]
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length) return null

  let ext = 'webm'
  if (mime.includes('ogg') || mime.includes('opus')) ext = 'ogg'
  else if (mime.includes('mp4') || mime.includes('m4a')) ext = 'm4a'
  else if (mime.includes('mpeg') || mime.includes('mp3')) ext = 'mp3'
  else if (mime.includes('wav')) ext = 'wav'
  else if (mime.includes('webm')) ext = 'webm'

  return { buffer, filename: `voice.${ext}`, mime }
}
