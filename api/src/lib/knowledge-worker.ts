import { basename } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  knowledgeEvaluationRuns,
  operationGuidelineDocuments,
  operationGuidelineVersions,
  operationGuidelines,
} from '../db/schema.js'
import { extractKnowledgeDocument, readKnowledgeDocument } from './knowledge-documents.js'
import { runKnowledgeEvaluation } from './knowledge-evaluation.js'
import { indexGuidelineGeneration } from './knowledge-index.js'
import {
  claimKnowledgeJob,
  completeKnowledgeJob,
  failKnowledgeJob,
  updateKnowledgeJobProgress,
  type ClaimedKnowledgeJob,
} from './knowledge-jobs.js'
import { ocrPdf } from './knowledge-ocr.js'
import { deleteKnowledgeObject, promoteKnowledgeObject, putKnowledgeObject } from './knowledge-storage.js'
import { scanBufferForMalware } from './malware-scan.js'

function payloadId(job: ClaimedKnowledgeJob, key: string) {
  const value = job.payload[key]
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`Knowledge job is missing ${key}`)
  return value
}

async function processDocument(job: ClaimedKnowledgeJob) {
  const documentId = payloadId(job, 'documentId')
  const [document] = await db.select().from(operationGuidelineDocuments).where(
    and(eq(operationGuidelineDocuments.id, documentId), eq(operationGuidelineDocuments.farmId, job.farmId)),
  ).limit(1)
  if (!document) throw new Error('Knowledge document no longer exists')
  if (document.scanStatus === 'clean' && document.extractionStatus === 'needs_review') return

  await db.update(operationGuidelineDocuments).set({
    scanStatus: 'scanning', extractionStatus: 'scanning', updatedAt: new Date(),
  }).where(eq(operationGuidelineDocuments.id, document.id))
  await updateKnowledgeJobProgress(job.id, 15)
  const original = await readKnowledgeDocument(document.farmId, document.storageKey)
  const scan = await scanBufferForMalware(original)
  if (!scan.clean) {
    await db.update(operationGuidelineDocuments).set({
      scanStatus: 'infected', scanResult: scan.signature, scannedAt: new Date(),
      extractionStatus: 'quarantined', updatedAt: new Date(),
    }).where(eq(operationGuidelineDocuments.id, document.id))
    return
  }

  await db.update(operationGuidelineDocuments).set({
    scanStatus: 'clean', scanResult: scan.raw, scannedAt: new Date(),
    extractionStatus: 'extracting', updatedAt: new Date(),
  }).where(eq(operationGuidelineDocuments.id, document.id))
  await updateKnowledgeJobProgress(job.id, 45)

  const cleanKey = `clean/${document.farmId}/${basename(document.storageKey)}`
  let extractedText = ''
  let warnings: string[] = []
  let ocrStatus = 'not_needed'
  let ocrConfidence: string | null = null
  let promoted = false
  try {
    const extracted = await extractKnowledgeDocument(original, document.originalFilename)
    extractedText = extracted.text
    warnings = extracted.warnings
  } catch (error) {
    if (document.mimeType !== 'application/pdf') throw error
    ocrStatus = 'processing'
    await db.update(operationGuidelineDocuments).set({ ocrStatus, updatedAt: new Date() }).where(eq(operationGuidelineDocuments.id, document.id))
    const ocr = await ocrPdf(original)
    if (ocr.text.trim().length < 20) throw new Error('OCR did not find enough readable text')
    extractedText = ocr.text.slice(0, 250_000)
    ocrConfidence = String(ocr.confidence)
    ocrStatus = 'completed'
    warnings = [`OCR quality estimate: ${ocr.confidence}%. Review the extracted text against the source before approval.`]
    await putKnowledgeObject(cleanKey, ocr.pdf, 'application/pdf')
    await deleteKnowledgeObject(document.storageKey)
    promoted = true
  }
  if (!promoted) await promoteKnowledgeObject(document.storageKey, cleanKey, document.mimeType)
  await updateKnowledgeJobProgress(job.id, 85)
  await db.update(operationGuidelineDocuments).set({
    cleanStorageKey: cleanKey,
    extractedText,
    extractionWarnings: warnings,
    extractionStatus: 'needs_review',
    ocrStatus,
    ocrConfidence,
    updatedAt: new Date(),
  }).where(eq(operationGuidelineDocuments.id, document.id))
}

async function processGuidelineIndex(job: ClaimedKnowledgeJob) {
  const guidelineId = payloadId(job, 'guidelineId')
  const versionId = payloadId(job, 'versionId')
  const documentId = typeof job.payload.documentId === 'string' ? job.payload.documentId : null
  const [guideline] = await db.select().from(operationGuidelines).where(
    and(eq(operationGuidelines.id, guidelineId), eq(operationGuidelines.farmId, job.farmId)),
  ).limit(1)
  const [version] = await db.select().from(operationGuidelineVersions).where(
    and(eq(operationGuidelineVersions.id, versionId), eq(operationGuidelineVersions.farmId, job.farmId)),
  ).limit(1)
  if (!guideline || !version || version.guidelineId !== guideline.id) throw new Error('Approved guideline version is unavailable')
  // A pending activation becomes stale if somebody edits or archives the
  // guideline. Never let the late job replace or resurrect the live version.
  if (guideline.status !== 'indexing' || guideline.version !== version.version) return
  await indexGuidelineGeneration({ ...guideline, title: version.title, category: version.category, body: version.body, audience: version.audience, version: version.version }, documentId, version.id)
}

async function processEvaluation(job: ClaimedKnowledgeJob) {
  const runId = payloadId(job, 'runId')
  const [run] = await db.select().from(knowledgeEvaluationRuns).where(
    and(eq(knowledgeEvaluationRuns.id, runId), eq(knowledgeEvaluationRuns.farmId, job.farmId)),
  ).limit(1)
  if (!run) throw new Error('Retrieval evaluation run no longer exists')
  await runKnowledgeEvaluation(run.id, job.farmId)
}

export async function runKnowledgeWorkerOnce(workerId: string): Promise<boolean> {
  const job = await claimKnowledgeJob(workerId)
  if (!job) return false
  try {
    if (job.type === 'document_process') await processDocument(job)
    else if (job.type === 'guideline_index') await processGuidelineIndex(job)
    else await processEvaluation(job)
    await completeKnowledgeJob(job.id)
  } catch (error) {
    if (job.type === 'document_process') {
      const documentId = typeof job.payload.documentId === 'string' ? job.payload.documentId : null
      if (documentId) await db.update(operationGuidelineDocuments).set({
        scanStatus: job.attempts >= job.maxAttempts ? 'error' : 'queued',
        extractionStatus: job.attempts >= job.maxAttempts ? 'failed' : 'queued',
        scanResult: (error instanceof Error ? error.message : String(error)).slice(0, 1000), updatedAt: new Date(),
      }).where(eq(operationGuidelineDocuments.id, documentId))
    }
    if (job.type === 'guideline_index') {
      const guidelineId = typeof job.payload.guidelineId === 'string' ? job.payload.guidelineId : null
      if (guidelineId && job.attempts >= job.maxAttempts) await db.update(operationGuidelines).set({ status: 'draft', updatedAt: new Date() }).where(eq(operationGuidelines.id, guidelineId))
    }
    if (job.type === 'retrieval_evaluation') {
      const runId = typeof job.payload.runId === 'string' ? job.payload.runId : null
      if (runId && job.attempts >= job.maxAttempts) await db.update(knowledgeEvaluationRuns).set({ status: 'failed', completedAt: new Date() }).where(eq(knowledgeEvaluationRuns.id, runId))
    }
    await failKnowledgeJob(job, error)
  }
  return true
}
