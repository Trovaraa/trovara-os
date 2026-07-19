import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { tasks, users } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { recordFarmEvent } from './farm-events.js'
import { verifyAndConsumeLinkCode, resolveActiveTelegramLink, extractButlerLinkCode } from './butler-link-codes.js'
import { answerPhoto, answerText, recordChatMessage, transcribeVoice } from './butler-core.js'
import { voiceNotUnderstoodMessage } from './reply-locale.js'
import { checkButlerChatRateLimit, checkButlerRateLimit } from './butler-rate-limit.js'
import { deliverButlerReply, handleTelegramVoiceCommand } from './butler-reply.js'
import { looksUrgent, notifyWorkerAlertChannels } from './farm-notify.js'
import { canAssignTasks, canManageOrders } from './rbac.js'
import {
  languageKeyboard,
  setUserPreferredLocale,
  transitionOrderFromCallback,
  tryHandleStaffOrderCommand,
} from './order-fulfillment.js'
import {
  languagePromptMessage,
  languageSavedMessage,
  orderCommandHelp,
  staffLocale,
} from './order-messages.js'
import {
  tryHandleStaffOpsCommand,
  transitionTaskFromCallback,
} from './staff-ops.js'
import { processEvidenceValue } from './evidence-store.js'
import type { PreferredLocale } from '../db/schema.js'
import { formatHandoverProgressText, getHandoverProgress } from './handover-templates.js'
import {
  cancelActionDraft,
  confirmActionDraft,
  markTelegramUpdateProcessed,
  storeActionDraft,
  wasTelegramUpdateProcessed,
} from './task-drafts.js'
import {
  buildLotQrPng,
  findPrintableLotByCode,
  findPrintableLotById,
  listRecentPrintableLots,
  printQrPickerKeyboard,
  type PrintableLot,
} from './lot-print.js'
import {
  answerTelegramCallbackQuery,
  confirmCancelKeyboard,
  downloadTelegramFile,
  downloadTelegramFileBuffer,
  sendTelegramMessage,
  sendTelegramPhoto,
  setTelegramCommandsForChat,
  startTelegramPollLoop,
  type TelegramUpdate,
} from './telegram.js'
import {
  executeConfirmedCropCycle,
  executeConfirmedLivestockBatch,
  parseCropCycleIntent,
  parseLivestockBatchIntent,
  resolvePlotByName,
} from './action-draft-farm.js'
import {
  applyConfirmedOpsDraft,
  parseAssetCountIntent,
  parseCensusIntent,
  parseCreateTaskIntent,
  prepareAssetCountDraft,
  prepareCensusDraft,
  prepareCreateTaskDraft,
} from './action-draft-ops.js'
import {
  applyConfirmedInventoryDraft,
  parseLowStockAckIntent,
  parseOpeningCountIntent,
  parseStockMoveIntent,
  prepareLowStockAckDraft,
  prepareOpeningCountDraft,
  prepareStockMoveDraft,
} from './action-draft-inventory.js'
import {
  applyConfirmedZoneDraft,
  parseCreatePlotIntent,
  parseCreateZoneIntent,
  prepareCreatePlotDraft,
  prepareCreateZoneDraft,
} from './action-draft-zones.js'
import {
  applyConfirmedLivestockLogDraft,
  parseLivestockLogIntent,
  prepareLivestockLogDraft,
} from './action-draft-livestock-log.js'
import {
  applyConfirmedLotDraft,
  applyLotEnrichText,
  attachPhotoToLotEnrichDraft,
  formatLotsToPackMessage,
  parseVerifyLotIntent,
  prepareVerifyLotDraft,
  startLotEnrichDraft,
} from './lot-enrich.js'
import { roleCommandHelp } from './role-menus.js'

const ENTITY = 'telegram_message'
const LINK_ENTITY = 'telegram_link'
const BUTLER_RATE_LIMIT_MSG = 'You have reached the hourly Butler limit. Please try again later.'
const BOT_KEY = 'staff'
const CREATE_PLOT_HINT = 'Create plot: Name zone=ZoneName'

function withCreatePlotHint(error: string): string {
  return /not found/i.test(error) ? `${error}\n\n${CREATE_PLOT_HINT}` : error
}

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

async function offerCensusDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseCensusIntent>>,
) {
  const prepared = await prepareCensusDraft({
    user,
    ...intent,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, withCreatePlotHint(prepared.error))
    return
  }
  await sendTelegramMessage(
    chatId,
    `${prepared.preview}\n\nTap Confirm or Cancel below.`,
    { replyMarkup: confirmCancelKeyboard(prepared.draftId) },
  )
}

async function offerAssetCountDraft(
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
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(
    chatId,
    `${prepared.preview}\n\nTap Confirm or Cancel below.`,
    { replyMarkup: confirmCancelKeyboard(prepared.draftId) },
  )
}

async function offerCropCycleDraft(
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

  const stored = await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'create_crop_cycle',
    payload: {
      plotId: plot.id,
      plotName: plot.name,
      cropType: intent.cropType,
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

async function offerLivestockBatchDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseLivestockBatchIntent>>,
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

  const stored = await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'create_livestock_batch',
    payload: {
      name: intent.name,
      species: intent.species,
      headCount: intent.headCount,
      plotId,
      plotName,
      acquiredAt: new Date(intent.acquiredAt).toISOString(),
    },
    channel: 'telegram',
    externalChatId: String(chatId),
  })

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

async function offerTaskDraft(
  user: SessionUser,
  chatId: number,
  title: string,
  description?: string,
) {
  const prepared = await prepareCreateTaskDraft({
    user,
    title,
    description,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(
    chatId,
    `${prepared.preview}\n\nTap Confirm or Cancel below.`,
    { replyMarkup: confirmCancelKeyboard(prepared.draftId) },
  )
}

async function handleCallbackQuery(
  dbUser: DbUser,
  callback: NonNullable<TelegramUpdate['callback_query']>,
) {
  const chatId = callback.message?.chat.id
  if (!chatId || !callback.data) return

  await answerTelegramCallbackQuery(callback.id)

  const user = toSessionUser(dbUser)
  const parts = callback.data.split(':')

  if (parts[0] === 'lang' && parts[1]) {
    const locale = parts[1] as PreferredLocale
    if (!['en', 'yo', 'pcm', 'fr'].includes(locale)) {
      await sendTelegramMessage(chatId, 'Unknown language.')
      return
    }
    await setUserPreferredLocale(dbUser.id, locale)
    await sendTelegramMessage(chatId, languageSavedMessage(locale))
    await sendTelegramMessage(chatId, orderCommandHelp(locale))
    return
  }

  if (parts[0] === 'task' && parts[1] && parts[2]) {
    const action = parts[1]
    const taskId = parts[2]
    if (!['start', 'done', 'approve', 'reject'].includes(action)) {
      await sendTelegramMessage(chatId, 'Unknown task action.')
      return
    }
    const result = await transitionTaskFromCallback({
      actor: toActor(dbUser),
      taskId,
      action: action as 'start' | 'done' | 'approve' | 'reject',
    })
    await sendTelegramMessage(chatId, result.reply ?? 'Done.')
    return
  }

  if (parts[0] === 'label' && parts[1]) {
    if (!canManageOrders(user)) {
      await sendTelegramMessage(chatId, 'Only Admin, Supervisor, or Sales can print box QR labels.')
      return
    }
    const lot = await findPrintableLotById(user.farmId, parts[1])
    if (!lot) {
      await sendTelegramMessage(chatId, 'Lot not found.')
      return
    }
    try {
      await deliverPrintQr(chatId, lot)
    } catch (err) {
      await sendTelegramMessage(
        chatId,
        err instanceof Error ? err.message : 'Could not send QR label.',
      )
    }
    return
  }

  if (parts[0] === 'order' && parts[1] && parts[2]) {
    const action = parts[1]
    const orderId = parts[2]
    if (!['confirm', 'cancel', 'dispatch', 'deliver'].includes(action)) {
      await sendTelegramMessage(chatId, 'Unknown order action.')
      return
    }
    if (!canManageOrders(user)) {
      await sendTelegramMessage(chatId, 'You are not allowed to update orders.')
      return
    }
    const result = await transitionOrderFromCallback({
      actor: toActor(dbUser),
      orderId,
      action: action as 'confirm' | 'cancel' | 'dispatch' | 'deliver',
    })
    await sendTelegramMessage(chatId, result.reply)
    return
  }

  const [action, draftId] = parts
  if (!draftId || (action !== 'confirm' && action !== 'cancel')) {
    await sendTelegramMessage(chatId, 'Unknown button action.')
    return
  }

  if (action === 'cancel') {
    const ok = await cancelActionDraft(draftId, user.id)
    await sendTelegramMessage(chatId, ok ? 'Cancelled. Nothing was written.' : 'Draft already resolved or expired.')
    return
  }

  const confirmed = await confirmActionDraft(draftId, user.id)
  if (!confirmed) {
    await sendTelegramMessage(chatId, 'Draft expired or already used. Please create it again.')
    return
  }

  if (confirmed.farmId !== user.farmId) {
    await sendTelegramMessage(chatId, 'Draft is not valid for this farm.')
    return
  }

  try {
    const opsResult = await applyConfirmedOpsDraft(
      user,
      confirmed.actionType,
      confirmed.payload,
      'telegram_confirm',
    )
    if (opsResult != null) {
      await sendTelegramMessage(chatId, opsResult)
      return
    }

    const invResult = await applyConfirmedInventoryDraft(
      user,
      confirmed.actionType,
      confirmed.payload,
      'telegram_confirm',
    )
    if (invResult != null) {
      await sendTelegramMessage(chatId, invResult)
      return
    }

    const zoneResult = await applyConfirmedZoneDraft(
      user,
      confirmed.actionType,
      confirmed.payload,
      'telegram_confirm',
    )
    if (zoneResult != null) {
      await sendTelegramMessage(chatId, zoneResult)
      return
    }

    const logResult = await applyConfirmedLivestockLogDraft(
      user,
      confirmed.actionType,
      confirmed.payload,
      'telegram_confirm',
    )
    if (logResult != null) {
      await sendTelegramMessage(chatId, logResult)
      return
    }

    const lotResult = await applyConfirmedLotDraft(
      user,
      confirmed.actionType,
      confirmed.payload,
    )
    if (lotResult != null) {
      await sendTelegramMessage(chatId, lotResult)
      return
    }

    if (confirmed.actionType === 'create_crop_cycle') {
      const result = await executeConfirmedCropCycle(user, confirmed.payload)
      await sendTelegramMessage(chatId, result)
      return
    }

    if (confirmed.actionType === 'create_livestock_batch') {
      const result = await executeConfirmedLivestockBatch(user, confirmed.payload)
      await sendTelegramMessage(chatId, result)
      return
    }

    await sendTelegramMessage(
      chatId,
      `Confirmed ${confirmed.actionType}. Complete structured forms in the web app if needed.`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to apply draft'
    await sendTelegramMessage(chatId, `Could not apply draft: ${message}`)
  }
}

async function deliverPrintQr(chatId: number, lot: PrintableLot): Promise<void> {
  const { png, publicUrl, labelUrl } = await buildLotQrPng(lot)
  const caption = [
    `📦 Box label · ${lot.lotCode}`,
    `${lot.productName} · ${lot.quantityKg} ${lot.unit === 'crates' ? 'crates' : 'kg'}`,
    'Print this QR on the delivery box.',
    `Printable label: ${labelUrl}`,
    `(Scan opens: ${publicUrl})`,
  ].join('\n')

  await sendTelegramPhoto(chatId, png, {
    caption,
    filename: `${lot.lotCode}-qr.png`,
  })
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

async function offerLotEnrichDraft(user: SessionUser, chatId: number, lotCode: string) {
  const prepared = await startLotEnrichDraft(user, lotCode, {
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(chatId, prepared.preview, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

async function tryApplyLotEnrichText(user: SessionUser, chatId: number, text: string): Promise<boolean> {
  const result = await applyLotEnrichText(user, text)
  if (!result.handled) return false
  await sendTelegramMessage(chatId, result.reply, {
    replyMarkup: confirmCancelKeyboard(result.draftId),
  })
  return true
}

async function offerStockMoveDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseStockMoveIntent>>,
) {
  const prepared = await prepareStockMoveDraft({
    user,
    ...intent,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(chatId, `${prepared.preview}\n\nTap Confirm or Cancel below.`, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

async function offerOpeningCountDraft(
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
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(chatId, `${prepared.preview}\n\nTap Confirm or Cancel below.`, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

async function offerLowStockAckDraft(
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
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(chatId, `${prepared.preview}\n\nTap Confirm or Cancel below.`, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

async function offerCreateZoneDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseCreateZoneIntent>>,
) {
  const prepared = await prepareCreateZoneDraft({
    user,
    ...intent,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(chatId, `${prepared.preview}\n\nTap Confirm or Cancel below.`, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

async function offerCreatePlotDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseCreatePlotIntent>>,
) {
  const prepared = await prepareCreatePlotDraft({
    user,
    ...intent,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(chatId, `${prepared.preview}\n\nTap Confirm or Cancel below.`, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

async function offerLivestockLogDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseLivestockLogIntent>>,
) {
  const prepared = await prepareLivestockLogDraft({
    user,
    ...intent,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(chatId, `${prepared.preview}\n\nTap Confirm or Cancel below.`, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

async function offerVerifyLotDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseVerifyLotIntent>>,
) {
  const prepared = await prepareVerifyLotDraft({
    user,
    ...intent,
    channel: 'telegram',
    externalChatId: String(chatId),
  })
  if (!prepared.ok) {
    await sendTelegramMessage(chatId, prepared.error)
    return
  }
  await sendTelegramMessage(chatId, `${prepared.preview}\n\nTap Confirm or Cancel below.`, {
    replyMarkup: confirmCancelKeyboard(prepared.draftId),
  })
}

async function handleLinkedText(
  dbUser: DbUser,
  chatId: number,
  messageId: number,
  text: string,
  opts?: { skipUserLog?: boolean; inboundWasVoice?: boolean },
) {
  if (!checkButlerRateLimit(dbUser.id)) {
    await sendTelegramMessage(chatId, BUTLER_RATE_LIMIT_MSG)
    return
  }

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

  if (text === '/language' || text.toLowerCase() === 'language') {
    await promptLanguage(chatId, dbUser.preferredLocale)
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

  if (await tryApplyLotEnrichText(user, chatId, text)) return

  const verifyLotIntent = parseVerifyLotIntent(text)
  if (verifyLotIntent) {
    await offerVerifyLotDraft(user, chatId, verifyLotIntent)
    return
  }

  const opsCmd = await tryHandleStaffOpsCommand({
    actor: toActor(dbUser),
    text,
  })
  if (opsCmd.handled) {
    await sendTelegramMessage(chatId, opsCmd.reply ?? 'Done.', {
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
    await offerTaskDraft(user, chatId, taskIntent.title)
    return
  }

  const censusIntent = parseCensusIntent(text)
  if (censusIntent) {
    await offerCensusDraft(user, chatId, censusIntent)
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
    await offerLivestockBatchDraft(user, chatId, livestockIntent)
    return
  }

  const stockMoveIntent = parseStockMoveIntent(text)
  if (stockMoveIntent) {
    await offerStockMoveDraft(user, chatId, stockMoveIntent)
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
    await offerCreateZoneDraft(user, chatId, createZoneIntent)
    return
  }

  const createPlotIntent = parseCreatePlotIntent(text)
  if (createPlotIntent) {
    await offerCreatePlotDraft(user, chatId, createPlotIntent)
    return
  }

  const livestockLogIntent = parseLivestockLogIntent(text)
  if (livestockLogIntent) {
    await offerLivestockLogDraft(user, chatId, livestockLogIntent)
    return
  }

  if (!opts?.skipUserLog) {
    await recordChatMessage({
      farmId: user.farmId,
      userId: user.id,
      entityType: ENTITY,
      messageId: `tg-${messageId}`,
      text,
      role: 'user',
      direction: 'inbound',
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

  if (dbUser.role === 'field_worker' && looksUrgent(text)) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ Urgent report from ${user.name} (Telegram):\n\n"${text.slice(0, 300)}"\n\nButler replied with guidance. Please review in Trovara OS.`,
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

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: `tg-${msg.message_id}`,
    text: caption ? `[photo] ${caption}` : '[photo]',
    role: 'user',
    direction: 'inbound',
    extra: { kind: 'image' },
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
      const opsCmd = await tryHandleStaffOpsCommand({
        actor: toActor(dbUser),
        text: caption,
        photoUrl,
      })
      if (opsCmd.handled) {
        await sendTelegramMessage(chatId, opsCmd.reply ?? 'Done.', {
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

  if (dbUser.role === 'field_worker' && caption && looksUrgent(caption)) {
    await notifyWorkerAlertChannels(
      user.farmId,
      `⚠️ ${user.name} sent a photo on Telegram with note: "${caption.slice(0, 200)}". Butler sent a diagnosis. Please review.`,
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

  await recordChatMessage({
    farmId: user.farmId,
    userId: user.id,
    entityType: ENTITY,
    messageId: `tg-${msg.message_id}`,
    text: transcript,
    role: 'user',
    direction: 'inbound',
    extra: { kind: 'voice' },
  })

  // Route voice through the same structured command path as text (tasks, orders, lots…).
  await handleLinkedText(dbUser, chatId, msg.message_id, transcript, {
    skipUserLog: true,
    inboundWasVoice: true,
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
