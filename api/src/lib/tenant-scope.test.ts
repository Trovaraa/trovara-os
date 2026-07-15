import { describe, expect, it, vi } from 'vitest'
import { assertTenantScope, sanitizeAnonymizedEmail, sanitizeAnonymizedName } from './tenant-scope.js'

const { verifySyncMock } = vi.hoisted(() => ({
  verifySyncMock: vi.fn(),
}))

vi.mock('otplib', () => ({
  generateSecret: vi.fn(() => 'test-secret'),
  generateURI: vi.fn(() => 'otpauth://totp/mock'),
  verifySync: verifySyncMock,
}))

describe('tenant scoping convention', () => {
  it('allows access when farm ids match', () => {
    expect(() => assertTenantScope('farm-1', 'farm-1')).not.toThrow()
  })

  it('blocks access when farm ids differ', () => {
    expect(() => assertTenantScope('farm-1', 'farm-2')).toThrow('TENANT_SCOPE_MISMATCH')
  })
})

describe('anonymization sanitizers', () => {
  it('uses fixed anonymized name', () => {
    expect(sanitizeAnonymizedName()).toBe('Anonymized')
  })

  it('creates deterministic anonymized email', () => {
    expect(sanitizeAnonymizedEmail('worker-123')).toBe('anon@worker-123.invalid')
  })
})

describe('totp verification uses otplib', () => {
  it('delegates token verification to verifySync', async () => {
    verifySyncMock.mockReturnValueOnce({ valid: true, delta: 0 })
    const { verifyToken } = await import('./totp.js')
    const ok = verifyToken('secret', '123456')
    expect(ok).toBe(true)
    expect(verifySyncMock).toHaveBeenCalledWith({ secret: 'secret', token: '123456' })
  })
})
