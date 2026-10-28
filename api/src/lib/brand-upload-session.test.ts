import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, appendFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

let root: string
vi.mock('./evidence-store.js', () => ({ getEvidenceStorageRoot: () => root }))
let sessions: typeof import('./brand-upload-session.js')
let media: typeof import('./brand-media.js')
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'brand-chunk-test-'))
  sessions = await import('./brand-upload-session.js')
  media = await import('./brand-media.js')
})
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
const body = (value: string) => new Response(value).body!

describe('durable Brand upload chunks', () => {
  it('accepts the two supplied video sizes but rejects oversized originals', async () => {
    for (const total of [115183195, 230494485]) {
      const session = await sessions.startUploadSession(randomUUID(), 'user', { name: 'clip.MOV', mime: '', total })
      expect(session.mime).toBe('video/quicktime')
      expect(session.total).toBe(total)
    }
    await expect(sessions.startUploadSession(randomUUID(), 'u', { name: 'clip.mov', mime: '', total: 501 * 1048576 })).rejects.toThrow('500 MiB')
  })
  it('persists committed offsets and never duplicates a retransmitted chunk', async () => {
    const farm = randomUUID()
    let session = await sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 6 })
    session = await sessions.appendUploadChunk(farm, session, 0, body('abc'))
    expect((await sessions.getUploadSession(farm, 'u', session.id)).offset).toBe(3)
    await expect(sessions.appendUploadChunk(farm, session, 0, body('abc'))).rejects.toThrow('offset')
    const { sourcePath } = await media.createBrandUploadSession(farm, session.id)
    await appendFile(sourcePath, 'uncommitted')
    session = await sessions.appendUploadChunk(farm, session, 3, body('def'))
    expect(await readFile(sourcePath, 'utf8')).toBe('abcdef')
    expect(session.offset).toBe(6)
    await sessions.finishUploadSession(farm, session)
    const finished = await sessions.getUploadSession(farm, 'u', session.id)
    expect(finished.completed).toBe(true)
    await expect(sessions.appendUploadChunk(farm, finished, 6, body('x'))).rejects.toThrow()
  })
  it('binds sessions to both farm and uploader and rejects path traversal', async () => {
    const farm = randomUUID()
    const session = await sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 6 })
    await expect(sessions.getUploadSession(farm, 'other', session.id)).rejects.toThrow('not found')
    await expect(sessions.getUploadSession(randomUUID(), 'u', session.id)).rejects.toThrow('not found')
    await expect(sessions.getUploadSession(farm, 'u', '../source')).rejects.toThrow('not found')
  })
  it('rejects chunk overflows, empty chunks and counts nested temporary storage', async () => {
    const farm = randomUUID()
    const session = await sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 3 })
    await expect(sessions.appendUploadChunk(farm, session, 0, body('abcd'))).rejects.toThrow('too large')
    await expect(sessions.appendUploadChunk(farm, session, 0, body(''))).rejects.toThrow('Empty')
    await sessions.appendUploadChunk(farm, session, 0, body('abc'))
    expect(await media.farmStorageBytes(farm)).toBeGreaterThan(3)
  })
  it('bounds concurrent unfinished reservations', async () => {
    const farm = randomUUID()
    for (let i = 0; i < 8; i++) await sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 3 })
    await expect(sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 3 })).rejects.toThrow('Too many')
  })
  it('enforces the chunk ceiling and reserves space for pending originals and outputs', async () => {
    const farm = randomUUID()
    const session = await sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 500 * 1048576 })
    await expect(sessions.appendUploadChunk(farm, session, 0, new Response(new Uint8Array(8 * 1048576 + 1)).body)).rejects.toThrow('too large')
    await sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 500 * 1048576 })
    await expect(sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 500 * 1048576 })).rejects.toThrow('quota')
  })
  it('expires abandoned sessions without deleting a completed processing source', async () => {
    const farm = randomUUID()
    for (const completed of [false, true]) {
      const session = await sessions.startUploadSession(farm, 'u', { name: 'clip.mov', mime: '', total: 3 })
      await sessions.appendUploadChunk(farm, session, 0, body('abc'))
      const { sourcePath } = await media.createBrandUploadSession(farm, session.id)
      await writeFile(join(media.brandFarmRoot(farm), '.uploads', `${session.id}.json`), JSON.stringify({ ...session, completed, createdAt: Date.now() - 25 * 3600000 }))
      await expect(sessions.getUploadSession(farm, 'u', session.id)).rejects.toThrow('expired')
      await sessions.startUploadSession(farm, 'u', { name: 'next.mov', mime: '', total: 3 })
      expect(await stat(sourcePath).then(() => true).catch(() => false)).toBe(completed)
    }
  })
})
