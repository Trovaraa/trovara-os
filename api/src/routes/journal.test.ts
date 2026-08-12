import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const tableName = (table: unknown) => getTableName(table as never)
let sessionUser: Row = {
  id: '11111111-1111-4111-8111-111111111111',
  farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'owner',
  name: 'Admin',
}
const selectQueue: Row[][] = []
const inserts: Row[] = []

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      let rows: Row[] = []
      const chain: Record<string, unknown> = {}
      const same = () => chain
      Object.assign(chain, {
        from: (table: unknown) => {
          if (tableName(table) === 'journal_posts') rows = selectQueue.shift() ?? []
          return chain
        },
        where: same,
        orderBy: same,
        limit: same,
        then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject),
      })
      return chain
    },
    insert: () => ({
      values: (values: Row) => {
        inserts.push(values)
        return { returning: async () => [{ id: 'post-new', ...values }] }
      },
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
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
vi.mock('../lib/customer-orders.js', () => ({
  resolveCustomerFarm: vi.fn(async () => ({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Farm',
    location: 'Lagos',
  })),
}))
vi.mock('../lib/journal-media.js', () => ({
  storeJournalMedia: vi.fn(),
  readJournalMedia: vi.fn(),
}))
vi.mock('../lib/journal-build-hook.js', () => ({ triggerJournalBuildHook: vi.fn() }))
vi.mock('../lib/rate-limit.js', () => ({
  checkRateLimit: () => ({ allowed: true, retryAfterSec: 0 }),
  checkDurableRateLimit: async () => ({ allowed: true, retryAfterSec: 0 }),
}))

async function adminApp() {
  const { journalRoutes } = await import('./journal.js')
  const app = new Hono()
  app.route('/', journalRoutes)
  return app
}

async function publicApp() {
  const { publicJournalRoutes } = await import('./journal.js')
  const app = new Hono()
  app.route('/', publicJournalRoutes)
  return app
}

const validPost = {
  slug: 'First Harvest',
  title: 'First harvest',
  excerpt: 'What the team harvested.',
  bodyMarkdown: '# Harvest',
  authorName: 'Trovara Team',
  category: 'Farm update',
  tags: ['harvest'],
}

beforeEach(() => {
  vi.clearAllMocks()
  selectQueue.length = 0
  inserts.length = 0
  sessionUser = {
    id: '11111111-1111-4111-8111-111111111111',
    farmId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'owner',
    name: 'Admin',
  }
})

describe('journal routes', () => {
  it('rejects non-owner mutations', async () => {
    sessionUser = { ...sessionUser, role: 'supervisor' }
    const response = await (await adminApp()).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPost),
    })
    expect(response.status).toBe(403)
    expect(inserts).toHaveLength(0)
  })

  it('rejects non-owners with 403 before Zod on incomplete bodies', async () => {
    sessionUser = { ...sessionUser, role: 'supervisor' }
    const response = await (await adminApp()).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(403)
    expect(inserts).toHaveLength(0)
  })

  it('does not expose drafts to non-owner staff', async () => {
    sessionUser = { ...sessionUser, role: 'supervisor' }
    const response = await (await adminApp()).request('/')
    expect(response.status).toBe(403)
  })

  it('creates a normalized draft for an owner', async () => {
    selectQueue.push([])
    const response = await (await adminApp()).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPost),
    })
    expect(response.status).toBe(201)
    expect(inserts[0]).toMatchObject({ slug: 'first-harvest', published: false, publishedAt: null })
  })

  it('returns only the published rows supplied by the public query', async () => {
    selectQueue.push([
      {
        slug: 'published-post',
        title: 'Published',
        excerpt: 'Visible',
        authorName: 'Trovara Team',
        category: 'News',
        tags: [],
        coverImageUrl: null,
        published: true,
        publishedAt: new Date('2026-08-01T12:00:00Z'),
      },
      {
        slug: 'draft-post',
        title: 'Draft',
        excerpt: 'Hidden',
        authorName: 'Trovara Team',
        category: 'News',
        tags: [],
        coverImageUrl: null,
        published: false,
        publishedAt: null,
      },
    ])
    const response = await (await publicApp()).request('/')
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.posts).toHaveLength(1)
    expect(payload.posts[0].slug).toBe('published-post')
    expect(payload.posts[0]).not.toHaveProperty('bodyMarkdown')
  })

  it('rejects journal media for a farmId that does not match the resolved shop farm', async () => {
    const { readJournalMedia } = await import('../lib/journal-media.js')
    const response = await (await publicApp()).request(
      '/media/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/example.jpg',
    )
    expect(response.status).toBe(404)
    expect(readJournalMedia).not.toHaveBeenCalled()
  })

  it('serves owner journal media over the authenticated API path', async () => {
    const { readJournalMedia } = await import('../lib/journal-media.js')
    vi.mocked(readJournalMedia).mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      contentType: 'image/jpeg',
    })
    const response = await (await adminApp()).request('/media/examplefileexamplefileex.jpg')
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(readJournalMedia).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'examplefileexamplefileex.jpg',
    )
  })
})
