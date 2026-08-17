import { Hono } from 'hono'
import { createHash } from 'node:crypto'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db/index.js'
import {
  knowledgeEvaluationCases,
  knowledgeEvaluationRuns,
  knowledgeJobs,
  operationGuidelineDocuments,
  operationGuidelineVersions,
  operationGuidelines,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { hasPermission } from '../lib/rbac.js'
import { logAudit } from '../lib/audit.js'
import { deleteKnowledgeDocument, extractKnowledgeDocument, inspectKnowledgeDocument, MAX_KNOWLEDGE_DOCUMENT_BYTES, readKnowledgeDocument, storeKnowledgeDocument } from '../lib/knowledge-documents.js'
import { briefGuidelineContent } from '../lib/knowledge-brief.js'
import { findGuidelineDocumentId, removeGuidelineFromIndex } from '../lib/knowledge-index.js'
import { embeddingModel } from '../lib/embeddings.js'

const guidelineSchema = z.object({
  title: z.string().trim().min(3).max(160),
  category: z.string().trim().min(2).max(80),
  body: z.string().trim().min(20).max(250000),
  audience: z.enum(['all', 'management', 'finance', 'operations', 'sales']).default('all'),
  ownerId: z.string().uuid().optional(),
  reviewDueAt: z.string().datetime().nullable().optional(),
})

const evaluationCaseSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  expectedGuidelineId: z.string().uuid(),
  expectedText: z.string().trim().max(1000).nullable().optional(),
  audience: z.enum(['all', 'management', 'finance', 'operations', 'sales']).default('all'),
  language: z.enum(['en', 'yo', 'pcm', 'fr']).default('en'),
})

const briefSchema = z.object({
  guidelineId: z.string().uuid().optional(),
  documentId: z.string().uuid().optional(),
  title: z.string().trim().max(160).optional(),
  body: z.string().trim().min(20).max(250000).optional(),
  locale: z.enum(['en', 'yo', 'pcm', 'fr']).optional(),
}).refine((value) => Boolean(value.guidelineId || value.documentId || value.body), {
  message: 'Choose a guideline or document to brief',
})

export const operationGuidelineRoutes = new Hono<{ Variables: AppVariables }>()
operationGuidelineRoutes.use('*', authMiddleware)

const guidelineAuthor = alias(users, 'operation_guideline_author')
const guidelineOwner = alias(users, 'operation_guideline_owner')

async function isAssignableGuidelineOwner(farmId: string, ownerId: string): Promise<boolean> {
  const [owner] = await db.select({ id: users.id }).from(users).where(and(
    eq(users.id, ownerId),
    eq(users.farmId, farmId),
    eq(users.active, true),
  )).limit(1)
  return Boolean(owner)
}

operationGuidelineRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.read') && !hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const rows = await db
    .select({ guideline: operationGuidelines, authorName: guidelineAuthor.name, ownerName: guidelineOwner.name, documentId: operationGuidelineDocuments.id, documentFilename: operationGuidelineDocuments.originalFilename })
    .from(operationGuidelines)
    .leftJoin(guidelineAuthor, eq(operationGuidelines.createdById, guidelineAuthor.id))
    .leftJoin(guidelineOwner, eq(operationGuidelines.ownerId, guidelineOwner.id))
    .leftJoin(operationGuidelineDocuments, eq(operationGuidelineDocuments.guidelineId, operationGuidelines.id))
    .where(eq(operationGuidelines.farmId, user.farmId))
    .orderBy(desc(operationGuidelines.updatedAt))
  const canApprove = hasPermission(user, 'knowledge.approve')
  return c.json({ guidelines: rows
    .filter(({ guideline }) => canApprove || guideline.status === 'approved' || guideline.createdById === user.id)
    .map(({ guideline, authorName, ownerName, documentId, documentFilename }) => ({ ...guideline, authorName, ownerName, sourceDocument: documentId ? { id: documentId, filename: documentFilename } : null })) })
})

operationGuidelineRoutes.get('/owners', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const owners = await db.select({ id: users.id, name: users.name }).from(users).where(and(
    eq(users.farmId, user.farmId),
    eq(users.active, true),
  )).orderBy(users.name)
  return c.json({ owners })
})

operationGuidelineRoutes.post('/imports/preview', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const contentLength = Number(c.req.header('content-length') ?? 0)
  if (contentLength > MAX_KNOWLEDGE_DOCUMENT_BYTES + 500_000) return c.json({ error: 'Document is larger than 10 MB' }, 413)
  const form = await c.req.parseBody()
  const uploaded = form.file
  if (!(uploaded instanceof File)) return c.json({ error: 'Choose a PDF or DOCX document' }, 400)
  const buffer = Buffer.from(await uploaded.arrayBuffer())
  let inspected: ReturnType<typeof inspectKnowledgeDocument>
  try {
    inspected = inspectKnowledgeDocument(buffer, uploaded.name)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Document validation failed' }, 400)
  }
  const stored = await storeKnowledgeDocument(user.farmId, uploaded.name, buffer)
  try {
    const { document, job } = await db.transaction(async (tx) => {
      const [document] = await tx.insert(operationGuidelineDocuments).values({
        farmId: user.farmId,
        originalFilename: uploaded.name.slice(0, 255),
        storageKey: stored.storageKey,
        storageBucket: stored.storageBucket,
        mimeType: inspected.mimeType,
        sizeBytes: buffer.length,
        sha256: stored.sha256,
        extractionStatus: 'queued',
        scanStatus: 'queued',
        ocrStatus: inspected.extension === 'pdf' ? 'pending' : 'not_needed',
        extractedText: '',
        extractionWarnings: [],
        uploadedById: user.id,
      }).returning()
      const [job] = await tx.insert(knowledgeJobs).values({
        farmId: user.farmId,
        type: 'document_process',
        payload: { documentId: document.id },
        createdById: user.id,
      }).returning()
      return { document, job }
    })
    await logAudit({ farmId: user.farmId, userId: user.id, action: 'operation_guideline_document_preview', entityType: 'operation_guideline_document', entityId: document.id, metadata: { filename: document.originalFilename, sizeBytes: document.sizeBytes } })
    return c.json({ document: { id: document.id, filename: document.originalFilename, sizeBytes: document.sizeBytes, status: document.extractionStatus, scanStatus: document.scanStatus, ocrStatus: document.ocrStatus, extractedText: '', warnings: [] }, jobId: job.id }, 202)
  } catch (error) {
    await deleteKnowledgeDocument(user.farmId, stored.storageKey)
    throw error
  }
})

operationGuidelineRoutes.get('/imports/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write') && !hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const [document] = await db.select().from(operationGuidelineDocuments).where(and(
    eq(operationGuidelineDocuments.id, c.req.param('id')),
    eq(operationGuidelineDocuments.farmId, user.farmId),
  )).limit(1)
  if (!document) return c.json({ error: 'Document preview not found' }, 404)
  if (document.uploadedById !== user.id && !hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  return c.json({ document: {
    id: document.id,
    filename: document.originalFilename,
    sizeBytes: document.sizeBytes,
    status: document.extractionStatus,
    scanStatus: document.scanStatus,
    scanResult: document.scanStatus === 'infected' ? document.scanResult : null,
    ocrStatus: document.ocrStatus,
    ocrConfidence: document.ocrConfidence == null ? null : Number(document.ocrConfidence),
    extractedText: document.extractionStatus === 'needs_review' ? document.extractedText : '',
    warnings: document.extractionWarnings,
  } })
})

operationGuidelineRoutes.post('/imports/:id/create-draft', zValidator('json', guidelineSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const [document] = await db.select().from(operationGuidelineDocuments).where(and(eq(operationGuidelineDocuments.id, c.req.param('id')), eq(operationGuidelineDocuments.farmId, user.farmId))).limit(1)
  if (!document) return c.json({ error: 'Document preview not found' }, 404)
  if (document.scanStatus !== 'clean' || document.extractionStatus !== 'needs_review' || document.guidelineId) return c.json({ error: 'This document has not completed safe processing or has already been used' }, 409)
  if (document.uploadedById !== user.id && !hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const ownerId = body.ownerId ?? user.id
  if (!await isAssignableGuidelineOwner(user.farmId, ownerId)) return c.json({ error: 'Choose an active owner from this farm' }, 400)
  const guideline = await db.transaction(async (tx) => {
    const [created] = await tx.insert(operationGuidelines).values({ farmId: user.farmId, title: body.title, category: body.category, body: body.body, audience: body.audience, ownerId, reviewDueAt: body.reviewDueAt ? new Date(body.reviewDueAt) : null, createdById: user.id }).returning()
    await tx.update(operationGuidelineDocuments).set({ guidelineId: created.id, extractionStatus: 'draft_created', updatedAt: new Date() }).where(eq(operationGuidelineDocuments.id, document.id))
    return created
  })
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'operation_guideline_create_from_document', entityType: 'operation_guideline', entityId: guideline.id, metadata: { documentId: document.id } })
  return c.json({ guideline }, 201)
})

operationGuidelineRoutes.delete('/imports/:id', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const [document] = await db.select().from(operationGuidelineDocuments).where(and(eq(operationGuidelineDocuments.id, c.req.param('id')), eq(operationGuidelineDocuments.farmId, user.farmId))).limit(1)
  if (!document) return c.json({ error: 'Document preview not found' }, 404)
  if (document.guidelineId || ['scanning', 'extracting', 'draft_created'].includes(document.extractionStatus)) return c.json({ error: 'This document cannot be discarded while it is processing or linked to a guideline' }, 409)
  if (document.uploadedById !== user.id && !hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  await db.delete(operationGuidelineDocuments).where(eq(operationGuidelineDocuments.id, document.id))
  await deleteKnowledgeDocument(user.farmId, document.storageKey)
  if (document.cleanStorageKey) await deleteKnowledgeDocument(user.farmId, document.cleanStorageKey)
  return c.json({ deleted: true })
})

operationGuidelineRoutes.post('/documents/:id/reextract', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const [document] = await db.select().from(operationGuidelineDocuments).where(and(
    eq(operationGuidelineDocuments.id, c.req.param('id')),
    eq(operationGuidelineDocuments.farmId, user.farmId),
  )).limit(1)
  if (!document) return c.json({ error: 'Document not found' }, 404)
  if (document.scanStatus !== 'clean') return c.json({ error: 'Document is quarantined or still processing' }, 409)
  const storageKey = document.cleanStorageKey || document.storageKey
  if (!storageKey) return c.json({ error: 'The original file is no longer available' }, 409)
  if (document.uploadedById !== user.id && !hasPermission(user, 'knowledge.approve')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const file = await readKnowledgeDocument(user.farmId, storageKey)
  let extracted
  try {
    extracted = await extractKnowledgeDocument(file, document.originalFilename)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Could not re-read the source document' }, 422)
  }
  await db.update(operationGuidelineDocuments).set({
    extractedText: extracted.text,
    extractionWarnings: extracted.warnings,
    updatedAt: new Date(),
  }).where(eq(operationGuidelineDocuments.id, document.id))
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'operation_guideline_document_reextract',
    entityType: 'operation_guideline_document',
    entityId: document.id,
    metadata: { guidelineId: document.guidelineId, filename: document.originalFilename },
  })
  return c.json({
    document: {
      id: document.id,
      filename: document.originalFilename,
      extractedText: extracted.text,
      warnings: extracted.warnings,
    },
  })
})

operationGuidelineRoutes.post('/brief', zValidator('json', briefSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.read') && !hasPermission(user, 'knowledge.write')) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const payload = c.req.valid('json')
  let title = payload.title?.trim() || ''
  let body = payload.body?.trim() || ''
  let source: 'form' | 'guideline' | 'document' = 'form'

  if (payload.body) {
    if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
    source = 'form'
  } else if (payload.guidelineId) {
    const [guideline] = await db.select().from(operationGuidelines).where(and(
      eq(operationGuidelines.id, payload.guidelineId),
      eq(operationGuidelines.farmId, user.farmId),
    )).limit(1)
    if (!guideline) return c.json({ error: 'Guideline not found' }, 404)
    const canRead = guideline.status === 'approved' || guideline.createdById === user.id || hasPermission(user, 'knowledge.approve')
    if (!canRead) return c.json({ error: 'Forbidden' }, 403)
    title = title || guideline.title
    body = guideline.body
    source = 'guideline'
  } else if (payload.documentId) {
    if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
    const [document] = await db.select().from(operationGuidelineDocuments).where(and(
      eq(operationGuidelineDocuments.id, payload.documentId),
      eq(operationGuidelineDocuments.farmId, user.farmId),
    )).limit(1)
    if (!document) return c.json({ error: 'Document not found' }, 404)
    if (document.uploadedById !== user.id && !hasPermission(user, 'knowledge.approve')) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (document.scanStatus !== 'clean' || !document.extractedText.trim()) {
      return c.json({ error: 'Document is still processing or has no extracted text', code: 'empty' }, 409)
    }
    title = title || document.originalFilename
    body = document.extractedText
    source = 'document'
  }

  const result = await briefGuidelineContent({
    farmId: user.farmId,
    title,
    body,
    locale: payload.locale,
  })
  if (!result.ok) {
    const messages = {
      llm_unavailable: 'Farm AI is not configured on this server',
      budget_exhausted: 'Farm AI daily limit reached. Try again tomorrow.',
      empty: 'There is not enough document text to brief',
      llm_failed: 'Could not write a brief right now',
    } as const
    const status = result.reason === 'llm_unavailable' ? 503
      : result.reason === 'budget_exhausted' ? 429
        : result.reason === 'empty' ? 422
          : 502
    return c.json({ error: messages[result.reason], code: result.reason }, status)
  }
  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'operation_guideline_brief',
    entityType: source === 'guideline' ? 'operation_guideline' : 'operation_guideline_document',
    entityId: payload.guidelineId ?? payload.documentId,
    metadata: { source, title: title.slice(0, 160) },
  })
  return c.json({ brief: result.brief, model: result.model })
})

operationGuidelineRoutes.get('/documents/:id/download', async (c) => {
  const user = c.get('user')
  const [row] = await db.select({ document: operationGuidelineDocuments, guideline: operationGuidelines }).from(operationGuidelineDocuments).leftJoin(operationGuidelines, eq(operationGuidelineDocuments.guidelineId, operationGuidelines.id)).where(and(eq(operationGuidelineDocuments.id, c.req.param('id')), eq(operationGuidelineDocuments.farmId, user.farmId))).limit(1)
  if (!row) return c.json({ error: 'Document not found' }, 404)
  const canRead = (row.guideline?.status === 'approved' && hasPermission(user, 'knowledge.read')) || row.document.uploadedById === user.id || hasPermission(user, 'knowledge.approve')
  if (!canRead) return c.json({ error: 'Forbidden' }, 403)
  if (row.document.scanStatus !== 'clean' || !row.document.cleanStorageKey) return c.json({ error: 'Document is quarantined or still processing' }, 409)
  const file = await readKnowledgeDocument(user.farmId, row.document.cleanStorageKey)
  const sourceName = row.document.originalFilename.replace(/[\r\n"\\]/g, '_')
  const asciiName = sourceName.replace(/[^a-zA-Z0-9._ -]/g, '_') || 'source-document'
  const encodedName = encodeURIComponent(sourceName).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'operation_guideline_document_download', entityType: 'operation_guideline_document', entityId: row.document.id, metadata: { guidelineId: row.guideline?.id ?? null } })
  return c.body(new Uint8Array(file), 200, { 'Content-Type': row.document.mimeType, 'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
})

operationGuidelineRoutes.post('/', zValidator('json', guidelineSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const ownerId = body.ownerId ?? user.id
  if (!await isAssignableGuidelineOwner(user.farmId, ownerId)) return c.json({ error: 'Choose an active owner from this farm' }, 400)
  const [guideline] = await db.insert(operationGuidelines).values({ farmId: user.farmId, title: body.title, category: body.category, body: body.body, audience: body.audience, ownerId, reviewDueAt: body.reviewDueAt ? new Date(body.reviewDueAt) : null, createdById: user.id }).returning()
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'operation_guideline_create', entityType: 'operation_guideline', entityId: guideline.id })
  return c.json({ guideline }, 201)
})

operationGuidelineRoutes.patch('/:id', zValidator('json', guidelineSchema.partial()), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.write')) return c.json({ error: 'Forbidden' }, 403)
  const id = c.req.param('id')
  const [existing] = await db.select().from(operationGuidelines).where(and(eq(operationGuidelines.id, id), eq(operationGuidelines.farmId, user.farmId))).limit(1)
  if (!existing) return c.json({ error: 'Guideline not found' }, 404)
  if (existing.createdById !== user.id && !hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  if (body.ownerId && !await isAssignableGuidelineOwner(user.farmId, body.ownerId)) return c.json({ error: 'Choose an active owner from this farm' }, 400)
  const [guideline] = await db.update(operationGuidelines).set({ ...body, reviewDueAt: body.reviewDueAt === undefined ? existing.reviewDueAt : body.reviewDueAt ? new Date(body.reviewDueAt) : null, status: 'draft', approvedAt: null, approvedById: null, version: existing.version + 1, updatedAt: new Date() }).where(eq(operationGuidelines.id, id)).returning()
  return c.json({ guideline })
})

operationGuidelineRoutes.post('/:id/approve', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const [existing] = await db.select().from(operationGuidelines).where(and(eq(operationGuidelines.id, c.req.param('id')), eq(operationGuidelines.farmId, user.farmId))).limit(1)
  if (!existing) return c.json({ error: 'Guideline not found' }, 404)
  if (existing.status !== 'draft') return c.json({ error: 'Only a draft can be approved' }, 409)
  const documentId = await findGuidelineDocumentId(existing.id)
  if (documentId && existing.createdById === user.id && user.role !== 'owner') return c.json({ error: 'A different manager must approve an imported document' }, 409)
  const approvedAt = new Date()
  const contentSha256 = createHash('sha256').update([existing.title, existing.category, existing.audience, existing.ownerId ?? '', existing.body].join('\n')).digest('hex')
  let approved: {
    guideline: typeof existing
    version: typeof operationGuidelineVersions.$inferSelect
    job: typeof knowledgeJobs.$inferSelect
  } | null = null
  try {
    approved = await db.transaction(async (tx) => {
      const [guideline] = await tx.update(operationGuidelines).set({ status: 'indexing', approvedById: user.id, approvedAt, updatedAt: approvedAt }).where(and(eq(operationGuidelines.id, existing.id), eq(operationGuidelines.status, 'draft'), eq(operationGuidelines.version, existing.version))).returning()
      if (!guideline) throw new Error('APPROVAL_CONFLICT')
      const [version] = await tx.insert(operationGuidelineVersions).values({
        farmId: user.farmId,
        guidelineId: existing.id,
        version: existing.version,
        title: existing.title,
        category: existing.category,
        body: existing.body,
        audience: existing.audience,
        ownerId: existing.ownerId,
        contentSha256,
        sourceDocumentId: documentId,
        approvedById: user.id,
        approvedAt,
      }).onConflictDoNothing().returning()
      if (!version) throw new Error('APPROVAL_CONFLICT')
      const [job] = await tx.insert(knowledgeJobs).values({
        farmId: user.farmId,
        type: 'guideline_index',
        payload: { guidelineId: guideline.id, versionId: version.id, documentId },
        createdById: user.id,
      }).returning()
      return { guideline, version, job }
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'APPROVAL_CONFLICT') {
      return c.json({ error: 'Guideline changed or this version already has an approval record. Edit the draft before approving it again.' }, 409)
    }
    throw error
  }
  if (!approved) return c.json({ error: 'Approval could not be queued' }, 409)
  const { guideline, version, job } = approved
  await logAudit({ farmId: user.farmId, userId: user.id, action: 'operation_guideline_approve_queued', entityType: 'operation_guideline', entityId: guideline.id, metadata: { version: guideline.version, immutableVersionId: version.id, indexJobId: job.id } })
  return c.json({ guideline, versionId: version.id, jobId: job.id }, 202)
})

operationGuidelineRoutes.get('/:id/versions', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.read') && !hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const [guideline] = await db.select().from(operationGuidelines).where(and(eq(operationGuidelines.id, c.req.param('id')), eq(operationGuidelines.farmId, user.farmId))).limit(1)
  if (!guideline) return c.json({ error: 'Guideline not found' }, 404)
  const versions = await db.select().from(operationGuidelineVersions).where(eq(operationGuidelineVersions.guidelineId, guideline.id)).orderBy(desc(operationGuidelineVersions.version))
  return c.json({ versions })
})

operationGuidelineRoutes.get('/evaluations/cases', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const cases = await db.select().from(knowledgeEvaluationCases).where(eq(knowledgeEvaluationCases.farmId, user.farmId)).orderBy(desc(knowledgeEvaluationCases.createdAt))
  return c.json({ cases })
})

operationGuidelineRoutes.post('/evaluations/cases', zValidator('json', evaluationCaseSchema), async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const body = c.req.valid('json')
  const [guideline] = await db.select({ id: operationGuidelines.id }).from(operationGuidelines).where(and(eq(operationGuidelines.id, body.expectedGuidelineId), eq(operationGuidelines.farmId, user.farmId))).limit(1)
  if (!guideline) return c.json({ error: 'Expected guideline not found' }, 404)
  const [evaluationCase] = await db.insert(knowledgeEvaluationCases).values({ farmId: user.farmId, ...body, expectedText: body.expectedText || null, createdById: user.id }).returning()
  return c.json({ case: evaluationCase }, 201)
})

operationGuidelineRoutes.get('/evaluations/runs', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const runs = await db.select().from(knowledgeEvaluationRuns).where(eq(knowledgeEvaluationRuns.farmId, user.farmId)).orderBy(desc(knowledgeEvaluationRuns.createdAt)).limit(25)
  return c.json({ runs })
})

operationGuidelineRoutes.post('/evaluations/runs', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const [{ count }] = await db.select({ count: sql<number>`count(*)::integer` }).from(knowledgeEvaluationCases).where(and(eq(knowledgeEvaluationCases.farmId, user.farmId), eq(knowledgeEvaluationCases.active, true)))
  if (!count) return c.json({ error: 'Add at least one active evaluation case first' }, 409)
  const { run, job } = await db.transaction(async (tx) => {
    const [run] = await tx.insert(knowledgeEvaluationRuns).values({ farmId: user.farmId, embeddingModel: embeddingModel(), totalCases: count, createdById: user.id }).returning()
    const [job] = await tx.insert(knowledgeJobs).values({
      farmId: user.farmId,
      type: 'retrieval_evaluation',
      payload: { runId: run.id },
      createdById: user.id,
    }).returning()
    return { run, job }
  })
  return c.json({ run, jobId: job.id }, 202)
})

operationGuidelineRoutes.post('/:id/archive', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'knowledge.approve')) return c.json({ error: 'Forbidden' }, 403)
  const [guideline] = await db.update(operationGuidelines).set({ status: 'archived', updatedAt: new Date() }).where(and(eq(operationGuidelines.id, c.req.param('id')), eq(operationGuidelines.farmId, user.farmId))).returning()
  if (!guideline) return c.json({ error: 'Guideline not found' }, 404)
  await removeGuidelineFromIndex(guideline.id)
  return c.json({ guideline })
})
