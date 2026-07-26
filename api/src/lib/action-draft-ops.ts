import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assetLogs, assets, plots, tasks } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canAssignTasks } from './rbac.js'
import { logAudit } from './audit.js'
import { createCensusSurvey } from './census-service.js'
import { resolvePlotByName } from './action-draft-farm.js'
import { matchByName, matchedRow } from './entity-name-match.js'
import { canonicalizeDraftPayload } from './draft-canonical.js'
import {
  contentLocaleValues,
  storeActionDraft,
  storeTaskDraft,
  type ContentLocaleMeta,
} from './task-drafts.js'

export {
  parseAssetCountIntent,
  parseCensusIntent,
  parseCreateTaskIntent,
} from './action-draft-ops-parse.js'

export async function executeConfirmedCreateTask(
  user: SessionUser,
  payload: Record<string, unknown>,
  source = 'butler',
  locale?: ContentLocaleMeta,
): Promise<string> {
  if (!canAssignTasks(user)) return 'Only Admin or Supervisor can create tasks.'
  const title = String(payload.title ?? '').trim()
  if (!title) return 'Draft was missing a title.'

  const plotId = typeof payload.plotId === 'string' ? payload.plotId : undefined
  const assignedToId = typeof payload.assignedToId === 'string' ? payload.assignedToId : undefined

  if (plotId) {
    const [plot] = await db
      .select({ id: plots.id })
      .from(plots)
      .where(and(eq(plots.id, plotId), eq(plots.farmId, user.farmId)))
      .limit(1)
    if (!plot) return 'Invalid plot on draft.'
  }

  const [task] = await db
    .insert(tasks)
    .values({
      farmId: user.farmId,
      title,
      description: typeof payload.description === 'string' ? payload.description : undefined,
      plotId: plotId ?? null,
      assignedToId: assignedToId ?? null,
      createdById: user.id,
      status: 'pending',
      actionType: typeof payload.actionType === 'string' ? payload.actionType : null,
      actionPayload:
        payload.actionPayload && typeof payload.actionPayload === 'object'
          ? (payload.actionPayload as Record<string, unknown>)
          : null,
      ...contentLocaleValues(locale),
    })
    .returning({ id: tasks.id, title: tasks.title })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'task',
    entityId: task.id,
    metadata: { source },
  })

  return `✅ Task created: ${task.title}`
}

export async function executeConfirmedCensus(
  user: SessionUser,
  payload: Record<string, unknown>,
  locale?: ContentLocaleMeta,
): Promise<string> {
  const plotId = String(payload.plotId ?? '')
  const cropType = String(payload.cropType ?? '').trim()
  const plantCount = Number(payload.plantCount)
  if (!plotId || !cropType || !Number.isFinite(plantCount)) {
    return 'Draft was missing census fields.'
  }

  await createCensusSurvey(user, {
    plotId,
    cropType,
    plantCount,
    minHeight: payload.minHeight != null ? Number(payload.minHeight) : null,
    maxHeight: payload.maxHeight != null ? Number(payload.maxHeight) : null,
    heightUnit: 'cm',
    ...locale,
  })

  return `✅ Census saved for ${payload.plotName ?? 'block'} · ${cropType} (${plantCount}). Awaiting verification.`
}

export async function executeConfirmedAssetCount(
  user: SessionUser,
  payload: Record<string, unknown>,
  source = 'butler',
): Promise<string> {
  const assetId = String(payload.assetId ?? '')
  const countAvailable = Number(payload.countAvailable)
  const countDamaged = Number(payload.countDamaged ?? 0)
  if (!assetId || !Number.isFinite(countAvailable)) {
    return 'Draft was missing asset count fields.'
  }

  const [asset] = await db
    .select({ id: assets.id, name: assets.name })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.farmId, user.farmId)))
    .limit(1)
  if (!asset) return 'Asset no longer found.'

  const [log] = await db
    .insert(assetLogs)
    .values({
      farmId: user.farmId,
      assetId: asset.id,
      logDate: new Date(),
      countAvailable,
      countDamaged: Number.isFinite(countDamaged) ? countDamaged : 0,
      condition: String(payload.condition ?? 'good'),
      recordedById: user.id,
      verificationStatus: 'reported',
    })
    .returning({ id: assetLogs.id })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'asset_log_create',
    entityType: 'asset_log',
    entityId: log.id,
    metadata: { source },
  })

  return `✅ Asset count saved for ${asset.name}: ${countAvailable} available. Awaiting verification.`
}

/**
 * The active asset a worker's words name, by name or by asset tag. Accents,
 * hyphens, case and spacing are folded at comparison time only — the row keeps
 * the farm's own spelling.
 */
export async function resolveAssetByQuery(
  farmId: string,
  query: string,
): Promise<{ id: string; name: string } | null> {
  const farmAssets = await db
    .select({
      id: assets.id,
      name: assets.name,
      assetTag: assets.assetTag,
    })
    .from(assets)
    .where(and(eq(assets.farmId, farmId), eq(assets.active, true)))

  const asset = matchedRow(matchByName(farmAssets, query, (a) => [a.name, a.assetTag]))
  return asset ? { id: asset.id, name: asset.name } : null
}

/** Prepare + store a create-task draft. Returns preview text or an error. */
export async function prepareCreateTaskDraft(params: {
  user: SessionUser
  title: string
  description?: string
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  if (!canAssignTasks(params.user)) {
    return { ok: false, error: 'Only Admin or Supervisor can create tasks.' }
  }
  const stored = await storeTaskDraft(
    params.user.id,
    params.user.farmId,
    { title: params.title, description: params.description },
    { channel: params.channel, externalChatId: params.externalChatId },
  )
  return {
    ok: true,
    draftId: stored.draftId,
    preview: [
      'Draft task ready:',
      `Title: ${params.title}`,
      params.description ? `Notes: ${params.description}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

/**
 * The census payload keys that must reach the row exactly as they are: two ids,
 * the block name the worker retypes to address the same plot, the crop lexicon
 * key the playbooks are matched on, and the height unit. Everything else the
 * payload carries counts as prose.
 */
const CENSUS_VERBATIM_FIELDS = ['plotId', 'plotName', 'cropType', 'heightUnit'] as const

export async function prepareCensusDraft(params: {
  user: SessionUser
  blockName: string
  cropType: string
  plantCount: number
  minHeight?: number
  maxHeight?: number
  channel: string
  externalChatId: string
  authorLocale?: string | null
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  const plot = await resolvePlotByName(params.user.farmId, params.blockName)
  if (!plot) {
    return {
      ok: false,
      error: `Block "${params.blockName}" not found. Use the exact block name from Zones.`,
    }
  }

  const { payload, locale } = await canonicalizeDraftPayload({
    farmId: params.user.farmId,
    authorLocale: params.authorLocale,
    verbatim: CENSUS_VERBATIM_FIELDS,
    payload: {
      plotId: plot.id,
      plotName: plot.name,
      cropType: params.cropType,
      plantCount: params.plantCount,
      minHeight: params.minHeight ?? null,
      maxHeight: params.maxHeight ?? null,
      heightUnit: 'cm',
    },
  })

  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'create_census',
    payload,
    channel: params.channel,
    externalChatId: params.externalChatId,
    ...locale,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      'Draft census ready:',
      `Block: ${plot.name}`,
      `Crop: ${params.cropType}`,
      `Count: ${params.plantCount}`,
      params.minHeight != null || params.maxHeight != null
        ? `Height: ${params.minHeight ?? '?'}–${params.maxHeight ?? '?'} cm`
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export async function prepareAssetCountDraft(params: {
  user: SessionUser
  assetQuery: string
  countAvailable: number
  countDamaged: number
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  const asset = await resolveAssetByQuery(params.user.farmId, params.assetQuery)
  if (!asset) {
    return {
      ok: false,
      error: `Asset "${params.assetQuery}" not found. Use the exact asset name or tag.`,
    }
  }

  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'asset_count',
    payload: {
      assetId: asset.id,
      assetName: asset.name,
      countAvailable: params.countAvailable,
      countDamaged: params.countDamaged,
      condition: params.countDamaged > 0 ? 'damaged' : 'good',
    },
    channel: params.channel,
    externalChatId: params.externalChatId,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      'Draft asset count ready:',
      `Asset: ${asset.name}`,
      `Available: ${params.countAvailable}`,
      `Damaged: ${params.countDamaged}`,
    ].join('\n'),
  }
}

/** Apply a confirmed ops draft (task / census / asset). Returns null if unknown type. */
export async function applyConfirmedOpsDraft(
  user: SessionUser,
  actionType: string,
  payload: Record<string, unknown>,
  source = 'butler',
  locale?: ContentLocaleMeta,
): Promise<string | null> {
  if (actionType === 'create_task') {
    return executeConfirmedCreateTask(user, payload, source, locale)
  }
  if (actionType === 'create_census') return executeConfirmedCensus(user, payload, locale)
  if (actionType === 'asset_count') return executeConfirmedAssetCount(user, payload, source)
  return null
}
