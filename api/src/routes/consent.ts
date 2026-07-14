import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { consentRecords } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { logAudit } from '../lib/audit.js'

const consentSchema = z.object({
  consentType: z.enum(['privacy', 'data_processing']),
  version: z.string().min(1).max(20),
})

export const consentRoutes = new Hono<{ Variables: AppVariables }>()

consentRoutes.use('*', authMiddleware)

consentRoutes.post('/', zValidator('json', consentSchema), async (c) => {
  const user = c.get('user')
  const body = c.req.valid('json')

  const [record] = await db
    .insert(consentRecords)
    .values({
      userId: user.id,
      farmId: user.farmId,
      consentType: body.consentType,
      version: body.version,
      acceptedAt: new Date(),
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'consent_accepted',
    entityType: 'consent',
    entityId: record.id,
    metadata: {
      consentType: record.consentType,
      version: record.version,
    },
  })

  return c.json({ consent: record }, 201)
})

consentRoutes.get('/status', async (c) => {
  const user = c.get('user')
  const rows = await db
    .select({
      consentType: consentRecords.consentType,
      version: consentRecords.version,
      acceptedAt: consentRecords.acceptedAt,
      userId: consentRecords.userId,
    })
    .from(consentRecords)
    .where(eq(consentRecords.farmId, user.farmId))
    .orderBy(desc(consentRecords.acceptedAt))

  const latestByType = new Map<string, { version: string; acceptedByCurrentUser: boolean }>()
  for (const row of rows) {
    if (latestByType.has(row.consentType)) continue
    latestByType.set(row.consentType, {
      version: row.version,
      acceptedByCurrentUser: row.userId === user.id,
    })
  }

  const requiredTypes = ['privacy', 'data_processing']
  const acceptedLatest = requiredTypes.every((type) => latestByType.get(type)?.acceptedByCurrentUser ?? false)

  return c.json({
    acceptedLatest,
    latest: requiredTypes.map((type) => ({
      consentType: type,
      version: latestByType.get(type)?.version ?? null,
      acceptedByCurrentUser: latestByType.get(type)?.acceptedByCurrentUser ?? false,
    })),
  })
})
