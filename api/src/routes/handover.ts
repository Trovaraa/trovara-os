import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks } from '../lib/rbac.js'
import {
  generateHandoverTasks,
  getHandoverProgress,
  seedHandoverTemplates,
} from '../lib/handover-templates.js'

const generateSchema = z.object({
  templateKeys: z.array(z.string().min(1).max(100)).max(20).optional(),
  plotIds: z.array(z.string().uuid()).max(200).optional(),
  assignedToId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
})

export const handoverRoutes = new Hono<{ Variables: AppVariables }>()

handoverRoutes.use('*', authMiddleware)

handoverRoutes.post('/seed-templates', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const created = await seedHandoverTemplates(user.farmId)
  return c.json({ created })
})

handoverRoutes.post('/generate-tasks', zValidator('json', generateSchema), async (c) => {
  const user = c.get('user')
  try {
    const created = await generateHandoverTasks(user, c.req.valid('json'))
    return c.json({ count: created.length, tasks: created }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed'
    if (message === 'FORBIDDEN') return c.json({ error: 'Forbidden' }, 403)
    return c.json({ error: message }, 400)
  }
})

handoverRoutes.get('/progress', async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)
  const progress = await getHandoverProgress(user.farmId)
  return c.json({ progress })
})
