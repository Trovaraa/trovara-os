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
  return resolveClientIp({
    forwardedFor: getHeader('x-forwarded-for'),
    fallback: getHeader('x-real-ip') ?? 'local',
  })
}
