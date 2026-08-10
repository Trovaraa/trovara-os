import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { hashPassword } from '../lib/session.js'

type Row = Record<string, unknown>
const tableName = (table: unknown) => getTableName(table as never)

const farmId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const packId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const assetId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const shareToken = 'share-token-example-abcdefghijklmnopqrstuvwxyz'

let sessionUser: Row = {
  id: '11111111-1111-4111-8111-111111111111',
  farmId,
  role: 'owner',
  name: 'Admin',
}

const packsByToken = new Map<string, Row>()
const packAssets: Row[] = []
let passwordHash: string | null = null

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      let rows: Row[] = []
      const chain: Record<string, unknown> = {}
      const same = () => chain
      Object.assign(chain, {
        from: (table: unknown) => {
          const name = tableName(table)
          if (name === 'brand_packs') rows = []
          if (name === 'brand_pack_assets') rows = packAssets
          if (name === 'brand_assets') rows = packAssets.map((row) => row)
          return chain
        },
        innerJoin: same,
        where: (_clause: unknown) => {
          // token lookups and asset joins resolve from in-memory fixtures
          if (packsByToken.size && rows.length === 0) {
            const pack = packsByToken.get(shareToken)
            if (pack) rows = [pack]
          }
          return chain
        },
        orderBy: same,
        limit: () => chain,
        then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      })
      return chain
    },
    insert: () => ({
      values: (values: Row | Row[]) => ({
        returning: async () => [Array.isArray(values) ? { id: 'new', ...values[0] } : { id: 'new', ...values }],
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: packId }],
        }),
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('user', sessionUser)
    await next()
  },
}))
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
}))
vi.mock('../middleware/security.js', () => ({
  checkDurableRateLimit: vi.fn(async () => true),
  hashedRateKey: (scope: string, identity: string) => `${scope}:${identity}`,
}))
vi.mock('../lib/brand-media.js', () => ({
  storeBrandMedia: vi.fn(async () => ({
    filename: 'aaaaaaaaaaaaaaaaaaaa.jpg',
    mimeType: 'image/jpeg',
    byteSize: 12,
  })),
  readBrandMedia: vi.fn(async () => ({
    buffer: Buffer.from('fake-image-bytes'),
    contentType: 'image/jpeg',
  })),
  openBrandMediaStream: vi.fn(async () => {
    const { Readable } = await import('node:stream')
    return {
      stream: Readable.from([Buffer.from('fake-image-bytes')]),
      contentType: 'image/jpeg',
      size: 16,
    }
  }),
  openBrandMediaRange: vi.fn(async () => {
    const { Readable } = await import('node:stream')
    return {
      stream: Readable.from([Buffer.from('fake')]),
      contentType: 'image/jpeg',
      size: 16,
    }
  }),
  brandMediaAbsolutePath: (_farmId: string, filename: string) => `/tmp/${filename}`,
  brandFarmRoot: () => '/tmp',
  deleteBrandMedia: vi.fn(),
  removeBrandUploadSession: vi.fn(),
  createBrandUploadSession: vi.fn(),
  streamRequestBodyToFile: vi.fn(),
  newShareToken: () => shareToken,
}))
vi.mock('../lib/streaming-zip.js', async () => {
  const { Readable } = await import('node:stream')
  return {
    createStoredZipStream: () => Readable.from([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])]),
  }
})
vi.mock('../lib/brand-processing.js', () => ({
  enqueueBrandAssetProcessing: vi.fn(),
}))

async function publicApp() {
  const { publicBrandRoutes } = await import('./brand.js')
  const app = new Hono()
  app.route('/', publicBrandRoutes)
  return app
}

describe('public brand packs', () => {
  beforeEach(async () => {
    passwordHash = await hashPassword('pack-secret')
    packsByToken.clear()
    packsByToken.set(shareToken, {
      id: packId,
      farmId,
      title: 'Press pack',
      notes: 'For creators',
      shareToken,
      passwordHash,
      expiresAt: null,
      revokedAt: null,
      viewCount: 0,
      downloadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    packAssets.length = 0
    packAssets.push({
      id: assetId,
      assetId,
      packId,
      position: 0,
      filename: 'aaaaaaaaaaaaaaaaaaaa.jpg',
      originalName: 'logo.jpg',
      mimeType: 'image/jpeg',
      byteSize: 12,
      width: null,
      height: null,
      mediaKind: 'image',
      status: 'ready',
      durationSeconds: null,
      posterFilename: null,
      farmId,
    })
  })

  it('hides files until unlocked with the correct password', async () => {
    const app = await publicApp()
    const meta = await app.request(`/${shareToken}`)
    expect(meta.status).toBe(200)
    const body = await meta.json()
    expect(body.passwordRequired).toBe(true)
    expect(body.unlocked).toBe(false)

    const denied = await app.request(`/${shareToken}/items`)
    expect(denied.status).toBe(401)

    const bad = await app.request(`/${shareToken}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })
    expect(bad.status).toBe(401)

    const unlock = await app.request(`/${shareToken}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pack-secret' }),
    })
    expect(unlock.status).toBe(200)
    const cookie = unlock.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('trovara_brand_pack=')

    const items = await app.request(`/${shareToken}/items`, {
      headers: { Cookie: cookie.split(';')[0]! },
    })
    expect(items.status).toBe(200)
    const payload = await items.json()
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0].originalName).toBe('logo.jpg')
  })

  it('returns 404 for revoked packs', async () => {
    packsByToken.set(shareToken, {
      ...packsByToken.get(shareToken)!,
      revokedAt: new Date(),
    })
    const app = await publicApp()
    const res = await app.request(`/${shareToken}`)
    expect(res.status).toBe(404)
  })

  it('streams a zip after unlock', async () => {
    const app = await publicApp()
    const unlock = await app.request(`/${shareToken}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'pack-secret' }),
    })
    const cookie = unlock.headers.get('set-cookie')?.split(';')[0] ?? ''
    const zip = await app.request(`/${shareToken}/download.zip`, {
      headers: { Cookie: cookie },
    })
    expect(zip.status).toBe(200)
    expect(zip.headers.get('content-type')).toContain('application/zip')
    const bytes = Buffer.from(await zip.arrayBuffer())
    expect(bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true)
  })
})
