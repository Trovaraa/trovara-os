import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { validateEvidenceDataUrl } from './evidence-url.js'

const EVIDENCE_URL_PREFIX = '/api/evidence/'
const MAX_DECODED_BYTES = 1_500_000

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
}

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  m4a: 'audio/x-m4a',
}

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceRoot = resolve(
  process.env.EVIDENCE_STORAGE_ROOT?.trim() || join(apiRoot, 'data', 'evidence'),
)

function safePathSegment(value: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(value) && value !== '.' && value !== '..'
}

function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,([A-Za-z0-9+/=]+)$/i)
  if (!match) return null
  const mime = match[1]!.toLowerCase()
  const buffer = Buffer.from(match[2]!, 'base64')
  return { mime, buffer }
}

function safeFilename(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && !name.includes('..')
}

export function isEvidenceStorageUrl(value: string): boolean {
  return value.startsWith(EVIDENCE_URL_PREFIX)
}

export function parseEvidenceStorageUrl(value: string): { farmId: string; filename: string } | null {
  if (!isEvidenceStorageUrl(value)) return null
  const rest = value.slice(EVIDENCE_URL_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const farmId = rest.slice(0, slash)
  const filename = rest.slice(slash + 1)
  if (!safePathSegment(farmId) || !safeFilename(filename)) return null
  return { farmId, filename }
}

export function validateEvidenceRef(value: string): boolean {
  if (isEvidenceStorageUrl(value)) {
    return parseEvidenceStorageUrl(value) !== null
  }
  return validateEvidenceDataUrl(value)
}

export function evidenceStorageUrl(farmId: string, filename: string): string {
  return `${EVIDENCE_URL_PREFIX}${farmId}/${filename}`
}

function evidenceFilePath(farmId: string, filename: string): string {
  if (!safePathSegment(farmId) || !safeFilename(filename)) {
    throw new Error('Invalid evidence path')
  }
  return join(evidenceRoot, farmId, filename)
}

export function getEvidenceStorageRoot(): string {
  return evidenceRoot
}

export async function storeEvidenceFromDataUrl(farmId: string, dataUrl: string): Promise<string> {
  if (!validateEvidenceDataUrl(dataUrl)) {
    throw new Error('Invalid evidence data URL')
  }

  const parsed = parseDataUrl(dataUrl)
  if (!parsed) {
    throw new Error('Invalid evidence data URL')
  }
  if (parsed.buffer.length > MAX_DECODED_BYTES) {
    throw new Error('Evidence file too large')
  }

  const ext = MIME_TO_EXT[parsed.mime]
  if (!ext) {
    throw new Error('Unsupported evidence MIME type')
  }

  const filename = `${randomBytes(16).toString('base64url')}.${ext}`
  const filePath = evidenceFilePath(farmId, filename)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, parsed.buffer)

  return evidenceStorageUrl(farmId, filename)
}

export async function processEvidenceValue(
  farmId: string,
  value: string | null | undefined,
): Promise<string | null | undefined> {
  if (value === undefined) return undefined
  if (value === null || value === '') return value
  if (isEvidenceStorageUrl(value)) return value
  if (value.startsWith('data:')) {
    return storeEvidenceFromDataUrl(farmId, value)
  }
  return value
}

export async function readEvidenceFile(
  farmId: string,
  filename: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  if (!safeFilename(filename)) {
    throw new Error('Invalid evidence filename')
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const contentType = EXT_TO_MIME[ext]
  if (!contentType) {
    throw new Error('Unsupported evidence file type')
  }

  const buffer = await readFile(evidenceFilePath(farmId, filename))
  return { buffer, contentType }
}

export async function deleteEvidenceByUrl(value: string | null | undefined): Promise<boolean> {
  if (!value) return false
  const parsed = parseEvidenceStorageUrl(value)
  if (!parsed) return false

  try {
    await unlink(evidenceFilePath(parsed.farmId, parsed.filename))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
