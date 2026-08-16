import { and, asc, cosineDistance, desc, eq, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  operationGuidelineChunks,
  operationGuidelineDocuments,
  operationGuidelineIndexGenerations,
  operationGuidelineVersions,
  operationGuidelines,
} from '../db/schema.js'
import type { SessionUser } from './session.js'
import { hasPermission } from './rbac.js'
import { embedTexts, embeddingModel } from './embeddings.js'
import { splitGuidelineIntoChunks } from './knowledge-documents.js'

type GuidelineForIndex = typeof operationGuidelines.$inferSelect

function canUseAudience(user: SessionUser, audience: string): boolean {
  if (audience === 'all') return true
  if (audience === 'management') return hasPermission(user, 'tasks.approve')
  if (audience === 'finance') return hasPermission(user, 'finance.read')
  if (audience === 'sales') return hasPermission(user, 'orders.read')
  return (
    hasPermission(user, 'zones.manage') ||
    hasPermission(user, 'crops.manage') ||
    hasPermission(user, 'livestock.manage') ||
    hasPermission(user, 'livestock.log') ||
    hasPermission(user, 'inventory.read') ||
    hasPermission(user, 'inventory.count')
  )
}

export async function removeGuidelineFromIndex(guidelineId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(operationGuidelineIndexGenerations).set({ status: 'retired', retiredAt: new Date() }).where(
      and(eq(operationGuidelineIndexGenerations.guidelineId, guidelineId), eq(operationGuidelineIndexGenerations.status, 'active')),
    )
    await tx.update(operationGuidelines).set({ activeIndexGenerationId: null, activeVersionId: null }).where(eq(operationGuidelines.id, guidelineId))
  })
}

export async function indexGuidelineGeneration(
  guideline: GuidelineForIndex,
  documentId: string | null,
  versionId: string,
): Promise<number> {
  const chunks = splitGuidelineIntoChunks(guideline.body)
  if (!chunks.length) throw new Error('Guideline has no text to index')
  const model = embeddingModel()
  const [generation] = await db.insert(operationGuidelineIndexGenerations).values({
    farmId: guideline.farmId,
    guidelineId: guideline.id,
    versionId,
    embeddingModel: model,
  }).returning()
  const vectors: number[][] = []
  try {
    for (let offset = 0; offset < chunks.length; offset += 32) {
      vectors.push(...(await embedTexts(chunks.slice(offset, offset + 32).map((chunk) => chunk.content))))
    }
    if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== 1536)) {
      throw new Error('Embedding validation failed: chunk/vector dimensions do not match')
    }

    await db.transaction(async (tx) => {
      await tx.insert(operationGuidelineChunks).values(
        chunks.map((chunk, index) => ({
          farmId: guideline.farmId,
          guidelineId: guideline.id,
          documentId,
          versionId,
          generationId: generation.id,
          guidelineVersion: guideline.version,
          chunkIndex: chunk.chunkIndex,
          heading: chunk.heading,
          content: chunk.content,
          embedding: vectors[index]!,
          embeddingModel: model,
        })),
      )
      const [activatedGuideline] = await tx.update(operationGuidelines).set({
        status: 'approved',
        activeVersionId: versionId,
        activeIndexGenerationId: generation.id,
        updatedAt: new Date(),
      }).where(and(
        eq(operationGuidelines.id, guideline.id),
        eq(operationGuidelines.version, guideline.version),
        eq(operationGuidelines.status, 'indexing'),
      )).returning({ id: operationGuidelines.id })
      if (!activatedGuideline) throw new Error('Index activation became stale because the guideline changed')
      await tx.update(operationGuidelineIndexGenerations).set({
        status: 'retired',
        retiredAt: new Date(),
      }).where(and(
        eq(operationGuidelineIndexGenerations.guidelineId, guideline.id),
        eq(operationGuidelineIndexGenerations.status, 'active'),
      ))
      await tx.update(operationGuidelineIndexGenerations).set({
        status: 'active',
        chunkCount: chunks.length,
        validatedAt: new Date(),
        activatedAt: new Date(),
      }).where(eq(operationGuidelineIndexGenerations.id, generation.id))
    })
    return chunks.length
  } catch (error) {
    await db.update(operationGuidelineIndexGenerations).set({
      status: 'failed',
      validationError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    }).where(eq(operationGuidelineIndexGenerations.id, generation.id))
    throw error
  }
}

export type KnowledgeSearchResult = {
  guidelineId: string
  title: string
  category: string
  audience: string
  version: number
  chunkIndex: number
  heading: string | null
  sourcePage: number | null
  content: string
  similarity: number
}

export async function searchApprovedKnowledge(
  user: SessionUser,
  query: string,
  limit = 6,
): Promise<KnowledgeSearchResult[]> {
  if (!hasPermission(user, 'knowledge.read') || query.trim().length < 3) return []
  const [queryVector] = await embedTexts([query.slice(0, 8_000)])
  const similarity = sql<number>`1 - (${cosineDistance(operationGuidelineChunks.embedding, queryVector!)})`
  const rows = await db
    .select({
      guidelineId: operationGuidelines.id,
      title: operationGuidelineVersions.title,
      category: operationGuidelineVersions.category,
      audience: operationGuidelineVersions.audience,
      version: operationGuidelineVersions.version,
      chunkIndex: operationGuidelineChunks.chunkIndex,
      heading: operationGuidelineChunks.heading,
      sourcePage: operationGuidelineChunks.sourcePage,
      content: operationGuidelineChunks.content,
      similarity,
    })
    .from(operationGuidelineChunks)
    .innerJoin(operationGuidelines, eq(operationGuidelineChunks.guidelineId, operationGuidelines.id))
    .innerJoin(operationGuidelineVersions, eq(operationGuidelineVersions.id, operationGuidelines.activeVersionId))
    .where(
      and(
        eq(operationGuidelineChunks.farmId, user.farmId),
        eq(operationGuidelineChunks.generationId, operationGuidelines.activeIndexGenerationId),
        ne(operationGuidelines.status, 'archived'),
      ),
    )
    .orderBy(desc(similarity), asc(operationGuidelineChunks.chunkIndex))
    .limit(Math.min(Math.max(limit * 3, limit), 30))

  return rows
    .filter((row) => canUseAudience(user, row.audience) && Number(row.similarity) >= 0.35)
    .slice(0, Math.min(Math.max(limit, 1), 10))
    .map((row) => ({ ...row, similarity: Number(row.similarity) }))
}

export async function findGuidelineDocumentId(guidelineId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: operationGuidelineDocuments.id })
    .from(operationGuidelineDocuments)
    .where(eq(operationGuidelineDocuments.guidelineId, guidelineId))
    .limit(1)
  return row?.id ?? null
}
