import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { zValidator } from '@hono/zod-validator'
import { and, asc, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { careerPosts, talentApplications, talentCandidates, talentDocuments, talentEvents, talentMailCursors, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { getKnowledgeObject } from '../lib/knowledge-storage.js'
import { cvImportKey, deleteTalentApplication, findTalentApplication, importTalentEmail, ingestTalentApplication } from '../lib/talent.js'
import { TALENT_FILE_LIMIT, TALENT_STAGES, prepareTalentDocument } from '../lib/talent-documents.js'
import { sendTalentMessage, syncTalentZoho, talentZohoStatus } from '../lib/talent-zoho.js'

const uuid = z.string().uuid()
const nullableText = (max: number) => z.string().trim().max(max).nullable()
const candidateSchema = z.object({ name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320).nullable(), phone: nullableText(80), location: nullableText(300) })
const patchSchema = z.object({
  stage: z.enum(TALENT_STAGES), careerPostId: uuid.nullable(),
  assignedToId: uuid.nullable(), nextAction: nullableText(1000), dueAt: z.string().datetime().nullable(),
  needsReview: z.boolean(), candidate: candidateSchema, linkExistingCandidate: z.boolean().default(false),
  updateSharedCandidate: z.boolean().default(false), separateCandidate: z.boolean().default(false),
  expectedCandidateId: uuid.optional(),
}).refine((body) => !(body.separateCandidate && (body.updateSharedCandidate || body.linkExistingCandidate)), 'Separate and shared/link modes cannot be combined')

export const talentRoutes = new Hono<{ Variables: AppVariables }>()
talentRoutes.use('*', authMiddleware)
talentRoutes.use('*', async (c, next) => {
  const user = c.get('user')
  if (!hasPermission(user, 'talent.read')) return c.json({ error: 'Forbidden' }, 403)
  if (c.req.method !== 'GET' && !hasPermission(user, 'talent.manage')) return c.json({ error: 'Forbidden' }, 403)
  c.header('Cache-Control', 'private, no-store')
  await next()
})
talentRoutes.use('*', bodyLimit({ maxSize: TALENT_FILE_LIMIT + 64 * 1024, onError: (c) => c.json({ error: 'Upload must be smaller than 10 MB' }, 413) }))

talentRoutes.get('/', async (c) => {
  const user = c.get('user')
  const parsed = z.object({ q: z.string().max(150).optional(), stage: z.enum(TALENT_STAGES).optional(),
    job: uuid.optional(), assigned: uuid.optional(), review: z.enum(['true']).optional(),
    from: z.string().date().optional(), to: z.string().date().optional(),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  }).safeParse(c.req.query())
  if (!parsed.success) return c.json({ error: 'Invalid filters' }, 400)
  const query = parsed.data
  const conditions = [eq(talentApplications.farmId, user.farmId), isNull(talentApplications.deletedAt)]
  if (query.stage) conditions.push(eq(talentApplications.stage, query.stage))
  if (query.job) conditions.push(eq(talentApplications.careerPostId, query.job))
  if (query.assigned) conditions.push(eq(talentApplications.assignedToId, query.assigned))
  if (query.review) conditions.push(eq(talentApplications.needsReview, true))
  const { gte, lte } = await import('drizzle-orm')
  if (query.from) conditions.push(gte(talentApplications.receivedAt, new Date(`${query.from}T00:00:00Z`)))
  if (query.to) conditions.push(lte(talentApplications.receivedAt, new Date(`${query.to}T23:59:59.999Z`)))
  if (query.q) {
    const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`
    conditions.push(or(ilike(talentCandidates.name, pattern), ilike(talentCandidates.email, pattern), ilike(talentApplications.roleLabel, pattern))!)
  }
  const rows = await db.select({ application: talentApplications, candidate: talentCandidates }).from(talentApplications)
    .innerJoin(talentCandidates, eq(talentCandidates.id, talentApplications.candidateId))
    .where(and(...conditions)).orderBy(desc(talentApplications.receivedAt), desc(talentApplications.id)).limit(51).offset(query.offset)
  return c.json({ applications: rows.slice(0, 50), hasMore: rows.length > 50 })
})

talentRoutes.get('/metadata', async (c) => {
  const farmId = c.get('user').farmId
  const [jobs, reviewers, cursors] = await Promise.all([
    db.select({ id: careerPosts.id, title: careerPosts.title, published: careerPosts.published }).from(careerPosts).where(eq(careerPosts.farmId, farmId)).orderBy(asc(careerPosts.title)),
    db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.farmId, farmId), eq(users.active, true))).orderBy(asc(users.name)),
    db.select({ lastSyncedAt: talentMailCursors.lastSyncedAt, lastError: talentMailCursors.lastError }).from(talentMailCursors).where(eq(talentMailCursors.farmId, farmId)),
  ])
  return c.json({ jobs, reviewers, stages: TALENT_STAGES, zoho: talentZohoStatus(farmId), sync: cursors })
})

talentRoutes.post('/import', async (c) => {
  const user = c.get('user')
  const form = await c.req.formData()
  const file = form.get('file')
  const role = form.get('careerPostId') || null
  if (!(file instanceof File) || !uuid.nullable().safeParse(role).success) return c.json({ error: 'Select a PDF, DOCX or EML file and a valid role' }, 400)
  if (file.size > TALENT_FILE_LIMIT) return c.json({ error: 'File exceeds 10 MB' }, 413)
  const buffer = Buffer.from(await file.arrayBuffer())
  const careerPostId = role as string | null
  try {
    const result = /\.eml$/i.test(file.name)
      ? await importTalentEmail({ farmId: user.farmId, actorId: user.id, filename: file.name, buffer, careerPostId })
      : await ingestTalentApplication({ farmId: user.farmId, actorId: user.id,
        name: 'CV import — review required', careerPostId, source: 'cv_upload', sourceKey: cvImportKey(buffer, careerPostId),
        documents: [await prepareTalentDocument(user.farmId, file.name, buffer, 'cv')],
      })
    await logAudit({ farmId: user.farmId, userId: user.id, action: 'import', entityType: 'talent_application', entityId: result.application.id })
    return c.json({ id: result.application.id, duplicate: result.duplicate }, 201)
  } catch (error) {
    // File validation is useful to the recruiter; infrastructure details never leave the API.
    const message = error instanceof Error ? error.message : ''
    if (/Only PDF|file|document|Email |sender|attachment|Role not found|10 MB|30 MB|previously deleted/i.test(message)) return c.json({ error: message.slice(0, 250) }, 400)
    return c.json({ error: 'Import could not complete. Check the malware scanner and private storage, then retry.' }, 503)
  }
})

talentRoutes.post('/sync', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'talent.admin')) return c.json({ error: 'Forbidden' }, 403)
  if (!talentZohoStatus(user.farmId).configured) return c.json({ error: 'Configure Zoho OAuth and recruitment folders on the server first' }, 503)
  const result = await syncTalentZoho(user.farmId, user.id)
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'sync', entityType: 'talent_intake', metadata: result })
  return c.json(result)
})

talentRoutes.get('/:id', async (c) => {
  const user = c.get('user')
  if (!uuid.safeParse(c.req.param('id')).success) return c.json({ error: 'Invalid application ID' }, 400)
  const application = await findTalentApplication(user.farmId, c.req.param('id'))
  if (!application) return c.json({ error: 'Not found' }, 404)
  const [candidate] = await db.select().from(talentCandidates).where(and(eq(talentCandidates.farmId, user.farmId), eq(talentCandidates.id, application.candidateId)))
  const documents = await db.select({ id: talentDocuments.id, filename: talentDocuments.filename, kind: talentDocuments.kind,
    extractionStatus: talentDocuments.extractionStatus, extractedText: talentDocuments.extractedText,
    extractedFields: talentDocuments.extractedFields, warnings: talentDocuments.warnings,
  }).from(talentDocuments).where(and(eq(talentDocuments.farmId, user.farmId), eq(talentDocuments.applicationId, application.id)))
  const events = await db.select().from(talentEvents).where(and(eq(talentEvents.farmId, user.farmId), eq(talentEvents.applicationId, application.id))).orderBy(desc(talentEvents.occurredAt))
  const otherApplications = await db.select({ id: talentApplications.id, roleLabel: talentApplications.roleLabel, stage: talentApplications.stage }).from(talentApplications)
    .where(and(eq(talentApplications.farmId, user.farmId), eq(talentApplications.candidateId, application.candidateId), isNull(talentApplications.deletedAt)))
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'view', entityType: 'talent_application', entityId: application.id })
  return c.json({ application, candidate, documents, events, otherApplications })
})

talentRoutes.patch('/:id', zValidator('json', patchSchema), async (c) => {
  const user = c.get('user')
  if (!uuid.safeParse(c.req.param('id')).success) return c.json({ error: 'Invalid application ID' }, 400)
  const application = await findTalentApplication(user.farmId, c.req.param('id'))
  if (!application) return c.json({ error: 'Not found' }, 404)
  const body = c.req.valid('json')
  let roleLabel = application.careerPostId && !body.careerPostId ? 'Unassigned / general interest' : application.roleLabel
  if (body.careerPostId) {
    const [job] = await db.select().from(careerPosts).where(and(eq(careerPosts.farmId, user.farmId), eq(careerPosts.id, body.careerPostId))).limit(1)
    if (!job) return c.json({ error: 'Role not found' }, 400)
    roleLabel = job.title
  }
  if (body.assignedToId) {
    const [reviewer] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId), eq(users.active, true))).limit(1)
    if (!reviewer) return c.json({ error: 'Reviewer not found' }, 400)
  }
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`talent:${user.farmId}`}))`)
      const [application] = await tx.select().from(talentApplications).where(and(
        eq(talentApplications.farmId, user.farmId), eq(talentApplications.id, c.req.param('id')), isNull(talentApplications.deletedAt),
      )).for('update')
      if (!application || (body.expectedCandidateId && body.expectedCandidateId !== application.candidateId)) throw new Error('APPLICATION_CHANGED')
      let candidateId = application.candidateId
      const [current] = await tx.select().from(talentCandidates).where(and(eq(talentCandidates.farmId, user.farmId), eq(talentCandidates.id, candidateId))).for('update')
      if (!current) throw new Error('APPLICATION_CHANGED')
      const related = await tx.select({ id: talentApplications.id }).from(talentApplications).where(and(
        eq(talentApplications.farmId, user.farmId), eq(talentApplications.candidateId, candidateId),
      ))
      const changed = (['name', 'email', 'phone', 'location'] as const).some((key) => body.candidate[key] !== current[key])
      const separate = body.separateCandidate || (related.length > 1 && changed && !body.updateSharedCandidate)
      const [existing] = body.candidate.email ? await tx.select().from(talentCandidates).where(and(eq(talentCandidates.farmId, user.farmId), eq(talentCandidates.email, body.candidate.email))).limit(1) : []
      if (existing && existing.id !== candidateId) {
        if (!body.linkExistingCandidate || body.separateCandidate) throw new Error('CANDIDATE_EXISTS')
        candidateId = existing.id
      } else if (separate && related.length > 1) {
        if (existing) throw new Error('SHARED_EMAIL')
        const [created] = await tx.insert(talentCandidates).values({ farmId: user.farmId, ...body.candidate }).returning()
        candidateId = created.id
      } else {
        await tx.update(talentCandidates).set({ ...body.candidate, updatedAt: new Date() }).where(and(eq(talentCandidates.farmId, user.farmId), eq(talentCandidates.id, candidateId)))
      }
      await tx.update(talentApplications).set({ candidateId, careerPostId: body.careerPostId, roleLabel,
        stage: body.stage, needsReview: body.needsReview, assignedToId: body.assignedToId,
        nextAction: body.nextAction, dueAt: body.dueAt ? new Date(body.dueAt) : null, updatedAt: new Date(),
      }).where(and(eq(talentApplications.farmId, user.farmId), eq(talentApplications.id, application.id)))
      if (candidateId !== application.candidateId) {
        const [other] = await tx.select({ id: talentApplications.id }).from(talentApplications).where(eq(talentApplications.candidateId, application.candidateId)).limit(1)
        if (!other) await tx.delete(talentCandidates).where(and(eq(talentCandidates.farmId, user.farmId), eq(talentCandidates.id, application.candidateId)))
      }
      await tx.insert(talentEvents).values({ farmId: user.farmId, applicationId: application.id, actorId: user.id,
        kind: 'updated', body: `Stage: ${application.stage} → ${body.stage}. ${body.needsReview ? 'Needs review.' : 'Details reviewed.'}${candidateId !== application.candidateId ? (existing ? ' Linked to an existing candidate; existing profile retained.' : ' Separated into an independent candidate; other applications unchanged.') : changed && related.length > 1 ? ' Shared contact profile updated with explicit confirmation.' : ''}` })
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'APPLICATION_CHANGED') return c.json({ error: 'Application changed. Reload before saving.' }, 409)
    if (error instanceof Error && error.message === 'SHARED_EMAIL') return c.json({ error: 'This email belongs to the shared profile. Enter this applicant’s own email (or clear it) to edit independently, or explicitly choose to update all linked applications.' }, 409)
    if ((error instanceof Error && error.message === 'CANDIDATE_EXISTS') || (error as { code?: string }).code === '23505') return c.json({ error: 'This email already belongs to a candidate. Confirm linking to their existing profile.' }, 409)
    throw error
  }
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'update', entityType: 'talent_application', entityId: application.id })
  return c.json({ ok: true })
})

talentRoutes.post('/:id/notes', zValidator('json', z.object({ body: z.string().trim().min(1).max(10_000) })), async (c) => {
  const user = c.get('user')
  const application = await findTalentApplication(user.farmId, c.req.param('id'))
  if (!application) return c.json({ error: 'Not found' }, 404)
  await db.insert(talentEvents).values({ farmId: user.farmId, applicationId: application.id, actorId: user.id, kind: 'note', body: c.req.valid('json').body })
  return c.json({ ok: true }, 201)
})

talentRoutes.get('/:id/documents/:documentId', async (c) => {
  const user = c.get('user')
  if (!uuid.safeParse(c.req.param('documentId')).success) return c.json({ error: 'Invalid document ID' }, 400)
  if (!await findTalentApplication(user.farmId, c.req.param('id'))) return c.json({ error: 'Not found' }, 404)
  const [document] = await db.select().from(talentDocuments).where(and(eq(talentDocuments.farmId, user.farmId),
    eq(talentDocuments.applicationId, c.req.param('id')), eq(talentDocuments.id, c.req.param('documentId')))).limit(1)
  if (!document) return c.json({ error: 'Not found' }, 404)
  const value = await getKnowledgeObject(document.storageKey)
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'download', entityType: 'talent_document', entityId: document.id })
  c.header('Content-Type', 'application/octet-stream')
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Content-Security-Policy', "default-src 'none'; sandbox")
  return c.body(new Uint8Array(value))
})

talentRoutes.post('/:id/documents', async (c) => {
  const user = c.get('user')
  const application = await findTalentApplication(user.farmId, c.req.param('id'))
  if (!application) return c.json({ error: 'Not found' }, 404)
  const form = await c.req.formData(); const file = form.get('file')
  if (!(file instanceof File) || !file.size || file.size > TALENT_FILE_LIMIT) return c.json({ error: 'Choose a PDF or DOCX document up to 10 MB' }, 400)
  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    await ingestTalentApplication({ farmId: user.farmId, actorId: user.id, name: 'Existing candidate',
      source: application.source as 'cv_upload' | 'email_import' | 'zoho' | 'website', sourceKey: application.sourceKey,
      documents: [await prepareTalentDocument(user.farmId, file.name, buffer, 'supporting')],
    })
    await db.insert(talentEvents).values({ farmId: user.farmId, applicationId: application.id, actorId: user.id,
      kind: 'document_added', body: 'Supporting document uploaded; extraction queued.' })
    return c.json({ ok: true }, 201)
  } catch { return c.json({ error: 'Unable to securely accept this document. Check file format, scanner and storage.' }, 400) }
})

talentRoutes.post('/:id/extract', async (c) => {
  const user = c.get('user')
  if (!await findTalentApplication(user.farmId, c.req.param('id'))) return c.json({ error: 'Not found' }, 404)
  await db.update(talentDocuments).set({ extractionStatus: 'pending', warnings: [] }).where(and(
    eq(talentDocuments.farmId, user.farmId), eq(talentDocuments.applicationId, c.req.param('id')), eq(talentDocuments.extractionStatus, 'needs_review'),
  ))
  return c.json({ ok: true })
})

talentRoutes.post('/:id/messages', zValidator('json', z.object({ subject: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/),
  body: z.string().trim().min(1).max(10_000), requestId: uuid })), async (c) => {
  const user = c.get('user')
  if (!await findTalentApplication(user.farmId, c.req.param('id'))) return c.json({ error: 'Not found' }, 404)
  try {
    const result = await sendTalentMessage({ ...c.req.valid('json'), farmId: user.farmId, actorId: user.id, applicationId: c.req.param('id') })
    return c.json(result)
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'Unable to send email' }, 409) }
})

talentRoutes.post('/:id/retention', zValidator('json', z.object({ until: z.string().datetime(), reason: z.string().trim().min(10).max(1000) })), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'talent.admin')) return c.json({ error: 'Forbidden' }, 403)
  const application = await findTalentApplication(user.farmId, c.req.param('id'))
  if (!application) return c.json({ error: 'Not found' }, 404)
  const body = c.req.valid('json'); const until = new Date(body.until)
  if (until.getTime() <= Date.now() || until.getTime() > Date.now() + 366 * 86400_000) return c.json({ error: 'Choose a future retention date within one year' }, 400)
  await db.transaction(async (tx) => {
    await tx.update(talentApplications).set({ retentionUntil: until }).where(and(eq(talentApplications.farmId, user.farmId), eq(talentApplications.id, application.id)))
    await tx.insert(talentEvents).values({ farmId: user.farmId, applicationId: application.id, actorId: user.id, kind: 'retention', body: `Retain until ${body.until}. Reason: ${body.reason}` })
  })
  return c.json({ ok: true })
})

talentRoutes.delete('/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'talent.admin')) return c.json({ error: 'Forbidden' }, 403)
  if (!uuid.safeParse(c.req.param('id')).success) return c.json({ error: 'Invalid application ID' }, 400)
  const deleted = await deleteTalentApplication(user.farmId, c.req.param('id'), user.id)
  return deleted ? c.json({ ok: true }) : c.json({ error: 'Not found' }, 404)
})
