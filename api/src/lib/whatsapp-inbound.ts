import { sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { users } from '../db/schema.js'
import type { SessionUser } from './session.js'
import {
  downloadWhatsAppMedia,
  downloadWhatsAppMediaBuffer,
  sendWhatsAppImage,
  sendWhatsAppText,
} from './whatsapp-meta.js'
import {
  buildLotQrPng,
  findPrintableLotByCode,
  listRecentPrintableLots,
} from './lot-print.js'
import { answerPhoto, answerText, recordChatMessage, transcribeVoice } from './butler-core.js'
import { checkButlerRateLimit } from './butler-rate-limit.js'
import { deliverButlerReply } from './butler-reply.js'
import { looksUrgent, notifyWorkerAlertChannels } from './farm-notify.js'
import { voiceNotUnderstoodMessage } from './reply-locale.js'
import { canManageOrders } from './rbac.js'
import {
  setUserPreferredLocale,
  tryHandleStaffOrderCommand,
} from './order-fulfillment.js'
import {
  languagePromptMessage,
  languageSavedMessage,
  orderCommandHelp,
  staffLocale,
  type StaffLocale,
} from './order-messages.js'
import { markLanguagePrompted, shouldPromptLanguage } from './language-prompt.js'
import { tryHandleStaffOpsCommand } from './staff-ops.js'
import type { ContentLocaleMeta } from './task-drafts.js'
import { roleCommandHelp } from './role-menus.js'
import {
  parseCropCycleIntent,
  parseLivestockBatchIntent,
} from './action-draft-farm.js'
import {
  parseAssetCountIntent,
  parseCensusIntent,
  parseCreateTaskIntent,
} from './action-draft-ops.js'
import {
  parseLowStockAckIntent,
  parseOpeningCountIntent,
  parseStockMoveIntent,
} from './action-draft-inventory.js'
import {
  parseCreatePlotIntent,
  parseCreateZoneIntent,
} from './action-draft-zones.js'
import { parseLivestockLogIntent } from './action-draft-livestock-log.js'
import {
  attachPhotoToLotEnrichDraft,
  formatLotsToPackMessage,
  parseVerifyLotIntent,
} from './lot-enrich.js'
import { formatHandoverProgressText, getHandoverProgress } from './handover-templates.js'
import { processEvidenceValue } from './evidence-store.js'
import type { PreferredLocale } from '../db/schema.js'
import {
  authorLocaleHint,
  toCanonicalEnglish,
  type CanonicalResult,
} from './content-locale.js'
import { draftConfirmHint, tryHandleWhatsAppDraftConfirm } from './whatsapp-draft-confirm.js'
import {
  offerAssetCountDraft,
  offerCensusDraft,
  offerCreatePlotDraft,
  offerCreateZoneDraft,
  offerCropCycleDraft,
  offerLivestockBatchDraft,
  offerLivestockLogDraft,
  offerLotEnrichDraft,
  offerLowStockAckDraft,
  offerOpeningCountDraft,
  offerStockMoveDraft,
  offerTaskDraft,
  offerVerifyLotDraft,
  tryApplyLotEnrichText,
  tryApplyPoultryTypeAnswer,
} from './whatsapp-offer-drafts.js'
import {
  claimInboundWhatsAppMessage,
  completeInboundWhatsAppMessage,
  failInboundWhatsAppMessage,
} from './whatsapp-message-claim.js'

const ENTITY = 'whatsapp_message'
const BUTLER_RATE_LIMIT_MSG = 'You have reached the hourly Butler limit. Please try again later.'

function flattenPickerReply(reply: string, replyMarkup?: Record<string, unknown>): string {
  if (!replyMarkup || typeof replyMarkup !== 'object') return reply
  const kb = replyMarkup as {
    inline_keyboard?: Array<Array<{ text?: string }>>
  }
  const lines = (kb.inline_keyboard ?? []).flat().map((b) => b.text).filter(Boolean)
  if (!lines.length) return reply
  return `${reply}\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n\nReply with the command + id, e.g. /done TSK-ABCDEF`
}

/**
 * Chat-log metadata for worker text stored as canonical English. A 'pending'
 * status means the LLM was unavailable and `text` is still the author's own
 * words, so the retry job can replace it later.
 */
function translationMeta(canonical: CanonicalResult, original: string) {
  return {
    sourceLocale: canonical.sourceLocale,
    translationStatus: canonical.status,
    ...(canonical.english === original ? {} : { originalText: original }),
  }
}

function voicePrefix(
  opts: { inboundWasVoice?: boolean } | undefined,
  originalText: string,
  reply: string,
): string {
  return opts?.inboundWasVoice ? `🗣️ "${originalText}"\n\n${reply}` : reply
}

const OPS_NOTE =
  /^\/?(?:start|begin|taskstart|done|complete|finish|approve|reject)\s+\S+\s+(.+)$/i

type OpsNotePrep = {
  text: string
  restoreReply: (reply: string) => string
  noteLocale?: ContentLocaleMeta
}

/**
 * Task transition commands persist the trailing note on the task row, so it is
 * swapped for English first. Keywords and the task reference stay as typed; the
 * WhatsApp reply swaps the English back for the worker's own words.
 */
async function withEnglishOpsNote(
  text: string,
  farmId: string,
  sourceLocale?: string | null,
): Promise<OpsNotePrep> {
  const identity: OpsNotePrep = { text, restoreReply: (reply: string) => reply }
  const trimmed = text.trim()
  const note = trimmed.match(OPS_NOTE)?.[1]
  if (!note) return identity

  const canonical = await toCanonicalEnglish({ text: note, farmId, sourceLocale })
  const noteLocale: ContentLocaleMeta = {
    sourceLocale: canonical.sourceLocale,
    translationStatus: canonical.status,
  }
  if (canonical.english === note) return { ...identity, noteLocale }

  return {
    text: `${trimmed.slice(0, trimmed.length - note.length)}${canonical.english}`,
    restoreReply: (reply) => reply.split(canonical.english).join(note),
    noteLocale,
  }
}

type InboundMessage = {
  from: string
  id: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type?: string; caption?: string }
  audio?: { id: string; mime_type?: string; voice?: boolean }
}

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
}

type DbUser = typeof users.$inferSelect

async function findUserByPhone(phone: string): Promise<DbUser | undefined> {
  const normalized = normalizePhone(phone)
  const allWithPhone = await db
    .select()
    .from(users)
    .where(sql`${users.phone} IS NOT NULL AND ${users.phone} <> '' AND ${users.active} = true`)

  return allWithPhone.find((u) => normalizePhone(u.phone ?? '') === normalized)
}

function toSessionUser(u: DbUser): SessionUser {
  return {
    id: u.id,
    farmId: u.farmId,
    email: u.email,
    name: u.name,
    role: u.role,
    mustChangePassword: u.mustChangePassword,
  }
}

function toActor(u: DbUser) {
  return {
    id: u.id,
    farmId: u.farmId,
    role: u.role,
    name: u.name,
    preferredLocale: u.preferredLocale,
  }
}

/** WhatsApp has no buttons, so the choices are spelled out in the text. */
function languagePromptText(locale: StaffLocale): string {
  return `${languagePromptMessage(locale)}\n\nReply: lang en | lang yo | lang pcm | lang fr`
}

const LANG_SET_PATTERN = /^lang(?:uage)?\s+(en|yo|pcm|fr)$/i

function isLanguageCommand(text: string): boolean {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  return lower === 'language' || lower === '/language' || LANG_SET_PATTERN.test(trimmed)
}

async function handleText(
  dbUser: DbUser,
  msg: InboundMessage,
  text: string,
  opts?: {
    inboundWasVoice?: boolean
    alreadyLogged?: boolean
    /** Reuse of an already-computed normalization (voice notes) — never translate twice. */
    canonical?: CanonicalResult
  },
): Promise<void> {
  const phone = normalizePhone(msg.from)

  if (!checkButlerRateLimit(dbUser.id)) {
    await sendWhatsAppText(phone, BUTLER_RATE_LIMIT_MSG).catch(() => undefined)
    return
  }

  await handleTextInner(dbUser, msg, text, opts)

  // After their message is dealt with, not before: someone reporting a dead bird
  // gets an answer first, and the nudge is the second message rather than a
  // gate. Skipped when they are already in the language flow.
  if (!isLanguageCommand(text) && shouldPromptLanguage(dbUser)) {
    await sendWhatsAppText(phone, languagePromptText(staffLocale(dbUser.preferredLocale))).catch(
      () => undefined,
    )
    await markLanguagePrompted(dbUser.id)
  }
}

async function handleTextInner(
  dbUser: DbUser,
  msg: InboundMessage,
  text: string,
  opts?: {
    inboundWasVoice?: boolean
    alreadyLogged?: boolean
    canonical?: CanonicalResult
  },
): Promise<void> {
  const user = toSessionUser(dbUser)
  const phone = normalizePhone(msg.from)
  const locale = staffLocale(dbUser.preferredLocale)
  const authorLocale = authorLocaleHint(dbUser.preferredLocale)

  const lower = text.trim().toLowerCase()
  if (lower === 'language' || lower === '/language') {
    await sendWhatsAppText(phone, languagePromptText(locale)).catch(() => undefined)
    await markLanguagePrompted(dbUser.id)
    return
  }

  const langMatch = text.trim().match(LANG_SET_PATTERN)
  if (langMatch) {
    const next = langMatch[1]!.toLowerCase() as PreferredLocale
    await setUserPreferredLocale(dbUser.id, next)
    await sendWhatsAppText(phone, languageSavedMessage(next)).catch(() => undefined)
    await sendWhatsAppText(phone, roleCommandHelp(next, dbUser.role)).catch(() => undefined)
    return
  }

  if (lower === 'orders' || lower === '/orders') {
    if (!canManageOrders(user)) {
      await sendWhatsAppText(
        phone,
        `Orders aren't available for your role.\n\n${roleCommandHelp(locale, dbUser.role)}`,
      ).catch(() => undefined)
      return
    }
    await sendWhatsAppText(phone, orderCommandHelp(locale)).catch(() => undefined)
    return
  }

  if (lower === 'ops' || lower === '/ops' || lower === 'help' || lower === '/help' || lower === 'menu') {
    await sendWhatsAppText(phone, roleCommandHelp(locale, dbUser.role)).catch(() => undefined)
    return
  }

  if (await tryHandleWhatsAppDraftConfirm(user, phone, text, dbUser.preferredLocale)) return

  const taskIntent = parseCreateTaskIntent(text)
  if (taskIntent) {
    await offerTaskDraft(user, phone, taskIntent.title, authorLocale)
    return
  }

  const censusIntent = parseCensusIntent(text)
  if (censusIntent) {
    await offerCensusDraft(user, phone, censusIntent, authorLocale)
    return
  }

  const assetCountIntent = parseAssetCountIntent(text)
  if (assetCountIntent) {
    await offerAssetCountDraft(user, phone, assetCountIntent)
    return
  }

  const cropIntent = parseCropCycleIntent(text)
  if (cropIntent) {
    await offerCropCycleDraft(user, phone, cropIntent, authorLocale)
    return
  }

  const livestockIntent = parseLivestockBatchIntent(text)
  if (livestockIntent) {
    await offerLivestockBatchDraft(user, phone, livestockIntent, dbUser.preferredLocale)
    return
  }

  const stockMoveIntent = parseStockMoveIntent(text)
  if (stockMoveIntent) {
    await offerStockMoveDraft(user, phone, stockMoveIntent, authorLocale)
    return
  }

  const openingCountIntent = parseOpeningCountIntent(text)
  if (openingCountIntent) {
    await offerOpeningCountDraft(user, phone, openingCountIntent)
    return
  }

  const lowStockAckIntent = parseLowStockAckIntent(text)
  if (lowStockAckIntent) {
    await offerLowStockAckDraft(user, phone, lowStockAckIntent)
    return
  }

  const createZoneIntent = parseCreateZoneIntent(text)
  if (createZoneIntent) {
    await offerCreateZoneDraft(user, phone, createZoneIntent, authorLocale)
    return
  }

  const createPlotIntent = parseCreatePlotIntent(text)
  if (createPlotIntent) {
    await offerCreatePlotDraft(user, phone, createPlotIntent, authorLocale)
    return
  }

  const livestockLogIntent = parseLivestockLogIntent(text)
  if (livestockLogIntent) {
    await offerLivestockLogDraft(user, phone, livestockLogIntent, authorLocale)
    return
  }

  if (lower === 'lots' || lower === '/lots') {
    await sendWhatsAppText(phone, await formatLotsToPackMessage(user.farmId)).catch(() => undefined)
    return
  }

  const packMatch = text.match(/^(?:pack|lot)\s+(\S+)/i)
  if (packMatch) {
    await offerLotEnrichDraft(user, phone, packMatch[1])
    return
  }

  if (await tryApplyLotEnrichText(user, phone, text, authorLocale)) return

  if (await tryApplyPoultryTypeAnswer(user, phone, text, dbUser.preferredLocale)) return

  const verifyLotIntent = parseVerifyLotIntent(text)
  if (verifyLotIntent) {
    await offerVerifyLotDraft(user, phone, verifyLotIntent, authorLocale)
    return
  }

  const printQrMatch = text.trim().match(/^(?:\/)?(?:printqr|print\s*qr|label)(?:\s+(\S+))?$/i)
  if (printQrMatch) {
    if (!canManageOrders(user)) {
      await sendWhatsAppText(
        phone,
        'Only Admin, Supervisor, or Sales can print box QR labels.',
      ).catch(() => undefined)
      return
    }
    const code = printQrMatch[1]
    if (!code) {
      const lots = await listRecentPrintableLots(user.farmId, 8)
      if (!lots.length) {
        await sendWhatsAppText(phone, 'No harvest lots yet.').catch(() => undefined)
        return
      }
      const lines = lots.map(
        (lot, i) => `${i + 1}. ${lot.lotCode} — ${lot.productName}`,
      )
      await sendWhatsAppText(
        phone,
        `Print box QR — reply:\n/printqr LOT-CODE\n\nRecent lots:\n${lines.join('\n')}`,
      ).catch(() => undefined)
      return
    }
    const lot = await findPrintableLotByCode(user.farmId, code)
    if (!lot) {
      await sendWhatsAppText(phone, `Lot not found: ${code}`).catch(() => undefined)
      return
    }
    try {
      const { png, publicUrl, labelUrl } = await buildLotQrPng(lot)
      await sendWhatsAppImage(phone, png, {
        filename: `${lot.lotCode}-qr.png`,
        caption: [
          `Box label · ${lot.lotCode}`,
          'Print this QR on the delivery box.',
          `Printable: ${labelUrl}`,
          `Scan opens: ${publicUrl}`,
        ].join('\n'),
      })
    } catch {
      await sendWhatsAppText(phone, 'Could not send QR image. Try again.').catch(() => undefined)
    }
    return
  }

  if (lower === 'handover' || lower === '/handover') {
    try {
      const progress = await getHandoverProgress(user.farmId)
      await sendWhatsAppText(phone, formatHandoverProgressText(progress)).catch(() => undefined)
    } catch {
      await sendWhatsAppText(phone, 'Could not load handover progress.').catch(() => undefined)
    }
    return
  }

  const opsText = await withEnglishOpsNote(text, user.farmId, authorLocale)
  const opsCmd = await tryHandleStaffOpsCommand({
    actor: toActor(dbUser),
    text: opsText.text,
    noteLocale: opsText.noteLocale,
  })
  if (opsCmd.handled) {
    await sendWhatsAppText(
      phone,
      voicePrefix(
        opts,
        text,
        flattenPickerReply(
          opsText.restoreReply(opsCmd.reply ?? 'Done.'),
          opsCmd.replyMarkup,
        ),
      ),
    ).catch(() => undefined)
    return
  }

  if (canManageOrders(user)) {
    const orderCmd = await tryHandleStaffOrderCommand({
      actor: toActor(dbUser),
      text,
    })
    if (orderCmd.handled) {
      await sendWhatsAppText(
        phone,
        voicePrefix(
          opts,
          text,
          flattenPickerReply(orderCmd.reply ?? 'Done.', orderCmd.replyMarkup),
        ),
      ).catch(() => undefined)
      return
    }
  }

  // The language nudge used to live here, firing only on "hi"/"hello" and only
  // while preferred_locale still read 'en' — so a worker who opened with a report
  // was never asked, and one who had chosen English was asked forever. It is now
  // handled once for every message by the caller, keyed off whether they answered.

  // The chat log and the supervisor alert are read in English; the butler reply
  // below stays in the worker's language.
  const canonical =
    opts?.canonical ??
    (await toCanonicalEnglish({ text, farmId: user.farmId, sourceLocale: authorLocale }))

  if (!opts?.alreadyLogged) {
    await recordChatMessage({
      farmId: user.farmId,
      userId: user.id,
      entityType: ENTITY,
      messageId: msg.id,
      text: canonical.english,
      role: 'user',
      direction: 'inbound',
      extra: translationMeta(canonical, text),
    })
  }

  const reply = await answerText(user, text, ENTITY, dbUser.preferredLocale)
  await deliverButlerReply({
    user,
    target: { channel: 'whatsapp', to: phone },
    text: voicePrefix(opts, text, reply),
    inboundWasVoice: !!opts?.inboundWasVoice,
    entityType: ENTITY,
  })

  // Urgency keywords are English-only, so match on the normalized text.
  if (dbUser.role === 'field_worker' && looksUrgent(canonical.english)) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ Urgent report from ${user.name} (WhatsApp):\n\n"${canonical.english.slice(0, 300)}"\n\nButler replied with guidance. Please review in Trovara OS.`,
      { actorUserId: user.id, reason: 'urgent_keyword' },
    )
  }
}

async function handleImage(dbUser: DbUser, msg: InboundMessage): Promise<void> {
  const user = toSessionUser(dbUser)
  const phone = normalizePhone(msg.from)
  const caption = msg.image?.caption?.trim() ?? ''

  if (!checkButlerRateLimit(user.id)) {
    await sendWhatsAppText(phone, BUTLER_RATE_LIMIT_MSG).catch(() => undefined)
    return
  }

  // Caption handlers below still match the worker's own words; only the stored
  // caption is normalized.
  const canonicalCaption = caption
    ? await toCanonicalEnglish({
        text: caption,
        farmId: user.farmId,
        sourceLocale: authorLocaleHint(dbUser.preferredLocale),
      })
    : null

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: msg.id,
    text: canonicalCaption ? `[photo] ${canonicalCaption.english}` : '[photo]',
    role: 'user',
    direction: 'inbound',
    extra: {
      kind: 'image',
      mediaId: msg.image?.id,
      ...(canonicalCaption ? translationMeta(canonicalCaption, caption) : {}),
    },
  })

  // Attach to pending enrich_lot draft before diagnostic photo path.
  try {
    const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
    const attached = await attachPhotoToLotEnrichDraft(user, dataUrl)
    if (attached.ok) {
      await sendWhatsAppText(
        phone,
        `Photo attached to lot draft. ${draftConfirmHint(dbUser.preferredLocale)}`,
      ).catch(() => undefined)
      return
    }
  } catch {
    // Fall through — other caption handlers may still apply.
  }

  if (canManageOrders(user) && /(?:delivered|deliver)\s+\S+/i.test(caption)) {
    try {
      const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
      const photoUrl = await processEvidenceValue(user.farmId, dataUrl)
      const orderCmd = await tryHandleStaffOrderCommand({
        actor: toActor(dbUser),
        text: caption,
        deliveryPhotoUrl: photoUrl,
      })
      if (orderCmd.handled) {
        await sendWhatsAppText(phone, orderCmd.reply ?? 'Done.').catch(() => undefined)
        return
      }
    } catch {
      await sendWhatsAppText(phone, 'Could not save delivery photo. Please resend.').catch(() => undefined)
      return
    }
  }

  if (/^(?:done|complete|finish|start|taskstart)\b/i.test(caption)) {
    try {
      const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
      const photoUrl = await processEvidenceValue(user.farmId, dataUrl)
      const opsText = await withEnglishOpsNote(
        caption,
        user.farmId,
        authorLocaleHint(dbUser.preferredLocale),
      )
      const opsCmd = await tryHandleStaffOpsCommand({
        actor: toActor(dbUser),
        text: opsText.text,
        photoUrl,
        noteLocale: opsText.noteLocale,
      })
      if (opsCmd.handled) {
        await sendWhatsAppText(
          phone,
          flattenPickerReply(
            opsText.restoreReply(opsCmd.reply ?? 'Done.'),
            opsCmd.replyMarkup,
          ),
        ).catch(() => undefined)
        return
      }
    } catch {
      await sendWhatsAppText(phone, 'Could not save task photo. Please resend.').catch(() => undefined)
      return
    }
  }

  let reply: string
  try {
    const dataUrl = await downloadWhatsAppMedia(msg.image!.id)
    reply = await answerPhoto(caption, dataUrl, dbUser.preferredLocale)
  } catch {
    reply = 'I could not open that photo. Please resend a clear, well-lit picture of the plant or animal.'
  }
  await deliverButlerReply({
    user,
    target: { channel: 'whatsapp', to: phone },
    text: reply,
    inboundWasVoice: false,
    entityType: ENTITY,
  })

  if (canonicalCaption && dbUser.role === 'field_worker' && looksUrgent(canonicalCaption.english)) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ ${user.name} sent a photo on WhatsApp with note: "${canonicalCaption.english.slice(0, 200)}". Butler sent a diagnosis. Please review.`,
      { actorUserId: user.id, reason: 'urgent_photo' },
    )
  }
}

async function handleAudio(dbUser: DbUser, msg: InboundMessage): Promise<void> {
  const user = toSessionUser(dbUser)
  const phone = normalizePhone(msg.from)

  if (!checkButlerRateLimit(user.id)) {
    await sendWhatsAppText(phone, BUTLER_RATE_LIMIT_MSG).catch(() => undefined)
    return
  }

  let transcript: string | null = null
  try {
    const { buffer, filename } = await downloadWhatsAppMediaBuffer(msg.audio!.id)
    transcript = await transcribeVoice(buffer, filename)
  } catch {
    transcript = null
  }

  if (!transcript) {
    await deliverButlerReply({
      user,
      target: { channel: 'whatsapp', to: phone },
      text: voiceNotUnderstoodMessage(staffLocale(dbUser.preferredLocale)),
      inboundWasVoice: true,
      entityType: ENTITY,
    })
    return
  }

  // Transcription returns the spoken language, so a voice note is normalized
  // exactly like typed text — once, here, and reused by handleText.
  const canonical = await toCanonicalEnglish({
    text: transcript,
    farmId: user.farmId,
    sourceLocale: authorLocaleHint(dbUser.preferredLocale),
  })

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: msg.id,
    text: canonical.english,
    role: 'user',
    direction: 'inbound',
    extra: { kind: 'voice', ...translationMeta(canonical, transcript) },
  })

  // Route voice through the same structured command path as text: commands and
  // plot names are matched on what was actually said.
  await handleText(dbUser, msg, transcript, {
    inboundWasVoice: true,
    alreadyLogged: true,
    canonical,
  })
}

export async function handleInboundWhatsApp(payload: unknown): Promise<{ handled: number }> {
  const body = payload as {
    entry?: {
      changes?: {
        value?: {
          messages?: InboundMessage[]
          metadata?: { phone_number_id?: string }
        }
      }[]
    }[]
  }

  let handled = 0

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      if (!value?.messages?.length) continue

      for (const msg of value.messages) {
        const phoneNumberId = value.metadata?.phone_number_id ?? 'unknown'
        if (!(await claimInboundWhatsAppMessage(phoneNumberId, msg))) continue
        const phone = normalizePhone(msg.from)
        const dbUser = await findUserByPhone(phone)

        if (!dbUser) {
          console.log(`WhatsApp inbound from unknown phone ${phone} (type ${msg.type})`)
          await completeInboundWhatsAppMessage(phoneNumberId, msg.id)
          continue
        }

        try {
          if (msg.type === 'text' && msg.text?.body) {
            await handleText(dbUser, msg, msg.text.body.trim())
            handled++
          } else if (msg.type === 'image' && msg.image?.id) {
            await handleImage(dbUser, msg)
            handled++
          } else if (msg.type === 'audio' && msg.audio?.id) {
            await handleAudio(dbUser, msg)
            handled++
          } else {
            await sendWhatsAppText(
              phone,
              'I can read text, voice notes and photos. Please send any of those.',
            ).catch(() => undefined)
          }
          await completeInboundWhatsAppMessage(phoneNumberId, msg.id)
        } catch (err) {
          console.error('WhatsApp inbound handling error:', err)
          await failInboundWhatsAppMessage(phoneNumberId, msg.id, err)
          throw err
        }
      }
    }
  }

  return { handled }
}
