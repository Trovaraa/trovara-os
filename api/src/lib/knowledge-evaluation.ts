import { and, asc, cosineDistance, desc, eq, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  knowledgeEvaluationCases,
  knowledgeEvaluationResults,
  knowledgeEvaluationRuns,
  operationGuidelineChunks,
  operationGuidelineVersions,
  operationGuidelines,
} from '../db/schema.js'
import { embedTexts, embeddingModel } from './embeddings.js'

function audienceAllowed(userAudience: string, documentAudience: string) {
  return documentAudience === 'all' || documentAudience === userAudience
}

export async function runKnowledgeEvaluation(runId: string, farmId: string) {
  const cases = await db.select().from(knowledgeEvaluationCases).where(
    and(eq(knowledgeEvaluationCases.farmId, farmId), eq(knowledgeEvaluationCases.active, true)),
  )
  await db.transaction(async (tx) => {
    // A worker may retry a run after a crash without mixing old and new
    // results or violating the unique run/case constraint.
    await tx.delete(knowledgeEvaluationResults).where(eq(knowledgeEvaluationResults.runId, runId))
    await tx.update(knowledgeEvaluationRuns).set({
      status: 'running',
      embeddingModel: embeddingModel(),
      totalCases: cases.length,
      passedCases: 0,
      permissionLeaks: 0,
      meanReciprocalRank: null,
      averageLatencyMs: null,
      startedAt: new Date(),
      completedAt: null,
    }).where(eq(knowledgeEvaluationRuns.id, runId))
  })

  let passed = 0
  let permissionLeaks = 0
  let reciprocalRank = 0
  let totalLatency = 0

  for (const item of cases) {
    const started = Date.now()
    const [queryVector] = await embedTexts([item.question.slice(0, 8_000)])
    const similarity = sql<number>`1 - (${cosineDistance(operationGuidelineChunks.embedding, queryVector!)})`
    const candidates = await db.select({
      guidelineId: operationGuidelineVersions.guidelineId,
      audience: operationGuidelineVersions.audience,
      content: operationGuidelineChunks.content,
      similarity,
      chunkIndex: operationGuidelineChunks.chunkIndex,
    }).from(operationGuidelineChunks)
      .innerJoin(operationGuidelines, eq(operationGuidelines.activeIndexGenerationId, operationGuidelineChunks.generationId))
      .innerJoin(operationGuidelineVersions, eq(operationGuidelineVersions.id, operationGuidelines.activeVersionId))
      .where(and(
        eq(operationGuidelineChunks.farmId, farmId),
        ne(operationGuidelines.status, 'archived'),
      ))
      .orderBy(desc(similarity), asc(operationGuidelineChunks.chunkIndex))
      .limit(30)

    const visible = candidates.filter((candidate) => audienceAllowed(item.audience, candidate.audience)).slice(0, 6)
    const leaked = visible.some((candidate) => !audienceAllowed(item.audience, candidate.audience))
    const orderedGuidelines = [...new Set(visible.map((candidate) => candidate.guidelineId))]
    const rankIndex = orderedGuidelines.indexOf(item.expectedGuidelineId)
    const expectedRank = rankIndex < 0 ? null : rankIndex + 1
    const expectedTextFound = !item.expectedText || visible.some((candidate) =>
      candidate.guidelineId === item.expectedGuidelineId && candidate.content.toLowerCase().includes(item.expectedText!.toLowerCase()),
    )
    const casePassed = expectedRank !== null && expectedRank <= 3 && expectedTextFound && !leaked
    const latencyMs = Date.now() - started
    if (casePassed) passed += 1
    if (leaked) permissionLeaks += 1
    if (expectedRank) reciprocalRank += 1 / expectedRank
    totalLatency += latencyMs
    await db.insert(knowledgeEvaluationResults).values({
      runId,
      caseId: item.id,
      retrievedGuidelineIds: orderedGuidelines,
      expectedRank,
      passed: casePassed,
      permissionLeak: leaked,
      latencyMs,
      details: { expectedTextFound, language: item.language, audience: item.audience },
    })
  }

  await db.update(knowledgeEvaluationRuns).set({
    status: 'succeeded',
    totalCases: cases.length,
    passedCases: passed,
    permissionLeaks,
    meanReciprocalRank: cases.length ? String(reciprocalRank / cases.length) : '0',
    averageLatencyMs: cases.length ? Math.round(totalLatency / cases.length) : 0,
    completedAt: new Date(),
  }).where(eq(knowledgeEvaluationRuns.id, runId))
}
