import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { actionDrafts } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { canAssignTasks } from './rbac.js'
import { storeActionDraft } from './task-drafts.js'
import { toCanonicalEnglish } from './content-locale.js'
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
} from './reply-locale.js'
import { confirmCancelKeyboard, sendTelegramMessage } from './telegram.js'
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

const CREATE_PLOT_HINT = 'Create plot: Name zone=ZoneName'

function withCreatePlotHint(error: string): string {
  return /not found/i.test(error) ? `${error}\n\n${CREATE_PLOT_HINT}` : error
}

/**
 * A free-text field normalized for storage: `text` is what goes into the draft
 * payload (English once translated), `original` is what the worker wrote and is
 * what the confirmation preview echoes back to them.
 */
type CanonicalField = {
  text: string
  original: string
  /** Null when the language could not be established; see `toCanonicalEnglish`. */
  sourceLocale: string | null
  status: 'done' | 'pending'
}

type DraftLocaleMeta = {
  sourceLocale: string | null
  translationStatus: 'done' | 'pending'
}

/**
 * Normalize one author-written prose field to English for storage.
 * Only prose belongs here: plot, zone, batch, asset and product names plus lot
 * and order codes are matched by exact string elsewhere and must survive as-is.
 */
async function canonicalize(
  text: string | null | undefined,
  farmId: string,
  authorLocale?: string | null,
): Promise<CanonicalField | undefined> {
  const original = text?.trim()
  if (!original) return undefined
  const result = await toCanonicalEnglish({ text: original, farmId, sourceLocale: authorLocale })
  return {
    text: result.english,
    original,
    sourceLocale: result.sourceLocale,
    status: result.status,
  }
}

function localeMeta(fields: Array<CanonicalField | undefined>): DraftLocaleMeta | null {
  const present = fields.filter((f): f is CanonicalField => f != null)
  if (!present.length) return null
  const foreign = present.find((f) => f.sourceLocale !== 'en')
  return {
    sourceLocale: (foreign ?? present[0]).sourceLocale,
    translationStatus: present.some((f) => f.status === 'pending') ? 'pending' : 'done',
  }
}

/**
 * Record the author's language and whether the payload still holds source text,
 * so the retry job can find drafts whose prose is not English yet.
 * `storeActionDraft` does not take these columns, so they are set right after
 * the insert; failing to tag must never lose the draft the worker just made.
 */
async function tagDraftLocale(
  draftId: string,
  fields: Array<CanonicalField | undefined>,
): Promise<void> {
  const meta = localeMeta(fields)
  if (!meta) return
  if (meta.sourceLocale === 'en' && meta.translationStatus === 'done') return
  try {
    await db.update(actionDrafts).set(meta).where(eq(actionDrafts.id, draftId))
  } catch {
    /* ignore */
  }
}

/**
 * Previews are a reply to the worker, so they stay in the worker's language:
 * swap the English we stored back to the words they actually sent.
 */
function restoreAuthorText(
  preview: string,
  fields: Array<CanonicalField | undefined>,
): string {
  let out = preview
  for (const field of fields) {
    if (!field || field.text === field.original) continue
    out = out.split(field.text).join(field.original)
  }
  return out
}

type PreparedOffer =
  | { ok: true; preview: string; draftId: string }
  | { ok: false; error: string }

/** Shared prepare→error→confirm keyboard wrapper for Telegram offer drafts. */
async function sendPreparedOffer(
  chatId: number,
  prepared: PreparedOffer,
  opts?: {
    formatError?: (error: string) => string
    /** When false, send preview as-is (lot enrich). Default true. */
    confirmHint?: boolean
    /** Prose fields stored in English; the preview is restored from them. */
    canonical?: Array<CanonicalField | undefined>
  },
): Promise<void> {
  if (!prepared.ok) {
    const error = opts?.formatError ? opts.formatError(prepared.error) : prepared.error
    await sendTelegramMessage(chatId, error)
    return
  }
  const fields = opts?.canonical ?? []
  if (fields.length) await tagDraftLocale(prepared.draftId, fields)
  const preview = restoreAuthorText(prepared.preview, fields)
  const text =
    opts?.confirmHint === false ? preview : `${preview}\n\nTap Confirm or Cancel below.`
  await sendTelegramMessage(chatId, text, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

export async function offerCensusDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseCensusIntent>>,
  authorLocale?: string | null,
) {
  const prepared = await prepareCensusDraft({
    user,
    ...intent,
    cropType: normalizeCropType(intent.cropType).canonical,
    channel: 'telegram',
    externalChatId: String(chatId),
    authorLocale,
  })
  await sendPreparedOffer(chatId, prepared, { formatError: withCreatePlotHint })
}

export async function offerAssetCountDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseAssetCountIntent>>,
) {
  const prepared = await prepareAssetCountDraft({
    user,
    ...intent,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared)
}

export async function offerCropCycleDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseCropCycleIntent>>,
) {
  if (!canAssignTasks(user)) {
    await sendTelegramMessage(chatId, 'Only Admin or Supervisor can create crop cycles.')
    return
  }
  const plot = await resolvePlotByName(user.farmId, intent.plotName)
  if (!plot) {
    await sendTelegramMessage(
      chatId,
      withCreatePlotHint(`Block "${intent.plotName}" not found. Use the exact plot name from Zones.`),
    )
    return
  }

  // No prose to normalize: the plot name comes from Zones. The crop type is
  // exact-matched against the lifecycle and advisory playbook keys, so it goes
  // through the deterministic lexicon — a French or Yoruba crop name stored as
  // typed resolves to no playbook at all, and a translation of it may resolve to
  // no key either. Unknown crops still pass through as typed.
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
    channel: 'telegram',
    externalChatId: String(chatId),
  })

  await sendTelegramMessage(
    chatId,
    [
      'Draft crop cycle — confirm to save:',
      '',
      `Plot: ${plot.name}`,
      `Type: ${intent.cropType}`,
      `Planted: ${intent.plantedAt}`,
      intent.expectedHarvestAt ? `Harvest: ${intent.expectedHarvestAt}` : null,
      intent.expectedYieldKg != null ? `Yield: ${intent.expectedYieldKg} kg` : null,
      '',
      'Tap Confirm or Cancel below.',
    ]
      .filter(Boolean)
      .join('\n'),
    { replyMarkup: confirmCancelKeyboard(stored.id) },
  )
}

export async function offerLivestockBatchDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseLivestockBatchIntent>>,
  preferredLocale?: string | null,
) {
  if (!canAssignTasks(user)) {
    await sendTelegramMessage(chatId, 'Only Admin or Supervisor can create livestock batches.')
    return
  }

  let plotId: string | null = null
  let plotName: string | null = null
  if (intent.plotName) {
    const plot = await resolvePlotByName(user.farmId, intent.plotName)
    if (!plot) {
      await sendTelegramMessage(
        chatId,
        withCreatePlotHint(
          `Plot "${intent.plotName}" not found. Use the exact plot name from Zones, or omit plot=.`,
        ),
      )
      return
    }
    plotId = plot.id
    plotName = plot.name
  }

  // The species gates the vaccination schedule, the weight curve and the noiler
  // playbook by exact value, so it goes through the deterministic lexicon, never
  // the translator: a merely-correct translation ("meat chicken") would match
  // nothing and fail silently. The words the worker sent are kept alongside for
  // the preview and the confirmation reply, and the batch type is derived from
  // the species again at execution rather than carried here, where the two could
  // drift apart.
  const { species } = normalizeSpeciesForWrite(intent.species)
  const poultryType = resolvePoultryType(intent.species)

  const stored = await storeActionDraft({
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
    channel: 'telegram',
    externalChatId: String(chatId),
  })

  // No Confirm button until the type is answered: the batch would otherwise be
  // saved with the calendar left unset on words that said it was poultry.
  if (poultryType.status === 'unspecified') {
    await sendTelegramMessage(
      chatId,
      butlerPoultryTypeQuestion(
        resolveStaffReplyLocale(preferredLocale),
        intent.species,
        POULTRY_TYPE_OPTIONS.join(' | '),
      ),
    )
    return
  }

  await sendTelegramMessage(
    chatId,
    [
      'Draft livestock batch — confirm to save:',
      '',
      `Name: ${intent.name}`,
      `Species: ${intent.species}`,
      `Heads: ${intent.headCount}`,
      plotName ? `Plot: ${plotName}` : 'Plot: (none)',
      `Acquired: ${intent.acquiredAt}`,
      '',
      'Tap Confirm or Cancel below.',
    ].join('\n'),
    { replyMarkup: confirmCancelKeyboard(stored.id) },
  )
}

export async function tryApplyPoultryTypeAnswer(
  user: SessionUser,
  chatId: number,
  text: string,
  preferredLocale?: string | null,
): Promise<boolean> {
  const result = await applyPoultryTypeAnswer(user, text)
  if (!result.handled) return false
  const answered = butlerPoultryTypeSetMessage(
    resolveStaffReplyLocale(preferredLocale),
    result.batchType,
  )
  await sendTelegramMessage(chatId, `${answered}\n\nTap Confirm or Cancel below.`, {
    replyMarkup: confirmCancelKeyboard(result.draftId),
  })
  return true
}

export async function offerTaskDraft(
  user: SessionUser,
  chatId: number,
  title: string,
  description?: string,
  authorLocale?: string | null,
) {
  // Title and description are separate columns on tasks, so they are normalized
  // separately; Telegram intents only ever carry a title today.
  const canonicalTitle = await canonicalize(title, user.farmId, authorLocale)
  const canonicalDescription = await canonicalize(description, user.farmId, authorLocale)
  const prepared = await prepareCreateTaskDraft({
    user,
    title: canonicalTitle?.text ?? title,
    description: canonicalDescription?.text ?? description,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared, {
    canonical: [canonicalTitle, canonicalDescription],
  })
}

export async function offerLotEnrichDraft(user: SessionUser, chatId: number, lotCode: string) {
  const prepared = await startLotEnrichDraft(user, lotCode, {
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared, { confirmHint: false })
}

/** `notes <text>` on a lot draft becomes public traceability text, so it is stored in English. */
const LOT_NOTES_LINE = /^(notes?\s+)(.+)$/i

export async function tryApplyLotEnrichText(
  user: SessionUser,
  chatId: number,
  text: string,
  authorLocale?: string | null,
): Promise<boolean> {
  const notes = text.trim().match(LOT_NOTES_LINE)
  const canonicalNotes = notes
    ? await canonicalize(notes[2], user.farmId, authorLocale)
    : undefined

  const result = await applyLotEnrichText(
    user,
    canonicalNotes && notes ? `${notes[1]}${canonicalNotes.text}` : text,
  )
  if (!result.handled) return false
  await tagDraftLocale(result.draftId, [canonicalNotes])
  await sendTelegramMessage(chatId, restoreAuthorText(result.reply, [canonicalNotes]), {
    replyMarkup: confirmCancelKeyboard(result.draftId),
  })
  return true
}

export async function offerStockMoveDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseStockMoveIntent>>,
  authorLocale?: string | null,
) {
  const reason = await canonicalize(intent.reason, user.farmId, authorLocale)
  const prepared = await prepareStockMoveDraft({
    user,
    ...intent,
    reason: reason?.text ?? intent.reason,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared, { canonical: [reason] })
}

export async function offerOpeningCountDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseOpeningCountIntent>>,
) {
  const prepared = await prepareOpeningCountDraft({
    user,
    ...intent,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared)
}

export async function offerLowStockAckDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseLowStockAckIntent>>,
) {
  const prepared = await prepareLowStockAckDraft({
    user,
    itemQuery: intent.itemQuery,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared)
}

export async function offerCreateZoneDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseCreateZoneIntent>>,
  authorLocale?: string | null,
) {
  // The zone name is matched by exact string when parsing later intents; only
  // the description is prose.
  const description = await canonicalize(intent.description, user.farmId, authorLocale)
  const prepared = await prepareCreateZoneDraft({
    user,
    ...intent,
    description: description?.text ?? intent.description,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared, { canonical: [description] })
}

export async function offerCreatePlotDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseCreatePlotIntent>>,
) {
  const prepared = await prepareCreatePlotDraft({
    user,
    ...intent,
    cropType: intent.cropType ? normalizeCropType(intent.cropType).canonical : intent.cropType,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared)
}

export async function offerLivestockLogDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseLivestockLogIntent>>,
  authorLocale?: string | null,
) {
  const notes = await canonicalize(intent.notes, user.farmId, authorLocale)
  const prepared = await prepareLivestockLogDraft({
    user,
    ...intent,
    notes: notes?.text ?? intent.notes,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared, { canonical: [notes] })
}

export async function offerVerifyLotDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseVerifyLotIntent>>,
  authorLocale?: string | null,
) {
  const note = await canonicalize(intent.note, user.farmId, authorLocale)
  const prepared = await prepareVerifyLotDraft({
    user,
    ...intent,
    note: note?.text ?? intent.note,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  await sendPreparedOffer(chatId, prepared, { canonical: [note] })
}
