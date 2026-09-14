import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono, type Context, type Next } from 'hono'
import { and, eq } from 'drizzle-orm'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { db } from '../db/index.js'
import { farms, users, careerPosts, talentApplications, talentCandidates, talentDocuments, talentEvents, rateLimitBuckets } from '../db/schema.js'
import { cvImportKey, ingestTalentApplication, importTalentEmail, processNextTalentDocument, deleteTalentApplication, purgeExpiredTalent } from '../lib/talent.js'
import { digest, prepareTalentDocument } from '../lib/talent-documents.js'
import type { SessionUser } from '../lib/session.js'

let session: SessionUser | null = null
vi.mock('../middleware/auth.js', () => ({ authMiddleware: async (c: Context, next: Next) => {
  if (!session) return c.json({ error: 'Unauthorized' }, 401)
  c.set('user', session); await next()
} }))
import { talentRoutes } from './talent.js'
import { publicTalentRoutes } from './talent-public.js'
import { careersRoutes } from './careers.js'

const app = new Hono().route('/api/talent', talentRoutes).route('/public/careers', publicTalentRoutes).route('/api/careers', careersRoutes)
const farmId = randomUUID(); const farmB = randomUUID(); const userId = randomUUID(); const userB = randomUUID()
const jobId = randomUUID(); const jobB = randomUUID()
let storage = ''
let sequence = 0
function owner(farm = farmId): SessionUser { return { id: farm === farmId ? userId : userB, farmId: farm, name: 'Test Owner', email: 'owner@example.invalid', role: 'owner' } }
function candidateName() { return `Example ${++sequence}` }
async function create(overrides: Partial<Parameters<typeof ingestTalentApplication>[0]> = {}) {
  return ingestTalentApplication({ farmId, actorId: userId, name: candidateName(), source: 'cv_upload', sourceKey: randomUUID(), documents: [], ...overrides })
}
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(`/api/talent${path}`, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
}
async function cv() {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Full name: Ada Example</w:t></w:r></w:p><w:p><w:r><w:t>ada@example.com</w:t></w:r></w:p><w:p><w:r><w:t>Skills</w:t></w:r></w:p><w:p><w:r><w:t>Nursery management and crop records</w:t></w:r></w:p></w:body></w:document>')
  return zip.generateAsync({ type: 'nodebuffer' })
}

beforeAll(async () => {
  storage = await mkdtemp(join(tmpdir(), 'talent-integration-'))
  vi.stubEnv('EVIDENCE_STORAGE_ROOT', storage); vi.stubEnv('KNOWLEDGE_STORAGE_ENDPOINT', '')
  vi.stubEnv('KNOWLEDGE_STORAGE_ENCRYPTION_KEY', ''); vi.stubEnv('CLAMAV_HOST', '')
  vi.stubEnv('CUSTOMER_FARM_ID', farmId); vi.stubEnv('TALENT_ZOHO_FOLDER_IDS', '')
  vi.stubEnv('TALENT_PUBLIC_APPLICATIONS_ENABLED', 'true')
  // Requests without proxy headers use the existing resolver's "local" fallback.
  await db.delete(rateLimitBuckets).where(eq(rateLimitBuckets.rateKey, `talent-public:${digest('local')}`))
  await db.insert(farms).values([{ id: farmId, name: 'Talent fixture', slug: `talent-${farmId}`, location: 'Test' }, { id: farmB, name: 'Other fixture', slug: `talent-${farmB}`, location: 'Test' }])
  await db.insert(users).values([{ id: userId, farmId, email: `${userId}@example.invalid`, name: 'Test Owner', role: 'owner', passwordHash: 'not-a-real-password' },
    { id: userB, farmId: farmB, email: `${userB}@example.invalid`, name: 'Other Owner', role: 'owner', passwordHash: 'not-a-real-password' }])
  await db.insert(careerPosts).values([{ id: jobId, farmId, slug: 'supervisor', title: 'Farm Supervisor', summary: 'Test role', bodyMarkdown: 'Test role details', published: true, publishedAt: new Date(), createdById: userId, updatedById: userId },
    { id: jobB, farmId: farmB, slug: 'other-role', title: 'Other farm role', summary: 'Test', bodyMarkdown: 'Test', published: true, publishedAt: new Date(), createdById: userB, updatedById: userB }])
})
beforeEach(() => { session = owner() })
afterAll(async () => {
  // Explicitly disposable fixture DB only; container teardown removes it after tests.
  vi.unstubAllEnvs()
  if (storage) await rm(storage, { recursive: true, force: true })
})

describe('Talent database and HTTP integration', () => {
  it('denies anonymous and careers-only users; catalog access does not leak applicants', async () => {
    session = null; expect((await request('')).status).toBe(401)
    session = { ...owner(), role: 'supervisor', permissions: ['careers.manage'] }
    expect((await request('')).status).toBe(403)
    expect((await request('/metadata')).status).toBe(403)
  })
  it('allows readers but denies mutations without talent.manage', async () => {
    session = { ...owner(), role: 'supervisor', permissions: ['talent.read'] }
    expect((await request('')).status).toBe(200)
    expect((await request('/import', 'POST')).status).toBe(403)
    expect((await request('/sync', 'POST')).status).toBe(403)
  })
  it('returns metadata with no credentials and a no-store header', async () => {
    const response = await request('/metadata')
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toContain('no-store')
    const result = await response.json(); expect(result.jobs).toHaveLength(1); expect(result.zoho.mailbox).toBe('hello@trovara.farm')
    expect(JSON.stringify(result)).not.toMatch(/clientSecret|refreshToken/)
  })
  it('does not leak cross-farm records, notes or file downloads', async () => {
    const result = await create()
    session = owner(farmB)
    expect((await request(`/${result.application.id}`)).status).toBe(404)
    expect((await request(`/${result.application.id}/notes`, 'POST', { body: 'Should not be saved' })).status).toBe(404)
    expect((await request(`/${result.application.id}/documents/${randomUUID()}`)).status).toBe(404)
    expect((await (await request('')).json()).applications).toHaveLength(0)
  })
  it('rejects foreign-farm job association even in the service layer', async () => {
    await expect(create({ careerPostId: jobB })).rejects.toThrow('Role not found')
  })
  it('deduplicates concurrent intake while retaining a candidate with multiple role applications', async () => {
    const sourceKey = randomUUID(); const email = `${randomUUID()}@example.com`
    const results = await Promise.all([create({ sourceKey, email }), create({ sourceKey, email })])
    expect(results[0].application.id).toBe(results[1].application.id)
    const next = await create({ email, careerPostId: jobId })
    expect(next.application.id).not.toBe(results[0].application.id)
    expect(next.application.candidateId).toBe(results[0].application.candidateId)
  })
  it('imports a CV alone, extracts source fields, serves a restricted download and avoids duplicate uploads', async () => {
    const buffer = await cv()
    const makeBody = () => { const body = new FormData(); body.append('file', new File([new Uint8Array(buffer)], 'ada.docx')); return body }
    const response = await app.request('/api/talent/import', { method: 'POST', body: makeBody() })
    expect(response.status).toBe(201)
    const result = await response.json()
    const duplicate = await app.request('/api/talent/import', { method: 'POST', body: makeBody() })
    expect((await duplicate.json()).duplicate).toBe(true)
    expect(await processNextTalentDocument(farmId)).toBe(true)
    const detail = await (await request(`/${result.id}`)).json()
    expect(detail.application.needsReview).toBe(true); expect(detail.documents).toHaveLength(1)
    expect(detail.documents[0].extractionStatus).toBe('ready')
    expect(detail.documents[0].extractedFields.name).toBe('Ada Example')
    expect(detail.documents[0].extractedText).toContain('Nursery management')
    const download = await request(`/${result.id}/documents/${detail.documents[0].id}`)
    expect(download.status).toBe(200); expect(download.headers.get('content-disposition')).toContain('attachment;')
    expect(Buffer.from(await download.arrayBuffer()).equals(buffer)).toBe(true)
    expect(detail.documents[0].storageKey).toBeUndefined()
  })
  it('preserves original email, detects repeat imports, and attaches only same-sender referenced replies', async () => {
    const messageId = `<${randomUUID()}@example.com>`
    const email = (id: string, sender: string, parent?: string) => Buffer.from(`From: Ada <${sender}>\r\nTo: hello@trovara.farm\r\nMessage-ID: ${id}\r\n${parent ? `In-Reply-To: ${parent}\r\n` : ''}Date: Tue, 11 Aug 2026 10:00:00 +0100\r\nSubject: Farm supervisor\r\nContent-Type: text/plain\r\n\r\nI would like to apply for the position.`)
    const sender = `${randomUUID()}@example.com`
    const first = await importTalentEmail({ farmId, filename: 'first.eml', buffer: email(messageId, sender) })
    const duplicate = await importTalentEmail({ farmId, filename: 'again.eml', buffer: email(messageId, sender) })
    expect(duplicate.duplicate).toBe(true)
    const reply = await importTalentEmail({ farmId, filename: 'reply.eml', buffer: email(`<${randomUUID()}@example.com>`, sender, messageId) })
    expect(reply.application.id).toBe(first.application.id)
    const other = await importTalentEmail({ farmId, filename: 'other.eml', buffer: email(`<${randomUUID()}@example.com>`, 'different@example.com', messageId) })
    expect(other.application.id).not.toBe(first.application.id)
    const detail = await (await request(`/${first.application.id}`)).json()
    expect(detail.documents).toHaveLength(2); expect(detail.events.filter((event: { kind: string }) => event.kind === 'email')).toHaveLength(2)
  })
  it('saves stage, private notes, assignments and reviewed contact details', async () => {
    const { application } = await create()
    const response = await request(`/${application.id}`, 'PATCH', { stage: 'shortlisted', careerPostId: jobId,
      assignedToId: userId, nextAction: 'Arrange interview', dueAt: '2026-10-01T12:00:00Z', needsReview: false,
      candidate: { name: 'Reviewed Example', email: `${randomUUID()}@example.com`, phone: null, location: 'Abeokuta' } })
    expect(response.status).toBe(200)
    expect((await request(`/${application.id}/notes`, 'POST', { body: 'Relevant farm operations experience.' })).status).toBe(201)
    const detail = await (await request(`/${application.id}`)).json()
    expect(detail.application.stage).toBe('shortlisted'); expect(detail.application.assignedToId).toBe(userId)
    expect(detail.candidate.name).toBe('Reviewed Example')
    expect(detail.events.some((event: { kind: string }) => event.kind === 'note')).toBe(true)
  })
  it('routes replies to a Talent reference only when the sender matches the candidate', async () => {
    const email = `${randomUUID()}@example.com`; const original = await create({ email })
    const source = (sender: string) => Buffer.from(`From: Example <${sender}>\r\nTo: hello@trovara.farm\r\nMessage-ID: <${randomUUID()}@example.com>\r\nSubject: Re: [Trovara ${original.application.id}] Interview\r\n\r\nThank you for the invitation.`)
    const reply = await importTalentEmail({ farmId, filename: 'reply.eml', buffer: source(email) })
    expect(reply.application.id).toBe(original.application.id)
    const other = await importTalentEmail({ farmId, filename: 'other.eml', buffer: source('other@example.com') })
    expect(other.application.id).not.toBe(original.application.id)
  })
  it('keeps hiring records when someone tries to delete an associated career listing', async () => {
    await create({ careerPostId: jobId })
    const response = await app.request(`/api/careers/${jobId}`, { method: 'DELETE' })
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('Unpublish')
  })
  it('attaches a supporting document to the existing application instead of making a new application', async () => {
    const { application } = await create()
    const buffer = await cv(); const body = new FormData()
    body.append('file', new File([new Uint8Array(buffer)], 'support.docx'))
    const response = await app.request(`/api/talent/${application.id}/documents`, { method: 'POST', body })
    expect(response.status).toBe(201)
    const detail = await (await request(`/${application.id}`)).json()
    expect(detail.documents).toHaveLength(1); expect(detail.documents[0].kind).toBe('supporting')
  })
  it('requires explicit confirmation before linking another candidate', async () => {
    const email = `${randomUUID()}@example.com`; const original = await create({ email, name: 'Existing profile' }); const imported = await create()
    const body = { stage: 'reviewing', careerPostId: null, assignedToId: null, nextAction: null, dueAt: null, needsReview: false,
      candidate: { name: 'Should not replace existing', email, phone: null, location: null } }
    expect((await request(`/${imported.application.id}`, 'PATCH', body)).status).toBe(409)
    expect((await request(`/${imported.application.id}`, 'PATCH', { ...body, linkExistingCandidate: true })).status).toBe(200)
    const detail = await (await request(`/${imported.application.id}`)).json()
    expect(detail.candidate.id).toBe(original.application.candidateId); expect(detail.candidate.name).toBe('Existing profile')
  })
  it('rejects cross-farm reviewer assignment and invalid IDs', async () => {
    const { application } = await create()
    const response = await request(`/${application.id}`, 'PATCH', { stage: 'new', careerPostId: null, assignedToId: userB, nextAction: null, dueAt: null, needsReview: true,
      candidate: { name: 'Example', email: null, phone: null, location: null } })
    expect(response.status).toBe(400); expect((await request('/not-an-id')).status).toBe(400)
  })
  it('accepts a public application with a reference only and never allows a private job', async () => {
    const buffer = await cv()
    const makeBody = (job: string) => {
      const body = new FormData()
      for (const [key, value] of Object.entries({ careerPostId: job, name: 'Public Example', email: `${randomUUID()}@example.com`, privacyAcknowledged: 'true', privacyNoticeVersion: 'talent-2026-09-13', requestId: randomUUID() })) body.append(key, value)
      body.append('cv', new File([new Uint8Array(buffer)], 'public.docx')); return body
    }
    const response = await app.request('/public/careers/applications', { method: 'POST', body: makeBody(jobId) })
    expect(response.status).toBe(201); const body = await response.json()
    expect(body.reference).toMatch(/^[a-f0-9-]{36}$/); expect(body.candidate).toBeUndefined()
    expect((await app.request('/public/careers/applications', { method: 'POST', body: makeBody(jobB) })).status).toBe(400)
  })
  it('limits deletion and retention changes to administrators', async () => {
    const { application } = await create()
    session = { ...owner(), role: 'supervisor', permissions: ['talent.read', 'talent.manage'] }
    expect((await request(`/${application.id}`, 'DELETE')).status).toBe(403)
    expect((await request(`/${application.id}/retention`, 'POST', { until: new Date(Date.now() + 86400_000).toISOString(), reason: 'Applicant requested extension' })).status).toBe(403)
  })
  it('deletes source objects/profile and prevents re-import of deleted sources', async () => {
    const buffer = await cv(); const sourceKey = cvImportKey(buffer, jobId)
    const result = await create({ sourceKey, documents: [await prepareTalentDocument(farmId, 'deletion.docx', buffer, 'cv')] })
    await deleteTalentApplication(farmId, result.application.id, userId)
    expect(await db.select().from(talentCandidates).where(eq(talentCandidates.id, result.application.candidateId))).toHaveLength(0)
    expect(await db.select().from(talentDocuments).where(eq(talentDocuments.applicationId, result.application.id))).toHaveLength(0)
    expect(await db.select().from(talentEvents).where(eq(talentEvents.applicationId, result.application.id))).toHaveLength(0)
    await expect(create({ sourceKey })).rejects.toThrow('previously deleted')
  })
  it('purges expired records while preserving other applications for that candidate', async () => {
    const email = `${randomUUID()}@example.com`; const first = await create({ email }); const second = await create({ email })
    await db.update(talentApplications).set({ retentionUntil: new Date('2020-01-01') }).where(eq(talentApplications.id, first.application.id))
    expect(await purgeExpiredTalent(farmId)).toBeGreaterThan(0)
    expect(await db.select().from(talentApplications).where(and(eq(talentApplications.farmId, farmId), eq(talentApplications.id, second.application.id)))).toHaveLength(1)
    expect(await db.select().from(talentCandidates).where(eq(talentCandidates.id, second.application.candidateId))).toHaveLength(1)
  })
})
