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
  INCIDENT_SUMMARY_PROMPT,
  LIVESTOCK_DIAGNOSIS_PROMPT,
  ADVISORY_DISCLAIMER,
  type CropDiagnosis,
  type LivestockDiagnosis,
} from '../lib/ai-advisor.js'
import { advisoryCloseLine, ensureAdvisoryClose } from '../lib/advisory-close.js'
import { containsPesticideLanguage } from '../lib/pesticide-filter.js'
import { resolveMarketplaceProducts } from '../lib/marketplace-search.js'
import { resolveStaffReplyLocale, type ReplyLocale } from '../lib/reply-locale.js'
import { briefingDateLabel, renderBriefing } from '../lib/briefing-messages.js'
import { checkLlmBudget, consumeLlmBudget } from '../lib/llm-budget.js'
import { parseTaskDraft } from '../lib/butler-actions.js'
import { logAudit } from '../lib/audit.js'
import { sanitizeForLlm, isAllowedEvidenceImageDataUrl, isAllowedAudioDataUrl, parseAudioDataUrl } from '../lib/sanitize-input.js'
import {
  contentLocaleValues,
  storeActionDraft,
  takeTaskDraft,
  type ContentLocaleMeta,
} from '../lib/task-drafts.js'
import {
  authorLocaleForUserId,
  toCanonicalEnglish,
  toViewerLocaleMany,
} from '../lib/content-locale.js'
import { transcribeVoice } from '../lib/butler-core.js'
import {
  detectReplyLocale,
  webCopilotLlmOffMessage,
  webCopilotUnavailableMessage,
} from '../lib/reply-locale.js'

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

/**
 * The briefing is built from counts this service already holds, so every string
 * in it is developer-authored chrome and comes from `briefing-messages.ts` in
 * the owner's language. No LLM is involved on this path at all - it must answer
 * with the AI switched off or over budget - and the farm's own words (farm name,
 * location, inventory item names) are interpolated verbatim, never translated.
 */
function buildStructuredBriefing(data: BriefingPayload, locale: ReplyLocale) {
  const priorities: BriefingPriority[] = []

  if (data.summary.tasksAwaitingApproval > 0) {
    priorities.push({
      label: renderBriefing('briefing.approvals.label', locale),
      detail: renderBriefing('briefing.approvals.detail', locale, {
        count: data.summary.tasksAwaitingApproval,
      }),
      urgency: 'high',
    })
  }

  for (const item of data.lowStockItems) {
    priorities.push({
      label: renderBriefing('briefing.restock.label', locale, { item: item.name }),
      detail: renderBriefing('briefing.restock.detail', locale, {
        quantity: item.quantity,
        unit: item.unit,
        reorderLevel: item.reorderLevel,
      }),
      urgency: 'high',
    })
  }

  if (data.summary.tasksPending > 0) {
    priorities.push({
      label: renderBriefing('briefing.pendingTasks.label', locale),
      detail: renderBriefing('briefing.pendingTasks.detail', locale, {
        count: data.summary.tasksPending,
      }),
      urgency: data.summary.tasksPending >= 3 ? 'high' : 'medium',
    })
  }

  if (data.summary.tasksInProgress > 0) {
    priorities.push({
      label: renderBriefing('briefing.fieldWork.label', locale),
      detail: renderBriefing('briefing.fieldWork.detail', locale, {
        count: data.summary.tasksInProgress,
      }),
      urgency: 'medium',
    })
  }

  return {
    farmName: data.farm?.name ?? renderBriefing('briefing.farmFallback', locale),
    location: data.farm?.location ?? '',
    dateLabel: briefingDateLabel(locale),
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

async function preferredLocaleForUser(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ preferredLocale: users.preferredLocale })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return row?.preferredLocale ?? null
}

/**
 * Render AI-generated English into the viewer's language.
 *
 * Every prose string in a response goes through one call, so a diagnosis costs
 * a single batched translation (deduplicated and cache-read in one query) and
 * an English viewer costs nothing at all. A failure inside the service leaves
 * the English in place rather than blanking the answer.
 */
async function localizeTexts(
  texts: string[],
  farmId: string,
  targetLocale: string | null,
): Promise<string[]> {
  if (resolveStaffReplyLocale(targetLocale) === 'en') return texts
  if (texts.length === 0) return texts
  try {
    return await toViewerLocaleMany({ texts, targetLocale, farmId })
  } catch {
    return texts
  }
}

/**
 * One `source_locale`/`translation_status` pair describes a whole row, so the
 * labels of every piece of text going into it are folded together: `'pending'`
 * wins over `'done'` because the row is only English once all of it is, and a
 * non-English locale wins over `'en'` because that is the hint the retry job
 * needs.
 */
function foldContentLocale(labels: ContentLocaleMeta[]): ContentLocaleMeta {
  let sourceLocale: string | null = null
  let pending = false
  for (const label of labels) {
    if ((label.translationStatus ?? 'done') !== 'done') pending = true
    const locale = label.sourceLocale ?? null
    if (locale && (!sourceLocale || sourceLocale === 'en')) sourceLocale = locale
  }
  return { sourceLocale, translationStatus: pending ? 'pending' : 'done' }
}

type TaskTextField = 'title' | 'description'

/**
 * Normalize authored task prose to English for storage.
 *
 * Each field is its own column, so they are translated as concurrent calls
 * rather than one merged prompt: a title and a description cost one round trip
 * of latency instead of two, and neither field can bleed into the other's
 * column. A failure returns the original text labelled `'pending'`, never an
 * error - the user's write must not depend on the translator being up.
 */
async function toCanonicalTaskText(
  fields: Partial<Record<TaskTextField, string | undefined>>,
  farmId: string,
  sourceLocale: string | null,
): Promise<{ text: Partial<Record<TaskTextField, string>>; locale: ContentLocaleMeta }> {
  const entries = Object.entries(fields).filter(
    (entry): entry is [TaskTextField, string] =>
      typeof entry[1] === 'string' && entry[1].trim() !== '',
  )
  if (entries.length === 0) return { text: {}, locale: {} }

  const results = await Promise.all(
    entries.map(([, text]) => toCanonicalEnglish({ text, farmId, sourceLocale })),
  )

  const text: Partial<Record<TaskTextField, string>> = {}
  entries.forEach(([field], index) => {
    text[field] = results[index].english
  })

  return {
    text,
    locale: foldContentLocale(
      results.map((result) => ({
        sourceLocale: result.sourceLocale,
        translationStatus: result.status,
      })),
    ),
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

  const locale = resolveStaffReplyLocale(await preferredLocaleForUser(user.id))
  const briefing = buildStructuredBriefing(dataPayload, locale)

  return c.json({
    generatedAt: new Date().toISOString(),
    source: 'farm_data',
    locale,
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

const incidentSummaryPrompt = INCIDENT_SUMMARY_PROMPT

type IncidentLlmResult = {
  summaryText?: string
  severity?: string
  category?: string
  recommendedActions?: string[]
}

type IncidentSummary = ReturnType<typeof buildIncidentSummary>

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

/**
 * `INCIDENT_SUMMARY_PROMPT` asks for a "plain English summary", so the model
 * already produces canonical English and there is nothing to normalize on the
 * way in - a `toCanonicalEnglish` round trip here would be an LLM call that
 * translates English into English. The prose is instead rendered for whoever
 * asked, in one batched call.
 *
 * `severity` and `category` stay put: both are enum-like keys (`category` is
 * specified as a slug) that the UI switches on.
 */
async function localizeIncidentSummary(
  summary: IncidentSummary,
  farmId: string,
  viewerId: string,
): Promise<IncidentSummary> {
  const viewerLocale = await preferredLocaleForUser(viewerId)
  if (resolveStaffReplyLocale(viewerLocale) === 'en') return summary

  const rendered = await localizeTexts(
    [summary.summaryText, ...summary.recommendedActions],
    farmId,
    viewerLocale,
  )
  return {
    ...summary,
    summaryText: rendered[0],
    recommendedActions: rendered.slice(1),
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

  const budget = checkLlmBudget(user.farmId)
  if (!budget.allowed) {
    return c.json({
      placeholder: true,
      budgetExceeded: true,
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
    consumeLlmBudget(user.farmId)
    const summary = buildIncidentSummary(body, parsed)
    return c.json({
      placeholder: false,
      model,
      summary: await localizeIncidentSummary(summary, user.farmId, user.id),
      // The reporter's own words, echoed exactly as they were written.
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
    /** Optional UI locale hint (en|yo|pcm|fr) used for offline fallbacks. */
    locale: z.enum(['en', 'yo', 'pcm', 'fr']).optional(),
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

  const { question, imageUrl, history, locale: localeHint } = c.req.valid('json')
  const locale = detectReplyLocale(question, localeHint)

  if (imageUrl) {
    const imageError = validateAskImageUrl(imageUrl)
    if (imageError) return c.json({ error: imageError }, 400)
  }

  if (!isLlmConfigured()) {
    return c.json({
      placeholder: true,
      answer: webCopilotLlmOffMessage(locale),
      question,
    })
  }

  const budget = checkLlmBudget(user.farmId)
  if (!budget.allowed) {
    return c.json({
      placeholder: true,
      budgetExceeded: true,
      answer: webCopilotUnavailableMessage(locale),
      question,
    })
  }

  try {
    const context = await buildFarmContext(user, locale)
    const systemPrompt = buildButlerPrompt(context, { replyLocale: locale })
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

    consumeLlmBudget(user.farmId)
    return c.json({ placeholder: false, model: result.model, answer: result.text, question: safeQuestion })
  } catch {
    return c.json({
      placeholder: true,
      error: 'AI service temporarily unavailable',
      answer: webCopilotUnavailableMessage(locale),
      question,
    })
  }
})

const transcribeSchema = z.object({
  /** Browser MediaRecorder clip as data:audio/...;base64,... */
  audioDataUrl: z.string().min(30).max(6_000_000),
  filename: z.string().max(200).optional(),
})

aiRoutes.post('/transcribe', zValidator('json', transcribeSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor')

  const { allowed, retryAfterSec } = checkRateLimit(`ai-transcribe:${user.id}`, 20, 60_000)
  if (!allowed) {
    return c.json(
      { error: `Too many transcription requests - wait ${retryAfterSec}s and try again.` },
      429,
    )
  }

  if (!isLlmConfigured()) {
    return c.json({ error: 'AI not configured - add OPENAI_API_KEY to .env' }, 503)
  }

  const { audioDataUrl, filename } = c.req.valid('json')
  if (!isAllowedAudioDataUrl(audioDataUrl)) {
    return c.json({ error: 'Invalid audio - use a WebM, OGG, MP4, MP3, or WAV recording.' }, 400)
  }

  const parsed = parseAudioDataUrl(audioDataUrl)
  if (!parsed) {
    return c.json({ error: 'Could not read audio data.' }, 400)
  }
  // ~4 MB decoded; keeps abuse surface small while covering ~2–3 min of speech
  if (parsed.buffer.length > 4_000_000) {
    return c.json({ error: 'Voice clip is too large - keep it under about 2 minutes.' }, 400)
  }

  const transcript = await transcribeVoice(parsed.buffer, filename?.trim() || parsed.filename)
  if (!transcript) {
    return c.json({ error: 'Could not understand that voice note. Try again or type your question.' }, 422)
  }

  return c.json({ transcript })
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

/**
 * The draft title is the user's own sentence, not model output: `parseTaskDraft`
 * only recognises the English "create task ..." form, and everything else falls
 * back to the raw question. A francophone owner therefore lands French in
 * `action_drafts.payload`, so this is the channel's normalization point - the
 * same one `whatsapp-offer-drafts` uses - and confirmation copies the English
 * through instead of translating twice.
 *
 * `storeActionDraft` is called directly because `storeTaskDraft` has no way to
 * carry the locale columns, and `action_drafts` has them. `create_task` is
 * already in the retry job's `DRAFT_FREE_TEXT_FIELDS`, so a draft stored
 * `pending` gets repaired rather than stranded.
 */
aiRoutes.post('/draft-task', zValidator('json', draftTaskSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor')

  const { question } = c.req.valid('json')
  const draft = parseTaskDraft(question) ?? {
    title: question.trim().slice(0, 200),
  }

  const authorLocale = await authorLocaleForUserId(user.id)
  const canonical = await toCanonicalEnglish({
    text: draft.title,
    farmId: user.farmId,
    sourceLocale: authorLocale,
  })

  const stored = await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'create_task',
    payload: { ...draft, title: canonical.english },
    channel: 'web',
    ...contentLocaleValues({
      sourceLocale: canonical.sourceLocale,
      translationStatus: canonical.status,
    }),
  })

  // The user confirms and edits their own words; the draft row holds English.
  return c.json({
    draftId: stored.id,
    draft,
    needsConfirm: true,
  })
})

aiRoutes.post('/confirm-task', zValidator('json', confirmTaskSchema), async (c) => {
  const user = c.get('user')
  requireRole(user, 'owner', 'supervisor')
  const body = c.req.valid('json')

  const stored = await takeTaskDraft(body.draftId, user.id)
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

  // The title and description come from the confirmation form, not the draft, so
  // the user may have rewritten them between drafting and confirming. Text that
  // came back unchanged is the draft's canonical English and is copied through
  // with the draft's own labels - no second translation of the same words - while
  // anything rewritten is authored text and is normalized here.
  const title = body.title.trim()
  const description = body.description?.trim() || undefined
  const draftLabel: ContentLocaleMeta = {
    sourceLocale: stored.sourceLocale,
    translationStatus: stored.translationStatus,
  }

  const rewritten: Partial<Record<TaskTextField, string>> = {}
  const labels: ContentLocaleMeta[] = []
  if (title === stored.title) labels.push(draftLabel)
  else rewritten.title = title
  if (description !== undefined) {
    if (description === stored.description) labels.push(draftLabel)
    else rewritten.description = description
  }

  const authorLocale =
    Object.keys(rewritten).length > 0 ? await authorLocaleForUserId(user.id) : null
  const canonical = await toCanonicalTaskText(rewritten, user.farmId, authorLocale)
  labels.push(canonical.locale)

  const [task] = await db
    .insert(tasks)
    .values({
      farmId: user.farmId,
      title: canonical.text.title ?? title,
      description: canonical.text.description ?? description,
      ...contentLocaleValues(foldContentLocale(labels)),
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

  // The author reads back their own words; the row holds the English.
  return c.json(
    { task: { ...task, title, description: description ?? task.description } },
    201,
  )
})

/**
 * `LIVESTOCK_DIAGNOSIS_PROMPT` and `CROP_DIAGNOSIS_PROMPT` ask for a summary "in
 * the user language", which makes the output language a side effect of whichever
 * language the symptoms happened to be typed in - and English whenever a photo
 * arrives with no notes, while the close line beside it was already localized
 * from a table. Generation is pinned to English here and the reader's language is
 * applied on the way out, the same rework `buildWeatherActionsPrompt` had.
 *
 * The rule is added at this call site because those prompts live in
 * `ai-advisor.ts`, shared with the chat butler, which must keep replying in
 * whatever language it is spoken to.
 */
const ENGLISH_DIAGNOSIS_RULE =
  'LANGUAGE (required): write every string in the JSON in English, whatever language the request uses.'

/**
 * Render a diagnosis in the reader's language with one batched call, or hand back
 * the English untouched for an English reader.
 *
 * Prose only: `likelihood`, `urgency` and `callVet` are an enum value and a
 * boolean the UI switches on. Treatment names double as the marketplace search
 * query and as the input to the pesticide filter, both of which match English, so
 * this must run after them - it takes a copy and never edits in place.
 */
async function localizeDiagnosis<T extends CropDiagnosis | LivestockDiagnosis>(
  diagnosis: T,
  farmId: string,
  locale: ReplyLocale,
): Promise<T> {
  if (locale === 'en') return diagnosis

  const causes = diagnosis.likelyCauses ?? []
  const immediateActions = diagnosis.immediateActions ?? []
  const treatments = diagnosis.treatments ?? []
  const prevention = diagnosis.prevention ?? []

  const rendered = await localizeTexts(
    [
      diagnosis.summary ?? '',
      ...causes.flatMap((cause) => [cause.name, cause.why]),
      ...immediateActions,
      ...treatments.flatMap((treatment) => [treatment.name, treatment.usage, treatment.note ?? '']),
      ...prevention,
    ],
    farmId,
    locale,
  )

  let cursor = 0
  const take = () => rendered[cursor++] ?? ''

  const summary = take()
  const localizedCauses = causes.map((cause) => {
    const name = take()
    const why = take()
    return { ...cause, name, why }
  })
  const localizedActions = immediateActions.map(() => take())
  const localizedTreatments = treatments.map((treatment) => {
    const name = take()
    const usage = take()
    const note = take()
    return { ...treatment, name, usage, ...(treatment.note === undefined ? {} : { note }) }
  })
  const localizedPrevention = prevention.map(() => take())

  return {
    ...diagnosis,
    summary,
    likelyCauses: localizedCauses,
    immediateActions: localizedActions,
    treatments: localizedTreatments,
    prevention: localizedPrevention,
  }
}

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

  const budget = checkLlmBudget(user.farmId)
  if (!budget.allowed) {
    return c.json({
      placeholder: true,
      budgetExceeded: true,
      disclaimer: ADVISORY_DISCLAIMER,
      error: 'Daily AI budget exceeded for this farm - try again tomorrow.',
    }, 200)
  }

  try {
    const symptoms = sanitizeForLlm(body.symptoms)
    const species = body.species ? sanitizeForLlm(body.species) : 'poultry/livestock'
    const { text, model } = await completeChat(
      `${LIVESTOCK_DIAGNOSIS_PROMPT} ${ENGLISH_DIAGNOSIS_RULE}`,
      `Animal: ${species}\nSymptoms observed:\n${symptoms}`,
    )
    const parsed = parseJsonFromLlm<LivestockDiagnosis>(text)
    parsed.treatments = (parsed.treatments ?? []).filter(
      (t) => !containsPesticideLanguage(`${t.name} ${t.usage} ${t.note ?? ''}`),
    )
    consumeLlmBudget(user.farmId)

    const [[farmRow], [pref]] = await Promise.all([
      db.select({ location: farms.location }).from(farms).where(eq(farms.id, user.farmId)).limit(1),
      db.select({ preferredLocale: users.preferredLocale }).from(users).where(eq(users.id, user.id)).limit(1),
    ])
    const locale = resolveStaffReplyLocale(pref?.preferredLocale)
    const needQuery =
      parsed.treatments[0]?.name && !containsPesticideLanguage(parsed.treatments[0].name)
        ? parsed.treatments[0].name
        : 'poultry electrolytes vitamins agrovet'
    const recommendedProducts = await resolveMarketplaceProducts({
      farmLocation: farmRow?.location,
      needQuery,
      locale,
      farmId: user.farmId,
    })

    // The close line comes from the table in `advisory-close.ts`, so it is
    // appended after localization rather than translated by the LLM.
    const diagnosis = await localizeDiagnosis(parsed, user.farmId, locale)
    diagnosis.summary = ensureAdvisoryClose(diagnosis.summary ?? '', locale, 'livestock')

    return c.json({
      placeholder: false,
      model,
      diagnosis,
      recommendedProducts,
      closeLine: advisoryCloseLine(locale, 'livestock'),
      disclaimer: ADVISORY_DISCLAIMER,
    })
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

  const budget = checkLlmBudget(user.farmId)
  if (!budget.allowed) {
    return c.json({
      placeholder: true,
      budgetExceeded: true,
      disclaimer: ADVISORY_DISCLAIMER,
      error: 'Daily AI budget exceeded for this farm - try again tomorrow.',
    }, 200)
  }

  try {
    const cropType = body.cropType ? sanitizeForLlm(body.cropType) : 'unknown'
    const notes = body.notes ? sanitizeForLlm(body.notes) : 'none'
    const { text, model } = await completeChatVision(
      `${CROP_DIAGNOSIS_PROMPT} ${ENGLISH_DIAGNOSIS_RULE}`,
      `Crop: ${cropType}\nFarmer notes: ${notes}\nDiagnose from the photo.`,
      [body.imageUrl],
    )
    const parsed = parseJsonFromLlm<CropDiagnosis>(text)
    parsed.treatments = (parsed.treatments ?? []).filter(
      (t) => !containsPesticideLanguage(`${t.name} ${t.usage} ${t.note ?? ''}`),
    )
    consumeLlmBudget(user.farmId)

    const [[farmRow], [pref]] = await Promise.all([
      db.select({ location: farms.location }).from(farms).where(eq(farms.id, user.farmId)).limit(1),
      db.select({ preferredLocale: users.preferredLocale }).from(users).where(eq(users.id, user.id)).limit(1),
    ])
    const locale = resolveStaffReplyLocale(pref?.preferredLocale)
    const needQuery =
      parsed.treatments[0]?.name && !containsPesticideLanguage(parsed.treatments[0].name)
        ? parsed.treatments[0].name
        : 'organic fertilizer compost mulch'
    const recommendedProducts = await resolveMarketplaceProducts({
      farmLocation: farmRow?.location,
      needQuery,
      locale,
      farmId: user.farmId,
    })

    const diagnosis = await localizeDiagnosis(parsed, user.farmId, locale)
    diagnosis.summary = ensureAdvisoryClose(diagnosis.summary ?? '', locale, 'crop')

    return c.json({
      placeholder: false,
      model,
      diagnosis,
      recommendedProducts,
      closeLine: advisoryCloseLine(locale, 'crop'),
      disclaimer: ADVISORY_DISCLAIMER,
    })
  } catch {
    return c.json({
      placeholder: true,
      error: 'AI service temporarily unavailable',
      disclaimer: ADVISORY_DISCLAIMER,
    }, 200)
  }
})
