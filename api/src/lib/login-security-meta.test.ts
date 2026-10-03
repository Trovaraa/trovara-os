import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

const query = vi.hoisted(() => ({ rows: [] as { name: string }[], where: vi.fn(), select: vi.fn() }))
vi.mock('../db/index.js', () => ({ db: {
  select: (...args: unknown[]) => { query.select(...args); return { from: () => ({
    where: (condition: unknown) => { query.where(condition); return { limit: async () => query.rows } },
  }) } },
} }))
vi.mock('./session.js', () => ({ hashIp: () => 'hashed-ip', isUnusualLoginIp: async () => false }))
vi.mock('./request-access-meta.js', () => ({
  withAccessMeta: (_headers: unknown, meta: object) => ({ ...meta, ip: '127.0.0.1' }),
}))
import { staffLoginSecurityMeta } from './login-security-meta.js'

const user = { id: 'user', email: 'synthetic@example.test', role: 'supervisor', farmId: 'farm', farmRoleId: 'custom' }
beforeEach(() => { vi.clearAllMocks(); query.rows = [{ name: 'Content Creator' }] })

describe('login role snapshot', () => {
  it.each([undefined, 'totp', 'totp_recovery', 'env_password'])('records custom and system role via %s', async via => {
    const result = await staffLoginSecurityMeta(() => undefined, user, via ? { via } : {})
    expect(result).toMatchObject({ role: 'Content Creator', systemRole: 'supervisor', farmRoleId: 'custom', unusualLogin: false })
    const sql = new PgDialect().sqlToQuery(query.where.mock.calls[0][0] as SQL)
    expect(sql.params).toEqual(['custom', 'farm'])
  })
  it('snapshots the role name rather than looking it up again for historical display', async () => {
    const first = await staffLoginSecurityMeta(() => undefined, user)
    query.rows = [{ name: 'Editor' }]
    const second = await staffLoginSecurityMeta(() => undefined, user)
    expect(first.role).toBe('Content Creator')
    expect(second.role).toBe('Editor')
  })
  it('handles legacy accounts without a custom role and protects identity fields from extra metadata', async () => {
    const result = await staffLoginSecurityMeta(() => undefined, { ...user, farmRoleId: null }, { role: 'owner', systemRole: 'owner' })
    expect(result).toMatchObject({ role: 'supervisor', systemRole: 'supervisor', farmRoleId: null })
    expect(query.select).not.toHaveBeenCalled()
  })
  it('does not substitute an unrelated or missing farm role name', async () => {
    query.rows = []
    expect(await staffLoginSecurityMeta(() => undefined, user)).toMatchObject({ role: 'supervisor', systemRole: 'supervisor', farmRoleId: 'custom' })
  })
})
