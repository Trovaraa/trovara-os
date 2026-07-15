import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { and, count, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, inventoryItems, plots, tasks, users } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { requireRole } from '../lib/rbac.js'
import { checkRateLimit } from '../lib/rate-limit.js'
import {
  completeChat,
  completeChatHistory,
  completeChatVision,
  isLlmConfigured,
  parseJsonFromLlm,
} from '../lib/llm.js'
import { buildFarmContext } from '../lib/farm-context.js'
import {
  buildButlerPrompt,
  CROP_DIAGNOSIS_PROMPT,
  LIVESTOCK_DIAGNOSIS_PROMPT,
  ADVISORY_DISCLAIMER,
  type CropDiagnosis,
  type LivestockDiagnosis,
} from '../lib/ai-advisor.js'
import { parseTaskDraft } from '../lib/butler-actions.js'
import { logAudit } from '../lib/audit.js'
import { sanitizeForLlm, isAllowedEvidenceImageDataUrl } from '../lib/sanitize-input.js'
import { storeTaskDraft, takeTaskDraft } from '../lib/task-drafts.js'

type BriefingPriority = {
  label: string
  detail: string
  urgency: 'high' | 'medium'
}

type BriefingPayload = {
  farm: { name: string; location: string } | null
  summary: {
    tasksPending: number
    tasksInProgress: number
    tasksAwaitingApproval: number
    tasksCompleted: number
    plotCount: number
    lowStockCount: number
  }
  lowStockItems: {
    name: string
    quantity: number
    reorderLevel: number
    unit: string
  }[]
}

function buildStructuredBriefing(data: BriefingPayload) {
  const priorities: BriefingPriority[] = []

  if (data.summary.tasksAwaitingApproval > 0) {
    priorities.push({
      label: 'Approve worker submissions',
      detail: `${data.summary.tasksAwaitingApproval} task(s) waiting for your review`,
      urgency: 'high',
    })
  }

  for (const item of data.lowStockItems) {
    priorities.push({
      label: `Restock ${item.name}`,
      detail: `${item.quantity} ${item.unit} left - reorder at ${item.reorderLevel}`,
      urgency: 'high',
    })
  }

  if (data.summary.tasksPending > 0) {
    priorities.push({
      label: 'Assign or follow up pending tasks',
      detail: `${data.summary.tasksPending} task(s) not started`,
      urgency: data.summary.tasksPending >= 3 ? 'high' : 'medium',
    })
  }

  if (data.summary.tasksInProgress > 0) {
    priorities.push({
      label: 'Check in on field work',
      detail: `${data.summary.tasksInProgress} task(s) in progress today`,
      urgency: 'medium',
    })
  }

  const dateLabel = new Date().toLocaleDateString('en-NG', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })

  return {
    farmName: data.farm?.name ?? 'Farm',
    location: data.farm?.location ?? '',
    dateLabel,
    priorities,
    tasks: {
      pending: data.summary.tasksPending,
      inProgress: data.summary.tasksInProgress,
      awaitingApproval: data.summary.tasksAwaitingApproval,
      completed: data.summary.tasksCompleted,
    },
    lowStock: data.lowStockItems,
    plotCount: data.summary.plotCount,
    allClear: priorities.length === 0,
  }
}

export const aiRoutes = new Hono<{ Variables: AppVariables }>()

aiRoutes.use('*', authMiddleware)

// Cost control: cap LLM-invoking requests per user (POSTs are the ones that pay OpenAI)
const AI_LIMIT_PER_HOUR = Number(process.env.AI_RATE_LIMIT_PER_HOUR ?? 60)

aiRoutes.use('*', async (c, next) => {
  if (c.req.method === 'POST') {
    const user = c.get('user')
    const { allowed, retryAfterSec } = checkRateLimit(`ai:${user.id}`, AI_LIMIT_PER_HOUR, 60 * 60 * 1000)
    if (!allowed) {
      c.header('Retry-After', String(retryAfterSec))
      return c.json({ error: 'Too many AI requests - please wait a bit and try again.' }, 429)
    }
  }
  await next()
})

aiRoutes.get('/status', (c) => {
  return c.json({
    configured: isLlmConfigured(),
    hint: isLlmConfigured()
      ? 'LLM ready'
      : 'Set OPENAI_API_KEY (or LLM_API_KEY + LLM_BASE_URL) - see docs/INTEGRATIONS.md',
  })
})

aiRoutes.get('/briefing', async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor')

  const [farm] = await db.select().from(farms).where(eq(farms.id, user.farmId)).limit(1)

  const taskStats = await db
    .select({ status: tasks.status, total: count() })
    .from(tasks)
    .where(eq(tasks.farmId, user.farmId))
    .groupBy(tasks.status)

  const [plotCount] = await db
    .select({ total: count() })
    .from(plots)
    .where(eq(plots.farmId, user.farmId))

  const lowStock = await db
    .select()
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.farmId, user.farmId),
        sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
      ),
    )

  const statsMap = Object.fromEntries(taskStats.map((s) => [s.status, Number(s.total)]))
  const summary = {
    tasksPending: statsMap.pending ?? 0,
    tasksInProgress: statsMap.in_progress ?? 0,
    tasksAwaitingApproval: statsMap.awaiting_approval ?? 0,
    tasksCompleted: statsMap.completed ?? 0,
    plotCount: Number(plotCount?.total ?? 0),
    lowStockCount: lowStock.length,
  }

  const dataPayload: BriefingPayload = {
    farm: farm ? { name: farm.name, location: farm.location } : null,
    summary,
    lowStockItems: lowStock.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      reorderLevel: i.reorderLevel,
      unit: i.unit,
    })),
  }

  const briefing = buildStructuredBriefing(dataPayload)

  return c.json({
    generatedAt: new Date().toISOString(),
    source: 'farm_data',
    ...briefing,
  })
})

const summarizeSchema = z.object({
  incidentText: z.string().min(25).max(4000),
  plotId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
})

function validateAskImageUrl(imageUrl: string): string | null {
  if (isAllowedEvidenceImageDataUrl(imageUrl)) return null
  if (imageUrl.startsWith('https://')) {
    if (process.env.NODE_ENV === 'production') {
      return 'External image URLs are not allowed in production - upload a photo instead.'
    }
    return null
  }
  return 'Invalid image URL - use a JPEG, PNG, or WebP photo.'
}

const VAGUE_INCIDENT_PATTERNS = [
  /^describe what happened/i,
  /^what happened(\s+on the farm)?[.?]*$/i,
  /^incident(\s+report)?[.?]*$/i,
  /^test(ing)?[.?]*$/i,
  /^n\/?a[.?]*$/i,
]

function validateIncidentText(text: string): string | null {
  const trimmed = text.trim()
  if (trimmed.length < 25) {
    return 'Write at least a sentence or two: what happened, where on the farm, and what you saw.'
  }
  if (VAGUE_INCIDENT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return 'Please describe the actual incident - e.g. "3 birds died in pen B after lethargy yesterday".'
  }
  if (trimmed.split(/\s+/).length < 8) {
    return 'Add more detail so AI can summarize accurately (who, where, what, when).'
  }
  return null
}

const incidentSummaryPrompt =
  'You summarize real farm incidents for Trovara OS managers in Nigeria. Use only facts from the report. Respond ONLY with valid JSON (no markdown): {"summaryText":"2-3 sentence plain English summary using specific details from the report","severity":"low|medium|high","category":"short_category_slug","recommendedActions":["concrete farm action"]}. Never say details are missing if the report contains them.'

type IncidentLlmResult = {
  summaryText?: string
  severity?: string
  category?: string
  recommendedActions?: string[]
}

function buildIncidentSummary(body: { incidentText: string }, parsed?: IncidentLlmResult) {
  return {
    summaryText:
      parsed?.summaryText?.trim() ||
      `Incident reported: ${body.incidentText.trim().slice(0, 280)}${body.incidentText.length > 280 ? '…' : ''}`,
    severity: parsed?.severity ?? 'medium',
    category: parsed?.category ?? 'unclassified',
    recommendedActions: parsed?.recommendedActions?.length
      ? parsed.recommendedActions
      : ['Review with assigned supervisor', 'Log follow-up task in Tasks'],
  }
}

aiRoutes.post('/summarize-incident', zValidator('json', summarizeSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor')

  const body = c.req.valid('json')

  const validationError = validateIncidentText(body.incidentText)
  if (validationError) {
    return c.json({ error: validationError }, 400)
  }

  if (!isLlmConfigured()) {
    return c.json({
      placeholder: true,
      summary: buildIncidentSummary(body),
      incidentText: body.incidentText,
      plotId: body.plotId ?? null,
      batchId: body.batchId ?? null,
    })
  }

  try {
    const incidentText = sanitizeForLlm(body.incidentText)
    const { text, model } = await completeChat(
      incidentSummaryPrompt,
      `Incident report:\n${incidentText}\nPlot: ${body.plotId ?? 'n/a'}\nBatch: ${body.batchId ?? 'n/a'}`,
    )
    const parsed = parseJsonFromLlm<IncidentLlmResult>(text)
    return c.json({
      placeholder: false,
      model,
      summary: buildIncidentSummary(body, parsed),
      incidentText: body.incidentText,
      plotId: body.plotId ?? null,
      batchId: body.batchId ?? null,
    })
  } catch {
    return c.json({
      placeholder: true,
      error: 'AI service temporarily unavailable',
      summary: buildIncidentSummary(body),
      incidentText: body.incidentText,
      plotId: body.plotId ?? null,
      batchId: body.batchId ?? null,
    })
  }
})

const askSchema = z
  .object({
    question: z.string().max(2000).optional().default(''),
    // data URL (data:image/jpeg;base64,...) or https URL - for crop/animal photos
    imageUrl: z.string().min(10).max(8_000_000).optional(),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().max(4000),
        }),
      )
      .max(12)
      .optional(),
  })
  .refine((v) => v.question.trim().length > 0 || v.imageUrl, {
    message: 'Provide a question or a photo',
  })

aiRoutes.post('/ask', zValidator('json', askSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor')

  const { question, imageUrl, history } = c.req.valid('json')

  if (imageUrl) {
    const imageError = validateAskImageUrl(imageUrl)
    if (imageError) return c.json({ error: imageError }, 400)
  }

  if (!isLlmConfigured()) {
    return c.json({
      placeholder: true,
      answer:
        'The Copilot needs an AI key to answer questions. Add OPENAI_API_KEY (or LLM_API_KEY) to your .env and restart the API. Until then, use the dashboard and Reports pages to find this information.',
      question,
    })
  }

  try {
    const context = await buildFarmContext(user)
    const systemPrompt = buildButlerPrompt(context)
    const safeQuestion = sanitizeForLlm(question)
    const safeHistory = (history ?? []).map((m) => ({
      role: m.role,
      content: sanitizeForLlm(m.content),
    }))

    let result: { text: string; model: string }
    if (imageUrl) {
      const prompt = safeQuestion.trim()
        ? safeQuestion
        : 'Look at this farm photo and tell me what you see and any problem or advice. Do not announce whether it is a plant or animal - just answer naturally.'
      result = await completeChatVision(systemPrompt, prompt, [imageUrl])
    } else {
      result = await completeChatHistory(systemPrompt, safeHistory, safeQuestion)
    }

    return c.json({ placeholder: false, model: result.model, answer: result.text, question: safeQuestion })
  } catch {
    return c.json({
      placeholder: true,
      error: 'AI service temporarily unavailable',
      answer: 'The Copilot could not reach the AI service. Please try again in a moment.',
      question,
    })
  }
})

const draftTaskSchema = z.object({
  question: z.string().min(1).max(1000),
})

const confirmTaskSchema = z.object({
  draftId: z.string().min(20),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  plotId: z.string().uuid().optional(),
  assignedToId: z.string().uuid().optional(),
})

aiRoutes.post('/draft-task', zValidator('json', draftTaskSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor')

  const { question } = c.req.valid('json')
  const draft = parseTaskDraft(question) ?? {
    title: question.trim().slice(0, 200),
  }
  const stored = storeTaskDraft(user.id, user.farmId, draft)

  return c.json({
    draftId: stored.draftId,
    draft: stored.draft,
    needsConfirm: true,
  })
})

aiRoutes.post('/confirm-task', zValidator('json', confirmTaskSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor')
  const body = c.req.valid('json')

  const stored = takeTaskDraft(body.draftId, user.id)
  if (!stored) {
    return c.json({ error: 'Task draft expired or invalid - please draft again.' }, 400)
  }
  if (stored.farmId !== user.farmId) {
    return c.json({ error: 'Task draft expired or invalid - please draft again.' }, 400)
  }

  if (body.plotId) {
    const [plot] = await db
      .select({ id: plots.id })
      .from(plots)
      .where(and(eq(plots.id, body.plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) return c.json({ error: 'Invalid plot' }, 400)
  }

  if (body.assignedToId) {
    const [assignee] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, body.assignedToId), eq(users.farmId, user.farmId)))
      .limit(1)
    if (!assignee) return c.json({ error: 'Invalid assignee' }, 400)
  }

  const [task] = await db
    .insert(tasks)
    .values({
      farmId: user.farmId,
      title: body.title.trim(),
      description: body.description,
      plotId: body.plotId,
      assignedToId: body.assignedToId,
      createdById: user.id,
      status: 'pending',
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'task',
    entityId: task.id,
    metadata: { source: 'ai_confirm_task' },
  })

  return c.json({ task }, 201)
})

// ── Livestock health diagnosis (Africa vet advisor) ──────────────────────────
const livestockSchema = z.object({
  species: z.string().min(2).max(60).optional(),
  symptoms: z.string().min(10).max(2000),
  batchId: z.string().uuid().optional(),
})

aiRoutes.post('/diagnose-livestock', zValidator('json', livestockSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const body = c.req.valid('json')

  if (!isLlmConfigured()) {
    return c.json({ placeholder: true, disclaimer: ADVISORY_DISCLAIMER, error: 'AI not configured - add OPENAI_API_KEY to .env' }, 200)
  }

  try {
    const symptoms = sanitizeForLlm(body.symptoms)
    const species = body.species ? sanitizeForLlm(body.species) : 'poultry/livestock'
    const { text, model } = await completeChat(
      LIVESTOCK_DIAGNOSIS_PROMPT,
      `Animal: ${species}\nSymptoms observed:\n${symptoms}`,
    )
    const parsed = parseJsonFromLlm<LivestockDiagnosis>(text)
    return c.json({ placeholder: false, model, diagnosis: parsed, disclaimer: ADVISORY_DISCLAIMER })
  } catch {
    return c.json({
      placeholder: true,
      error: 'AI service temporarily unavailable',
      disclaimer: ADVISORY_DISCLAIMER,
    }, 200)
  }
})

// ── Crop diagnosis from a photo (Africa agronomy advisor, vision) ────────────
const cropSchema = z.object({
  cropType: z.string().min(2).max(60).optional(),
  notes: z.string().max(2000).optional(),
  // data URL (data:image/jpeg;base64,...) or https URL
  imageUrl: z.string().min(10).max(8_000_000),
})

aiRoutes.post('/diagnose-crop', zValidator('json', cropSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor', 'field_worker')

  const body = c.req.valid('json')

  if (!isLlmConfigured()) {
    return c.json({ placeholder: true, disclaimer: ADVISORY_DISCLAIMER, error: 'AI not configured - add OPENAI_API_KEY to .env' }, 200)
  }

  const imageError = validateAskImageUrl(body.imageUrl)
  if (imageError) return c.json({ error: imageError }, 400)

  try {
    const cropType = body.cropType ? sanitizeForLlm(body.cropType) : 'unknown'
    const notes = body.notes ? sanitizeForLlm(body.notes) : 'none'
    const { text, model } = await completeChatVision(
      CROP_DIAGNOSIS_PROMPT,
      `Crop: ${cropType}\nFarmer notes: ${notes}\nDiagnose from the photo.`,
      [body.imageUrl],
    )
    const parsed = parseJsonFromLlm<CropDiagnosis>(text)
    return c.json({ placeholder: false, model, diagnosis: parsed, disclaimer: ADVISORY_DISCLAIMER })
  } catch {
    return c.json({
      placeholder: true,
      error: 'AI service temporarily unavailable',
      disclaimer: ADVISORY_DISCLAIMER,
    }, 200)
  }
})
