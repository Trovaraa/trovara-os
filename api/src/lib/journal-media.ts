import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { getEvidenceStorageRoot } from './evidence-store.js'

const MAX_DECODED_BYTES = 2_500_000
const MAX_DATA_URL_LENGTH = 3_400_000
const PUBLIC_PREFIX = '/public/journal/media'
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}
const mediaRoot = resolve(getEvidenceStorageRoot(), 'journal-media')

function safeFarmId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function safeFilename(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}\.(?:jpg|png|webp)$/.test(value)
}

function filePath(farmId: string, filename: string): string {
  if (!safeFarmId(farmId) || !safeFilename(filename)) throw new Error('Invalid journal media path')
  const path = resolve(mediaRoot, farmId, filename)
  const farmRoot = `${resolve(mediaRoot, farmId)}${sep}`
  if (!path.startsWith(farmRoot)) throw new Error('Invalid journal media path')
  return path
}

function hasExpectedSignature(mime: keyof typeof MIME_TO_EXT, buffer: Buffer): boolean {
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  if (mime === 'image/png') {
    return (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
  }
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  )
}

export async function storeJournalMedia(farmId: string, dataUrl: string): Promise<string> {
  if (dataUrl.length > MAX_DATA_URL_LENGTH) throw new Error('Journal image too large')
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i)
  if (!match) throw new Error('Invalid journal image data URL')

  const mime = match[1]!.toLowerCase() as keyof typeof MIME_TO_EXT
  const encoded = match[2]!
  const buffer = Buffer.from(encoded, 'base64')
  if (buffer.length === 0 || buffer.length > MAX_DECODED_BYTES) {
    throw new Error('Journal image too large')
  }
  if (!hasExpectedSignature(mime, buffer)) throw new Error('Journal image content does not match MIME type')

  const filename = `${randomBytes(18).toString('base64url')}.${MIME_TO_EXT[mime]}`
  const path = filePath(farmId, filename)
  await mkdir(resolve(mediaRoot, farmId), { recursive: true })
  await writeFile(path, buffer, { flag: 'wx', mode: 0o640 })
  return `${PUBLIC_PREFIX}/${farmId}/${filename}`
}

export async function readJournalMedia(
  farmId: string,
  filename: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  const contentType = EXT_TO_MIME[extension]
  if (!contentType) throw new Error('Unsupported journal image')
  const buffer = await readFile(filePath(farmId, filename))
  return { buffer, contentType }
}
