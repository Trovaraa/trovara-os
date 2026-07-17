import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptSecret, decryptSecretForVerify, encryptSecret, isEncryptedSecret } from './secret-box.js'

describe('secret-box', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    process.env.TOTP_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    delete process.env.TOTP_KEY_DERIVATION_SECRET
  })

  afterEach(() => {
    delete process.env.TOTP_ENCRYPTION_KEY
    delete process.env.TOTP_KEY_DERIVATION_SECRET
  })

  it('encrypts and decrypts TOTP secrets', () => {
    const plaintext = 'JBSWY3DPEHPK3PXP'
    const encrypted = encryptSecret(plaintext)
    expect(isEncryptedSecret(encrypted)).toBe(true)
    expect(decryptSecret(encrypted)).toBe(plaintext)
  })

  it('treats legacy plaintext as readable and marks for re-encryption', () => {
    const legacy = 'JBSWY3DPEHPK3PXP'
    const result = decryptSecretForVerify(legacy)
    expect(result.plaintext).toBe(legacy)
    expect(result.shouldReencrypt).toBe(true)
  })

  it('accepts base64 encryption keys', () => {
    process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
    const encrypted = encryptSecret('secret-value')
    expect(decryptSecret(encrypted)).toBe('secret-value')
  })
})
