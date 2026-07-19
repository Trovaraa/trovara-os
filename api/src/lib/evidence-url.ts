const ALLOWED =
  /^data:(image\/(jpeg|png|webp|gif)|audio\/(mpeg|mp3|ogg|wav|webm|x-m4a|m4a|mp4|aac)|video\/mp4)(?:\s*;\s*[\w.+-]+=(?:"[^"]*"|'[^']*'|[\w.+-]+))*\s*;\s*base64\s*,[A-Za-z0-9+/=\s]+$/i

const MAX_LENGTH = 2_000_000

export function validateEvidenceDataUrl(url: string): boolean {
  if (url.length > MAX_LENGTH) return false

  const prefix = url.slice(0, 32).toLowerCase()
  if (prefix.startsWith('javascript:') || prefix.startsWith('data:text/html')) {
    return false
  }

  return ALLOWED.test(url)
}
