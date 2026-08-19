/**
 * Resolve the client IP behind a reverse proxy without blindly trusting
 * client-supplied X-Forwarded-For. TRUSTED_PROXY_HOPS is the number of
 * proxy hops immediately in front of the API that we trust (default 1 in
 * production when NODE_ENV=production, else 0 → use direct connection /
 * the last hop only when hops > 0).
 *
 * Example with nginx → API (1 hop): TRUSTED_PROXY_HOPS=1
 * X-Forwarded-For: client, nginx  → we take "client"
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

function signedProxyClientId(
  getHeader: (name: string) => string | undefined,
): string | null {
  const secret = process.env.FORM_PROXY_SIGNING_SECRET?.trim()
  const clientId = getHeader('x-trovara-client-id')?.trim()
  const rawTimestamp = getHeader('x-trovara-client-timestamp')?.trim()
  const signature = getHeader('x-trovara-client-signature')?.trim()
  const timestamp = Number(rawTimestamp)
  if (
    !secret ||
    !clientId ||
    !/^[A-Za-z0-9_-]{32,64}$/.test(clientId) ||
    !rawTimestamp ||
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() - timestamp) > 5 * 60_000 ||
    !signature
  ) {
    return null
  }
  const expected = createHmac('sha256', secret)
    .update(`${rawTimestamp}.${clientId}`)
    .digest('base64url')
  const expectedBuffer = Buffer.from(expected)
  const signatureBuffer = Buffer.from(signature)
  if (
    expectedBuffer.length !== signatureBuffer.length ||
    !timingSafeEqual(expectedBuffer, signatureBuffer)
  ) {
    return null
  }
  return clientId
}

function trustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim()
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
  }
  return process.env.NODE_ENV === 'production' ? 1 : 0
}

export function resolveClientIp(params: {
  forwardedFor?: string | null
  fallback?: string | null
}): string {
  const hops = trustedProxyHops()
  const forwarded = (params.forwardedFor ?? '').trim()
  if (hops <= 0 || !forwarded) {
    return (params.fallback ?? 'local').trim() || 'local'
  }

  // X-Forwarded-For: client, proxy1, proxy2 (left = original client)
  const parts = forwarded
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

  if (!parts.length) return (params.fallback ?? 'local').trim() || 'local'

  // Drop the rightmost `hops` entries (trusted proxies that appended themselves)
  // and take the rightmost remaining = closest untrusted client.
  const idx = parts.length - hops - 1
  if (idx < 0) return parts[0] ?? 'local'
  return parts[idx] ?? parts[0] ?? 'local'
}

/** Convenience for Hono contexts. */
export function clientIpFromHeaders(
  getHeader: (name: string) => string | undefined,
): string {
  const clientId = signedProxyClientId(getHeader)
  if (clientId) return `proxy:${clientId}`
  return resolveClientIp({
    forwardedFor: getHeader('x-forwarded-for'),
    fallback: getHeader('x-real-ip') ?? 'local',
  })
}

/** True when FORM_PROXY_SIGNING_SECRET is set and the request carries a valid HMAC. */
export function formProxySignatureValid(
  getHeader: (name: string) => string | undefined,
): boolean {
  return signedProxyClientId(getHeader) !== null
}

/** When the form-proxy secret is configured in production, unsigned public-form posts are rejected. */
export function rejectUnsignedFormProxy(c: {
  req: { header: (name: string) => string | undefined }
  json: (body: unknown, status?: number) => Response
}): Response | null {
  if (process.env.NODE_ENV !== 'production') return null
  if (!process.env.FORM_PROXY_SIGNING_SECRET?.trim()) return null
  if (formProxySignatureValid((name) => c.req.header(name))) return null
  return c.json({ error: 'Unauthorized' }, 401)
}
