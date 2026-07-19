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

/**
 * Browser MediaRecorder clips (incl. iOS Safari).
 * Prefer parseAudioDataUrl / isAllowedAudioDataUrl — Safari often emits
 * `audio/mp4; codecs=…` (space after `;`) which breaks a naive regex.
 */
const ALLOWED_AUDIO_MIME = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/aac',
  'audio/x-m4a',
  'audio/m4a',
  'audio/caf',
  'audio/x-caf',
  // iOS sometimes labels AAC-in-MP4 as video/mp4 even for audio-only clips
  'video/mp4',
])

/** @deprecated Use isAllowedAudioDataUrl — kept for callers that only need a quick shape check. */
export const AUDIO_DATA_URL_PATTERN =
  /^data:(?:audio|video)\/[\w.+-]+(?:\s*;\s*[\w.+-]+=(?:"[^"]*"|'[^']*'|[\w.+-]+))*\s*;\s*base64\s*,[A-Za-z0-9+/=\s]+$/i

export function isAllowedAudioDataUrl(url: string): boolean {
  return parseAudioDataUrl(url) !== null
}

/** Parse a data:audio/...;base64,... URL into bytes + a safe filename for OpenAI. */
export function parseAudioDataUrl(
  dataUrl: string,
): { buffer: Buffer; filename: string; mime: string } | null {
  if (!dataUrl || dataUrl.length > 6_000_000) return null
  const match = dataUrl.match(/^data:([^,]*?);base64,([\s\S]+)$/i)
  if (!match) return null

  const header = match[1].trim()
  const mime = header.split(';')[0].trim().toLowerCase()
  if (!ALLOWED_AUDIO_MIME.has(mime)) return null

  const base64 = match[2].replace(/\s+/g, '')
  if (!base64 || !/^[A-Za-z0-9+/]+=*$/.test(base64)) return null

  const buffer = Buffer.from(base64, 'base64')
  if (!buffer.length) return null

  let ext = 'webm'
  let outMime = mime
  if (mime.includes('ogg') || mime.includes('opus')) {
    ext = 'ogg'
    outMime = 'audio/ogg'
  } else if (mime.includes('aac')) {
    ext = 'm4a'
    outMime = 'audio/mp4'
  } else if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('caf')) {
    ext = 'm4a'
    outMime = 'audio/mp4'
  } else if (mime.includes('mpeg') || mime.includes('mp3')) {
    ext = 'mp3'
    outMime = 'audio/mpeg'
  } else if (mime.includes('wav')) {
    ext = 'wav'
    outMime = 'audio/wav'
  } else if (mime.includes('webm')) {
    ext = 'webm'
    outMime = 'audio/webm'
  }

  return { buffer, filename: `voice.${ext}`, mime: outMime }
}
