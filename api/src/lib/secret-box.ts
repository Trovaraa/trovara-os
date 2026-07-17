import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

const VERSION_PREFIX = 'v1:'
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const KEY_LENGTH = 32
const SCRYPT_SALT = 'trovara-totp-v1'

function parseKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex')
  }
  const fromBase64 = Buffer.from(trimmed, 'base64')
  if (fromBase64.length === KEY_LENGTH) {
    return fromBase64
  }
  throw new Error('TOTP_ENCRYPTION_KEY must be 32 bytes (64-char hex or base64)')
}

function getEncryptionKey(): Buffer {
  const direct = process.env.TOTP_ENCRYPTION_KEY?.trim()
  if (direct) return parseKeyMaterial(direct)

  const derivationSecret = process.env.TOTP_KEY_DERIVATION_SECRET?.trim()
  if (derivationSecret) {
    return scryptSync(derivationSecret, SCRYPT_SALT, KEY_LENGTH)
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('TOTP_ENCRYPTION_KEY or TOTP_KEY_DERIVATION_SECRET is required in production')
  }

  return scryptSync('trovara-dev-totp-key', SCRYPT_SALT, KEY_LENGTH)
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(VERSION_PREFIX)
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${VERSION_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`
}

export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) {
    return stored
  }

  const payload = stored.slice(VERSION_PREFIX.length)
  const parts = payload.split(':')
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error('Invalid encrypted secret format')
  }

  const [ivPart, tagPart, ciphertextPart] = parts
  const key = getEncryptionKey()
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart!, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagPart!, 'base64url'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart!, 'base64url')),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

export function decryptSecretForVerify(stored: string): { plaintext: string; shouldReencrypt: boolean } {
  if (!isEncryptedSecret(stored)) {
    return { plaintext: stored, shouldReencrypt: true }
  }
  return { plaintext: decryptSecret(stored), shouldReencrypt: false }
}
