import { and, eq, inArray, lt } from 'drizzle-orm'
import { db } from '../db/index.js'
import { momentSubmissions } from '../db/schema.js'
import { deleteMomentMedia } from './moments-media.js'

const DEFAULT_RETENTION_DAYS = 30

function retentionDays(): number {
  const configured = Number(process.env.MOMENTS_UNPUBLISHED_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)
  return Number.isFinite(configured) && configured >= 1
    ? Math.floor(configured)
    : DEFAULT_RETENTION_DAYS
}

export async function cleanupUnpublishedMoments(
  farmId?: string,
  now = new Date(),
): Promise<{ deletedRows: number; deletedFiles: number; retentionDays: number }> {
  const days = retentionDays()
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const statusAndAge = and(
    inArray(momentSubmissions.status, ['pending', 'rejected']),
    lt(momentSubmissions.createdAt, cutoff),
  )
  const rows = await db
    .delete(momentSubmissions)
    .where(
      farmId
        ? and(eq(momentSubmissions.farmId, farmId), statusAndAge)
        : statusAndAge,
    )
    .returning({
      farmId: momentSubmissions.farmId,
      storageKey: momentSubmissions.storageKey,
      posterStorageKey: momentSubmissions.posterStorageKey,
    })

  let deletedFiles = 0
  const results = await Promise.allSettled(
    rows.flatMap((row) => [
      deleteMomentMedia(row.farmId, row.storageKey),
      ...(row.posterStorageKey
        ? [deleteMomentMedia(row.farmId, row.posterStorageKey)]
        : []),
    ]),
  )
  for (const result of results) {
    if (result.status === 'fulfilled') deletedFiles += 1
    else console.error('Failed to delete retained Moment media:', result.reason)
  }
  return { deletedRows: rows.length, deletedFiles, retentionDays: days }
}
