import { describe, expect, it, beforeEach, afterEach } from 'vitest'

describe('vault-box', () => {
  const prev = process.env.VAULT_ENCRYPTION_KEY

  beforeEach(() => {
    process.env.VAULT_ENCRYPTION_KEY = 'a'.repeat(64)
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.VAULT_ENCRYPTION_KEY
    else process.env.VAULT_ENCRYPTION_KEY = prev
  })

  it('round-trips plaintext', async () => {
    const { encryptVaultSecret, decryptVaultSecret } = await import('./vault-box.js')
    const cipher = encryptVaultSecret('portal-secret-123')
    expect(cipher.startsWith('v1:')).toBe(true)
    expect(decryptVaultSecret(cipher)).toBe('portal-secret-123')
  })
})
