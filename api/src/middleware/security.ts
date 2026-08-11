import type { Context, Next } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { getCookie } from 'hono/cookie'
import { csrfMiddleware } from '../lib/csrf.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'
import { randomUUID } from 'node:crypto'
import { checkDurableRateLimit as checkPostgresRateLimit } from '../lib/rate-limit.js'
import { deploymentSha } from '../lib/deployment.js'

const mutationAttempts = new Map<string, { count: number; resetAt: number }>()
const authMutationAttempts = new Map<string, { count: number; resetAt: number }>()
const MUTATION_WINDOW_MS = 15 * 60 * 1000
const MUTATION_MAX = 120
const AUTH_MUTATION_MAX = 30
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

// Staff + shop login counters are durable (Postgres) so restarts cannot clear lockouts.
export {
  checkDurableRateLimit,
  checkLoginRateLimit,
  resetDurableRateLimit,
  resetLoginRateLimit,
  staffLoginRateKey,
  shopLoginRateKey,
  shopEmailIpRateKey,
  shopEmailAddrRateKey,
  vaultRevealRateKey,
  hashedRateKey,
  purgeExpiredLoginRateLimits,
  LOGIN_RATE_MAX_ATTEMPTS,
  SHOP_EMAIL_IP_MAX_ATTEMPTS,
  SHOP_EMAIL_ADDR_MAX_ATTEMPTS,
  VAULT_REVEAL_MAX_ATTEMPTS,
  LOGIN_RATE_WINDOW_MS,
} from '../lib/login-rate-limit.js'

// Photo/voice uploads arrive as base64 JSON (~8 MB worst case); anything bigger
// is abuse. A reverse proxy (Caddy/nginx) should enforce the same cap in front.
// Brand Kit streaming uploads use a dedicated higher limit (see isBrandUploadPath).
export const MAX_BODY_BYTES = 12 * 1024 * 1024
export const BRAND_UPLOAD_BODY_BYTES = Number(
  process.env.BRAND_UPLOAD_MAX_BYTES?.trim() || 500 * 1024 * 1024,
)

/** Authenticated Brand Kit binary upload / replace paths — streamed, not JSON. */
export function isBrandUploadPath(pathname: string): boolean {
  const path = pathname.split('?')[0] ?? pathname
  return (
    path === '/api/brand/assets/upload' ||
    /^\/api\/brand\/assets\/upload\/[^/]+$/.test(path)
  )
}

async function bodySizeLimit(c: Context, next: Next) {
  const path = new URL(c.req.url).pathname
  const brandUpload = isBrandUploadPath(path)
  const maxBytes = brandUpload ? BRAND_UPLOAD_BODY_BYTES : MAX_BODY_BYTES

  const lenHeader = c.req.header('content-length')
  const len = Number(lenHeader)
  if (Number.isFinite(len) && len > maxBytes) {
    return c.json({ error: 'Payload too large' }, 413)
  }

  // Brand uploads stream to disk in the route — do not buffer here.
  if (brandUpload) {
    await next()
    return
  }

  // Chunked uploads without Content-Length: stream with a hard byte cap and
  // re-wrap the Request so downstream JSON parsers still work.
  const method = c.req.method.toUpperCase()
  if (
    !Number.isFinite(len) &&
    MUTATING_METHODS.has(method) &&
    c.req.raw.body
  ) {
    const reader = c.req.raw.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        return c.json({ error: 'Payload too large' }, 413)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const headers = new Headers(c.req.raw.headers)
    headers.set('content-length', String(total))
    const rebuilt = new Request(c.req.url, {
      method: c.req.method,
      headers,
      body: total > 0 ? merged : undefined,
      duplex: 'half',
    } as RequestInit)
    Object.defineProperty(c.req, 'raw', { value: rebuilt, writable: true })
  }

  await next()
}

export function securityMiddleware() {
  const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  return [
    async (c: Context, next: Next) => {
      const supplied = c.req.header('x-request-id')?.trim()
      const requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID()
      c.header('X-Request-ID', requestId)
      await next()
    },
    // cross-origin: marketing shop (trovara.farm) may call this API directly;
    // same-origin proxy (/shop-api) also works. Default same-origin CORP blocks
    // credentialed cross-origin fetches even when CORS allows the origin.
    secureHeaders({
      crossOriginResourcePolicy: 'cross-origin',
    }),
    bodySizeLimit,
    cors({
      origin: (origin) => {
        if (!origin) return allowedOrigins[0] ?? 'http://127.0.0.1:5173'
        return allowedOrigins.includes(origin) ? origin : null
      },
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Request-ID'],
      exposeHeaders: ['X-Request-ID', 'Retry-After'],
    }),
    csrfMiddleware,
  ]
}

export function checkMutationRateLimit(identity: string): {
  allowed: boolean
  retryAfterSec: number
} {
  const now = Date.now()
  const entry = mutationAttempts.get(identity)
  if (!entry || now > entry.resetAt) {
    mutationAttempts.set(identity, { count: 1, resetAt: now + MUTATION_WINDOW_MS })
    return { allowed: true, retryAfterSec: 0 }
  }
  entry.count += 1
  if (entry.count > MUTATION_MAX) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    }
  }
  return { allowed: true, retryAfterSec: 0 }
}

export function resetMutationRateLimit(identity?: string) {
  if (identity) {
    mutationAttempts.delete(identity)
    return
  }
  mutationAttempts.clear()
}

export function checkAuthMutationRateLimit(
  identity: string,
  max = AUTH_MUTATION_MAX,
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now()
  const entry = authMutationAttempts.get(identity)
  if (!entry || now > entry.resetAt) {
    authMutationAttempts.set(identity, { count: 1, resetAt: now + MUTATION_WINDOW_MS })
    return { allowed: true, retryAfterSec: 0 }
  }
  entry.count += 1
  if (entry.count > max) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    }
  }
  return { allowed: true, retryAfterSec: 0 }
}

export function resetAuthMutationRateLimit(identity?: string) {
  if (identity) {
    authMutationAttempts.delete(identity)
    return
  }
  authMutationAttempts.clear()
}

export async function authMutationRateLimit(c: Context, next: Next) {
  const method = c.req.method.toUpperCase()
  if (!MUTATING_METHODS.has(method)) {
    await next()
    return
  }

  const ip = clientIpFromHeaders((name) => c.req.header(name))
  const { allowed, retryAfterSec } = await checkPostgresRateLimit(
    `auth-mutation:ip:${ip}`,
    AUTH_MUTATION_MAX,
    MUTATION_WINDOW_MS,
  )
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many auth requests. Please try again later.' }, 429)
  }

  await next()
}

export async function apiMutationRateLimit(c: Context, next: Next) {
  const method = c.req.method.toUpperCase()
  if (!MUTATING_METHODS.has(method)) {
    await next()
    return
  }

  const { SESSION_COOKIE, getUserFromSession } = await import('../lib/session.js')
  const token = getCookie(c, SESSION_COOKIE)
  const user = token ? await getUserFromSession(token) : null
  const ip = clientIpFromHeaders((name) => c.req.header(name))
  const key = user?.id ? `user:${user.id}` : `ip:${ip}`
  const { allowed, retryAfterSec } = await checkPostgresRateLimit(
    `api-mutation:${key}`,
    MUTATION_MAX,
    MUTATION_WINDOW_MS,
  )
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many write requests. Please try again later.' }, 429)
  }

  await next()
}

export async function requestLogger(c: Context, next: Next) {
  const startedAt = performance.now()
  await next()
  const latencyMs = Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10)
  const requestId = c.res.headers.get('x-request-id') ?? 'unknown'
  const metadata = {
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latencyMs,
    deploymentSha: deploymentSha(),
  }
  const line = JSON.stringify({ type: 'request', ...metadata })
  if (process.env.NODE_ENV === 'development') {
    console.log(line)
    return
  }
  const { logApiEvent } = await import('../lib/api-log.js')
  logApiEvent(c.res.status >= 500 ? 'request_error' : 'request', metadata)
}
