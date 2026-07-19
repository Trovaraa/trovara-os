import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { plots } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canAssignTasks } from './rbac.js'
import {
  enrichHarvestLot,
  findLotByCode,
  listIncompleteLots,
  verifyHarvestLot,
} from './harvest-lots.js'
import { normalizeLotUnit } from './lot-codes.js'
import {
  getLatestPendingDraft,
  mergeActionDraftPayload,
  storeActionDraft,
} from './task-drafts.js'

export type LotEnrichChannel = {
  channel: string
  externalChatId: string
}

export async function formatLotsToPackMessage(farmId: string): Promise<string> {
  const lots = await listIncompleteLots(farmId)
  if (!lots.length) {
    return 'No lots waiting for pack details. New customer orders create lots automatically.'
  }
  const lines = lots.map(
    (lot, i) =>
      `${i + 1}. ${lot.lotCode} — ${lot.productName} (${lot.quantityKg} ${lot.unit})` +
      `${lot.plotId ? '' : ' · needs plot'}${lot.photoUrl ? '' : ' · needs photo'}`,
  )
  return [
    'Lots to pack / enrich:',
    '',
    ...lines,
    '',
    'Reply: pack LOTCODE',
    'Then: qty 12 crates | plot BLOCKNAME | notes public text',
    'Send a photo to attach it, then Confirm (Telegram button / WhatsApp: CONFIRM).',
  ].join('\n')
}

export async function startLotEnrichDraft(
  user: SessionUser,
  lotCode: string,
  channel: LotEnrichChannel,
): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  const lot = await findLotByCode(user.farmId, lotCode.trim())
  if (!lot) return { ok: false, error: `Lot not found: ${lotCode}` }

  const stored = await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'enrich_lot',
    channel: channel.channel,
    externalChatId: channel.externalChatId,
    payload: {
      lotId: lot.id,
      lotCode: lot.lotCode,
      productName: lot.productName,
      quantityKg: lot.quantityKg,
      unit: lot.unit === 'crates' ? 'crates' : 'kg',
      plotId: lot.plotId,
      publicNotes: lot.publicNotes,
      internalNotes: lot.internalNotes,
      photoUrl: lot.photoUrl,
    },
    ttlMs: 20 * 60 * 1000,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      `Packing ${lot.lotCode}`,
      `Product: ${lot.productName}`,
      `Qty: ${lot.quantityKg} ${lot.unit}`,
      '',
      'Send updates:',
      '• qty 24 crates   (or qty 50 kg)',
      '• plot Block A',
      '• notes Fresh morning harvest',
      '• or send a photo',
      '',
      'Then Confirm to save.',
    ].join('\n'),
  }
}

export type LotEnrichApplyResult =
  | { handled: false }
  | { handled: true; reply: string; draftId: string }

/** Apply qty / plot / notes lines to the latest enrich_lot draft. */
export async function applyLotEnrichText(
  user: SessionUser,
  text: string,
): Promise<LotEnrichApplyResult> {
  const draft = await getLatestPendingDraft(user.id, 'enrich_lot')
  if (!draft) return { handled: false }

  const qtyMatch = text.match(/^qty\s+(\d+)\s*(kg|crates?|crate)?$/i)
  if (qtyMatch) {
    const quantityKg = Number(qtyMatch[1])
    const unit = normalizeLotUnit(qtyMatch[2] ?? (draft.payload.unit as string) ?? 'kg')
    await mergeActionDraftPayload(draft.id, user.id, { quantityKg, unit })
    return {
      handled: true,
      draftId: draft.id,
      reply: `Draft qty set to ${quantityKg} ${unit}. Confirm when ready.`,
    }
  }

  const plotMatch = text.match(/^plot\s+(.+)$/i)
  if (plotMatch) {
    const name = plotMatch[1].trim()
    const [plot] = await db
      .select({ id: plots.id, name: plots.name })
      .from(plots)
      .where(and(eq(plots.farmId, user.farmId), sql`lower(${plots.name}) = ${name.toLowerCase()}`))
      .limit(1)
    if (!plot) {
      return {
        handled: true,
        draftId: draft.id,
        reply: `No plot named "${name}". Try exact block name from Zones, or Create plot: … zone=…`,
      }
    }
    await mergeActionDraftPayload(draft.id, user.id, { plotId: plot.id })
    return {
      handled: true,
      draftId: draft.id,
      reply: `Draft plot set to ${plot.name}. Confirm when ready.`,
    }
  }

  const notesMatch = text.match(/^notes?\s+(.+)$/i)
  if (notesMatch) {
    await mergeActionDraftPayload(draft.id, user.id, { publicNotes: notesMatch[1].trim() })
    return {
      handled: true,
      draftId: draft.id,
      reply: 'Draft public notes saved. Confirm when ready.',
    }
  }

  return { handled: false }
}

export async function attachPhotoToLotEnrichDraft(
  user: SessionUser,
  photoDataUrl: string,
): Promise<{ ok: true; draftId: string } | { ok: false; error: string }> {
  const draft = await getLatestPendingDraft(user.id, 'enrich_lot')
  if (!draft) return { ok: false, error: 'no_draft' }
  await mergeActionDraftPayload(draft.id, user.id, { photoUrl: photoDataUrl })
  return { ok: true, draftId: draft.id }
}

export async function executeConfirmedEnrichLot(
  user: SessionUser,
  payload: Record<string, unknown>,
): Promise<string> {
  const lotId = typeof payload.lotId === 'string' ? payload.lotId : ''
  if (!lotId) return 'Draft is missing the lot id.'

  const result = await enrichHarvestLot({
    farmId: user.farmId,
    lotId,
    userId: user.id,
    updates: {
      productName: typeof payload.productName === 'string' ? payload.productName : undefined,
      quantityKg: payload.quantityKg != null ? Number(payload.quantityKg) : undefined,
      unit:
        payload.unit === 'crates' || payload.unit === 'kg'
          ? payload.unit
          : undefined,
      plotId:
        payload.plotId === null
          ? null
          : typeof payload.plotId === 'string'
            ? payload.plotId
            : undefined,
      publicNotes:
        payload.publicNotes === null
          ? null
          : typeof payload.publicNotes === 'string'
            ? payload.publicNotes
            : undefined,
      internalNotes: canAssignTasks(user)
        ? payload.internalNotes === null
          ? null
          : typeof payload.internalNotes === 'string'
            ? payload.internalNotes
            : undefined
        : undefined,
      photoUrl:
        payload.photoUrl === null
          ? null
          : typeof payload.photoUrl === 'string'
            ? payload.photoUrl
            : undefined,
    },
  })

  if ('error' in result) return result.error

  return (
    `Lot ${result.lot.lotCode} updated: ${result.lot.quantityKg} ${result.lot.unit}` +
    (result.lot.plotId ? ' · plot set' : '') +
    (result.lot.photoUrl ? ' · photo saved' : '') +
    '\nSupervisor can Verify it when ready.'
  )
}

/** Verify / reject: Verify LOT-… [note=…] | Reject LOT-… [note=…] */
export function parseVerifyLotIntent(text: string): {
  lotCode: string
  status: 'verified' | 'rejected'
  note?: string
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(verify|reject)\s+(\S+)(?:\s+notes?\s*=\s*(.+))?$/i,
  )
  if (!match) return null
  const status = match[1].toLowerCase() === 'reject' ? 'rejected' : 'verified'
  return {
    lotCode: match[2].trim(),
    status,
    note: match[3]?.trim(),
  }
}

export async function prepareVerifyLotDraft(params: {
  user: SessionUser
  lotCode: string
  status: 'verified' | 'rejected'
  note?: string
  channel: string
  externalChatId: string
}): Promise<{ ok: true; preview: string; draftId: string } | { ok: false; error: string }> {
  if (!canAssignTasks(params.user)) {
    return { ok: false, error: 'Only Admin or Supervisor can verify harvest lots.' }
  }
  const lot = await findLotByCode(params.user.farmId, params.lotCode.trim())
  if (!lot) return { ok: false, error: `Lot not found: ${params.lotCode}` }

  const stored = await storeActionDraft({
    userId: params.user.id,
    farmId: params.user.farmId,
    actionType: 'verify_lot',
    payload: {
      lotId: lot.id,
      lotCode: lot.lotCode,
      status: params.status,
      note: params.note ?? null,
    },
    channel: params.channel,
    externalChatId: params.externalChatId,
  })

  return {
    ok: true,
    draftId: stored.id,
    preview: [
      `Draft ${params.status === 'verified' ? 'verify' : 'reject'}:`,
      `${lot.lotCode} — ${lot.productName} (${lot.quantityKg} ${lot.unit})`,
      params.note ? `Note: ${params.note}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export async function executeConfirmedVerifyLot(
  user: SessionUser,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!canAssignTasks(user)) return 'Only Admin or Supervisor can verify harvest lots.'
  const lotId = String(payload.lotId ?? '')
  const status = payload.status === 'rejected' ? 'rejected' : 'verified'
  if (!lotId) return 'Draft was missing lot id.'

  const result = await verifyHarvestLot({
    farmId: user.farmId,
    lotId,
    userId: user.id,
    status,
    note: typeof payload.note === 'string' ? payload.note : null,
  })
  if ('error' in result) return result.error

  return status === 'verified'
    ? `✅ Lot ${result.lot.lotCode} verified — visible on public traceability.`
    : `Lot ${result.lot.lotCode} rejected.`
}

export async function applyConfirmedLotDraft(
  user: SessionUser,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (actionType === 'enrich_lot') return executeConfirmedEnrichLot(user, payload)
  if (actionType === 'verify_lot') return executeConfirmedVerifyLot(user, payload)
  return null
}
