import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { tasks, users } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { recordFarmEvent } from './farm-events.js'
import { verifyAndConsumeLinkCode, resolveActiveTelegramLink, extractButlerLinkCode } from './butler-link-codes.js'
import { answerPhoto, answerText, recordChatMessage, transcribeVoice } from './butler-core.js'
import { authorLocaleHint, toCanonicalEnglish, type CanonicalResult } from './content-locale.js'
import { markLanguagePrompted, shouldPromptLanguage } from './language-prompt.js'
import { voiceNotUnderstoodMessage } from './reply-locale.js'
import { checkButlerChatRateLimit, checkButlerRateLimit } from './butler-rate-limit.js'
import { deliverButlerReply, handleTelegramVoiceCommand } from './butler-reply.js'
import { looksUrgent, notifyWorkerAlertChannels } from './farm-notify.js'
import { canAssignTasks, canManageOrders } from './rbac.js'
import {
  languageKeyboard,
  tryHandleStaffOrderCommand,
} from './order-fulfillment.js'
import {
  languagePromptMessage,
  orderCommandHelp,
  staffLocale,
} from './order-messages.js'
import { tryHandleStaffOpsCommand } from './staff-ops.js'
import type { ContentLocaleMeta } from './task-drafts.js'
import { processEvidenceValue } from './evidence-store.js'
import { formatHandoverProgressText, getHandoverProgress } from './handover-templates.js'
import {
  markTelegramUpdateProcessed,
  wasTelegramUpdateProcessed,
} from './task-drafts.js'
import {
  findPrintableLotByCode,
  listRecentPrintableLots,
  printQrPickerKeyboard,
} from './lot-print.js'
import {
  answerTelegramCallbackQuery,
  confirmCancelKeyboard,
  downloadTelegramFile,
  downloadTelegramFileBuffer,
  sendTelegramMessage,
  setTelegramCommandsForChat,
  startTelegramPollLoop,
  type TelegramUpdate,
} from './telegram.js'
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
} from './telegram-offer-drafts.js'
import { deliverPrintQr, handleCallbackQuery } from './telegram-callbacks.js'
import { roleCommandHelp } from './role-menus.js'

const ENTITY = 'telegram_message'
const LINK_ENTITY = 'telegram_link'
const BUTLER_RATE_LIMIT_MSG = 'You have reached the hourly Butler limit. Please try again later.'
const BOT_KEY = 'staff'

type DbUser = typeof users.$inferSelect

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

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '')
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

/**
 * Canonical English for anything this message persists. The preference goes
 * through `authorLocaleHint` so the default `'en'` becomes "detect it from the
 * text" rather than a claim that the text is already English. Never throws or
 * blocks the worker's write.
 */
function canonicalForStorage(text: string, dbUser: DbUser): Promise<CanonicalResult> {
  return toCanonicalEnglish({
    text,
    farmId: dbUser.farmId,
    sourceLocale: authorLocaleHint(dbUser.preferredLocale),
  })
}

const OPS_NOTE =
  /^\/?(?:start|begin|taskstart|done|complete|finish|approve|reject)\s+\S+\s+(.+)$/i

type OpsNotePrep = {
  text: string
  restoreReply: (reply: string) => string
  /** Present when the command carried a free-text note — executors inherit it. */
  noteLocale?: ContentLocaleMeta
}

/**
 * Task transition commands write their trailing note straight onto the task
 * (completion note / rejection reason), so the note is swapped for English
 * before the command runs. Keywords and the task reference are left untouched,
 * and the reply that echoes the note back to the worker keeps their own words.
 *
 * `noteLocale` is the outcome of that normalization so the task row records
 * whether the English is final or still pending a retry.
 */
async function withEnglishOpsNote(text: string, dbUser: DbUser): Promise<OpsNotePrep> {
  const identity: OpsNotePrep = { text, restoreReply: (reply: string) => reply }
  const trimmed = text.trim()
  const note = trimmed.match(OPS_NOTE)?.[1]
  if (!note) return identity

  const canonical = await canonicalForStorage(note, dbUser)
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

async function promptLanguage(chatId: number, localeHint?: string | null) {
  const locale = staffLocale(localeHint)
  await sendTelegramMessage(chatId, languagePromptMessage(locale), {
    replyMarkup: languageKeyboard(),
  })
}

async function linkChat(chatId: number, user: DbUser): Promise<void> {
  await recordFarmEvent({
    farmId: user.farmId,
    actorUserId: user.id,
    entityType: LINK_ENTITY,
    entityId: String(chatId),
    eventType: 'other',
    source: 'telegram',
    afterValue: { userId: user.id, chatId },
    metadata: { linkedAt: new Date().toISOString() },
  })
  await setTelegramCommandsForChat(chatId, user.role).catch(() => undefined)
}

async function findUserByPhone(phone: string): Promise<DbUser | undefined> {
  const normalized = normalizePhone(phone)
  const all = await db
    .select()
    .from(users)
    .where(sql`${users.phone} IS NOT NULL AND ${users.phone} <> '' AND ${users.active} = true`)
  return all.find((u) => normalizePhone(u.phone ?? '') === normalized)
}

const LINK_PROMPT = [
  'Welcome to Trovara Butler 👋',
  '',
  'To connect your farm account, either:',
  '• Tap "Share my phone number" below (if your number is on your Trovara profile), or',
  '• Generate a link code in Trovara Settings → Connect Telegram, then send:',
  '  /link YOURCODE',
  '  (or just paste the code alone)',
].join('\n')

const LINK_CODE_FAIL_MSG =
  'Invalid or expired link code. Generate a new code in Trovara Settings → Connect Telegram, then send /link YOURCODE (within 15 minutes).'

async function completeTelegramLink(chatId: number, u: DbUser): Promise<void> {
  await linkChat(chatId, u)
  await sendTelegramMessage(chatId, '✅ Connected successfully.')
  await sendTelegramMessage(chatId, roleCommandHelp(staffLocale(u.preferredLocale), u.role))
  await promptLanguage(chatId, u.preferredLocale)
  await markLanguagePrompted(u.id)
}

async function tryLinkWithCode(chatId: number, code: string): Promise<boolean> {
  const u = await verifyAndConsumeLinkCode(code)
  if (!u) {
    await sendTelegramMessage(chatId, LINK_CODE_FAIL_MSG)
    return false
  }
  await completeTelegramLink(chatId, u)
  return true
}

async function handleHandoverCommand(user: SessionUser, chatId: number) {
  if (!canAssignTasks(user)) {
    const assigned = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        dueDate: tasks.dueDate,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.farmId, user.farmId),
          eq(tasks.assignedToId, user.id),
          sql`${tasks.actionType} IS NOT NULL`,
          ne(tasks.status, 'completed'),
        ),
      )
      .orderBy(tasks.dueDate)
      .limit(15)

    if (!assigned.length) {
      await sendTelegramMessage(chatId, 'No open handover tasks assigned to you.')
      return
    }

    const lines = assigned.map(
      (t, i) => `${i + 1}. ${t.title} (${t.status})${t.dueDate ? ` · due ${t.dueDate.toISOString().slice(0, 10)}` : ''}`,
    )
    await sendTelegramMessage(chatId, ['Your handover tasks:', '', ...lines].join('\n'))
    return
  }

  const progress = await getHandoverProgress(user.farmId)
  await sendTelegramMessage(
    chatId,
    [
      formatHandoverProgressText(progress),
      '',
      'Draft a task: Create task: Count coconut in Block 2',
      'Census draft: Census: Block 2 crop=coconut count=120 min=1 max=3',
      'Asset draft: Asset count: Wheelbarrow available=2 damaged=0',
      'Then tap Confirm.',
    ].join('\n'),
  )
}

async function handlePrintQrCommand(user: SessionUser, chatId: number, text: string) {
  if (!canManageOrders(user)) {
    await sendTelegramMessage(chatId, 'Only Admin, Supervisor, or Sales can print box QR labels.')
    return
  }

  const match = text.trim().match(/^(?:\/)?(?:printqr|print\s*qr|label)\s+(\S+)/i)
  if (match?.[1]) {
    const lot = await findPrintableLotByCode(user.farmId, match[1])
    if (!lot) {
      await sendTelegramMessage(chatId, `Lot not found: ${match[1]}`)
      return
    }
    await deliverPrintQr(chatId, lot)
    return
  }

  const lots = await listRecentPrintableLots(user.farmId, 8)
  if (!lots.length) {
    await sendTelegramMessage(chatId, 'No harvest lots yet. Create an order or a lot first.')
    return
  }

  await sendTelegramMessage(chatId, 'Pick a lot to print the box QR label:', {
    replyMarkup: printQrPickerKeyboard(lots),
  })
}

async function handleLotsCommand(user: SessionUser, chatId: number) {
  await sendTelegramMessage(chatId, await formatLotsToPackMessage(user.farmId))
}

const isLanguageCommand = (text: string) =>
  text === '/language' || text.toLowerCase() === 'language'

async function handleLinkedText(
  dbUser: DbUser,
  chatId: number,
  messageId: number,
  text: string,
  opts?: {
    skipUserLog?: boolean
    inboundWasVoice?: boolean
    /** Already-normalized form of `text`, so voice notes translate only once. */
    canonical?: CanonicalResult
  },
) {
  if (!checkButlerRateLimit(dbUser.id)) {
    await sendTelegramMessage(chatId, BUTLER_RATE_LIMIT_MSG)
    return
  }

  await handleLinkedTextInner(dbUser, chatId, messageId, text, opts)

  // After their message is dealt with, not before: someone reporting a dead bird
  // gets an answer first, and the nudge is the second message rather than a
  // gate. Skipped when they are already in the language flow.
  if (!isLanguageCommand(text) && shouldPromptLanguage(dbUser)) {
    await promptLanguage(chatId, dbUser.preferredLocale)
    await markLanguagePrompted(dbUser.id)
  }
}

async function handleLinkedTextInner(
  dbUser: DbUser,
  chatId: number,
  messageId: number,
  text: string,
  opts?: {
    skipUserLog?: boolean
    inboundWasVoice?: boolean
    canonical?: CanonicalResult
  },
) {
  const user = toSessionUser(dbUser)
  const locale = staffLocale(dbUser.preferredLocale)

  // Allow re-link / switch account even when this chat is already connected.
  const linkCode = extractButlerLinkCode(text)
  if (linkCode || /^\/link(?:@\S+)?(?:\s|$)/i.test(text.trim())) {
    if (!linkCode) {
      await sendTelegramMessage(
        chatId,
        `This chat is already linked as ${dbUser.name}.\n\nTo switch accounts, send a fresh code:\n/link YOURCODE`,
      )
      return
    }
    await tryLinkWithCode(chatId, linkCode)
    return
  }

  if (isLanguageCommand(text)) {
    await promptLanguage(chatId, dbUser.preferredLocale)
    await markLanguagePrompted(dbUser.id)
    return
  }

  if (text === '/orders' || text.toLowerCase() === 'orders') {
    if (!canManageOrders(user)) {
      await sendTelegramMessage(
        chatId,
        `Orders aren't available for your role.\n\n${roleCommandHelp(locale, dbUser.role)}`,
      )
      return
    }
    await sendTelegramMessage(chatId, orderCommandHelp(locale))
    return
  }

  if (
    text === '/ops' ||
    text.toLowerCase() === 'ops' ||
    text === '/field' ||
    text.toLowerCase() === 'fieldhelp' ||
    text === '/help' ||
    text.toLowerCase() === 'help' ||
    text === '/start'
  ) {
    await setTelegramCommandsForChat(chatId, dbUser.role).catch(() => undefined)
    await sendTelegramMessage(chatId, roleCommandHelp(locale, dbUser.role))
    return
  }

  if (text === '/handover' || text.toLowerCase() === 'handover') {
    await handleHandoverCommand(user, chatId)
    return
  }

  if (text === '/lots' || text.toLowerCase() === 'lots') {
    await handleLotsCommand(user, chatId)
    return
  }

  if (
    /^(?:\/)?(?:printqr|print\s*qr|label)(?:\s+\S+)?$/i.test(text.trim())
  ) {
    await handlePrintQrCommand(user, chatId, text)
    return
  }

  const packMatch = text.match(/^(?:pack|lot)\s+(\S+)/i)
  if (packMatch) {
    await offerLotEnrichDraft(user, chatId, packMatch[1])
    return
  }

  if (await tryApplyLotEnrichText(user, chatId, text, dbUser.preferredLocale)) return

  if (await tryApplyPoultryTypeAnswer(user, chatId, text, dbUser.preferredLocale)) return

  const verifyLotIntent = parseVerifyLotIntent(text)
  if (verifyLotIntent) {
    await offerVerifyLotDraft(user, chatId, verifyLotIntent, dbUser.preferredLocale)
    return
  }

  const opsText = await withEnglishOpsNote(text, dbUser)
  const opsCmd = await tryHandleStaffOpsCommand({
    actor: toActor(dbUser),
    text: opsText.text,
    noteLocale: opsText.noteLocale,
  })
  if (opsCmd.handled) {
    await sendTelegramMessage(chatId, opsText.restoreReply(opsCmd.reply ?? 'Done.'), {
      replyMarkup: opsCmd.replyMarkup,
    })
    return
  }

  if (canManageOrders(user)) {
    const orderCmd = await tryHandleStaffOrderCommand({
      actor: toActor(dbUser),
      text,
    })
    if (orderCmd.handled) {
      await sendTelegramMessage(chatId, orderCmd.reply ?? 'Done.', {
        replyMarkup: orderCmd.replyMarkup,
      })
      return
    }
  }

  const taskIntent = parseCreateTaskIntent(text)
  if (taskIntent) {
    await offerTaskDraft(user, chatId, taskIntent.title, undefined, dbUser.preferredLocale)
    return
  }

  const censusIntent = parseCensusIntent(text)
  if (censusIntent) {
    await offerCensusDraft(user, chatId, censusIntent, dbUser.preferredLocale)
    return
  }

  const assetCountIntent = parseAssetCountIntent(text)
  if (assetCountIntent) {
    await offerAssetCountDraft(user, chatId, assetCountIntent)
    return
  }

  const cropIntent = parseCropCycleIntent(text)
  if (cropIntent) {
    await offerCropCycleDraft(user, chatId, cropIntent)
    return
  }

  const livestockIntent = parseLivestockBatchIntent(text)
  if (livestockIntent) {
    await offerLivestockBatchDraft(user, chatId, livestockIntent, dbUser.preferredLocale)
    return
  }

  const stockMoveIntent = parseStockMoveIntent(text)
  if (stockMoveIntent) {
    await offerStockMoveDraft(user, chatId, stockMoveIntent, dbUser.preferredLocale)
    return
  }

  const openingCountIntent = parseOpeningCountIntent(text)
  if (openingCountIntent) {
    await offerOpeningCountDraft(user, chatId, openingCountIntent)
    return
  }

  const lowStockAckIntent = parseLowStockAckIntent(text)
  if (lowStockAckIntent) {
    await offerLowStockAckDraft(user, chatId, lowStockAckIntent)
    return
  }

  const createZoneIntent = parseCreateZoneIntent(text)
  if (createZoneIntent) {
    await offerCreateZoneDraft(user, chatId, createZoneIntent, dbUser.preferredLocale)
    return
  }

  const createPlotIntent = parseCreatePlotIntent(text)
  if (createPlotIntent) {
    await offerCreatePlotDraft(user, chatId, createPlotIntent)
    return
  }

  const livestockLogIntent = parseLivestockLogIntent(text)
  if (livestockLogIntent) {
    await offerLivestockLogDraft(user, chatId, livestockLogIntent, dbUser.preferredLocale)
    return
  }

  // One normalization for everything this message stores: the chat log and the
  // supervisor alert read the English, the Butler reply keeps the worker's words.
  const canonical = opts?.canonical ?? (await canonicalForStorage(text, dbUser))

  if (!opts?.skipUserLog) {
    await recordChatMessage({
      farmId: user.farmId,
      userId: user.id,
      entityType: ENTITY,
      messageId: `tg-${messageId}`,
      text: canonical.english,
      role: 'user',
      direction: 'inbound',
      extra: {
        sourceLocale: canonical.sourceLocale,
        translationStatus: canonical.status,
      },
    })
  }

  if (await handleTelegramVoiceCommand(user, chatId, text)) return

  const reply = await answerText(user, text, ENTITY, dbUser.preferredLocale)
  await deliverButlerReply({
    user,
    target: { channel: 'telegram', chatId },
    text: opts?.inboundWasVoice ? `🗣️ "${text}"\n\n${reply}` : reply,
    inboundWasVoice: !!opts?.inboundWasVoice,
    entityType: ENTITY,
  })

  // Urgency keywords are English, so detection reads the canonical text: a
  // French "trois poulets sont morts" now reaches the supervisor too.
  if (dbUser.role === 'field_worker' && looksUrgent(canonical.english)) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ Urgent report from ${user.name} (Telegram):\n\n"${canonical.english.slice(0, 300)}"\n\nButler replied with guidance. Please review in Trovara OS.`,
      { actorUserId: user.id, reason: 'urgent_keyword' },
    )
  }
}

async function handlePhoto(dbUser: DbUser, chatId: number, msg: NonNullable<TelegramUpdate['message']>) {
  if (!checkButlerRateLimit(dbUser.id)) {
    await sendTelegramMessage(chatId, BUTLER_RATE_LIMIT_MSG)
    return
  }

  const user = toSessionUser(dbUser)
  const caption = msg.caption?.trim() ?? ''
  const fileId = msg.photo?.[msg.photo.length - 1]?.file_id
  if (!fileId) return

  const canonicalCaption = caption ? await canonicalForStorage(caption, dbUser) : null

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: `tg-${msg.message_id}`,
    text: canonicalCaption ? `[photo] ${canonicalCaption.english}` : '[photo]',
    role: 'user',
    direction: 'inbound',
    extra: {
      kind: 'image',
      ...(canonicalCaption
        ? {
            sourceLocale: canonicalCaption.sourceLocale,
            translationStatus: canonicalCaption.status,
          }
        : {}),
    },
  })

  try {
    const dataUrl = await downloadTelegramFile(fileId)
    const attached = await attachPhotoToLotEnrichDraft(user, dataUrl)
    if (attached.ok) {
      await sendTelegramMessage(chatId, 'Photo attached to lot draft. Confirm to save.', {
        replyMarkup: confirmCancelKeyboard(attached.draftId),
      })
      return
    }
  } catch {
    // Fall through — other caption handlers may still apply.
  }

  if (canManageOrders(user) && /(?:delivered|deliver)\s+\S+/i.test(caption)) {
    try {
      const dataUrl = await downloadTelegramFile(fileId)
      const photoUrl = await processEvidenceValue(user.farmId, dataUrl)
      const orderCmd = await tryHandleStaffOrderCommand({
        actor: toActor(dbUser),
        text: caption,
        deliveryPhotoUrl: photoUrl,
      })
      if (orderCmd.handled) {
        await sendTelegramMessage(chatId, orderCmd.reply ?? 'Done.')
        return
      }
    } catch {
      await sendTelegramMessage(chatId, 'Could not save delivery photo. Please resend.')
      return
    }
  }

  if (/^(?:done|complete|finish|start|taskstart)\b/i.test(caption)) {
    try {
      const dataUrl = await downloadTelegramFile(fileId)
      const photoUrl = await processEvidenceValue(user.farmId, dataUrl)
      const opsText = await withEnglishOpsNote(caption, dbUser)
      const opsCmd = await tryHandleStaffOpsCommand({
        actor: toActor(dbUser),
        text: opsText.text,
        photoUrl,
        noteLocale: opsText.noteLocale,
      })
      if (opsCmd.handled) {
        await sendTelegramMessage(chatId, opsText.restoreReply(opsCmd.reply ?? 'Done.'), {
          replyMarkup: opsCmd.replyMarkup,
        })
        return
      }
    } catch {
      await sendTelegramMessage(chatId, 'Could not save task photo. Please resend.')
      return
    }
  }

  let reply: string
  try {
    const dataUrl = await downloadTelegramFile(fileId)
    reply = await answerPhoto(caption, dataUrl, dbUser.preferredLocale)
  } catch {
    reply = 'I could not open that photo. Please resend a clear, well-lit picture of the plant or animal.'
  }
  await deliverButlerReply({
    user,
    target: { channel: 'telegram', chatId },
    text: reply,
    inboundWasVoice: false,
    entityType: ENTITY,
  })

  if (
    dbUser.role === 'field_worker' &&
    canonicalCaption &&
    looksUrgent(canonicalCaption.english)
  ) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ ${user.name} sent a photo on Telegram with note: "${(canonicalCaption?.english ?? caption).slice(0, 200)}". Butler sent a diagnosis. Please review.`,
      { actorUserId: user.id, reason: 'urgent_photo' },
    )
  }
}

async function handleVoice(dbUser: DbUser, chatId: number, msg: NonNullable<TelegramUpdate['message']>) {
  if (!checkButlerRateLimit(dbUser.id)) {
    await sendTelegramMessage(chatId, BUTLER_RATE_LIMIT_MSG)
    return
  }

  const user = toSessionUser(dbUser)
  const fileId = msg.voice?.file_id ?? msg.audio?.file_id
  if (!fileId) return

  let transcript: string | null = null
  try {
    const { buffer, filename } = await downloadTelegramFileBuffer(fileId)
    transcript = await transcribeVoice(buffer, filename)
  } catch {
    transcript = null
  }

  if (!transcript) {
    await sendTelegramMessage(chatId, voiceNotUnderstoodMessage(staffLocale(dbUser.preferredLocale)))
    return
  }

  // Transcription keeps the spoken language (Yoruba / Pidgin / French), so the
  // transcript is normalized before it is stored.
  const canonical = await canonicalForStorage(transcript, dbUser)

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: `tg-${msg.message_id}`,
    text: canonical.english,
    role: 'user',
    direction: 'inbound',
    extra: {
      kind: 'voice',
      sourceLocale: canonical.sourceLocale,
      translationStatus: canonical.status,
    },
  })

  // Route voice through the same structured command path as text (tasks, orders, lots…).
  // The original transcript drives intent parsing and the reply; the English is reused.
  await handleLinkedText(dbUser, chatId, msg.message_id, transcript, {
    skipUserLog: true,
    inboundWasVoice: true,
    canonical,
  })
}

/** Process a single Telegram update (used by both webhook and polling). */
export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (await wasTelegramUpdateProcessed(BOT_KEY, update.update_id)) return
  const claimed = await markTelegramUpdateProcessed(BOT_KEY, update.update_id)
  if (!claimed) return

  if (update.callback_query) {
    const chatId = update.callback_query.message?.chat.id
    if (!chatId) return
    const linkedUser = await resolveActiveTelegramLink(chatId)
    if (!linkedUser) {
      await answerTelegramCallbackQuery(update.callback_query.id, 'Link your account first.')
      return
    }
    try {
      await handleCallbackQuery(linkedUser, update.callback_query)
    } catch (err) {
      console.error('Telegram callback handling error:', err)
    }
    return
  }

  const msg = update.message
  if (!msg) return
  const chatId = msg.chat.id

  const linkedUser = await resolveActiveTelegramLink(chatId)

  if (!linkedUser) {
    if (!checkButlerChatRateLimit(String(chatId))) {
      await sendTelegramMessage(chatId, 'Too many messages - please wait before trying again.')
      return
    }

    if (msg.contact?.phone_number) {
      if (msg.contact.user_id !== msg.from?.id) {
        await sendTelegramMessage(
          chatId,
          'Please share your own phone number using the button below, not someone else\'s contact.',
        )
        await sendTelegramMessage(chatId, LINK_PROMPT, { withContactButton: true })
        return
      }

      const u = await findUserByPhone(msg.contact.phone_number)
      if (u) {
        await completeTelegramLink(chatId, u)
      } else {
        await sendTelegramMessage(
          chatId,
          'That number is not on any Trovara profile. Ask the Admin to add your phone, or use a link code from Settings.',
        )
      }
      return
    }

    const text = msg.text?.trim() ?? ''
    const linkCode = extractButlerLinkCode(text)
    if (linkCode || text.toLowerCase().startsWith('/link')) {
      if (!linkCode) {
        await sendTelegramMessage(chatId, LINK_CODE_FAIL_MSG)
        return
      }
      await tryLinkWithCode(chatId, linkCode)
      return
    }

    await sendTelegramMessage(chatId, LINK_PROMPT, { withContactButton: true })
    return
  }

  try {
    if (msg.voice || msg.audio) {
      await handleVoice(linkedUser, chatId, msg)
    } else if (msg.photo?.length) {
      await handlePhoto(linkedUser, chatId, msg)
    } else if (msg.text) {
      await handleLinkedText(linkedUser, chatId, msg.message_id, msg.text.trim())
    } else {
      await sendTelegramMessage(chatId, 'I can read text, voice notes and photos. Send any of those.')
    }
  } catch (err) {
    console.error('Telegram update handling error:', err)
  }
}

export async function handleTelegramWebhook(payload: unknown): Promise<{ handled: number }> {
  await handleTelegramUpdate(payload as TelegramUpdate)
  return { handled: 1 }
}

export function startTelegramPolling(): void {
  startTelegramPollLoop('staff', handleTelegramUpdate)
}
