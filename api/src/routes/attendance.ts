import { Hono, type Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import {
  clockIn,
  clockOut,
  listToday,
  supervisorCorrect,
} from '../lib/attendance-service.js'
import { canApproveTasks } from '../lib/rbac.js'

const allocationSchema = z.object({
  plotId: z.string().uuid().nullable().optional(),
  taskId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

const correctionSchema = allocationSchema
  .extend({
    clockInAt: z.string().datetime().optional(),
    clockOutAt: z.string().datetime().nullable().optional(),
    monthlyWageSnapshotNgn: z.number().int().min(0).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'At least one correction is required')

export const attendanceRoutes = new Hono<{ Variables: AppVariables }>()

attendanceRoutes.use('*', authMiddleware)

attendanceRoutes.get('/today', async (c) => {
  const user = c.get('user')
  const sessions = await listToday(user)
  return c.json({ sessions })
})

attendanceRoutes.post('/clock-in', zValidator('json', allocationSchema), async (c) => {
  try {
    const result = await clockIn(c.get('user'), c.req.valid('json'))
    return c.json(result, result.idempotent ? 200 : 201)
  } catch (error) {
    return attendanceError(c, error)
  }
})

attendanceRoutes.post('/clock-out', async (c) => {
  try {
    return c.json(await clockOut(c.get('user')))
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
