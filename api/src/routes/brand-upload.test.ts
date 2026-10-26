import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

let root: string
let app: Hono
let rows: Record<string, unknown>[] = []
let holdInsert: (() => Promise<void>) | undefined
const user = { id: randomUUID(), farmId: randomUUID(), role: 'owner' }
let allowed = true
const enqueue = vi.fn()
vi.mock('../lib/evidence-store.js', () => ({ getEvidenceStorageRoot: () => root }))
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => { c.set('user', user); await next() } }))
vi.mock('../lib/rbac.js', () => ({ hasPermission: () => allowed }))
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/brand-processing.js', () => ({ enqueueBrandAssetProcessing: (...args: unknown[]) => enqueue(...args) }))
vi.mock('../db/index.js', () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  insert: () => ({ values: (values: Record<string, unknown>) => ({ returning: async () => {
    await holdInsert?.()
    const row = { ...values, createdAt: new Date(), updatedAt: new Date() }
    rows.push(row)
    return [row]
  } }) }),
} }))
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'brand-route-test-'))
  const { brandRoutes } = await import('./brand.js')
  app = new Hono().route('/api/brand', brandRoutes)
})
beforeEach(() => { rows = []; allowed = true; holdInsert = undefined; user.farmId = randomUUID(); enqueue.mockClear() })
afterAll(async () => { await rm(root, { recursive: true, force: true }) })
const base = '/api/brand/assets/upload/session'
async function start(total = 3) {
  return app.request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'clip.MOV', mime: 'video/quicktime', total }) })
}
describe('Brand chunk HTTP routes', () => {
  it('serializes legacy uploads through database finalization and releases the farm lock', async () => {
    let entered!: () => void
    let release!: () => void
    const insertionStarted = new Promise<void>(resolve => { entered = resolve })
    const paused = new Promise<void>(resolve => { release = resolve })
    holdInsert = async () => { entered(); await paused }
    const legacy = app.request('/api/brand/assets/upload', { method: 'POST', headers: { 'Content-Type': 'video/quicktime', 'Content-Length': '3', 'X-Brand-Original-Name': 'clip.mov' }, body: 'abc' })
    await insertionStarted
    try { expect((await start()).status).toBe(429) }
    finally { release() }
    expect((await legacy).status).toBe(202)
    expect((await start()).status).toBe(201)
  })
  it('uploads and finalizes idempotently, with no duplicate asset or queue entry', async () => {
    const response = await start()
    expect(response.status).toBe(201)
    const { session } = await response.json()
    const uploaded = await app.request(`${base}/${session.id}`, { method: 'PATCH', headers: { 'X-Upload-Offset': '0' }, body: 'abc' })
    expect(uploaded.status).toBe(200)
    expect((await uploaded.json()).session.offset).toBe(3)
    const first = await app.request(`${base}/${session.id}/complete`, { method: 'POST' })
    expect(first.status).toBe(202)
    const second = await app.request(`${base}/${session.id}/complete`, { method: 'POST' })
    expect(second.status).toBe(200)
    expect(rows).toHaveLength(1)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
  it('retains uploaded bytes when database finalization fails temporarily', async () => {
    const { session } = await (await start()).json()
    await app.request(`${base}/${session.id}`, { method: 'PATCH', headers: { 'X-Upload-Offset': '0' }, body: 'abc' })
    holdInsert = async () => { throw new Error('Temporary database failure') }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try { expect((await app.request(`${base}/${session.id}/complete`, { method: 'POST' })).status).toBe(500) }
    finally { consoleError.mockRestore(); holdInsert = undefined }
    const { createBrandUploadSession } = await import('../lib/brand-media.js')
    const { sourcePath } = await createBrandUploadSession(user.farmId, session.id)
    expect(await readFile(sourcePath, 'utf8')).toBe('abc')
    expect((await app.request(`${base}/${session.id}/complete`, { method: 'POST' })).status).toBe(202)
    expect(rows).toHaveLength(1)
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
  it('enforces permissions, ownership, size and offset at the HTTP boundary', async () => {
    allowed = false
    expect((await start()).status).toBe(403)
    allowed = true
    expect((await start(501 * 1048576)).status).toBe(413)
    const { session } = await (await start()).json()
    expect((await app.request(`${base}/${session.id}/complete`, { method: 'POST' })).status).toBe(409)
    expect((await app.request(`${base}/${session.id}`, { method: 'PATCH', headers: { 'X-Upload-Offset': '1' }, body: 'a' })).status).toBe(409)
    user.farmId = randomUUID()
    expect((await app.request(`${base}/${session.id}`)).status).toBe(404)
  })
})
