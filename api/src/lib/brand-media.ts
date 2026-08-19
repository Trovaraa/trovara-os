import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, opendir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { getEvidenceStorageRoot } from './evidence-store.js'
import {
  BRAND_MAX_DATA_URL_DECODED,
  BRAND_MAX_DATA_URL_LENGTH,
  BRAND_MAX_FARM_STORAGE_BYTES,
  BRAND_MAX_UPLOAD_BYTES,
} from './brand-limits.js'

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
} as const

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
}

export type BrandStoredMime = keyof typeof MIME_TO_EXT

const mediaRoot = resolve(getEvidenceStorageRoot(), 'brand-media')

function safeFarmId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function safeFilename(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}\.(?:jpg|png|webp|mp4)$/.test(value)
}

function safeTempSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,120}$/.test(value) && !value.includes('..')
}

export function brandMediaRoot(): string {
  return mediaRoot
}

export function brandFarmRoot(farmId: string): string {
  if (!safeFarmId(farmId)) throw new Error('Invalid brand media path')
  return resolve(mediaRoot, farmId)
}

function filePath(farmId: string, filename: string): string {
  if (!safeFarmId(farmId) || !safeFilename(filename)) throw new Error('Invalid brand media path')
  const path = resolve(mediaRoot, farmId, filename)
  const farmRoot = `${brandFarmRoot(farmId)}${sep}`
  if (!path.startsWith(farmRoot)) throw new Error('Invalid brand media path')
  return path
}

function hasExpectedSignature(mime: BrandStoredMime, buffer: Buffer): boolean {
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
  if (mime === 'video/mp4') {
    // ISO BMFF: size(4) + 'ftyp' at offset 4
    return buffer.length >= 8 && buffer.subarray(4, 8).toString('ascii') === 'ftyp'
  }
  return false
}

/** Total on-disk Brand Kit footprint, including in-progress uploads. */
async function farmStorageBytes(farmId: string): Promise<number> {
  let total = 0
  const root = brandFarmRoot(farmId)
  try {
    const directory = await opendir(root)
    for await (const entry of directory) {
      const entryPath = resolve(root, entry.name)
      if (entry.isFile()) total += (await stat(entryPath)).size
      if (entry.isDirectory()) {
        const nested = await opendir(entryPath)
        for await (const child of nested) {
          if (child.isFile()) total += (await stat(resolve(entryPath, child.name))).size
        }
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return total
}

export async function assertBrandStorageCapacity(farmId: string, incomingBytes: number): Promise<void> {
  if (!Number.isFinite(incomingBytes) || incomingBytes < 1) throw new Error('Invalid upload size')
  if (incomingBytes > BRAND_MAX_UPLOAD_BYTES) throw new Error('Brand upload too large')
  if ((await farmStorageBytes(farmId)) + incomingBytes > BRAND_MAX_FARM_STORAGE_BYTES) {
    throw new Error('Brand storage quota exceeded')
  }
}

export type StoredBrandMedia = {
  filename: string
  mimeType: BrandStoredMime
  byteSize: number
}

export async function storeBrandMedia(farmId: string, dataUrl: string): Promise<StoredBrandMedia> {
  if (dataUrl.length > BRAND_MAX_DATA_URL_LENGTH) throw new Error('Brand image too large')
  const match = dataUrl.match(
    /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i,
  )
  if (!match) throw new Error('Invalid brand image data URL')

  const mime = match[1]!.toLowerCase() as BrandStoredMime
  const buffer = Buffer.from(match[2]!, 'base64')
  if (buffer.length === 0 || buffer.length > BRAND_MAX_DATA_URL_DECODED) {
    throw new Error('Brand image too large')
  }
  await assertBrandStorageCapacity(farmId, buffer.length)
  if (!hasExpectedSignature(mime, buffer)) {
    throw new Error('Brand image content does not match MIME type')
  }

  const filename = `${randomBytes(18).toString('base64url')}.${MIME_TO_EXT[mime]}`
  const path = filePath(farmId, filename)
  await mkdir(brandFarmRoot(farmId), { recursive: true })
  await writeFile(path, buffer, { flag: 'wx', mode: 0o640 })
  return { filename, mimeType: mime, byteSize: buffer.length }
}

export async function createBrandUploadSession(
  farmId: string,
  assetId: string,
): Promise<{ sessionDir: string; sourcePath: string }> {
  if (!safeFarmId(farmId) || !safeTempSegment(assetId)) {
    throw new Error('Invalid brand media path')
  }
  const sessionDir = resolve(brandFarmRoot(farmId), '.tmp', assetId)
  const farmRoot = `${brandFarmRoot(farmId)}${sep}`
  if (!sessionDir.startsWith(farmRoot)) throw new Error('Invalid brand media path')
  await mkdir(sessionDir, { recursive: true, mode: 0o750 })
  return { sessionDir, sourcePath: resolve(sessionDir, 'source.part') }
}

/** Stream an HTTP request body to disk with a hard byte cap. */
export async function streamRequestBodyToFile(
  body: ReadableStream<Uint8Array> | null,
  destPath: string,
  maxBytes = BRAND_MAX_UPLOAD_BYTES,
): Promise<number> {
  if (!body) throw new Error('Empty upload body')
  await mkdir(dirname(destPath), { recursive: true })
  const nodeReadable = Readable.fromWeb(body as import('node:stream/web').ReadableStream)
  let total = 0
  const { Transform } = await import('node:stream')
  const limiter = new Transform({
    transform(chunk, _enc, callback) {
      total += chunk.length
      if (total > maxBytes) {
        callback(new Error('Brand upload too large'))
        return
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(nodeReadable, limiter, createWriteStream(destPath, { flags: 'wx', mode: 0o640 }))
  } catch (error) {
    await unlink(destPath).catch(() => undefined)
    throw error
  }
  if (total === 0) {
    await unlink(destPath).catch(() => undefined)
    throw new Error('Empty upload body')
  }
  return total
}

async function sniffFileHead(path: string, bytes = 256): Promise<Buffer> {
  const fh = await import('node:fs/promises').then((m) => m.open(path, 'r'))
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export async function promoteBrandFile(
  farmId: string,
  sourcePath: string,
  mime: BrandStoredMime,
): Promise<StoredBrandMedia> {
  const probe = await sniffFileHead(sourcePath)
  if (!hasExpectedSignature(mime, probe)) {
    throw new Error('Brand media content does not match MIME type')
  }

  const filename = `${randomBytes(18).toString('base64url')}.${MIME_TO_EXT[mime]}`
  const dest = filePath(farmId, filename)
  await mkdir(brandFarmRoot(farmId), { recursive: true })
  await rename(sourcePath, dest)
  const info = await stat(dest)
  return { filename, mimeType: mime, byteSize: info.size }
}

export async function writeBrandPosterFromFile(
  farmId: string,
  sourcePosterPath: string,
): Promise<string> {
  const filename = `${randomBytes(18).toString('base64url')}.jpg`
  const dest = filePath(farmId, filename)
  await mkdir(brandFarmRoot(farmId), { recursive: true })
  await rename(sourcePosterPath, dest)
  return filename
}

export async function readBrandMedia(
  farmId: string,
  filename: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  const contentType = EXT_TO_MIME[extension]
  if (!contentType) throw new Error('Unsupported brand media')
  const buffer = await readFile(filePath(farmId, filename))
  return { buffer, contentType }
}

export async function openBrandMediaStream(
  farmId: string,
  filename: string,
): Promise<{ stream: ReturnType<typeof createReadStream>; contentType: string; size: number }> {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  const contentType = EXT_TO_MIME[extension]
  if (!contentType) throw new Error('Unsupported brand media')
  const path = filePath(farmId, filename)
  const info = await stat(path)
  return {
    stream: createReadStream(path),
    contentType,
    size: info.size,
  }
}

export async function openBrandMediaRange(
  farmId: string,
  filename: string,
  start: number,
  end: number,
): Promise<{ stream: ReturnType<typeof createReadStream>; contentType: string; size: number }> {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  const contentType = EXT_TO_MIME[extension]
  if (!contentType) throw new Error('Unsupported brand media')
  const path = filePath(farmId, filename)
  const info = await stat(path)
  const safeStart = Math.max(0, start)
  const safeEnd = Math.min(info.size - 1, end)
  if (safeStart > safeEnd) throw new Error('Invalid range')
  return {
    stream: createReadStream(path, { start: safeStart, end: safeEnd }),
    contentType,
    size: info.size,
  }
}

export function brandMediaAbsolutePath(farmId: string, filename: string): string {
  return filePath(farmId, filename)
}

export async function deleteBrandMedia(farmId: string, filename: string | null | undefined): Promise<void> {
  if (!filename) return
  try {
    await unlink(filePath(farmId, filename))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function removeBrandUploadSession(farmId: string, assetId: string): Promise<void> {
  if (!safeFarmId(farmId) || !safeTempSegment(assetId)) return
  const sessionDir = resolve(brandFarmRoot(farmId), '.tmp', assetId)
  const farmRoot = `${brandFarmRoot(farmId)}${sep}`
  if (!sessionDir.startsWith(farmRoot)) return
  await rm(sessionDir, { recursive: true, force: true })
}

export function newShareToken(): string {
  return randomBytes(32).toString('base64url')
}

export function brandContentTypeForFilename(filename: string): string | null {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_MIME[extension] ?? null
}
