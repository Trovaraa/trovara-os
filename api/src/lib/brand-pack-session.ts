import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'trovara_brand_pack'
const VERSION = 'v1'
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000
const KEY_SALT = 'trovara-brand-pack-session-v1'

export { COOKIE_NAME as BRAND_PACK_SESSION_COOKIE }

function sessionSigningKey(): Buffer {
  const dedicated = process.env.BRAND_PACK_SESSION_SECRET?.trim()
  if (dedicated) {
    return scryptSync(dedicated, KEY_SALT, 32)
  }
  const totp = process.env.TOTP_ENCRYPTION_KEY?.trim()
  if (totp) {
    return scryptSync(totp, KEY_SALT, 32)
  }
  const derivation = process.env.TOTP_KEY_DERIVATION_SECRET?.trim()
  if (derivation) {
    return scryptSync(derivation, KEY_SALT, 32)
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('BRAND_PACK_SESSION_SECRET or TOTP_ENCRYPTION_KEY is required in production')
  }
  return scryptSync('trovara-dev-brand-pack', KEY_SALT, 32)
}

function sign(payload: string): string {
  return createHmac('sha256', sessionSigningKey()).update(payload).digest('base64url')
}

export type BrandPackSession = {
  packId: string
  exp: number
}

export function createBrandPackSessionToken(
  packId: string,
  expiresAt: Date | null,
  now = Date.now(),
): { token: string; maxAgeSec: number } {
  const hardCap = now + DEFAULT_TTL_MS
  const packCap = expiresAt ? expiresAt.getTime() : hardCap
  const exp = Math.min(hardCap, packCap)
  if (exp <= now) {
    throw new Error('Pack already expired')
  }
  const body = `${VERSION}.${packId}.${exp}`
  const token = `${body}.${sign(body)}`
  return { token, maxAgeSec: Math.max(1, Math.floor((exp - now) / 1000)) }
}

export function verifyBrandPackSessionToken(
  token: string | undefined,
  expectedPackId: string,
  now = Date.now(),
): boolean {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 4) return false
  const [version, packId, expRaw, mac] = parts
  if (version !== VERSION || !packId || !expRaw || !mac) return false
  if (packId !== expectedPackId) return false
  const exp = Number(expRaw)
  if (!Number.isFinite(exp) || exp <= now) return false
  const body = `${version}.${packId}.${expRaw}`
  const expected = sign(body)
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function brandPackSessionCookieOptions(secure: boolean, maxAgeSec: number) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'Lax' as const,
    path: '/',
    maxAge: maxAgeSec,
  }
}
