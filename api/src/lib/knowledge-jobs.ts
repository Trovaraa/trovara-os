import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { knowledgeJobs } from '../db/schema.js'

export type KnowledgeJobType = 'document_process' | 'guideline_index' | 'retrieval_evaluation'
export type ClaimedKnowledgeJob = {
  id: string
  farmId: string
  type: KnowledgeJobType
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
  createdById: string | null
}

export async function enqueueKnowledgeJob(params: {
  farmId: string
  type: KnowledgeJobType
  payload: Record<string, unknown>
  createdById?: string | null
}) {
  const [job] = await db.insert(knowledgeJobs).values({
    farmId: params.farmId,
    type: params.type,
    payload: params.payload,
    createdById: params.createdById ?? null,
  }).returning()
  return job
}

export async function claimKnowledgeJob(workerId: string): Promise<ClaimedKnowledgeJob | null> {
  const staleMinutes = Math.max(5, Number(process.env.KNOWLEDGE_JOB_STALE_MINUTES || 30))
  await db.execute(sql`
    UPDATE knowledge_jobs
    SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
        run_after = now(), locked_at = NULL, locked_by = NULL, updated_at = now(),
        last_error = CASE
          WHEN attempts >= max_attempts THEN COALESCE(last_error, 'Worker stopped before the job completed')
          ELSE last_error
        END
    WHERE status = 'running'
      AND locked_at < now() - (${staleMinutes} * interval '1 minute')
  `)
  const rows = await db.execute<{
    id: string
    farm_id: string
    type: KnowledgeJobType
    payload: Record<string, unknown>
    attempts: number
    max_attempts: number
    created_by_id: string | null
  }>(sql`
    WITH candidate AS (
      SELECT id FROM knowledge_jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE knowledge_jobs job
    SET status = 'running', attempts = job.attempts + 1, locked_at = now(),
        locked_by = ${workerId}, updated_at = now(), last_error = NULL
    FROM candidate
    WHERE job.id = candidate.id
    RETURNING job.id, job.farm_id, job.type, job.payload, job.attempts,
              job.max_attempts, job.created_by_id
  `)
  const row = rows[0]
  return row ? {
    id: row.id,
    farmId: row.farm_id,
    type: row.type,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    createdById: row.created_by_id,
  } : null
}

export async function updateKnowledgeJobProgress(jobId: string, progress: number) {
  await db.execute(sql`
    UPDATE knowledge_jobs SET progress = ${Math.max(0, Math.min(100, Math.round(progress)))}, updated_at = now()
    WHERE id = ${jobId}::uuid AND status = 'running'
  `)
}

export async function completeKnowledgeJob(jobId: string) {
  await db.execute(sql`
    UPDATE knowledge_jobs SET status = 'succeeded', progress = 100, completed_at = now(),
      locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE id = ${jobId}::uuid
  `)
}

export async function failKnowledgeJob(job: ClaimedKnowledgeJob, error: unknown) {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
  const exhausted = job.attempts >= job.maxAttempts
  const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, job.attempts - 1)))
  await db.execute(sql`
    UPDATE knowledge_jobs
    SET status = ${exhausted ? 'dead_letter' : 'queued'}, last_error = ${detail},
      run_after = now() + (${delaySeconds} * interval '1 second'), locked_at = NULL,
      locked_by = NULL, updated_at = now()
    WHERE id = ${job.id}::uuid
  `)
}
