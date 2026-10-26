import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, truncate, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { brandFarmRoot, createBrandUploadSession, farmStorageBytes, removeBrandUploadSession } from './brand-media.js'
import { BRAND_MAX_FARM_STORAGE_BYTES, BRAND_MAX_UPLOAD_BYTES, BRAND_UPLOAD_CHUNK_BYTES, normalizeBrandMime, mediaKindForMime } from './brand-limits.js'

const TTL = 24 * 60 * 60 * 1000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export type UploadSession = { id: string; userId: string; name: string; mime: string; total: number; offset: number; createdAt: number; completed?: boolean }
export class UploadSessionError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 413 = 400) { super(message) }
}
const directory = (farmId: string) => resolve(brandFarmRoot(farmId), '.uploads')
function metadataPath(farmId: string, id: string) {
  if (!uuid.test(id)) throw new UploadSessionError('Upload session not found', 404)
  return resolve(directory(farmId), `${id}.json`)
}
async function save(farmId: string, session: UploadSession) {
  const path = metadataPath(farmId, session.id)
  await writeFile(`${path}.next`, JSON.stringify(session), { mode: 0o600 })
  await rename(`${path}.next`, path)
}
export async function getUploadSession(farmId: string, userId: string, id: string): Promise<UploadSession> {
  let session: UploadSession
  try { session = JSON.parse(await readFile(metadataPath(farmId, id), 'utf8')) }
  catch { throw new UploadSessionError('Upload session not found', 404) }
  if (session.userId !== userId) throw new UploadSessionError('Upload session not found', 404)
  if (Date.now() - session.createdAt > TTL) throw new UploadSessionError('Upload session expired. Select the file again.', 409)
  return session
}
export async function startUploadSession(farmId: string, userId: string, input: { name: string; mime: string; total: number }) {
  const mime = normalizeBrandMime(input.mime, input.name)
  if (!mime || !mediaKindForMime(mime)) throw new UploadSessionError('Unsupported media type')
  if (!Number.isSafeInteger(input.total) || input.total < 1 || input.total > BRAND_MAX_UPLOAD_BYTES) {
    throw new UploadSessionError(`Original file must be between 1 byte and ${Math.floor(BRAND_MAX_UPLOAD_BYTES / 1048576)} MiB`, 413)
  }
  await mkdir(directory(farmId), { recursive: true, mode: 0o700 })
  await assertBrandUploadCapacity(farmId, input.total)
  const session: UploadSession = { id: randomUUID(), userId, name: input.name, mime, total: input.total, offset: 0, createdAt: Date.now() }
  await createBrandUploadSession(farmId, session.id)
  await save(farmId, session)
  return session
}

// Also used by legacy uploads so they cannot consume space reserved by chunks.
export async function assertBrandUploadCapacity(farmId: string, incomingBytes: number) {
  let reserved = 0
  let pending = 0
  const files = await readdir(directory(farmId)).catch(error => {
    if (error.code === 'ENOENT') return [] as string[]
    throw error
  })
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    const old: UploadSession = JSON.parse(await readFile(resolve(directory(farmId), name), 'utf8'))
    if (Date.now() - old.createdAt > TTL) {
      // Completed sessions can still be processing: never delete their source.
      if (!old.completed) await removeBrandUploadSession(farmId, old.id)
      await unlink(metadataPath(farmId, old.id))
    } else {
      if (!old.completed) {
        pending++
        reserved += Math.max(0, old.total - old.offset) + 200 * 1048576
      } else if (await stat(resolve(brandFarmRoot(farmId), '.tmp', old.id, 'source.part')).then(() => true).catch(() => false)) {
        reserved += 200 * 1048576
      }
    }
  }
  if (pending >= 8) throw new UploadSessionError('Too many unfinished uploads. Retry an existing file before adding more.', 409)
  if (await farmStorageBytes(farmId) + reserved + incomingBytes + 200 * 1048576 > BRAND_MAX_FARM_STORAGE_BYTES) {
    throw new UploadSessionError('Brand storage quota exceeded', 413)
  }
}
export async function appendUploadChunk(farmId: string, session: UploadSession, offset: number, body: ReadableStream<Uint8Array> | null) {
  if (session.completed || offset !== session.offset) throw new UploadSessionError('Upload offset changed. Resume from the server offset.', 409)
  if (!body) throw new UploadSessionError('Empty chunk')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > BRAND_UPLOAD_CHUNK_BYTES || session.offset + length > session.total) {
        await reader.cancel()
        throw new UploadSessionError('Upload chunk too large', 413)
      }
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  if (!length) throw new UploadSessionError('Empty chunk')
  const { sourcePath } = await createBrandUploadSession(farmId, session.id)
  const size = await stat(sourcePath).then(s => s.size).catch(() => 0)
  if (size < session.offset) throw new UploadSessionError('Upload is incomplete. Select the file again.', 409)
  // Recover an interrupted append whose metadata was not committed.
  if (size > session.offset) await truncate(sourcePath, session.offset)
  await appendFile(sourcePath, Buffer.concat(chunks), { mode: 0o640 })
  const next = { ...session, offset: session.offset + length }
  await save(farmId, next)
  return next
}
export async function finishUploadSession(farmId: string, session: UploadSession) {
  await save(farmId, { ...session, completed: true })
}
export function uploadSessionDto(session: UploadSession) {
  return { id: session.id, offset: session.offset, total: session.total, chunkBytes: BRAND_UPLOAD_CHUNK_BYTES, completed: Boolean(session.completed) }
}
