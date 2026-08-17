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
  reviewHours,
  submitHours,
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

const submitHoursSchema = allocationSchema.extend({
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  submittedMinutes: z.number().int().min(15).max(960),
  workSummary: z.string().trim().min(3).max(2000),
})

const reviewHoursSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().trim().max(500).nullable().optional(),
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

attendanceRoutes.post('/submit-hours', zValidator('json', submitHoursSchema), async (c) => {
  try {
    return c.json(await submitHours(c.get('user'), c.req.valid('json')), 201)
  } catch (error) {
    return attendanceError(c, error)
  }
})

attendanceRoutes.post('/:id/review', zValidator('json', reviewHoursSchema), async (c) => {
  try {
    return c.json({ session: await reviewHours(c.get('user'), c.req.param('id'), c.req.valid('json')) })
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
    INVALID_WORK_DATE: 'Enter a valid work date',
    WORK_DATE_OUT_OF_RANGE: 'Work dates can be today or within the allowed backfill period',
    INVALID_HOURS: 'Hours must be between 15 minutes and 16 hours',
    WORK_SUMMARY_REQUIRED: 'Describe what you spent time on',
    ALREADY_SUBMITTED: 'Hours have already been submitted for this date',
    NOT_PENDING: 'This hours entry is no longer awaiting review',
    SELF_APPROVAL_FORBIDDEN: 'You cannot approve your own hours',
    REJECTION_REASON_REQUIRED: 'Give a reason when returning an hours entry',
  }
  return c.json({ error: messages[code] ?? code }, 400)
}
