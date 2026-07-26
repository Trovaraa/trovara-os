import { and, desc, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  cropCensusEvidence,
  cropCensusSurveys,
  plots,
  tasks,
  users,
} from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canApproveTasks } from './rbac.js'
import { processEvidenceValue, validateEvidenceRef } from './evidence-store.js'
import { logAudit } from './audit.js'
import { normalizeCropType } from './crop-normalize.js'
import {
  contentLocaleValues,
  mergeContentLocale,
  type ContentLocaleMeta,
} from './task-drafts.js'

/**
 * The prose on a survey, and the only columns the row's locale pair describes.
 *
 * These are exactly the three the translation retry job repairs on
 * `crop_census_surveys`. `countingMethod` is deliberately not one of them: the
 * sweep never reads that column, so a row marked 'pending' because of it would
 * be set back to 'done' with the method still in the author's language. It is a
 * short descriptor ("full count", "sample"), not prose, and stays verbatim.
 *
 * Everything else is a key or a measurement: `cropType` is an exact lookup key,
 * `cropVariety` and staff names are proper nouns, and heights, counts, units,
 * coordinates, timestamps and the verification status are never translated.
 */
export const CENSUS_TEXT_FIELDS = [
  'conditionNotes',
  'mortalityNotes',
  'rejectionReason',
] as const

/**
 * Locale metadata is optional and defaults to today's behavior: a caller that
 * passes none writes no locale columns at all, so the schema defaults ('done',
 * no source locale) apply. A caller writing text the LLM could not turn into
 * English passes `translationStatus: 'pending'` so the retry job can find the
 * row; without it the row claims to be English forever.
 */
export type CensusSurveyInput = ContentLocaleMeta & {
  plotId: string
  cropType: string
  cropVariety?: string | null
  plantCount: number
  minHeight?: number | null
  maxHeight?: number | null
  avgHeight?: number | null
  heightUnit?: 'cm' | 'm'
  sampleSize?: number | null
  countingMethod?: string | null
  conditionNotes?: string | null
  mortalityNotes?: string | null
  surveyedAt?: string | null
  latitude?: string | number | null
  longitude?: string | number | null
  taskId?: string | null
  photoUrl?: string | null
  voiceUrl?: string | null
}

function heightToText(value: number | null | undefined): string | null {
  if (value == null) return null
  return String(value)
}

function parseHeight(value: string | null | undefined): number | null {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function validateCensusHeights(input: CensusSurveyInput): string | null {
  if (input.plantCount < 0) return 'Plant count cannot be negative'
  const min = input.minHeight ?? null
  const max = input.maxHeight ?? null
  const avg = input.avgHeight ?? null
  for (const [label, v] of [
    ['minHeight', min],
    ['maxHeight', max],
    ['avgHeight', avg],
  ] as const) {
    if (v != null && v < 0) return `${label} cannot be negative`
  }
  if (min != null && max != null && min > max) return 'minHeight cannot exceed maxHeight'
  if (avg != null && min != null && avg < min) return 'avgHeight must be within min/max'
  if (avg != null && max != null && avg > max) return 'avgHeight must be within min/max'
  return null
}

function coordToText(value: string | number | null | undefined): string | null {
  if (value == null || value === '') return null
  return String(value)
}

/**
 * Grouping key for crop types read back from the database.
 *
 * Rows written before crop names were normalized on write hold whatever the
 * worker typed, so the stored string cannot be trusted as the group identity:
 * "Noix de coco" and "coconut" are one crop and would otherwise show up as two
 * in the same summary. The key resolves through the lexicon first, then folds
 * case and accents so spelling variants of a crop we have no playbook for still
 * collapse together. It is only ever a key — the row keeps its stored text for
 * display, and nothing is rewritten.
 */
function cropGroupKey(cropType: string): string {
  return normalizeCropType(cropType)
    .canonical.normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[\s_/-]+/g, ' ')
    .trim()
}

export async function listCensusByPlot(farmId: string, plotId: string) {
  const rows = await db
    .select({
      id: cropCensusSurveys.id,
      plotId: cropCensusSurveys.plotId,
      taskId: cropCensusSurveys.taskId,
      cropType: cropCensusSurveys.cropType,
      cropVariety: cropCensusSurveys.cropVariety,
      plantCount: cropCensusSurveys.plantCount,
      minHeight: cropCensusSurveys.minHeight,
      maxHeight: cropCensusSurveys.maxHeight,
      avgHeight: cropCensusSurveys.avgHeight,
      heightUnit: cropCensusSurveys.heightUnit,
      sampleSize: cropCensusSurveys.sampleSize,
      countingMethod: cropCensusSurveys.countingMethod,
      conditionNotes: cropCensusSurveys.conditionNotes,
      mortalityNotes: cropCensusSurveys.mortalityNotes,
      surveyedAt: cropCensusSurveys.surveyedAt,
      latitude: cropCensusSurveys.latitude,
      longitude: cropCensusSurveys.longitude,
      recordedById: cropCensusSurveys.recordedById,
      recordedByName: users.name,
      verificationStatus: cropCensusSurveys.verificationStatus,
      verifiedById: cropCensusSurveys.verifiedById,
      verifiedAt: cropCensusSurveys.verifiedAt,
      rejectionReason: cropCensusSurveys.rejectionReason,
      createdAt: cropCensusSurveys.createdAt,
    })
    .from(cropCensusSurveys)
    .leftJoin(users, eq(cropCensusSurveys.recordedById, users.id))
    .where(and(eq(cropCensusSurveys.farmId, farmId), eq(cropCensusSurveys.plotId, plotId)))
    .orderBy(desc(cropCensusSurveys.surveyedAt), desc(cropCensusSurveys.createdAt))

  return rows
}

/** Latest verified survey per crop type for a block. */
export async function currentVerifiedCensus(farmId: string, plotId: string) {
  const rows = await db
    .select()
    .from(cropCensusSurveys)
    .where(
      and(
        eq(cropCensusSurveys.farmId, farmId),
        eq(cropCensusSurveys.plotId, plotId),
        eq(cropCensusSurveys.verificationStatus, 'verified'),
      ),
    )
    .orderBy(desc(cropCensusSurveys.surveyedAt), desc(cropCensusSurveys.createdAt))

  const byCrop = new Map<string, (typeof rows)[number]>()
  for (const row of rows) {
    const key = cropGroupKey(row.cropType)
    if (!byCrop.has(key)) byCrop.set(key, row)
  }
  return [...byCrop.values()]
}

export async function createCensusSurvey(
  user: SessionUser,
  input: CensusSurveyInput,
  opts?: { autoVerify?: boolean },
) {
  const heightError = validateCensusHeights(input)
  if (heightError) throw new Error(heightError)

  const [plot] = await db
    .select({ id: plots.id })
    .from(plots)
    .where(and(eq(plots.id, input.plotId), eq(plots.farmId, user.farmId)))
    .limit(1)
  if (!plot) throw new Error('Invalid plot')

  if (input.taskId) {
    const [task] = await db
      .select({ id: tasks.id, assignedToId: tasks.assignedToId })
      .from(tasks)
      .where(and(eq(tasks.id, input.taskId), eq(tasks.farmId, user.farmId)))
      .limit(1)
    if (!task) throw new Error('Invalid task')
    if (user.role === 'field_worker' && task.assignedToId !== user.id) {
      throw new Error('FORBIDDEN')
    }
  }

  if (input.photoUrl && !validateEvidenceRef(input.photoUrl)) {
    throw new Error('Invalid photo evidence')
  }
  if (input.voiceUrl && !validateEvidenceRef(input.voiceUrl)) {
    throw new Error('Invalid voice evidence')
  }

  const photoUrl = await processEvidenceValue(user.farmId, input.photoUrl)
  const voiceUrl = await processEvidenceValue(user.farmId, input.voiceUrl)

  const autoVerify = opts?.autoVerify === true && canApproveTasks(user)
  const now = new Date()

  // The lifecycle and advisory lookups exact-match this string against their
  // English keys, so it is resolved here rather than in each caller: every
  // survey write goes through this function, including the butler executor,
  // which hands over whatever the worker said. Crops we have no playbook for
  // are stored as typed.
  const cropType = normalizeCropType(input.cropType.trim()).canonical

  const survey = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(cropCensusSurveys)
      .values({
        farmId: user.farmId,
        plotId: input.plotId,
        taskId: input.taskId ?? null,
        cropType,
        cropVariety: input.cropVariety?.trim() || null,
        plantCount: input.plantCount,
        minHeight: heightToText(input.minHeight),
        maxHeight: heightToText(input.maxHeight),
        avgHeight: heightToText(input.avgHeight),
        heightUnit: input.heightUnit ?? 'cm',
        sampleSize: input.sampleSize ?? null,
        countingMethod: input.countingMethod?.trim() || null,
        conditionNotes: input.conditionNotes?.trim() || null,
        mortalityNotes: input.mortalityNotes?.trim() || null,
        // The notes above carry the author's locale debt: a draft the LLM could
        // not translate lands here as 'pending' so the retry job still owns it.
        ...contentLocaleValues(input),
        surveyedAt: input.surveyedAt ? new Date(input.surveyedAt) : now,
        latitude: coordToText(input.latitude),
        longitude: coordToText(input.longitude),
        recordedById: user.id,
        verificationStatus: autoVerify ? 'verified' : 'reported',
        verifiedById: autoVerify ? user.id : null,
        verifiedAt: autoVerify ? now : null,
      })
      .returning()

    if (photoUrl) {
      await tx.insert(cropCensusEvidence).values({
        surveyId: row.id,
        kind: 'photo',
        evidenceUrl: photoUrl,
        createdById: user.id,
      })
    }
    if (voiceUrl) {
      await tx.insert(cropCensusEvidence).values({
        surveyId: row.id,
        kind: 'voice',
        evidenceUrl: voiceUrl,
        createdById: user.id,
      })
    }

    return row
  })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'census_create',
    entityType: 'crop_census_survey',
    entityId: survey.id,
    metadata: { plotId: input.plotId, cropType, autoVerify },
  })

  return survey
}

export async function verifyCensusSurvey(
  user: SessionUser,
  surveyId: string,
  status: 'verified' | 'rejected',
  rejectionReason?: string | null,
  locale?: ContentLocaleMeta,
) {
  if (!canApproveTasks(user)) throw new Error('FORBIDDEN')

  const [survey] = await db
    .select()
    .from(cropCensusSurveys)
    .where(and(eq(cropCensusSurveys.id, surveyId), eq(cropCensusSurveys.farmId, user.farmId)))
    .limit(1)

  if (!survey) throw new Error('NOT_FOUND')
  if (survey.recordedById === user.id) throw new Error('SELF_VERIFY')
  if (survey.verificationStatus !== 'reported') throw new Error('ALREADY_RESOLVED')
  if (status === 'rejected' && !rejectionReason?.trim()) {
    throw new Error('REJECTION_REASON_REQUIRED')
  }

  const now = new Date()
  const rejecting = status === 'rejected'
  const [updated] = await db
    .update(cropCensusSurveys)
    .set({
      verificationStatus: status,
      verifiedById: user.id,
      verifiedAt: now,
      rejectionReason: rejecting ? rejectionReason!.trim() : null,
      // A rejection adds a second author's text to a row that already holds the
      // worker's notes, and one locale pair describes the whole row: a French
      // reason escalates it to 'pending', and a row the retry job still owes
      // work on is left exactly as it is. Approving writes no text, so it never
      // touches the pair.
      ...(rejecting ? mergeContentLocale(survey, locale) : {}),
    })
    .where(eq(cropCensusSurveys.id, surveyId))
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: status === 'verified' ? 'census_verify' : 'census_reject',
    entityType: 'crop_census_survey',
    entityId: surveyId,
  })

  return updated
}

export type TaskCensusExtras = {
  completionNote?: string | null
}

export async function submitCensusForTask(
  user: SessionUser,
  taskId: string,
  input: CensusSurveyInput & TaskCensusExtras,
) {
  const [task] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.farmId, user.farmId)))
    .limit(1)

  if (!task) throw new Error('NOT_FOUND')
  if (user.role === 'field_worker' && task.assignedToId !== user.id) {
    throw new Error('FORBIDDEN')
  }
  if (task.status === 'completed') throw new Error('TASK_ALREADY_COMPLETED')

  const plotId = input.plotId || task.plotId
  if (!plotId) throw new Error('PLOT_REQUIRED')

  const survey = await createCensusSurvey(user, { ...input, plotId, taskId })

  const evidence = await db
    .select({ kind: cropCensusEvidence.kind, evidenceUrl: cropCensusEvidence.evidenceUrl })
    .from(cropCensusEvidence)
    .where(eq(cropCensusEvidence.surveyId, survey.id))

  const photoUrl =
    evidence.find((e) => e.kind === 'photo')?.evidenceUrl ?? task.photoUrl
  const voiceUrl =
    evidence.find((e) => e.kind === 'voice')?.evidenceUrl ?? task.voiceUrl

  const completionNote = input.completionNote?.trim() || null

  await db
    .update(tasks)
    .set({
      status: 'awaiting_approval',
      completionNote: completionNote ?? task.completionNote,
      // Same rule as the survey row: the note is free text on a translation
      // tracked table, so a note that is not English yet escalates the task to
      // 'pending' and an already-pending task is never downgraded.
      ...(completionNote ? mergeContentLocale(task, input) : {}),
      photoUrl,
      voiceUrl,
      latitude: coordToText(input.latitude) ?? task.latitude,
      longitude: coordToText(input.longitude) ?? task.longitude,
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, taskId))

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'census_task_submit',
    entityType: 'task',
    entityId: taskId,
    metadata: { surveyId: survey.id },
  })

  return survey
}

export function surveyHeightsAsNumbers<
  T extends {
    minHeight: string | null
    maxHeight: string | null
    avgHeight: string | null
  },
>(survey: T) {
  return {
    ...survey,
    minHeight: parseHeight(survey.minHeight),
    maxHeight: parseHeight(survey.maxHeight),
    avgHeight: parseHeight(survey.avgHeight),
  }
}

export async function plotsMissingVerifiedCensus(farmId: string) {
  const activePlots = await db
    .select({ id: plots.id, name: plots.name })
    .from(plots)
    .where(and(eq(plots.farmId, farmId), eq(plots.active, true)))

  const verified = await db
    .select({
      plotId: cropCensusSurveys.plotId,
    })
    .from(cropCensusSurveys)
    .where(
      and(
        eq(cropCensusSurveys.farmId, farmId),
        eq(cropCensusSurveys.verificationStatus, 'verified'),
      ),
    )

  const verifiedPlotIds = new Set(verified.map((v) => v.plotId))
  return activePlots.filter((p) => !verifiedPlotIds.has(p.id))
}

export async function rejectedCensusSurveys(farmId: string) {
  return db
    .select({
      id: cropCensusSurveys.id,
      plotId: cropCensusSurveys.plotId,
      plotName: plots.name,
      cropType: cropCensusSurveys.cropType,
      rejectionReason: cropCensusSurveys.rejectionReason,
      updatedAt: cropCensusSurveys.verifiedAt,
      createdAt: cropCensusSurveys.createdAt,
    })
    .from(cropCensusSurveys)
    .innerJoin(plots, eq(cropCensusSurveys.plotId, plots.id))
    .where(
      and(
        eq(cropCensusSurveys.farmId, farmId),
        eq(cropCensusSurveys.verificationStatus, 'rejected'),
      ),
    )
    .orderBy(desc(cropCensusSurveys.createdAt))
    .limit(50)
}

export async function pendingCensusVerification(farmId: string) {
  return db
    .select({
      id: cropCensusSurveys.id,
      plotName: plots.name,
      cropType: cropCensusSurveys.cropType,
      recordedByName: users.name,
      createdAt: cropCensusSurveys.createdAt,
    })
    .from(cropCensusSurveys)
    .innerJoin(plots, eq(cropCensusSurveys.plotId, plots.id))
    .leftJoin(users, eq(cropCensusSurveys.recordedById, users.id))
    .where(
      and(
        eq(cropCensusSurveys.farmId, farmId),
        eq(cropCensusSurveys.verificationStatus, 'reported'),
      ),
    )
    .orderBy(cropCensusSurveys.createdAt)
}

/** Active blocks whose newest verified census is older than `maxAgeDays`. */
export async function staleVerifiedCensus(farmId: string, maxAgeDays = 30) {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000)
  const activePlots = await db
    .select({ id: plots.id, name: plots.name })
    .from(plots)
    .where(and(eq(plots.farmId, farmId), eq(plots.active, true)))

  const verified = await db
    .select({
      plotId: cropCensusSurveys.plotId,
      surveyedAt: cropCensusSurveys.surveyedAt,
      createdAt: cropCensusSurveys.createdAt,
    })
    .from(cropCensusSurveys)
    .where(
      and(
        eq(cropCensusSurveys.farmId, farmId),
        eq(cropCensusSurveys.verificationStatus, 'verified'),
      ),
    )
    .orderBy(desc(cropCensusSurveys.surveyedAt), desc(cropCensusSurveys.createdAt))

  const latestByPlot = new Map<string, Date>()
  for (const row of verified) {
    if (latestByPlot.has(row.plotId)) continue
    latestByPlot.set(row.plotId, row.surveyedAt ?? row.createdAt)
  }

  return activePlots
    .filter((p) => {
      const latest = latestByPlot.get(p.id)
      return latest != null && latest.getTime() < cutoff.getTime()
    })
    .map((p) => ({
      id: p.id,
      name: p.name,
      lastVerifiedAt: latestByPlot.get(p.id)!,
    }))
}
