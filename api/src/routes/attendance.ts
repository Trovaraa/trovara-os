import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import {
  clockIn,
  clockOut,
  listHoursSummary,
  listToday,
  supervisorCorrect,
  type HoursSummaryRange,
} from '../lib/attendance-service.js'
import { authorLocaleHint, toViewerLocaleMany } from '../lib/content-locale.js'
import { canApproveTasks } from '../lib/rbac.js'
import type { SessionUser } from '../lib/session.js'

const allocationSchema = z.object({
  plotId: z.string().uuid().nullable().optional(),
  taskId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

const clockOutSchema = z.object({
  workSummary: z.string().trim().max(2000).nullable().optional(),
})

const correctionSchema = allocationSchema
  .extend({
    clockInAt: z.string().datetime().optional(),
    clockOutAt: z.string().datetime().nullable().optional(),
    monthlyWageSnapshotNgn: z.number().int().min(0).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'At least one correction is required')

const summaryQuerySchema = z.object({
  range: z.enum(['day', 'week', 'month', 'ytd']).default('week'),
  userId: z.string().uuid().optional(),
})

export const attendanceRoutes = new Hono<{ Variables: AppVariables }>()

attendanceRoutes.use('*', authMiddleware)

/**
 * Render attendance notes in the viewer's language with ONE batched translation
 * call per response: every note in the list is collected first, translated
 * together (the service deduplicates them and reads its cache in a single
 * query), then mapped back by position.
 *
 * `notes` is the only prose here. Worker names are proper nouns, the block and
 * task names are lookup labels, and the wage snapshot is money, so none of them
 * reach a translator. A viewer on the default 'en' preference costs one profile
 * read and nothing else: `authorLocaleHint` turns that default into null.
 */
async function localizeNotes<T extends { notes: string | null }>(
  rows: T[],
  user: SessionUser,
): Promise<T[]> {
  const texts = rows.map((row) => row.notes).filter((note): note is string => Boolean(note))
  if (texts.length === 0) return rows

  const [profile] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1)
  const viewerLocale = authorLocaleHint(profile?.preferredLocale)
  if (!viewerLocale) return rows

  const translated = await toViewerLocaleMany({
    texts,
    targetLocale: viewerLocale,
    farmId: user.farmId,
  })

  let cursor = 0
  return rows.map((row) => (row.notes ? { ...row, notes: translated[cursor++]! } : row))
}

attendanceRoutes.get('/today', async (c) => {
  const user = c.get('user')
  const sessions = await listToday(user)
  return c.json({ sessions: await localizeNotes(sessions, user) })
})

attendanceRoutes.get('/summary', zValidator('query', summaryQuerySchema), async (c) => {
  const user = c.get('user')
  const query = c.req.valid('query')
  try {
    const summary = await listHoursSummary(
      user,
      query.range as HoursSummaryRange,
      query.userId,
    )
    return c.json(summary)
  } catch (error) {
    return attendanceError(c, error)
  }
})

attendanceRoutes.post('/clock-in', zValidator('json', allocationSchema), async (c) => {
  try {
    const result = await clockIn(c.get('user'), c.req.valid('json'))
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) {
    return attendanceError(c, error)
  }
})

attendanceRoutes.post('/clock-out', zValidator('json', clockOutSchema), async (c) => {
  try {
    return c.json(await clockOut(c.get('user'), c.req.valid('json')))
  } catch (error) {
    return attendanceError(c, error)
  }
})

attendanceRoutes.patch(
  '/:id',
  zValidator('json', correctionSchema),
  async (c) => {
    const user = c.get('user')
    if (!canApproveTasks(user)) return c.json({ error: 'Forbidden' }, 403)
    try {
      const session = await supervisorCorrect(
        user,
        c.req.param('id'),
        c.req.valid('json'),
      )
      return c.json({ session })
    } catch (error) {
      return attendanceError(c, error)
    }
  },
)

function attendanceError(c: Context, error: unknown) {
  const code = error instanceof Error ? error.message : 'ATTENDANCE_FAILED'
  if (code === 'FORBIDDEN') return c.json({ error: 'Forbidden' }, 403)
  if (code === 'NOT_FOUND') return c.json({ error: 'Attendance session not found' }, 404)
  const messages: Record<string, string> = {
    WAGE_NOT_SET: 'Monthly wage must be set before clock-in',
    NOT_CLOCKED_IN: 'No open attendance session',
    INVALID_PLOT: 'Invalid block',
    INVALID_TASK: 'Invalid task',
    ALLOCATION_MISMATCH: 'Task does not belong to the selected block',
    INVALID_TIME_RANGE: 'Clock-out cannot be before clock-in',
  }
  return c.json({ error: messages[code] ?? code }, 400)
}
