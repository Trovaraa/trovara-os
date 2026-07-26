import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { actionDrafts, plots } from '../db/schema.js'
import { findByName } from './entity-name-match.js'
import type { SessionUser } from './session.js'
import { canAssignTasks } from './rbac.js'
import {
  authorLocaleForUser,
  enrichHarvestLot,
  findLotByCode,
  listIncompleteLots,
  verifyHarvestLot,
} from './harvest-lots.js'
import { normalizeLotUnit } from './lot-codes.js'
import { toCanonicalEnglish } from './content-locale.js'
import { resolveStaffReplyLocale } from './reply-locale.js'
import {
  getLatestPendingDraft,
  mergeActionDraftPayload,
  mergeContentLocale,
  storeActionDraft,
  type ContentLocaleMeta,
  type StoredActionDraft,
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

export type LotEnrichTextOptions = {
  /** The author's `preferred_locale`; read from their profile when omitted. */
  authorLocale?: string | null
  /**
   * Set by a caller that already normalized the notes line to English and tagged
   * the draft itself (the chat channels do this as they parse the message), so
   * the same text is not sent through the translator twice.
   */
  canonical?: boolean
}

type CanonicalNotes = { english: string; locale: ContentLocaleMeta }

/**
 * Normalize a `notes …` line to English before it reaches the draft payload.
 *
 * The draft is the last place this text is still separable from the lot row it
 * becomes, and `harvest_lots.public_notes` is rendered on a public traceability
 * URL, so storing the author's language here is externally visible and not just
 * an audit-trail problem. A degraded translator yields the author's own words
 * with status 'pending' rather than failing the message they just sent.
 */
async function canonicalNotes(
  user: SessionUser,
  text: string,
  opts?: LotEnrichTextOptions,
): Promise<CanonicalNotes> {
  const hint =
    opts?.authorLocale === undefined
      ? await authorLocaleForUser(user.id)
      : resolveStaffReplyLocale(opts.authorLocale) === 'en'
        ? null
        : resolveStaffReplyLocale(opts.authorLocale)

  try {
    const result = await toCanonicalEnglish({
      text,
      farmId: user.farmId,
      sourceLocale: hint,
    })
    return {
      english: result.english,
      locale: { sourceLocale: result.sourceLocale, translationStatus: result.status },
    }
  } catch {
    return { english: text, locale: { sourceLocale: hint, translationStatus: 'pending' } }
  }
}

/**
 * Record on the draft row how its payload was normalized, so the confirm path
 * and the retry job both know the payload may still hold the author's words.
 * Best-effort and escalate-only: it never fails the worker's message, and never
 * overwrites bookkeeping the retry job already owns.
 */
async function tagDraftLocale(
  draft: StoredActionDraft,
  locale: ContentLocaleMeta,
): Promise<void> {
  const values = mergeContentLocale(
    { sourceLocale: draft.sourceLocale, translationStatus: draft.translationStatus },
    locale,
  )
  if (Object.keys(values).length === 0) return
  try {
    await db.update(actionDrafts).set(values).where(eq(actionDrafts.id, draft.id))
  } catch {
    /* ignore */
  }
}

/** Apply qty / plot / notes lines to the latest enrich_lot draft. */
export async function applyLotEnrichText(
  user: SessionUser,
  text: string,
  opts?: LotEnrichTextOptions,
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
    // Folded in JS rather than `lower()` in SQL: the worker types "Bloc Nord"
    // for a plot stored as "Bloc-Nord". Every plot on the farm stays a
    // candidate here, including retired ones, because a lot can be packed from
    // a block that has since been closed.
    const farmPlots = await db
      .select({ id: plots.id, name: plots.name })
      .from(plots)
      .where(eq(plots.farmId, user.farmId))
    const plot = findByName(farmPlots, name)
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

  // `qty` carries a number and a unit and `plot` carries a block name matched by
  // exact string, so only the notes line is prose.
  const notesMatch = text.match(/^notes?\s+(.+)$/i)
  if (notesMatch) {
    const notes = notesMatch[1].trim()
    if (opts?.canonical) {
      await mergeActionDraftPayload(draft.id, user.id, { publicNotes: notes })
    } else {
      const canonical = await canonicalNotes(user, notes, opts)
      await mergeActionDraftPayload(draft.id, user.id, { publicNotes: canonical.english })
      await tagDraftLocale(draft, canonical.locale)
    }
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
  /**
   * How the draft payload was normalized (`draftContentLocale(draft)`). Without
   * it the notes are normalized again as they are written, because a payload the
   * translator could not convert would otherwise land in `harvest_lots`
   * claiming to be English, and the retry job only sweeps unfinished rows.
   */
  locale?: ContentLocaleMeta,
): Promise<string> {
  const lotId = typeof payload.lotId === 'string' ? payload.lotId : ''
  if (!lotId) return 'Draft is missing the lot id.'

  const result = await enrichHarvestLot({
    farmId: user.farmId,
    lotId,
    userId: user.id,
    contentLocale: locale,
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
  /** How the draft note was normalized (`draftContentLocale(draft)`). */
  locale?: ContentLocaleMeta,
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
    contentLocale: locale,
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
  /** How the draft's free text was normalized (`draftContentLocale(draft)`). */
  locale?: ContentLocaleMeta,
): Promise<string | null> {
  if (actionType === 'enrich_lot') return executeConfirmedEnrichLot(user, payload, locale)
  if (actionType === 'verify_lot') return executeConfirmedVerifyLot(user, payload, locale)
  return null
}
