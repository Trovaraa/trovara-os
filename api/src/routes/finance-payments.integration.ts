import { randomUUID } from 'node:crypto'
import { Hono, type Context, type Next } from 'hono'
import { and, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../db/index.js'
import { farms, users, assets, expenses, expensePayments, expenseLabels, expenseLabelLinks } from '../db/schema.js'
import type { SessionUser } from '../lib/session.js'
let session: SessionUser | null = null
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (c: Context, next: Next) => {
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  c.set('user', session); await next()
} }))
vi.mock('../lib/content-locale.js', () => ({ authorLocaleForUserId: async () => 'en', authorLocaleHint: () => 'en',
  toCanonicalEnglish: async ({ text }: { text: string }) => ({ english: text, status: 'done', sourceLocale: 'en' }), toViewerLocaleMany: async ({ texts }: { texts: string[] }) => texts }))
vi.mock('../lib/finance-inbound-ack.js', () => ({ maybeSendInboundApprovalAck: async () => ({ sent: false }) }))
import { financeRoutes } from './finance.js'
const app = new Hono().route('/finance', financeRoutes)
const farmId = randomUUID(), farmB = randomUUID(), userId = randomUUID(), userB = randomUUID()
function owner(farm = farmId): SessionUser { return { id: farm === farmId ? userId : userB, farmId: farm, role: 'owner', name: 'Fixture', email: 'fixture@example.invalid' } }
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(`/finance${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
}
async function invoice(overrides: Partial<typeof expenses.$inferInsert> = {}) {
  const [row] = await db.insert(expenses).values({ farmId, category: 'equipment', description: 'Synthetic invoice',
    amount: 100, currency: 'NGN', approvalStatus: 'approved', costCentreCode: 'CC10', recordedById: userId, expenseDate: new Date(), ...overrides }).returning()
  return row
}
const payment = (amount = 40) => ({ amount, currency: 'NGN', paidOn: new Date().toISOString().slice(0, 10), reference: 'Synthetic transfer', requestId: randomUUID() })
async function read(id: string) { return (await db.select().from(expenses).where(eq(expenses.id, id)))[0] }
beforeAll(async () => {
  await db.insert(farms).values([{ id: farmId, name: 'Finance fixture', slug: `finance-${farmId}`, location: 'Test' }, { id: farmB, name: 'Other fixture', slug: `finance-${farmB}`, location: 'Test' }])
  await db.insert(users).values([{ id: userId, farmId, email: `${userId}@example.invalid`, name: 'Test Owner', role: 'owner', passwordHash: 'not-a-password' },
    { id: userB, farmId: farmB, email: `${userB}@example.invalid`, name: 'Other Owner', role: 'owner', passwordHash: 'not-a-password' }])
})
beforeEach(() => { session = owner() })
describe('Finance payments and CAPEX integration', () => {
  it('defaults new approved invoices to unpaid with seven-day terms', async () => {
    const row = await invoice()
    expect(row.paymentStatus).toBe('unpaid'); expect(row.amountPaid).toBe(0)
    expect(row.approvedAt).toBeInstanceOf(Date)
    const due = new Date(row.approvedAt!); due.setUTCDate(due.getUTCDate() + 7)
    expect(row.paymentDueDate).toBe(due.toISOString().slice(0, 10))
  })
  it('sets the approval date on approval, not on initial draft creation', async () => {
    const row = await invoice({ approvalStatus: 'pending' })
    expect(row.approvedAt).toBeNull(); expect(row.paymentDueDate).toBeNull()
    expect((await request(`/${row.id}`, 'PATCH', { approvalStatus: 'approved' })).status).toBe(200)
    expect((await read(row.id)).approvedAt).toBeInstanceOf(Date)
  })
  it('preserves explicit payment terms when approving', async () => {
    const row = await invoice({ approvalStatus: 'pending', paymentDueDate: '2027-01-31' })
    expect((await request(`/${row.id}`, 'PATCH', { approvalStatus: 'approved' })).status).toBe(200)
    expect((await read(row.id)).paymentDueDate).toBe('2027-01-31')
  })
  it('tracks partial then full payment separately from approval', async () => {
    const row = await invoice()
    expect((await request(`/${row.id}/payments`, 'POST', payment())).status).toBe(201)
    expect(await read(row.id)).toMatchObject({ paymentStatus: 'partially_paid', amountPaid: 40, approvalStatus: 'approved' })
    expect((await request(`/${row.id}/payments`, 'POST', payment(60))).status).toBe(201)
    expect(await read(row.id)).toMatchObject({ paymentStatus: 'paid', amountPaid: 100 })
    const history = await (await request(`/${row.id}/payments`)).json()
    expect(history.payments).toHaveLength(2); expect(history.payments[0].recordedById).toBe(userId)
  })
  it('rejects unapproved and overpaid invoices', async () => {
    for (const status of ['pending', 'rejected']) {
      const row = await invoice({ approvalStatus: status })
      expect((await request(`/${row.id}/payments`, 'POST', payment())).status).toBe(409)
      expect((await read(row.id)).amountPaid).toBe(0)
    }
    const row = await invoice()
    expect((await request(`/${row.id}/payments`, 'POST', payment(101))).status).toBe(409)
  })
  it('serializes competing payments so they cannot exceed the balance', async () => {
    const row = await invoice()
    const responses = await Promise.all([request(`/${row.id}/payments`, 'POST', payment(60)), request(`/${row.id}/payments`, 'POST', payment(60))])
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]); expect((await read(row.id)).amountPaid).toBe(60)
  })
  it('retries identical requests without recording payment twice', async () => {
    const row = await invoice(), body = payment()
    const responses = await Promise.all([request(`/${row.id}/payments`, 'POST', body), request(`/${row.id}/payments`, 'POST', body)])
    expect(responses.map(r => r.status).sort()).toEqual([200, 201]); expect((await read(row.id)).amountPaid).toBe(40)
    expect((await request(`/${row.id}/payments`, 'POST', { ...body, amount: 20 })).status).toBe(409)
  })
  it('protects paid invoice amounts, approval, currency, entity and deletion', async () => {
    const row = await invoice(); await request(`/${row.id}/payments`, 'POST', payment())
    for (const change of [{ amount: 30 }, { approvalStatus: 'rejected' }, { currency: 'USD' }, { entityCode: '001' }]) {
      expect((await request(`/${row.id}`, 'PATCH', change)).status).toBe(409)
    }
    expect((await request(`/${row.id}`, 'DELETE')).status).toBe(409)
    await expect(db.update(expenses).set({ amount: 30 }).where(eq(expenses.id, row.id))).rejects.toThrow()
    await expect(db.delete(expenses).where(eq(expenses.id, row.id))).rejects.toThrow()
  })
  it('rejects stale currency and request-key reuse across different invoices', async () => {
    const first = await invoice(), second = await invoice(), body = payment()
    expect((await request(`/${first.id}/payments`, 'POST', { ...body, currency: 'USD' })).status).toBe(409)
    const responses = await Promise.all([request(`/${first.id}/payments`, 'POST', body), request(`/${second.id}/payments`, 'POST', body)])
    expect(responses.map(r => r.status).sort()).toEqual([201, 409])
    expect((await read(first.id)).amountPaid + (await read(second.id)).amountPaid).toBe(40)
  })
  it('allows finance readers to inspect but not record payments', async () => {
    const row = await invoice()
    session = { ...owner(), role: 'sales', permissions: ['finance.read'] }
    expect((await request(`/${row.id}/payments`)).status).toBe(200)
    expect((await request('/capex')).status).toBe(200)
    expect((await request(`/${row.id}/payments`, 'POST', payment())).status).toBe(403)
    expect((await request(`/${row.id}`, 'PATCH', { paymentDueDate: '2027-01-01' })).status).toBe(403)
  })
  it('keeps ledger entries immutable', async () => {
    const row = await invoice(); await request(`/${row.id}/payments`, 'POST', payment())
    await expect(db.update(expensePayments).set({ amount: 1 }).where(eq(expensePayments.expenseId, row.id))).rejects.toThrow()
    await expect(db.delete(expensePayments).where(eq(expensePayments.expenseId, row.id))).rejects.toThrow()
  })
  it('rejects malformed and future payments', async () => {
    const row = await invoice()
    for (const change of [{ amount: 0 }, { amount: -1 }, { amount: 0.5 }, { paidOn: '2099-01-01' }, { reference: '' }, { paidOn: '2026-02-30' }]) {
      expect((await request(`/${row.id}/payments`, 'POST', { ...payment(), ...change })).status).toBe(400)
    }
  })
  it('rejects anonymous, field-worker and cross-farm access', async () => {
    const row = await invoice(); session = null
    expect((await request('/capex')).status).toBe(401)
    session = { ...owner(), role: 'field_worker' }
    expect((await request('/capex')).status).toBe(403)
    expect((await request(`/${row.id}/payments`, 'POST', payment())).status).toBe(403)
    session = owner(farmB)
    expect((await request(`/${row.id}/payments`)).status).toBe(404)
    expect((await request(`/${row.id}/payments`, 'POST', payment())).status).toBe(404)
  })
  it('does not change the existing supervisor extraction permission', async () => {
    session = { ...owner(), role: 'supervisor' }
    expect((await request(`/${randomUUID()}/retry-extraction`, 'POST')).status).toBe(404)
    expect((await request('/capex')).status).toBe(403)
  })
  it('shows only this farm assets and CAPEX expenses without creating assets', async () => {
    const [asset] = await db.insert(assets).values({ farmId, name: 'Synthetic tractor', category: 'vehicle', acquisitionCostMinor: 10000 }).returning()
    await db.insert(assets).values({ farmId: farmB, name: 'Other farm private asset' })
    const [label] = await db.insert(expenseLabels).values({ farmId, name: 'Capex', slug: 'capex' }).onConflictDoUpdate({ target: [expenseLabels.farmId, expenseLabels.slug], set: { name: 'Capex' } }).returning()
    const row = await invoice(), ordinary = await invoice()
    await db.insert(expenseLabelLinks).values({ farmId, expenseId: row.id, labelId: label.id })
    const data = await (await request('/capex')).json()
    expect(data.assets.map((a: { id: string }) => a.id)).toEqual([asset.id])
    expect(data.expenses.map((e: { id: string }) => e.id)).toContain(row.id)
    expect(data.expenses.map((e: { id: string }) => e.id)).not.toContain(ordinary.id)
    expect(await db.select().from(assets).where(and(eq(assets.farmId, farmId)))).toHaveLength(1)
  })
})
