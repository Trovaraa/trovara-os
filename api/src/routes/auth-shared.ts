import { clientIpFromHeaders } from '../lib/client-ip.js'

export function authMutationKey(
  c: { req: { header: (name: string) => string | undefined } },
  userId?: string,
): string {
  if (userId) return `user:${userId}`
  return `ip:${clientIpFromHeaders((name) => c.req.header(name))}`
}

export function denyAuthMutation(c: any, retryAfterSec: number) {
  c.header('Retry-After', String(retryAfterSec))
  return c.json({ error: 'Too many requests. Please try again later.' }, 429)
}
