import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { careerPosts, talentApplications, talentCandidates, talentDocuments, talentEvents, talentSuppressedSources } from '../db/schema.js'
import { getKnowledgeObject, deleteKnowledgeObject } from './knowledge-storage.js'
import { logAudit } from './audit.js'
import { digest, discardPreparedDocuments, extractTalentCv, parseTalentEmail, prepareTalentDocument, type PreparedTalentDocument } from './talent-documents.js'

export async function findTalentApplication(farmId: string, id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)) return undefined
  const [row] = await db.select().from(talentApplications).where(and(
    eq(talentApplications.farmId, farmId), eq(talentApplications.id, id), isNull(talentApplications.deletedAt),
  )).limit(1)
  return row
}

export async function ingestTalentApplication(input: {
  farmId: string; actorId?: string; name: string; email?: string | null; phone?: string | null;
  careerPostId?: string | null; roleLabel?: string; source: 'cv_upload' | 'email_import' | 'zoho' | 'website';
  sourceKey: string; receivedAt?: Date; privacyNoticeVersion?: string; documents: PreparedTalentDocument[];
  message?: { key: string; body: string; references: string[]; applicationReference?: string };
}) {
  const unused = new Set(input.documents.map((document) => document.storageKey))
  let committed = false
  try {
    const result = await db.transaction(async (tx) => {
      // Serialise intake for a farm to make retries, email identities and attachment de-duplication atomic.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`talent:${input.farmId}`}))`)
      const [suppressed] = await tx.select().from(talentSuppressedSources).where(and(
        eq(talentSuppressedSources.farmId, input.farmId), eq(talentSuppressedSources.fingerprint, digest(input.sourceKey)),
      )).limit(1)
      if (suppressed) throw new Error('This source was previously deleted and will not be re-imported')
      let [application] = await tx.select().from(talentApplications).where(and(
        eq(talentApplications.farmId, input.farmId), eq(talentApplications.sourceKey, input.sourceKey),
      )).limit(1)
      if (input.message) {
        const [existing] = await tx.select().from(talentEvents).where(and(
          eq(talentEvents.farmId, input.farmId), eq(talentEvents.messageKey, input.message.key),
        )).limit(1)
        if (existing) {
          const [matched] = await tx.select().from(talentApplications).where(and(
            eq(talentApplications.farmId, input.farmId), eq(talentApplications.id, existing.applicationId),
          )).limit(1)
          if (matched) return { application: matched, duplicate: true }
        }
        // Only attach a reply when its references AND sender match a candidate in this farm.
        for (const key of input.message.references.slice(-20).reverse()) {
          const [parent] = await tx.select({ application: talentApplications }).from(talentEvents)
            .innerJoin(talentApplications, eq(talentApplications.id, talentEvents.applicationId))
            .innerJoin(talentCandidates, eq(talentCandidates.id, talentApplications.candidateId))
            .where(and(eq(talentEvents.farmId, input.farmId), eq(talentEvents.messageKey, key),
              eq(talentCandidates.email, input.email ?? ''), isNull(talentApplications.deletedAt))).limit(1)
          if (parent) { application = parent.application; break }
        }
        if (!application && input.message.applicationReference && input.email) {
          const [parent] = await tx.select({ application: talentApplications }).from(talentApplications)
            .innerJoin(talentCandidates, eq(talentCandidates.id, talentApplications.candidateId))
            .where(and(eq(talentApplications.farmId, input.farmId), eq(talentApplications.id, input.message.applicationReference),
              eq(talentCandidates.email, input.email), isNull(talentApplications.deletedAt))).limit(1)
          if (parent) application = parent.application
        }
      }
      const duplicate = Boolean(application)
      if (application?.deletedAt) throw new Error('This application is being deleted')
      if (!application) {
        let job: typeof careerPosts.$inferSelect | undefined
        if (input.careerPostId) {
          ;[job] = await tx.select().from(careerPosts).where(and(eq(careerPosts.farmId, input.farmId), eq(careerPosts.id, input.careerPostId))).limit(1)
          if (!job) throw new Error('Role not found in this farm')
        }
        if (input.source === 'website' && (!job?.published || !job.publishedAt ||
          (job.applicationDeadline && Date.now() > new Date(`${job.applicationDeadline}T23:59:59.999+01:00`).getTime()))) {
          throw new Error('This role is no longer accepting applications')
        }
        const email = input.email?.trim().toLowerCase() || null
        let candidate: typeof talentCandidates.$inferSelect | undefined
        if (email) {
          ;[candidate] = await tx.select().from(talentCandidates).where(and(eq(talentCandidates.farmId, input.farmId), eq(talentCandidates.email, email))).limit(1)
        }
        if (!candidate) {
          ;[candidate] = await tx.insert(talentCandidates).values({
            farmId: input.farmId, name: input.name.slice(0, 200), email, phone: input.phone?.slice(0, 80),
          }).returning()
        }
        ;[application] = await tx.insert(talentApplications).values({
          farmId: input.farmId, candidateId: candidate!.id, careerPostId: job?.id,
          roleLabel: job?.title ?? input.roleLabel?.slice(0, 300) ?? 'Unassigned / general interest',
          source: input.source, sourceKey: input.sourceKey, receivedAt: input.receivedAt,
          privacyNoticeVersion: input.privacyNoticeVersion,
        }).returning()
        await tx.insert(talentEvents).values({ farmId: input.farmId, applicationId: application!.id,
          actorId: input.actorId, kind: 'received', body: `Application received via ${input.source}. Human review required.\nSubmitted name: ${input.name}\nSubmitted email: ${input.email || 'Not provided'}\nSubmitted phone: ${input.phone || 'Not provided'}` })
      }
      if (!application) throw new Error('Application could not be created')
      let newDocuments = false
      for (const document of input.documents) {
        const [saved] = await tx.insert(talentDocuments).values({ ...document, farmId: input.farmId, applicationId: application.id })
          .onConflictDoNothing().returning({ id: talentDocuments.id })
        if (saved) { unused.delete(document.storageKey); newDocuments = true }
      }
      if (newDocuments || input.message) await tx.update(talentApplications).set({ needsReview: true, updatedAt: new Date() })
        .where(and(eq(talentApplications.farmId, input.farmId), eq(talentApplications.id, application.id)))
      if (input.message) await tx.insert(talentEvents).values({
        farmId: input.farmId, applicationId: application.id, actorId: input.actorId,
        kind: 'email', messageKey: input.message.key, body: input.message.body,
        occurredAt: input.receivedAt ?? new Date(),
      }).onConflictDoNothing()
      return { application, duplicate }
    })
    committed = true
    return result
  } finally {
    const cleanup = input.documents.filter((document) => !committed || unused.has(document.storageKey))
    // Never turn a successful intake into a failed request because cleanup of a redundant object failed.
    await discardPreparedDocuments(cleanup).catch(() => console.error('[talent] Redundant upload cleanup failed; check private storage'))
  }
}

export async function importTalentEmail(input: {
  farmId: string; actorId?: string; filename: string; buffer: Buffer; careerPostId?: string | null;
  source?: 'email_import' | 'zoho'; receivedAt?: Date;
}) {
  const email = await parseTalentEmail(input.buffer)
  const documents: PreparedTalentDocument[] = []
  const skipped: string[] = []
  try {
    documents.push(await prepareTalentDocument(input.farmId, input.filename, input.buffer, 'email'))
    for (const attachment of email.attachments) {
      const filename = attachment.filename ?? 'attachment'
      if (!/\.(pdf|docx)$/i.test(filename)) { skipped.push('A non-PDF/DOCX attachment is retained only in the original email.'); continue }
      documents.push(await prepareTalentDocument(input.farmId, filename, attachment.content, 'supporting'))
    }
  } catch (error) {
    await discardPreparedDocuments(documents)
    throw error
  }
  const result = await ingestTalentApplication({
    ...input, name: email.name, email: email.email, roleLabel: email.subject,
    source: input.source ?? 'email_import', sourceKey: `email:${email.messageKey}`,
    receivedAt: input.receivedAt ?? email.receivedAt, documents,
    message: { key: email.messageKey, references: email.references, applicationReference: email.applicationReference,
      body: `From: ${email.email}\nSubject: ${email.subject}\n\n${email.body}${skipped.length ? `\n\nImport warning: ${skipped.join(' ')}` : ''}` },
  })
  return { ...result, warnings: skipped }
}

/** One claim at a time; a stopped worker's lease becomes retryable after 15 minutes. */
export async function processNextTalentDocument(farmId?: string): Promise<boolean> {
  await db.update(talentDocuments).set({ extractionStatus: 'needs_review', processingAt: null,
    warnings: ['Extraction exceeded its processing window. Review manually or retry with a simpler document.'],
  }).where(and(farmId ? eq(talentDocuments.farmId, farmId) : undefined, eq(talentDocuments.extractionStatus, 'processing'), lt(talentDocuments.processingAt, new Date(Date.now() - 15 * 60_000))))
  const document = await db.transaction(async (tx) => {
    const [row] = await tx.select({ document: talentDocuments }).from(talentDocuments)
      .innerJoin(talentApplications, eq(talentDocuments.applicationId, talentApplications.id))
      .where(and(farmId ? eq(talentDocuments.farmId, farmId) : undefined, isNull(talentApplications.deletedAt), eq(talentDocuments.extractionStatus, 'pending')))
      .orderBy(asc(talentDocuments.createdAt)).limit(1).for('update', { skipLocked: true })
    if (!row) return null
    await tx.update(talentDocuments).set({ extractionStatus: 'processing', processingAt: new Date() }).where(eq(talentDocuments.id, row.document.id))
    return row.document
  })
  if (!document) return false
  try {
    const buffer = await getKnowledgeObject(document.storageKey)
    const result = await extractTalentCv(buffer, document.filename)
    await db.update(talentDocuments).set({ extractionStatus: 'ready', processingAt: null,
      extractedText: result.text, extractedFields: result.fields, warnings: result.warnings,
    }).where(eq(talentDocuments.id, document.id))
  } catch {
    await db.update(talentDocuments).set({ extractionStatus: 'needs_review', processingAt: null,
      warnings: ['Text extraction could not complete. Check the original CV, enter details manually, or retry after OCR is configured.'],
    }).where(eq(talentDocuments.id, document.id))
  }
  return true
}

export async function deleteTalentApplication(farmId: string, id: string, actorId?: string) {
  // Hide first. Keep object references until every private object is deleted, so failures can be retried.
  const application = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`talent:${farmId}`}))`)
    const [row] = await tx.update(talentApplications).set({ deletedAt: new Date() })
      .where(and(eq(talentApplications.farmId, farmId), eq(talentApplications.id, id))).returning()
    if (!row) return undefined
    const events = await tx.select({ key: talentEvents.messageKey }).from(talentEvents).where(and(eq(talentEvents.farmId, farmId), eq(talentEvents.applicationId, id), eq(talentEvents.kind, 'email')))
    const keys = [row.sourceKey, ...events.flatMap((event) => event.key ? [`email:${event.key}`] : [])]
    await tx.insert(talentSuppressedSources).values(keys.map((key) => ({ farmId, fingerprint: digest(key) }))).onConflictDoNothing()
    return row
  })
  if (!application) return false
  const documents = await db.select().from(talentDocuments).where(and(eq(talentDocuments.farmId, farmId), eq(talentDocuments.applicationId, id)))
  for (const document of documents) await deleteKnowledgeObject(document.storageKey)
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`talent:${farmId}`}))`)
    await tx.delete(talentApplications).where(and(eq(talentApplications.farmId, farmId), eq(talentApplications.id, id)))
    const [other] = await tx.select({ id: talentApplications.id }).from(talentApplications)
      .where(and(eq(talentApplications.farmId, farmId), eq(talentApplications.candidateId, application.candidateId))).limit(1)
    if (!other) await tx.delete(talentCandidates).where(and(eq(talentCandidates.farmId, farmId), eq(talentCandidates.id, application.candidateId)))
  })
  await logAudit({ farmId, userId: actorId, action: 'delete', entityType: 'talent_application', entityId: id })
  return true
}

export async function purgeExpiredTalent(farmId?: string) {
  const rows = await db.select({ id: talentApplications.id, farmId: talentApplications.farmId }).from(talentApplications)
    .where(and(farmId ? eq(talentApplications.farmId, farmId) : undefined,
      or(lt(talentApplications.retentionUntil, new Date()), sql`${talentApplications.deletedAt} is not null`))).limit(100)
  for (const row of rows) await deleteTalentApplication(row.farmId, row.id)
  return rows.length
}

export function cvImportKey(buffer: Buffer, careerPostId?: string | null) {
  return `cv:${digest(buffer)}:${careerPostId ?? 'unassigned'}`
}
