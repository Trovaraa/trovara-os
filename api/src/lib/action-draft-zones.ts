import { and, eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { plots, zones } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canAssignTasks } from './rbac.js'
import { logAudit } from './audit.js'
import { storeActionDraft } from './task-drafts.js'
import { findByName } from './entity-name-match.js'

export {
  parseCreatePlotIntent,
  parseCreateZoneIntent,
} from './action-draft-zones-parse.js'

/**
 * The zone a worker's words name. Accents, hyphens, case and spacing are folded
 * at comparison time only — the row keeps the farm's own spelling.
 */
export async function resolveZoneByName(
  farmId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const farmZones = await db
    .select({ id: zones.id, name: zones.name })
    .from(zones)
    .where(eq(zones.farmId, farmId))
  return findByName(farmZones, name)
}

export async function executeConfirmedCreateZone(
  user: SessionUser,
  payload: Record<string, unknown>,
  source = 'butler',
): Promise<string> {
  if (!canAssignTasks(user)) return 'Only Admin or Supervisor can create zones.'
  const name = String(payload.name ?? '').trim()
  if (!name) return 'Draft was missing a zone name.'

  const [zone] = await db
    .insert(zones)
    .values({
      farmId: user.farmId,
      name,
      description: typeof payload.description === 'string' ? payload.description : undefined,
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'zone',
    entityId: zone.id,
    metadata: { source },
  })

  return `✅ Zone created: ${zone.name}`
}

export async function executeConfirmedCreatePlot(
  user: SessionUser,
  payload: Record<string, unknown>,
  source = 'butler',
): Promise<string> {
  if (!canAssignTasks(user)) return 'Only Admin or Supervisor can create plots.'
  const name = String(payload.name ?? '').trim()
  const zoneId = String(payload.zoneId ?? '')
  if (!name || !zoneId) return 'Draft was missing plot fields.'

  const [zone] = await db
    .select({ id: zones.id, name: zones.name })
    .from(zones)
    .where(and(eq(zones.id, zoneId), eq(zones.farmId, user.farmId)))
    .limit(1)
  if (!zone) return 'Invalid zone on draft.'

  const cropType =
    typeof payload.cropType === 'string' && payload.cropType.trim()
      ? payload.cropType.trim()
      : 'mixed'

  const [block] = await db
    .insert(plots)
    .values({
      farmId: user.farmId,
      zoneId: zone.id,
      name,
      cropType,
      active: true,
      updatedAt: new Date(),
    })
    .returning()

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'block',
    entityId: block.id,
    metadata: { source },
  })

  return `✅ Plot created: ${block.name} in ${zone.name}`
}

export async function prepareCreateZoneDraft(params: {
  user: SessionUser
  name: string
  description?: string
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  if (!canAssignTasks(params.user)) {
    return { ok: false, error: 'Only Admin or Supervisor can create zones.' }
  }

  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'create_zone',
    payload: {
      name: params.name,
      description: params.description ?? null,
    },
    channel: params.channel,
    externalChatId: params.externalChatId,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      'Draft zone ready:',
      `Name: ${params.name}`,
      params.description ? `Description: ${params.description}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export async function prepareCreatePlotDraft(params: {
  user: SessionUser
  name: string
  zoneName: string
  cropType?: string
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  if (!canAssignTasks(params.user)) {
    return { ok: false, error: 'Only Admin or Supervisor can create plots.' }
  }

  const zone = await resolveZoneByName(params.user.farmId, params.zoneName)
  if (!zone) {
    return {
      ok: false,
      error: `Zone "${params.zoneName}" not found. Use the exact zone name from Zones.`,
    }
  }

  const cropType = params.cropType?.trim() || 'mixed'

  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'create_plot',
    payload: {
      name: params.name,
      zoneId: zone.id,
      zoneName: zone.name,
      cropType,
    },
    channel: params.channel,
    externalChatId: params.externalChatId,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      'Draft plot ready:',
      `Name: ${params.name}`,
      `Zone: ${zone.name}`,
      `Crop: ${cropType}`,
    ].join('\n'),
  }
}

/** Apply a confirmed zone/plot draft. Returns null if unknown type. */
export async function applyConfirmedZoneDraft(
  user: SessionUser,
  actionType: string,
  payload: Record<string, unknown>,
  source = 'butler',
): Promise<string | null> {
  if (actionType === 'create_zone') return executeConfirmedCreateZone(user, payload, source)
  if (actionType === 'create_plot') return executeConfirmedCreatePlot(user, payload, source)
  return null
}
