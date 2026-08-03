import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_BREAK_GLASS_EMAIL,
  isAllowedOwnerEmail,
  isBreakGlassEmail,
  isBreakGlassEnvLoginEnabled,
  normalizeRegisterEmail,
  normalizeRegisterPhone,
  OWNER_EMAIL_DOMAIN,
  registerBodySchema,
  validateRegistrationSecret,
  verifyArmedBreakGlassPassword,
  verifyBreakGlassPassword,
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

describe('isAllowedOwnerEmail', () => {
  it(`accepts only the exact @${OWNER_EMAIL_DOMAIN} domain`, () => {
    expect(isAllowedOwnerEmail('ada@trovara.farm')).toBe(true)
    expect(isAllowedOwnerEmail('  Owner@Trovara.Farm ')).toBe(true)
  })

  it('rejects other domains and subdomains', () => {
    expect(isAllowedOwnerEmail('ada@gmail.com')).toBe(false)
    expect(isAllowedOwnerEmail('ada@example.com')).toBe(false)
    expect(isAllowedOwnerEmail('ada@mail.trovara.farm')).toBe(false)
    expect(isAllowedOwnerEmail('ada@not-trovara.farm')).toBe(false)
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
    email: 'ada@trovara.farm',
    phone: '+2348100000099',
    password: 'SecurePass1',
    registrationSecret: 'gate-secret',
    consentAccepted: true as const,
  }

  it('accepts a complete founder registration payload', () => {
    expect(registerBodySchema.parse(valid)).toMatchObject({
      name: 'Ada Founder',
      email: 'ada@trovara.farm',
      consentAccepted: true,
    })
  })

  it('rejects non-trovara.farm emails', () => {
    expect(() => registerBodySchema.parse({ ...valid, email: 'ada@gmail.com' })).toThrow()
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

describe('verifyBreakGlassPassword', () => {
  const prev = process.env.BREAK_GLASS_PASSWORD
  const prevEnabled = process.env.BREAK_GLASS_ENABLED

  afterEach(() => {
    if (prev === undefined) delete process.env.BREAK_GLASS_PASSWORD
    else process.env.BREAK_GLASS_PASSWORD = prev
    if (prevEnabled === undefined) delete process.env.BREAK_GLASS_ENABLED
    else process.env.BREAK_GLASS_ENABLED = prevEnabled
  })

  it('compares against BREAK_GLASS_PASSWORD from env', () => {
    process.env.BREAK_GLASS_PASSWORD = 'env-break-glass-secret'
    expect(verifyBreakGlassPassword('env-break-glass-secret')).toBe(true)
    expect(verifyBreakGlassPassword('wrong')).toBe(false)
  })

  it('fails when env password is unset', () => {
    delete process.env.BREAK_GLASS_PASSWORD
    expect(verifyBreakGlassPassword('anything')).toBe(false)
  })

  it('armed verify requires BREAK_GLASS_ENABLED=true', () => {
    process.env.BREAK_GLASS_PASSWORD = 'env-break-glass-secret'
    delete process.env.BREAK_GLASS_ENABLED
    expect(isBreakGlassEnvLoginEnabled()).toBe(false)
    expect(verifyArmedBreakGlassPassword('env-break-glass-secret')).toBe(false)

    process.env.BREAK_GLASS_ENABLED = 'true'
    expect(isBreakGlassEnvLoginEnabled()).toBe(true)
    expect(verifyArmedBreakGlassPassword('env-break-glass-secret')).toBe(true)
    expect(verifyArmedBreakGlassPassword('wrong')).toBe(false)
  })
})
