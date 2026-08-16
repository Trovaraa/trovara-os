import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getEvidenceStorageRoot } from './evidence-store.js'

const ENCRYPTED_MAGIC = Buffer.from('TVK1')
const IV_BYTES = 12
const TAG_BYTES = 16

function storageBucket() {
  return process.env.KNOWLEDGE_STORAGE_BUCKET?.trim() || 'trovara-knowledge'
}

function storageEndpoint() {
  return process.env.KNOWLEDGE_STORAGE_ENDPOINT?.trim() || ''
}

function encryptionKey(): Buffer {
  const configured = process.env.KNOWLEDGE_STORAGE_ENCRYPTION_KEY?.trim()
  if (configured) {
    const decoded = /^[a-f0-9]{64}$/i.test(configured)
      ? Buffer.from(configured, 'hex')
      : Buffer.from(configured, 'base64')
    if (decoded.length === 32) return decoded
    throw new Error('KNOWLEDGE_STORAGE_ENCRYPTION_KEY must be 32 bytes encoded as hex or base64')
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('KNOWLEDGE_STORAGE_ENCRYPTION_KEY is required in production')
  }
  return createHash('sha256').update('trovara-development-knowledge-storage-key').digest()
}

export function encryptKnowledgeObject(value: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()])
  return Buffer.concat([ENCRYPTED_MAGIC, iv, cipher.getAuthTag(), ciphertext])
}

export function decryptKnowledgeObject(value: Buffer): Buffer {
  if (!value.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)) {
    throw new Error('Knowledge object is not encrypted with the configured storage key')
  }
  const ivStart = ENCRYPTED_MAGIC.length
  const tagStart = ivStart + IV_BYTES
  const bodyStart = tagStart + TAG_BYTES
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), value.subarray(ivStart, tagStart))
  decipher.setAuthTag(value.subarray(tagStart, bodyStart))
  return Buffer.concat([decipher.update(value.subarray(bodyStart)), decipher.final()])
}

function s3Configured() {
  return Boolean(
    storageEndpoint() &&
    process.env.KNOWLEDGE_STORAGE_ACCESS_KEY?.trim() &&
    process.env.KNOWLEDGE_STORAGE_SECRET_KEY?.trim(),
  )
}

function assertStorageReady() {
  if (process.env.NODE_ENV === 'production' && !s3Configured()) {
    throw new Error('Private Operations Library object storage is not configured')
  }
}

let client: S3Client | null = null
let bucketReady: Promise<void> | null = null

function s3Client() {
  if (client) return client
  client = new S3Client({
    endpoint: storageEndpoint(),
    region: process.env.KNOWLEDGE_STORAGE_REGION?.trim() || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.KNOWLEDGE_STORAGE_ACCESS_KEY!.trim(),
      secretAccessKey: process.env.KNOWLEDGE_STORAGE_SECRET_KEY!.trim(),
    },
  })
  return client
}

async function ensureBucket() {
  if (!s3Configured()) return
  if (!bucketReady) {
    bucketReady = (async () => {
      const s3 = s3Client()
      try {
        await s3.send(new HeadBucketCommand({ Bucket: storageBucket() }))
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: storageBucket() }))
      }
      try {
        await s3.send(new PutBucketLifecycleConfigurationCommand({
          Bucket: storageBucket(),
          LifecycleConfiguration: {
            Rules: [
              { ID: 'expire-quarantine', Status: 'Enabled', Filter: { Prefix: 'quarantine/' }, Expiration: { Days: 14 } },
              { ID: 'expire-discarded', Status: 'Enabled', Filter: { Prefix: 'discarded/' }, Expiration: { Days: 30 } },
            ],
          },
        }))
      } catch (error) {
        console.warn('Knowledge object lifecycle policy was not accepted by the S3-compatible store:', error instanceof Error ? error.message : error)
      }
    })()
  }
  return bucketReady
}

function safeObjectKey(key: string) {
  if (!/^(quarantine|clean|discarded)\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(key)) {
    throw new Error('Invalid knowledge object key')
  }
  return key
}

function localObjectPath(key: string) {
  return join(getEvidenceStorageRoot(), '_knowledge_objects', safeObjectKey(key))
}

async function bodyBuffer(body: unknown): Promise<Buffer> {
  if (!body || typeof body !== 'object' || !('transformToByteArray' in body)) {
    throw new Error('Object storage returned an unreadable body')
  }
  const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray()
  return Buffer.from(bytes)
}

export function knowledgeStorageBackend() {
  assertStorageReady()
  return s3Configured() ? 's3-compatible' : 'encrypted-local-development'
}

export function knowledgeStorageBucket() {
  assertStorageReady()
  return s3Configured() ? storageBucket() : null
}

export async function putKnowledgeObject(key: string, value: Buffer, contentType: string) {
  assertStorageReady()
  safeObjectKey(key)
  const encrypted = encryptKnowledgeObject(value)
  if (s3Configured()) {
    await ensureBucket()
    await s3Client().send(new PutObjectCommand({
      Bucket: storageBucket(),
      Key: key,
      Body: encrypted,
      ContentType: 'application/octet-stream',
      Metadata: { originalContentType: contentType, encrypted: 'aes-256-gcm' },
    }))
  } else {
    const path = localObjectPath(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, encrypted, { flag: 'wx' })
  }
}

export async function getKnowledgeObject(key: string): Promise<Buffer> {
  assertStorageReady()
  safeObjectKey(key)
  const encrypted = s3Configured()
    ? await (async () => {
        await ensureBucket()
        const response = await s3Client().send(new GetObjectCommand({ Bucket: storageBucket(), Key: key }))
        return bodyBuffer(response.Body)
      })()
    : await readFile(localObjectPath(key))
  return decryptKnowledgeObject(encrypted)
}

export async function deleteKnowledgeObject(key: string): Promise<void> {
  assertStorageReady()
  safeObjectKey(key)
  if (s3Configured()) {
    await ensureBucket()
    await s3Client().send(new DeleteObjectCommand({ Bucket: storageBucket(), Key: key }))
    return
  }
  try {
    await unlink(localObjectPath(key))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function promoteKnowledgeObject(quarantineKey: string, cleanKey: string, contentType: string) {
  const value = await getKnowledgeObject(quarantineKey)
  await putKnowledgeObject(cleanKey, value, contentType)
  await deleteKnowledgeObject(quarantineKey)
}

/** Copy encrypted clean objects into the encrypted evidence backup tree. */
export async function snapshotCleanKnowledgeObjects(destinationRoot: string) {
  assertStorageReady()
  if (!s3Configured()) return { copied: 0, backend: knowledgeStorageBackend() }
  await ensureBucket()
  let copied = 0
  let continuationToken: string | undefined
  do {
    const page = await s3Client().send(new ListObjectsV2Command({
      Bucket: storageBucket(), Prefix: 'clean/', ContinuationToken: continuationToken,
    }))
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue
      safeObjectKey(object.Key)
      const response = await s3Client().send(new GetObjectCommand({ Bucket: storageBucket(), Key: object.Key }))
      const encrypted = await bodyBuffer(response.Body)
      const target = join(destinationRoot, object.Key)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, encrypted)
      copied += 1
    }
    continuationToken = page.NextContinuationToken
  } while (continuationToken)
  return { copied, backend: knowledgeStorageBackend() }
}
