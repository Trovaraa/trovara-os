import { Hono } from 'hono'
import { getTableName } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const FARM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER_ID = '11111111-1111-4111-8111-111111111111'
const CREATOR_ID = '22222222-2222-4222-8222-222222222222'
const ENTRY_ID = '33333333-3333-4333-8333-333333333333'

const selectQueue: Row[][] = []
const inserted: Array<{ table: string; values: unknown }> = []
const deleted: string[] = []

let sessionUser: Row = {
  id: OWNER_ID,
  farmId: FARM,
  role: 'owner',
}

function queryChain(rows: Row[]) {
  const chain: Record<string, unknown> = {}
  const same = () => chain
  Object.assign(chain, {
    from: same,
    innerJoin: same,
    leftJoin: same,
    where: same,
    orderBy: same,
    limit: same,
    then: (resolve: (value: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  })
  return chain
}

vi.mock('../db/index.js', () => ({
  db: {
    select: () => queryChain(selectQueue.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        inserted.push({ table: getTableName(table as never), values })
        return { returning: async () => [Array.isArray(values) ? values[0] : values] }
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        deleted.push(getTableName(table as never))
      },
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [] }) }),
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
vi.mock('../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../lib/security-log.js', () => ({ logSecurityEvent: vi.fn() }))
vi.mock('../middleware/security.js', () => ({
  checkDurableRateLimit: async () => true,
  resetDurableRateLimit: async () => undefined,
  vaultRevealRateKey: (id: string) => `vault:${id}`,
  VAULT_REVEAL_MAX_ATTEMPTS: 8,
}))

function entry(overrides: Row = {}): Row {
  return {
    id: ENTRY_ID,
    farmId: FARM,
    label: 'Instagram',
    category: 'social',
    loginUrl: 'https://instagram.com',
    loginEmail: 'social@trovara.farm',
    passwordCiphertext: 'cipher',
    notes: 'recovery',
    lastVerifiedAt: null,
    createdAt: new Date('2026-08-14T10:00:00Z'),
    updatedAt: new Date('2026-08-14T10:00:00Z'),
    ...overrides,
  }
}

async function app() {
  const { vaultRoutes } = await import('./vault.js')
  return new Hono().route('/', vaultRoutes)
}

beforeEach(() => {
  selectQueue.length = 0
  inserted.length = 0
  deleted.length = 0
  sessionUser = { id: OWNER_ID, farmId: FARM, role: 'owner' }
})

describe('vault sharing', () => {
  it('lets an owner share an entry with a content creator', async () => {
    selectQueue.push([{ id: ENTRY_ID, label: 'Instagram' }], [{ id: CREATOR_ID }])
    const response = await (await app()).request(`/${ENTRY_ID}/shares`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [CREATOR_ID] }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ sharedUserIds: [CREATOR_ID] })
    expect(deleted).toContain('portal_vault_shares')
    expect(inserted.some((row) => row.table === 'portal_vault_shares')).toBe(true)
  })

  it('returns only shared entries to a user without vault.view', async () => {
    sessionUser = {
      id: CREATOR_ID,
      farmId: FARM,
      role: 'supervisor',
      permissions: ['brand.manage'],
    }
    selectQueue.push(
      [entry(), entry({ id: 'other-entry', label: 'Paystack' })],
      [{ entryId: ENTRY_ID, farmId: FARM }],
      [{ entryId: ENTRY_ID, userId: CREATOR_ID }],
    )
    const response = await (await app()).request('/')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.canManage).toBe(false)
    expect(body.entries).toHaveLength(1)
    expect(body.entries[0]).toMatchObject({
      id: ENTRY_ID,
      label: 'Instagram',
      sharedWithMe: true,
      canReveal: true,
      canManage: false,
      notes: null,
    })
  })

  it('rejects reveal when the entry is not shared and the user cannot vault.reveal', async () => {
    sessionUser = {
      id: CREATOR_ID,
      farmId: FARM,
      role: 'supervisor',
      permissions: ['brand.manage'],
    }
    selectQueue.push([entry()], [])
    const response = await (await app()).request(`/${ENTRY_ID}/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(403)
  })

  it('lets vault.view users see every entry but only reveal ones shared with them', async () => {
    sessionUser = {
      id: CREATOR_ID,
      farmId: FARM,
      role: 'supervisor',
      permissions: ['vault.view'],
    }
    selectQueue.push(
      [entry(), entry({ id: 'other-entry', label: 'Paystack' })],
      [{ entryId: ENTRY_ID, userId: CREATOR_ID }],
    )
    const response = await (await app()).request('/')
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.entries).toHaveLength(2)
    const instagram = body.entries.find((row: Row) => row.id === ENTRY_ID)
    const paystack = body.entries.find((row: Row) => row.id === 'other-entry')
    expect(instagram).toMatchObject({ canReveal: true, sharedWithMe: true })
    expect(paystack).toMatchObject({ canReveal: false, sharedWithMe: false })
  })

  it('rejects shares for users who are not active staff on the farm', async () => {
    selectQueue.push([{ id: ENTRY_ID, label: 'Instagram' }], [])
    const response = await (await app()).request(`/${ENTRY_ID}/shares`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userIds: [CREATOR_ID] }),
    })
    expect(response.status).toBe(400)
  })
})
