import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { canAssignTasks, canApproveTasks } from '../lib/rbac.js'
import {
  createCensusSurvey,
  currentVerifiedCensus,
  listCensusByPlot,
  submitCensusForTask,
  surveyHeightsAsNumbers,
  verifyCensusSurvey,
} from '../lib/census-service.js'

const censusBodySchema = z
  .object({
    plotId: z.string().uuid(),
    cropType: z.string().trim().min(1).max(100),
    cropVariety: z.string().trim().max(100).nullable().optional(),
    plantCount: z.number().int().min(0),
    minHeight: z.number().min(0).nullable().optional(),
    maxHeight: z.number().min(0).nullable().optional(),
    avgHeight: z.number().min(0).nullable().optional(),
    heightUnit: z.enum(['cm', 'm']).default('cm'),
    sampleSize: z.number().int().min(0).nullable().optional(),
    countingMethod: z.string().trim().max(200).nullable().optional(),
    conditionNotes: z.string().trim().max(2000).nullable().optional(),
    mortalityNotes: z.string().trim().max(2000).nullable().optional(),
    surveyedAt: z.string().datetime().nullable().optional(),
    latitude: z.union([z.string().max(32), z.number()]).nullable().optional(),
    longitude: z.union([z.string().max(32), z.number()]).nullable().optional(),
    taskId: z.string().uuid().nullable().optional(),
    photoUrl: z.string().max(2_000_000).nullable().optional(),
    voiceUrl: z.string().max(2_000_000).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.minHeight != null &&
      value.maxHeight != null &&
      value.minHeight > value.maxHeight
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minHeight cannot exceed maxHeight',
        path: ['minHeight'],
      })
    }
  })

const taskCensusSchema = z
  .object({
    plotId: z.string().uuid().optional(),
    cropType: z.string().trim().min(1).max(100),
    cropVariety: z.string().trim().max(100).nullable().optional(),
    plantCount: z.number().int().min(0),
    minHeight: z.number().min(0).nullable().optional(),
    maxHeight: z.number().min(0).nullable().optional(),
    avgHeight: z.number().min(0).nullable().optional(),
    heightUnit: z.enum(['cm', 'm']).default('cm'),
    sampleSize: z.number().int().min(0).nullable().optional(),
    countingMethod: z.string().trim().max(200).nullable().optional(),
    conditionNotes: z.string().trim().max(2000).nullable().optional(),
    mortalityNotes: z.string().trim().max(2000).nullable().optional(),
    surveyedAt: z.string().datetime().nullable().optional(),
    latitude: z.union([z.string().max(32), z.number()]).nullable().optional(),
    longitude: z.union([z.string().max(32), z.number()]).nullable().optional(),
    photoUrl: z.string().max(2_000_000).nullable().optional(),
    voiceUrl: z.string().max(2_000_000).nullable().optional(),
    completionNote: z.string().max(2000).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.minHeight != null &&
      value.maxHeight != null &&
      value.minHeight > value.maxHeight
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'minHeight cannot exceed maxHeight',
        path: ['minHeight'],
      })
    }
  })

const verifySchema = z.object({
  status: z.enum(['verified', 'rejected']),
  rejectionReason: z.string().trim().min(5).max(2000).nullable().optional(),
})

export const censusRoutes = new Hono<{ Variables: AppVariables }>()

censusRoutes.use('*', authMiddleware)

censusRoutes.get('/plots/:plotId', async (c) => {
  const user = c.get('user')
  const plotId = c.req.param('plotId')
  const surveys = await listCensusByPlot(user.farmId, plotId)
  return c.json({ surveys: surveys.map(surveyHeightsAsNumbers) })
})

censusRoutes.get('/plots/:plotId/current', async (c) => {
  const user = c.get('user')
  const plotId = c.req.param('plotId')
  const surveys = await currentVerifiedCensus(user.farmId, plotId)
  return c.json({ surveys: surveys.map(surveyHeightsAsNumbers) })
})

censusRoutes.post('/', zValidator('json', censusBodySchema), async (c) => {
  const user = c.get('user')
  if (!canAssignTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  try {
    const survey = await createCensusSurvey(user, c.req.valid('json'), {
      autoVerify: false,
    })
    return c.json({ survey: surveyHeightsAsNumbers(survey) }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed'
    if (message === 'FORBIDDEN') return c.json({ error: 'Forbidden' }, 403)
    if (message === 'Invalid plot' || message === 'Invalid task') {
      return c.json({ error: message }, 400)
    }
    return c.json({ error: message }, 400)
  }
})

censusRoutes.post('/:id/verify', zValidator('json', verifySchema), async (c) => {
  const user = c.get('user')
  if (!canApproveTasks(user)) return c.json({ error: 'Forbidden' }, 403)

  const body = c.req.valid('json')
  try {
    const survey = await verifyCensusSurvey(
      user,
      c.req.param('id'),
      body.status,
      body.rejectionReason,
    )
    return c.json({ survey: surveyHeightsAsNumbers(survey) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed'
    if (message === 'FORBIDDEN') return c.json({ error: 'Forbidden' }, 403)
    if (message === 'NOT_FOUND') return c.json({ error: 'Not found' }, 404)
    if (message === 'SELF_VERIFY') {
      return c.json({ error: 'You cannot verify your own census submission' }, 400)
    }
    if (message === 'ALREADY_RESOLVED') {
      return c.json({ error: 'Survey already verified or rejected' }, 400)
    }
    if (message === 'REJECTION_REASON_REQUIRED') {
      return c.json({ error: 'rejectionReason is required' }, 400)
    }
    return c.json({ error: message }, 400)
  }
})

export const taskCensusRoutes = new Hono<{ Variables: AppVariables }>()

taskCensusRoutes.use('*', authMiddleware)

taskCensusRoutes.post(
  '/:id/census-submission',
  zValidator('json', taskCensusSchema),
  async (c) => {
    const user = c.get('user')
    const body = c.req.valid('json')
    try {
      const survey = await submitCensusForTask(user, c.req.param('id'), {
        ...body,
        plotId: body.plotId ?? '',
        cropType: body.cropType,
        plantCount: body.plantCount,
      })
      return c.json({ survey: surveyHeightsAsNumbers(survey) }, 201)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed'
      if (message === 'FORBIDDEN') return c.json({ error: 'Forbidden' }, 403)
      if (message === 'NOT_FOUND') return c.json({ error: 'Not found' }, 404)
      if (message === 'PLOT_REQUIRED') return c.json({ error: 'plotId is required' }, 400)
      return c.json({ error: message }, 400)
    }
  },
)
