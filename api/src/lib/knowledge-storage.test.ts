import { afterEach, describe, expect, it } from 'vitest'
import { decryptKnowledgeObject, encryptKnowledgeObject, knowledgeStorageBackend } from './knowledge-storage.js'

const originalKey = process.env.KNOWLEDGE_STORAGE_ENCRYPTION_KEY
const originalNodeEnv = process.env.NODE_ENV
const originalEndpoint = process.env.KNOWLEDGE_STORAGE_ENDPOINT
const originalAccessKey = process.env.KNOWLEDGE_STORAGE_ACCESS_KEY
const originalSecretKey = process.env.KNOWLEDGE_STORAGE_SECRET_KEY

afterEach(() => {
  if (originalKey === undefined) delete process.env.KNOWLEDGE_STORAGE_ENCRYPTION_KEY
  else process.env.KNOWLEDGE_STORAGE_ENCRYPTION_KEY = originalKey
  process.env.NODE_ENV = originalNodeEnv
  for (const [name, value] of [
    ['KNOWLEDGE_STORAGE_ENDPOINT', originalEndpoint],
    ['KNOWLEDGE_STORAGE_ACCESS_KEY', originalAccessKey],
    ['KNOWLEDGE_STORAGE_SECRET_KEY', originalSecretKey],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('knowledge object encryption', () => {
  it('encrypts private source bytes and detects tampering', () => {
    process.env.KNOWLEDGE_STORAGE_ENCRYPTION_KEY = '00'.repeat(32)
    const source = Buffer.from('%PDF-1.7 private farm procedure')
    const encrypted = encryptKnowledgeObject(source)
    expect(encrypted.equals(source)).toBe(false)
    expect(encrypted.includes(Buffer.from('private farm procedure'))).toBe(false)
    expect(decryptKnowledgeObject(encrypted)).toEqual(source)

    encrypted[encrypted.length - 1] ^= 1
    expect(() => decryptKnowledgeObject(encrypted)).toThrow()
  })

  it('rejects an invalid encryption key', () => {
    process.env.KNOWLEDGE_STORAGE_ENCRYPTION_KEY = 'too-short'
    expect(() => encryptKnowledgeObject(Buffer.from('document'))).toThrow(/32 bytes/)
  })

  it('fails closed when production object storage is incomplete', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.KNOWLEDGE_STORAGE_ENDPOINT
    delete process.env.KNOWLEDGE_STORAGE_ACCESS_KEY
    delete process.env.KNOWLEDGE_STORAGE_SECRET_KEY
    expect(() => knowledgeStorageBackend()).toThrow(/not configured/)
  })
})
