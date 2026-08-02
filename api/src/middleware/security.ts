import type { Context, Next } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { getCookie } from 'hono/cookie'
import { csrfMiddleware } from '../lib/csrf.js'
import { clientIpFromHeaders } from '../lib/client-ip.js'

const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const mutationAttempts = new Map<string, { count: number; resetAt: number }>()
const authMutationAttempts = new Map<string, { count: number; resetAt: number }>()
const MUTATION_WINDOW_MS = 15 * 60 * 1000
const MUTATION_MAX = 120
const AUTH_MUTATION_MAX = 30
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])

// Photo/voice uploads arrive as base64 JSON (~8 MB worst case); anything bigger
// is abuse. A reverse proxy (Caddy/nginx) should enforce the same cap in front.
export const MAX_BODY_BYTES = 12 * 1024 * 1024

async function bodySizeLimit(c: Context, next: Next) {
  const lenHeader = c.req.header('content-length')
  const len = Number(lenHeader)
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413)
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
      if (total > MAX_BODY_BYTES) {
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
      allowHeaders: ['Content-Type', 'X-CSRF-Token'],
    }),
    csrfMiddleware,
  ]
}

export function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = loginAttempts.get(ip)
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count += 1
  return true
}

export function resetLoginRateLimit(ip: string) {
  loginAttempts.delete(ip)
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
  const { allowed, retryAfterSec } = checkAuthMutationRateLimit(`ip:${ip}`)
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
  const { allowed, retryAfterSec } = checkMutationRateLimit(key)
  if (!allowed) {
    c.header('Retry-After', String(retryAfterSec))
    return c.json({ error: 'Too many write requests. Please try again later.' }, 429)
  }

  await next()
}

export async function requestLogger(c: Context, next: Next) {
  await next()
  const line = `${c.req.method} ${c.req.path} ${c.res.status}`
  if (process.env.NODE_ENV === 'development') {
    console.log(line)
    return
  }
  if (c.res.status >= 500) {
    const { logApiEvent } = await import('../lib/api-log.js')
    logApiEvent('request_error', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
    })
  }
}
