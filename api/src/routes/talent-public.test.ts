import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../db/index.js', () => ({ db: {} }))
vi.mock('../lib/customer-orders.js', () => ({ resolveCustomerFarm: vi.fn() }))
vi.mock('../lib/talent.js', () => ({ ingestTalentApplication: vi.fn() }))
vi.mock('../lib/rate-limit.js', () => ({ checkDurableRateLimit: vi.fn(async () => ({ allowed: true })) }))
import { applicationsClosed, publicApplicationSchema, publicTalentRoutes } from './talent-public.js'
import { checkDurableRateLimit } from '../lib/rate-limit.js'
import { isCsrfExemptPath } from '../lib/csrf.js'

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })
describe('Public Talent intake', () => {
  it('is disabled until explicitly enabled', async () => {
    vi.stubEnv('TALENT_PUBLIC_APPLICATIONS_ENABLED', 'false')
    const response = await publicTalentRoutes.request('/applications', { method: 'POST' })
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('hello@trovara.farm')
  })
  it('only exempts the anonymous submission, not private Talent mutations', () => {
    expect(isCsrfExemptPath('/public/careers/applications')).toBe(true)
    expect(isCsrfExemptPath('/api/talent/import')).toBe(false)
    expect(isCsrfExemptPath('/api/talent/123/notes')).toBe(false)
  })
  it('honours the whole deadline day in Nigeria', () => {
    expect(applicationsClosed('2026-09-13', new Date('2026-09-13T22:59:59Z'))).toBe(false)
    expect(applicationsClosed('2026-09-13', new Date('2026-09-13T23:00:00Z'))).toBe(true)
    expect(applicationsClosed(null)).toBe(false)
  })
  it('requires current notice acknowledgement and rejects honeypots', () => {
    const body = { careerPostId: crypto.randomUUID(), requestId: crypto.randomUUID(), name: 'Ada Example', email: 'ada@example.com', privacyAcknowledged: 'true', privacyNoticeVersion: 'talent-2026-09-13' }
    expect(publicApplicationSchema.safeParse(body).success).toBe(true)
    expect(publicApplicationSchema.safeParse({ ...body, privacyAcknowledged: 'false' }).success).toBe(false)
    expect(publicApplicationSchema.safeParse({ ...body, privacyNoticeVersion: 'old' }).success).toBe(false)
    expect(publicApplicationSchema.safeParse({ ...body, website: 'spam' }).success).toBe(false)
  })
  it('does not expose staff records from the public router', async () => {
    const app = new Hono().route('/public/careers', publicTalentRoutes)
    expect((await app.request('/public/careers/applications/private-id')).status).toBe(404)
  })
  it('enforces durable rate limits before reading documents', async () => {
    vi.stubEnv('TALENT_PUBLIC_APPLICATIONS_ENABLED', 'true')
    vi.mocked(checkDurableRateLimit).mockResolvedValueOnce({ allowed: false, retryAfterSec: 60 })
    const response = await publicTalentRoutes.request('/applications', { method: 'POST' })
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('60')
  })
})
