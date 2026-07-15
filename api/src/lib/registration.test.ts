import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BREAK_GLASS_EMAIL,
  isBreakGlassEmail,
  normalizeRegisterEmail,
  normalizeRegisterPhone,
  registerBodySchema,
  validateRegistrationSecret,
} from './registration.js'

describe('normalizeRegisterEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeRegisterEmail('  Ada@Trovara.Farm ')).toBe('ada@trovara.farm')
  })
})

describe('normalizeRegisterPhone', () => {
  it('strips non-digits for Telegram matching', () => {
    expect(normalizeRegisterPhone('+31 6 13 32 17 04')).toBe('31613321704')
    expect(normalizeRegisterPhone('234-810-000-0000')).toBe('2348100000000')
  })
})

describe('validateRegistrationSecret', () => {
  it('reports disabled when secret is unset or blank', () => {
    expect(validateRegistrationSecret('anything', undefined)).toEqual({
      ok: false,
      reason: 'disabled',
    })
    expect(validateRegistrationSecret('anything', '   ')).toEqual({
      ok: false,
      reason: 'disabled',
    })
  })

  it('rejects a wrong secret', () => {
    expect(validateRegistrationSecret('wrong', 'correct-secret')).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('accepts an exact match', () => {
    expect(validateRegistrationSecret('correct-secret', 'correct-secret')).toEqual({ ok: true })
  })
})

describe('registerBodySchema', () => {
  const valid = {
    name: 'Ada Founder',
    email: 'ada@example.com',
    phone: '+2348100000099',
    password: 'SecurePass1',
    registrationSecret: 'gate-secret',
    consentAccepted: true as const,
  }

  it('accepts a complete founder registration payload', () => {
    expect(registerBodySchema.parse(valid)).toMatchObject({
      name: 'Ada Founder',
      email: 'ada@example.com',
      consentAccepted: true,
    })
  })

  it('requires consentAccepted to be true', () => {
    expect(() =>
      registerBodySchema.parse({ ...valid, consentAccepted: false }),
    ).toThrow()
    expect(() => {
      const { consentAccepted: _, ...rest } = valid
      registerBodySchema.parse(rest)
    }).toThrow()
  })

  it('requires phone and registrationSecret', () => {
    expect(() => registerBodySchema.parse({ ...valid, phone: '' })).toThrow()
    expect(() =>
      registerBodySchema.parse({ ...valid, registrationSecret: '' }),
    ).toThrow()
  })
})

describe('isBreakGlassEmail', () => {
  it('matches the default break-glass address', () => {
    expect(isBreakGlassEmail(DEFAULT_BREAK_GLASS_EMAIL)).toBe(true)
    expect(isBreakGlassEmail('Owner@Trovara.Farm')).toBe(true)
    expect(isBreakGlassEmail('ada@example.com')).toBe(false)
  })
})
