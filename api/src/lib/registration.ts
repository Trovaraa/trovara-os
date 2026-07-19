import { z } from 'zod'
import { secureCompare, secureCompareSecret } from './secure-compare.js'

export const DEFAULT_BREAK_GLASS_EMAIL = 'owner@trovara.farm'

/** Founder self-signup emails must be on this exact domain (no subdomains). */
export const OWNER_EMAIL_DOMAIN = 'trovara.farm'

export function isAllowedOwnerEmail(email: string): boolean {
  const normalized = normalizeRegisterEmail(email)
  const at = normalized.lastIndexOf('@')
  if (at < 1) return false
  return normalized.slice(at + 1) === OWNER_EMAIL_DOMAIN
}

export const registerBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z
    .string()
    .email()
    .refine(isAllowedOwnerEmail, {
      message: `Email must use @${OWNER_EMAIL_DOMAIN}`,
    }),
  phone: z.string().trim().min(7).max(30),
  password: z.string().min(8).max(128),
  registrationSecret: z.string().min(1).max(256),
  consentAccepted: z.literal(true),
})

export type RegisterBody = z.infer<typeof registerBodySchema>

export function normalizeRegisterEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Digits only - matches Telegram phone matching in telegram-inbound. */
export function normalizeRegisterPhone(phone: string): string {
  return phone.replace(/\D/g, '')
}

export type RegistrationSecretResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'invalid' }

/**
 * Pure check against OWNER_REGISTRATION_SECRET. Empty / unset means registration
 * is disabled (503 at the route layer).
 */
export function validateRegistrationSecret(
  provided: string,
  configured: string | undefined,
): RegistrationSecretResult {
  const expected = configured?.trim()
  if (!expected) return { ok: false, reason: 'disabled' }
  if (!secureCompare(provided, expected)) return { ok: false, reason: 'invalid' }
  return { ok: true }
}

export function getBreakGlassEmail(): string {
  return (process.env.BREAK_GLASS_EMAIL?.trim() || DEFAULT_BREAK_GLASS_EMAIL).toLowerCase()
}

export function isBreakGlassEmail(email: string): boolean {
  return normalizeRegisterEmail(email) === getBreakGlassEmail()
}

/**
 * Break-glass password lives only in process env (BREAK_GLASS_PASSWORD), not the DB.
 * Changing it requires updating .env and restarting the API — no re-seed.
 */
export function getBreakGlassPasswordFromEnv(): string | null {
  const password = process.env.BREAK_GLASS_PASSWORD?.trim()
  return password || null
}

export function verifyBreakGlassPassword(password: string): boolean {
  const expected = getBreakGlassPasswordFromEnv()
  if (!expected) return false
  return secureCompareSecret(password, expected)
}
