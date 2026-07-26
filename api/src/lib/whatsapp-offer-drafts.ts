import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { actionDrafts } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canAssignTasks } from './rbac.js'
import { storeActionDraft } from './task-drafts.js'
import { sendWhatsAppText } from './whatsapp-meta.js'
import { toCanonicalEnglish, type TranslationOutcome } from './content-locale.js'
import { normalizeCropType } from './crop-normalize.js'
import {
  normalizeSpeciesForWrite,
  resolvePoultryType,
  POULTRY_TYPE_OPTIONS,
} from './species-normalize.js'
import {
  butlerPoultryTypeQuestion,
  butlerPoultryTypeSetMessage,
  resolveStaffReplyLocale,
  type ReplyLocale,
} from './reply-locale.js'
import {
  applyPoultryTypeAnswer,
  parseCropCycleIntent,
  parseLivestockBatchIntent,
  resolvePlotByName,
} from './action-draft-farm.js'
import {
  parseAssetCountIntent,
  parseCensusIntent,
  prepareAssetCountDraft,
  prepareCensusDraft,
  prepareCreateTaskDraft,
} from './action-draft-ops.js'
import {
  parseLowStockAckIntent,
  parseOpeningCountIntent,
  parseStockMoveIntent,
  prepareLowStockAckDraft,
  prepareOpeningCountDraft,
  prepareStockMoveDraft,
} from './action-draft-inventory.js'
import {
  parseCreatePlotIntent,
  parseCreateZoneIntent,
  prepareCreatePlotDraft,
  prepareCreateZoneDraft,
} from './action-draft-zones.js'
import {
  parseLivestockLogIntent,
  prepareLivestockLogDraft,
} from './action-draft-livestock-log.js'
import {
  applyLotEnrichText,
  parseVerifyLotIntent,
  prepareVerifyLotDraft,
  startLotEnrichDraft,
} from './lot-enrich.js'

export const WA_CONFIRM_HINT = 'Reply CONFIRM to save, or CANCEL.'
const CREATE_PLOT_HINT = 'Create plot: Name zone=ZoneName'

function withCreatePlotHint(error: string): string {
  return /not found/i.test(error) ? `${error}\n\n${CREATE_PLOT_HINT}` : error
}

/**
 * Worker prose in both languages: `english` is what the draft payload stores,
 * `original` is restored into the preview the worker reads back.
 */
type AuthorText = {
  english: string
  original: string
  /** Null when the language could not be established; see `toCanonicalEnglish`. */
  sourceLocale: ReplyLocale | null
  status: TranslationOutcome
}

/**
 * Draft creation is the single normalization point for the WhatsApp channel:
 * payloads reach `action_drafts` already in English, so confirmation writes real
 * rows without translating anything a second time.
 */
async function authorText(
  user: SessionUser,
  text: string,
  authorLocale?: string | null,
): Promise<AuthorText> {
  const result = await toCanonicalEnglish({
    text,
    farmId: user.farmId,
    sourceLocale: authorLocale,
  })
  return {
    english: result.english,
    original: text,
    sourceLocale: result.sourceLocale,
    status: result.status,
  }
}

async function optionalAuthorText(
  user: SessionUser,
  text: string | null | undefined,
  authorLocale?: string | null,
): Promise<AuthorText | undefined> {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return undefined
  return authorText(user, trimmed, authorLocale)
}

/** Show the worker the words they wrote, not the English we stored. */
function inAuthorLanguage(text: string, authored: readonly AuthorText[]): string {
  let out = text
  for (const field of authored) {
    if (field.english === field.original) continue
    out = out.replaceAll(field.english, field.original)
  }
  return out
}

/**
 * Persist how the payload was normalized. `translationStatus: 'pending'` means
 * the payload still holds the author's own words and the retry job must replace
 * them; a failure here must never fail the draft the worker just created.
 */
async function recordDraftTranslation(
  draftId: string,
  authored: readonly AuthorText[],
): Promise<void> {
  const translated = authored.filter((field) => field.sourceLocale !== 'en')
  if (translated.length === 0) return
  try {
    await db
      .update(actionDrafts)
      .set({
        sourceLocale: translated[0]!.sourceLocale,
        translationStatus: translated.some((field) => field.status === 'pending')
          ? 'pending'
          : 'done',
      })
      .where(eq(actionDrafts.id, draftId))
  } catch {
    /* ignore */
  }
}

type PreparedOffer =
  | { ok: true; preview: string; draftId: string }
  | { ok: false; error: string }

/** Shared prepare→error→confirm-hint wrapper for WhatsApp offer drafts. */
async function sendPreparedOffer(
  phone: string,
  prepared: PreparedOffer,
  opts?: {
    formatError?: (error: string) => string
    authored?: readonly (AuthorText | undefined)[]
  },
): Promise<void> {
  if (!prepared.ok) {
    const error = opts?.formatError ? opts.formatError(prepared.error) : prepared.error
    await sendWhatsAppText(phone, error).catch(() => undefined)
    return
  }
  const authored = (opts?.authored ?? []).filter((field): field is AuthorText => !!field)
  await recordDraftTranslation(prepared.draftId, authored)
  await sendWhatsAppText(
    phone,
    `${inAuthorLanguage(prepared.preview, authored)}\n\n${WA_CONFIRM_HINT}`,
  ).catch(() => undefined)
}

export async function offerTaskDraft(
  user: SessionUser,
  phone: string,
  title: string,
  authorLocale?: string | null,
) {
  const authoredTitle = await authorText(user, title, authorLocale)
  const prepared = await prepareCreateTaskDraft({
    user,
    title: authoredTitle.english,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared, { authored: [authoredTitle] })
}

export async function offerCensusDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseCensusIntent>>,
  authorLocale?: string | null,
) {
  const prepared = await prepareCensusDraft({
    user,
    ...intent,
    cropType: normalizeCropType(intent.cropType).canonical,
    channel: 'whatsapp',
    externalChatId: phone,
    authorLocale,
  })
  await sendPreparedOffer(phone, prepared, { formatError: withCreatePlotHint })
}

export async function offerAssetCountDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseAssetCountIntent>>,
) {
  const prepared = await prepareAssetCountDraft({
    user,
    ...intent,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared)
}

export async function offerCropCycleDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseCropCycleIntent>>,
  /** Kept for the shared inbound call shape; the crop type is a key, not prose. */
  _authorLocale?: string | null,
) {
  if (!canAssignTasks(user)) {
    await sendWhatsAppText(phone, 'Only Admin or Supervisor can create crop cycles.').catch(
      () => undefined,
    )
    return
  }
  const plot = await resolvePlotByName(user.farmId, intent.plotName)
  if (!plot) {
    await sendWhatsAppText(
      phone,
      withCreatePlotHint(
        `Block "${intent.plotName}" not found. Use the exact plot name from Zones.`,
      ),
    ).catch(() => undefined)
    return
  }
  // The crop type is exact-matched against the lifecycle and advisory playbook
  // keys, so it goes through the lexicon, never the translator: a merely-correct
  // translation ("coconut palm") would match no key and fail silently.
  const stored = await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'create_crop_cycle',
    payload: {
      plotId: plot.id,
      plotName: plot.name,
      cropType: normalizeCropType(intent.cropType).canonical,
      plantedAt: new Date(intent.plantedAt).toISOString(),
      expectedHarvestAt: intent.expectedHarvestAt
        ? new Date(intent.expectedHarvestAt).toISOString()
        : null,
      expectedYieldKg: intent.expectedYieldKg ?? null,
    },
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendWhatsAppText(
    phone,
    [
      'Draft crop cycle ready:',
      `${intent.cropType} on ${plot.name}, planted ${intent.plantedAt}`,
      '',
      WA_CONFIRM_HINT,
    ].join('\n'),
  ).catch(() => undefined)
}

export async function offerLivestockBatchDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseLivestockBatchIntent>>,
  preferredLocale?: string | null,
) {
  if (!canAssignTasks(user)) {
    await sendWhatsAppText(phone, 'Only Admin or Supervisor can create livestock batches.').catch(
      () => undefined,
    )
    return
  }
  let plotId: string | null = null
  let plotName: string | null = null
  if (intent.plotName) {
    const plot = await resolvePlotByName(user.farmId, intent.plotName)
    if (!plot) {
      await sendWhatsAppText(
        phone,
        withCreatePlotHint(
          `Plot "${intent.plotName}" not found. Omit plot= or use exact name.`,
        ),
      ).catch(() => undefined)
      return
    }
    plotId = plot.id
    plotName = plot.name
  }
  // Same rule as the crop type: the species is exact-matched against the poultry
  // playbook and the vaccination schedule, so it goes through the lexicon rather
  // than the translator. `speciesTyped` keeps the worker's own words for the
  // reply after confirm; the batch type is derived from the species again at
  // execution rather than carried here, where the two could drift apart.
  const { species } = normalizeSpeciesForWrite(intent.species)
  const poultryType = resolvePoultryType(intent.species)
  await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'create_livestock_batch',
    payload: {
      name: intent.name,
      species,
      speciesTyped: intent.species,
      headCount: intent.headCount,
      plotId,
      plotName,
      acquiredAt: new Date(intent.acquiredAt).toISOString(),
      awaitingBatchType: poultryType.status === 'unspecified',
    },
    channel: 'whatsapp',
    externalChatId: phone,
  })
  // No confirm hint until the type is answered: the batch would otherwise be
  // saved with the calendar left unset on words that said it was poultry.
  if (poultryType.status === 'unspecified') {
    await sendWhatsAppText(
      phone,
      butlerPoultryTypeQuestion(
        resolveStaffReplyLocale(preferredLocale),
        intent.species,
        POULTRY_TYPE_OPTIONS.join(' | '),
      ),
    ).catch(() => undefined)
    return
  }
  await sendWhatsAppText(
    phone,
    [
      'Draft livestock batch ready:',
      `${intent.name} · ${intent.species} · ${intent.headCount} head`,
      '',
      WA_CONFIRM_HINT,
    ].join('\n'),
  ).catch(() => undefined)
}

export async function tryApplyPoultryTypeAnswer(
  user: SessionUser,
  phone: string,
  text: string,
  preferredLocale?: string | null,
): Promise<boolean> {
  const result = await applyPoultryTypeAnswer(user, text)
  if (!result.handled) return false
  const answered = butlerPoultryTypeSetMessage(
    resolveStaffReplyLocale(preferredLocale),
    result.batchType,
  )
  await sendWhatsAppText(phone, `${answered}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
  return true
}

export async function offerStockMoveDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseStockMoveIntent>>,
  authorLocale?: string | null,
) {
  const authoredReason = await authorText(user, intent.reason, authorLocale)
  const prepared = await prepareStockMoveDraft({
    user,
    ...intent,
    reason: authoredReason.english,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared, { authored: [authoredReason] })
}

export async function offerOpeningCountDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseOpeningCountIntent>>,
) {
  const prepared = await prepareOpeningCountDraft({
    user,
    ...intent,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared)
}

export async function offerLowStockAckDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseLowStockAckIntent>>,
) {
  const prepared = await prepareLowStockAckDraft({
    user,
    itemQuery: intent.itemQuery,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared)
}

export async function offerCreateZoneDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseCreateZoneIntent>>,
  authorLocale?: string | null,
) {
  // Zone name is matched by exact string elsewhere; only the description is prose.
  const authoredDescription = await optionalAuthorText(user, intent.description, authorLocale)
  const prepared = await prepareCreateZoneDraft({
    user,
    ...intent,
    description: authoredDescription?.english,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared, { authored: [authoredDescription] })
}

export async function offerCreatePlotDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseCreatePlotIntent>>,
  /** Kept for the shared inbound call shape; the crop type is a key, not prose. */
  _authorLocale?: string | null,
) {
  // Plot and zone names must stay verbatim so intent parsing keeps resolving them,
  // and the crop type is normalized by lexicon rather than translated.
  const prepared = await prepareCreatePlotDraft({
    user,
    ...intent,
    cropType: intent.cropType ? normalizeCropType(intent.cropType).canonical : intent.cropType,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared)
}

export async function offerLivestockLogDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseLivestockLogIntent>>,
  authorLocale?: string | null,
) {
  const authoredNotes = await optionalAuthorText(user, intent.notes, authorLocale)
  const prepared = await prepareLivestockLogDraft({
    user,
    ...intent,
    notes: authoredNotes?.english,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared, { authored: [authoredNotes] })
}

export async function offerLotEnrichDraft(user: SessionUser, phone: string, lotCode: string) {
  const prepared = await startLotEnrichDraft(user, lotCode, {
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared)
}

export async function tryApplyLotEnrichText(
  user: SessionUser,
  phone: string,
  text: string,
  authorLocale?: string | null,
): Promise<boolean> {
  // "qty …" and "plot …" carry quantities and plot names — forward them verbatim.
  const notesMatch = text.match(/^(notes?)\s+(.+)$/i)
  const authoredNotes = notesMatch
    ? await authorText(user, notesMatch[2]!.trim(), authorLocale)
    : undefined
  const result = await applyLotEnrichText(
    user,
    authoredNotes ? `${notesMatch![1]} ${authoredNotes.english}` : text,
  )
  if (!result.handled) return false
  if (authoredNotes) await recordDraftTranslation(result.draftId, [authoredNotes])
  await sendWhatsAppText(phone, `${result.reply}\n\n${WA_CONFIRM_HINT}`).catch(() => undefined)
  return true
}

export async function offerVerifyLotDraft(
  user: SessionUser,
  phone: string,
  intent: NonNullable<ReturnType<typeof parseVerifyLotIntent>>,
  authorLocale?: string | null,
) {
  const authoredNote = await optionalAuthorText(user, intent.note, authorLocale)
  const prepared = await prepareVerifyLotDraft({
    user,
    ...intent,
    note: authoredNote?.english,
    channel: 'whatsapp',
    externalChatId: phone,
  })
  await sendPreparedOffer(phone, prepared, { authored: [authoredNote] })
}
