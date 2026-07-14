import { and, eq, isNotNull, lt, or } from 'drizzle-orm'
import { db } from '../db/index.js'
import { tasks } from '../db/schema.js'

function retentionDays(): number {
  const raw = Number(process.env.DATA_RETENTION_DAYS ?? '365')
  if (!Number.isFinite(raw) || raw < 1) return 365
  return Math.floor(raw)
}

export async function runDataRetention(farmId?: string): Promise<{
  farmId?: string
  retentionDays: number
  purgedTaskEvidence: number
}> {
  const days = retentionDays()
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  const whereClause = farmId
    ? and(
        eq(tasks.farmId, farmId),
        lt(tasks.updatedAt, cutoff),
        or(isNotNull(tasks.photoUrl), isNotNull(tasks.voiceUrl)),
      )
    : and(
        lt(tasks.updatedAt, cutoff),
        or(isNotNull(tasks.photoUrl), isNotNull(tasks.voiceUrl)),
      )

  const purgedRows = await db
    .update(tasks)
    .set({
      photoUrl: null,
      voiceUrl: null,
      updatedAt: new Date(),
    })
    .where(whereClause)
    .returning({ id: tasks.id })

  return {
    farmId,
    retentionDays: days,
    purgedTaskEvidence: purgedRows.length,
  }
}
