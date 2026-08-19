import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { getEvidenceStorageRoot } from './evidence-store.js'
import { transcodeBrandUpload } from './brand-transcode.js'
import { assertBufferIsClean } from './malware-scan.js'

export const MOMENTS_MAX_UPLOAD_BYTES = 12 * 1024 * 1024

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
}
const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
}
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const VIDEO_MIMES = new Set(['video/mp4', 'video/quicktime'])
const root = resolve(getEvidenceStorageRoot(), 'moments')

function safeFarmId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function farmRoot(farmId: string): string {
  if (!safeFarmId(farmId)) throw new Error('Invalid Moments media path')
  return resolve(root, farmId)
}

function mediaPath(farmId: string, storageKey: string): string {
  const prefix = `moments/${farmId}/`
  if (!storageKey.startsWith(prefix)) throw new Error('Invalid Moments media path')
  const filename = storageKey.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]{20,64}\.(?:jpg|png|webp|mp4|mov)$/.test(filename)) {
    throw new Error('Invalid Moments media path')
  }
  const path = resolve(root, farmId, filename)
  if (!path.startsWith(`${farmRoot(farmId)}${sep}`)) throw new Error('Invalid Moments media path')
  return path
}

export function normalizeMomentMediaMime(
  mime: string | undefined,
  filename?: string,
): string | null {
  const declared = mime?.split(';')[0]?.trim().toLowerCase()
  const inferred = filename ? EXT_TO_MIME[extname(filename).slice(1).toLowerCase()] : null
  const value = declared || inferred
  return value && (IMAGE_MIMES.has(value) || VIDEO_MIMES.has(value)) ? value : null
}

export function momentMediaKind(mime: string): 'image' | 'video' | null {
  if (IMAGE_MIMES.has(mime)) return 'image'
  if (VIDEO_MIMES.has(mime)) return 'video'
  return null
}

export function hasMomentMediaSignature(mime: string, buffer: Buffer): boolean {
  if (mime === 'image/jpeg') {
    return buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
  }
  if (mime === 'image/png') {
    return (
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
  }
  if (mime === 'image/webp') {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    )
  }
  return buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
}

function stripJpegMetadata(buffer: Buffer): Buffer {
  const parts = [buffer.subarray(0, 2)]
  let offset = 2
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) throw new Error('Invalid JPEG structure')
    const marker = buffer[offset + 1]!
    if (marker === 0xda || marker === 0xd9) {
      parts.push(buffer.subarray(offset))
      return Buffer.concat(parts)
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buffer.length) throw new Error('Invalid JPEG structure')
    const end = offset + 2 + length
    const metadata = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe
    if (!metadata) parts.push(buffer.subarray(offset, end))
    offset = end
  }
  throw new Error('Invalid JPEG structure')
}

function stripPngMetadata(buffer: Buffer): Buffer {
  const parts = [buffer.subarray(0, 8)]
  const stripped = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'iCCP', 'tIME'])
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > buffer.length) throw new Error('Invalid PNG structure')
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    if (!stripped.has(type)) parts.push(buffer.subarray(offset, end))
    offset = end
    if (type === 'IEND') return Buffer.concat(parts)
  }
  throw new Error('Invalid PNG structure')
}

function stripWebpMetadata(buffer: Buffer): Buffer {
  const chunks: Buffer[] = []
  const stripped = new Set(['EXIF', 'XMP ', 'ICCP'])
  let offset = 12
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(offset + 4)
    const end = offset + 8 + size + (size % 2)
    if (end > buffer.length) throw new Error('Invalid WebP structure')
    const type = buffer.subarray(offset, offset + 4).toString('ascii')
    if (!stripped.has(type)) chunks.push(buffer.subarray(offset, end))
    offset = end
  }
  if (offset !== buffer.length) throw new Error('Invalid WebP structure')
  const body = Buffer.concat(chunks)
  const header = Buffer.from('RIFF\0\0\0\0WEBP', 'binary')
  header.writeUInt32LE(body.length + 4, 4)
  return Buffer.concat([header, body])
}

export function stripMomentImageMetadata(mime: string, buffer: Buffer): Buffer {
  if (mime === 'image/jpeg') return stripJpegMetadata(buffer)
  if (mime === 'image/png') return stripPngMetadata(buffer)
  return stripWebpMetadata(buffer)
}

export type StoredMomentMedia = {
  storageKey: string
  byteSize: number
  mimeType: string
  mediaKind: 'image' | 'video'
  durationSeconds: number | null
}

export async function storeMomentMedia(
  farmId: string,
  buffer: Buffer,
  mime: string,
): Promise<StoredMomentMedia> {
  if (buffer.length === 0 || buffer.length > MOMENTS_MAX_UPLOAD_BYTES) {
    throw new Error('Moment upload too large')
  }
  if (!hasMomentMediaSignature(mime, buffer)) {
    throw new Error('Moment media content does not match MIME type')
  }
  const kind = momentMediaKind(mime)
  if (!kind) throw new Error('Unsupported media type')

  await assertBufferIsClean(buffer)

  const dir = farmRoot(farmId)
  const session = resolve(dir, '.tmp', randomBytes(12).toString('base64url'))
  await mkdir(session, { recursive: true, mode: 0o750 })
  try {
    let output = buffer
    let outputMime = mime
    let durationSeconds: number | null = null
    if (kind === 'image') {
      output = stripMomentImageMetadata(mime, buffer)
    } else {
      const source = resolve(session, `source.${MIME_TO_EXT[mime]}`)
      await writeFile(source, buffer, { flag: 'wx', mode: 0o640 })
      const transcoded = await transcodeBrandUpload({
        sourcePath: source,
        sessionDir: session,
        sourceMime: mime,
      })
      output = await readFile(transcoded.outputPath)
      outputMime = transcoded.mimeType
      durationSeconds = transcoded.durationSeconds
      if (output.length > MOMENTS_MAX_UPLOAD_BYTES) {
        throw new Error('Processed Moment media exceeds 12MB')
      }
    }

    const ext = MIME_TO_EXT[outputMime]
    if (!ext) throw new Error('Unsupported processed media type')
    const filename = `${randomBytes(18).toString('base64url')}.${ext}`
    const storageKey = `moments/${farmId}/${filename}`
    await mkdir(dir, { recursive: true, mode: 0o750 })
    await writeFile(mediaPath(farmId, storageKey), output, { flag: 'wx', mode: 0o640 })
    return {
      storageKey,
      byteSize: output.length,
      mimeType: outputMime,
      mediaKind: kind,
      durationSeconds,
    }
  } finally {
    await rm(session, { recursive: true, force: true })
  }
}

export async function deleteMomentMedia(farmId: string, storageKey: string): Promise<void> {
  try {
    await unlink(mediaPath(farmId, storageKey))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

type ByteRange = { start: number; end: number } | 'invalid' | null

export function parseMomentRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null
  const match = header.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return 'invalid'
  const suffix = !match[1] && match[2] ? Number(match[2]) : null
  const start = suffix == null ? Number(match[1]) : Math.max(0, size - suffix)
  const end = match[1] && match[2] ? Number(match[2]) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return 'invalid'
  }
  return { start, end: Math.min(end, size - 1) }
}

export async function momentMediaResponse(params: {
  farmId: string
  storageKey: string
  mimeType: string
  rangeHeader?: string
  cacheControl: string
}): Promise<Response> {
  const path = mediaPath(params.farmId, params.storageKey)
  const info = await stat(path)
  const range = parseMomentRange(params.rangeHeader, info.size)
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes' },
    })
  }
  const stream = range
    ? createReadStream(path, { start: range.start, end: range.end })
    : createReadStream(path)
  const length = range ? range.end - range.start + 1 : info.size
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': params.mimeType,
      'Content-Length': String(length),
      ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` } : {}),
      'Accept-Ranges': 'bytes',
      'Cache-Control': params.cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
