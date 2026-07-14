import type { Context, Next } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'
import { getCookie } from 'hono/cookie'
import { csrfMiddleware } from '../lib/csrf.js'

const loginAttempts = new Map<string, { count: number; resetAt: number }>()
const mutationAttempts = new Map<string, { count: number; resetAt: number }>()
const authMutationAttempts = new Map<string, { count: number; resetAt: number }>()
const MUTATION_WINDOW_MS = 15 * 60 * 1000
const MUTATION_MAX = 120
const AUTH_MUTATION_MAX = 30
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'DELETE'])

// Photo/voice uploads arrive as base64 JSON (~8 MB worst case); anything bigger
// is abuse. A reverse proxy (Caddy/nginx) should enforce the same cap in front.
const MAX_BODY_BYTES = 12 * 1024 * 1024

async function bodySizeLimit(c: Context, next: Next) {
  const len = Number(c.req.header('content-length'))
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return c.json({ error: 'Payload too large' }, 413)
  }
  await next()
}

export function securityMiddleware() {
  const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://127.0.0.1:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  return [
    secureHeaders(),
    bodySizeLimit,
    cors({
      origin: (origin) => {
        if (!origin) return allowedOrigins[0] ?? 'http://127.0.0.1:5173'
        return allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
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

  const ip = c.req.header('x-forwarded-for') ?? 'local'
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
  const ip = c.req.header('x-forwarded-for') ?? 'local'
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
