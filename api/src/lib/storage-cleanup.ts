import path from 'node:path'
import { unlink } from 'node:fs/promises'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { storageCleanupJobs } from '../db/schema.js'
import { getEvidenceStorageRoot } from './evidence-store.js'

function cleanupRoot(name: string): string | null {
  if (name === 'evidence') return path.resolve(getEvidenceStorageRoot())
  return null
}

export async function processStorageCleanupJobs(limit = 100): Promise<{
  completed: number
  failed: number
}> {
  const jobs = await db
    .select()
    .from(storageCleanupJobs)
    .where(inArray(storageCleanupJobs.status, ['pending', 'failed']))
    .orderBy(asc(storageCleanupJobs.createdAt))
    .limit(Math.max(1, Math.min(limit, 500)))

  let completed = 0
  let failed = 0
  for (const job of jobs) {
    const root = cleanupRoot(job.storageRoot)
    const filePath = root ? path.resolve(root, job.storageKey) : null
    if (!root || !filePath?.startsWith(root + path.sep)) {
      failed += 1
      await db
        .update(storageCleanupJobs)
        .set({
          status: 'failed',
          attemptCount: job.attemptCount + 1,
          lastError: 'Unknown or invalid cleanup path',
        })
        .where(eq(storageCleanupJobs.id, job.id))
      continue
    }

    try {
      await unlink(filePath)
      completed += 1
      await db
        .update(storageCleanupJobs)
        .set({ status: 'completed', completedAt: new Date(), lastError: null })
        .where(eq(storageCleanupJobs.id, job.id))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        completed += 1
        await db
          .update(storageCleanupJobs)
          .set({ status: 'completed', completedAt: new Date(), lastError: null })
          .where(eq(storageCleanupJobs.id, job.id))
      } else {
        failed += 1
        await db
          .update(storageCleanupJobs)
          .set({
            status: 'failed',
            attemptCount: job.attemptCount + 1,
            lastError: error instanceof Error ? error.message.slice(0, 500) : 'Cleanup failed',
          })
          .where(
            and(
              eq(storageCleanupJobs.id, job.id),
              inArray(storageCleanupJobs.status, ['pending', 'failed']),
            ),
          )
      }
    }
  }

  return { completed, failed }
}
