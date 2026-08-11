import { Hono } from 'hono'
import { getTableName, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const FARM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FARM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const dialect = new PgDialect()
const rows: Row[] = []
const whereLog: SQL[] = []
const insertErrors: unknown[] = []

let sessionUser: Row = {
  id: USER_ID,
  farmId: FARM_A,
  role: 'supervisor',
  permissions: ['careers.manage'],
}

function post(overrides: Row = {}): Row {
  return {
    id: crypto.randomUUID(),
    farmId: FARM_A,
    slug: 'farm-manager',
    title: 'Farm manager',
    department: 'Operations',
    location: 'Lagos',
    employmentType: 'full_time',
    summary: 'Run daily farm operations.',
    bodyMarkdown: '# Farm manager',
    applyEmail: 'jobs@example.com',
    published: false,
    publishedAt: null,
    createdById: USER_ID,
    updatedById: USER_ID,
    createdAt: new Date('2026-08-01T12:00:00Z'),
    updatedAt: new Date('2026-08-01T12:00:00Z'),
    ...overrides,
  }
}

function matchingRows(condition?: SQL): Row[] {
  if (!condition) return [...rows]
  const query = dialect.sqlToQuery(condition)
  return rows.filter((row) => {
    const equalities = [
      ...query.sql.matchAll(/"career_posts"\."([^"]+)" = \$(\d+)/g),
    ]
    for (const [, column, position] of equalities) {
      const property = {
        farm_id: 'farmId',
        published_at: 'publishedAt',
      }[column!] ?? column!
      if (row[property] !== query.params[Number(position) - 1]) return false
    }
    if (query.sql.includes('"career_posts"."published_at" is not null') && row.publishedAt == null) {
      return false
    }
    return true
  })
}

vi.mock('../db/index.js', () => ({
  db: {
    select: () => {
      let condition: SQL | undefined
      const chain: Record<string, unknown> = {}
      const same = () => chain
      Object.assign(chain, {
        from: (table: unknown) => {
          if (getTableName(table as never) !== 'career_posts') {
            throw new Error('Unexpected table')
          }
          return chain
        },
        where: (value: SQL) => {
          condition = value
          whereLog.push(value)
          return chain
        },
        orderBy: same,
        limit: same,
        then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(matchingRows(condition)).then(resolve, reject),
      })
      return chain
    },
    insert: (table: unknown) => ({
      values: (values: Row) => ({
        returning: async () => {
          if (getTableName(table as never) !== 'career_posts') throw new Error('Unexpected table')
          const error = insertErrors.shift()
          if (error) throw error
          const created = post(values)
          rows.push(created)
          return [created]
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: (condition: SQL) => ({
          returning: async () => {
            if (getTableName(table as never) !== 'career_posts') throw new Error('Unexpected table')
            whereLog.push(condition)
            const matches = matchingRows(condition)
            for (const match of matches) Object.assign(match, values)
            return matches
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: async (condition: SQL) => {
        if (getTableName(table as never) !== 'career_posts') throw new Error('Unexpected table')
        whereLog.push(condition)
        const ids = new Set(matchingRows(condition).map((row) => row.id))
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          if (ids.has(rows[index]!.id)) rows.splice(index, 1)
        }
      },
    }),
  },
}))

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set('user', sessionUser)
    await next()
  },
}))

vi.mock('../lib/customer-orders.js', () => ({
  resolveCustomerFarm: vi.fn(async () => ({ id: FARM_A, name: 'Farm A' })),
}))
vi.mock('../lib/rate-limit.js', () => ({
  checkDurableRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSec: 0 })),
}))
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))

async function managerApp() {
  const { careersRoutes } = await import('./careers.js')
  return new Hono().route('/', careersRoutes)
}

async function publicApp() {
  const { publicCareersRoutes } = await import('./careers.js')
  return new Hono().route('/', publicCareersRoutes)
}

const validPost = {
  slug: 'Farm Manager',
  title: 'Farm manager',
  department: 'Operations',
  location: 'Lagos',
  employmentType: 'full_time',
  summary: 'Run daily farm operations.',
  bodyMarkdown: '# Farm manager',
  applyEmail: 'jobs@example.com',
}

beforeEach(() => {
  vi.clearAllMocks()
  rows.length = 0
  whereLog.length = 0
  insertErrors.length = 0
  sessionUser = {
    id: USER_ID,
    farmId: FARM_A,
    role: 'supervisor',
    permissions: ['careers.manage'],
  }
})

describe('careers management authorization and scoping', () => {
  it('requires the exact careers.manage permission before reads or validation', async () => {
    sessionUser.permissions = ['journal.manage']
    const app = await managerApp()

    expect((await app.request('/')).status).toBe(403)
    const create = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    expect(create.status).toBe(403)
    expect(whereLog).toHaveLength(0)
  })

  it('allows an explicit careers.manage grant for a non-owner', async () => {
    rows.push(post())
    const response = await (await managerApp()).request('/')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      posts: [expect.objectContaining({ slug: 'farm-manager' })],
    })
  })

  it('does not read, update, or delete another farm post', async () => {
    const foreign = post({ id: 'foreign-post', farmId: FARM_B, slug: 'foreign-role' })
    rows.push(foreign)
    const app = await managerApp()

    expect((await app.request('/foreign-post')).status).toBe(404)
    expect(
      (
        await app.request('/foreign-post', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Taken over' }),
        })
      ).status,
    ).toBe(404)
    expect((await app.request('/foreign-post', { method: 'DELETE' })).status).toBe(404)
    expect(rows[0]).toEqual(foreign)
    expect(
      whereLog.every((condition) => dialect.sqlToQuery(condition).params.includes(FARM_A)),
    ).toBe(true)
  })
})

describe('career slug and publication behavior', () => {
  it('scopes normalized slug collisions to the current farm', async () => {
    rows.push(
      post({ id: 'same-farm', slug: 'farm-manager' }),
      post({ id: 'other-farm', farmId: FARM_B, slug: 'harvest-lead' }),
    )
    const app = await managerApp()

    const collision = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPost),
    })
    expect(collision.status).toBe(409)

    const allowed = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validPost, slug: 'Harvest Lead' }),
    })
    expect(allowed.status).toBe(201)
    await expect(allowed.json()).resolves.toMatchObject({
      post: { farmId: FARM_A, slug: 'harvest-lead' },
    })
  })

  it('maps a database uniqueness race to a slug conflict', async () => {
    insertErrors.push({ code: '23505' })
    const response = await (await managerApp()).request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPost),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Slug already exists' })
  })

  it('makes a post public on publish and hides it again on unpublish', async () => {
    rows.push(post({ id: 'toggle-post', slug: 'toggle-post' }))
    const manager = await managerApp()
    const publicRoutes = await publicApp()

    const publish = await manager.request('/toggle-post', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ published: true }),
    })
    expect(publish.status).toBe(200)
    expect((await publicRoutes.request('/toggle-post')).status).toBe(200)

    const unpublish = await manager.request('/toggle-post', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ published: false }),
    })
    expect(unpublish.status).toBe(200)
    expect((await publicRoutes.request('/toggle-post')).status).toBe(404)
    await expect((await publicRoutes.request('/')).json()).resolves.toEqual({ posts: [] })
  })
})

describe('public career reads', () => {
  it('returns only published posts for the resolved farm with a publication date', async () => {
    rows.push(
      post({
        id: 'visible',
        slug: 'visible-role',
        published: true,
        publishedAt: new Date('2026-08-10T12:00:00Z'),
      }),
      post({ id: 'draft', slug: 'draft-role' }),
      post({ id: 'missing-date', slug: 'missing-date', published: true }),
      post({
        id: 'foreign',
        farmId: FARM_B,
        slug: 'foreign-role',
        published: true,
        publishedAt: new Date('2026-08-10T12:00:00Z'),
      }),
    )
    const app = await publicApp()

    const list = await app.request('/')
    expect(list.status).toBe(200)
    const payload = await list.json()
    expect(payload.posts).toHaveLength(1)
    expect(payload.posts[0]).toMatchObject({ id: 'visible', slug: 'visible-role' })
    expect(payload.posts[0]).not.toHaveProperty('farmId')
    expect(payload.posts[0]).not.toHaveProperty('published')

    expect((await app.request('/Draft Role')).status).toBe(404)
    expect((await app.request('/Foreign Role')).status).toBe(404)
    const detail = await app.request('/Visible Role')
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({ post: { id: 'visible' } })
  })
})
