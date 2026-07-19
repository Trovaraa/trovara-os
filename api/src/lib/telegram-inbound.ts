import { and, eq, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assetLogs, assets, plots, tasks, users } from '../db/schema.js'
import type { SessionUser } from './session.js'
import { recordFarmEvent } from './farm-events.js'
import { verifyAndConsumeLinkCode, resolveActiveTelegramLink } from './butler-link-codes.js'
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
  salesOpsHelp,
  staffOpsHelp,
  tryHandleStaffOpsCommand,
  transitionTaskFromCallback,
} from './staff-ops.js'
import { processEvidenceValue } from './evidence-store.js'
import type { PreferredLocale } from '../db/schema.js'
import { formatHandoverProgressText, getHandoverProgress } from './handover-templates.js'
import {
  cancelActionDraft,
  confirmActionDraft,
  getLatestPendingDraft,
  markTelegramUpdateProcessed,
  mergeActionDraftPayload,
  storeActionDraft,
  storeTaskDraft,
  wasTelegramUpdateProcessed,
} from './task-drafts.js'
import {
  enrichHarvestLot,
  findLotByCode,
  listIncompleteLots,
} from './harvest-lots.js'
import {
  buildLotQrPng,
  findPrintableLotByCode,
  findPrintableLotById,
  listRecentPrintableLots,
  printQrPickerKeyboard,
  type PrintableLot,
} from './lot-print.js'
import { normalizeLotUnit } from './lot-codes.js'
import { createCensusSurvey } from './census-service.js'
import { logAudit } from './audit.js'
import {
  answerTelegramCallbackQuery,
  confirmCancelKeyboard,
  downloadTelegramFile,
  downloadTelegramFileBuffer,
  sendTelegramMessage,
  sendTelegramPhoto,
  startTelegramPollLoop,
  type TelegramUpdate,
} from './telegram.js'

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
  '• Generate a link code in Trovara Settings → Connect Telegram, then send: /link CODE',
].join('\n')

const LINK_CODE_FAIL_MSG =
  'Invalid or expired link code. Generate a new code in Trovara Settings → Connect Telegram.'

function parseCreateTaskIntent(text: string): { title: string } | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^(?:create(?:\s+a)?\s+)?(?:task|handover\s+task)\s*[:\-–]?\s*(.+)$/i,
  )
  if (match?.[1]) return { title: match[1].trim().slice(0, 200) }
  if (/^create\s+.+/i.test(trimmed) && /task/i.test(trimmed)) {
    return { title: trimmed.replace(/^create\s+/i, '').slice(0, 200) }
  }
  return null
}

/** Census: <block> crop=<type> count=<n> [min=<n>] [max=<n>] */
function parseCensusIntent(text: string): {
  blockName: string
  cropType: string
  plantCount: number
  minHeight?: number
  maxHeight?: number
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^census\s*[:\-–]?\s*(.+?)\s+crop\s*=\s*(\S+)\s+count\s*=\s*(\d+)(?:\s+min\s*=\s*([\d.]+))?(?:\s+max\s*=\s*([\d.]+))?$/i,
  )
  if (!match) return null
  return {
    blockName: match[1].trim(),
    cropType: match[2].trim(),
    plantCount: Number(match[3]),
    minHeight: match[4] != null ? Number(match[4]) : undefined,
    maxHeight: match[5] != null ? Number(match[5]) : undefined,
  }
}

/** Asset count: <asset name or tag> available=<n> [damaged=<n>] */
function parseAssetCountIntent(text: string): {
  assetQuery: string
  countAvailable: number
  countDamaged: number
} | null {
  const trimmed = text.trim()
  const match = trimmed.match(
    /^asset(?:\s+count)?\s*[:\-–]?\s*(.+?)\s+available\s*=\s*(\d+)(?:\s+damaged\s*=\s*(\d+))?$/i,
  )
  if (!match) return null
  return {
    assetQuery: match[1].trim(),
    countAvailable: Number(match[2]),
    countDamaged: match[3] != null ? Number(match[3]) : 0,
  }
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
  const farmPlots = await db
    .select({ id: plots.id, name: plots.name })
    .from(plots)
    .where(and(eq(plots.farmId, user.farmId), eq(plots.active, true)))

  const plot = farmPlots.find(
    (p) => p.name.toLowerCase() === intent.blockName.toLowerCase(),
  )
  if (!plot) {
    await sendTelegramMessage(
      chatId,
      `Block "${intent.blockName}" not found. Use the exact block name from Zones.`,
    )
    return
  }

  const stored = await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'create_census',
    payload: {
      plotId: plot.id,
      plotName: plot.name,
      cropType: intent.cropType,
      plantCount: intent.plantCount,
      minHeight: intent.minHeight ?? null,
      maxHeight: intent.maxHeight ?? null,
      heightUnit: 'cm',
    },
    channel: 'telegram',
    externalChatId: String(chatId),
  })

  await sendTelegramMessage(
    chatId,
    [
      'Draft census ready — confirm to save:',
      '',
      `Block: ${plot.name}`,
      `Crop: ${intent.cropType}`,
      `Count: ${intent.plantCount}`,
      intent.minHeight != null || intent.maxHeight != null
        ? `Height: ${intent.minHeight ?? '?'}–${intent.maxHeight ?? '?'} cm`
        : null,
      '',
      'Tap Confirm or Cancel below.',
    ]
      .filter(Boolean)
      .join('\n'),
    { replyMarkup: confirmCancelKeyboard(stored.id) },
  )
}

async function offerAssetCountDraft(
  user: SessionUser,
  chatId: number,
  intent: NonNullable<ReturnType<typeof parseAssetCountIntent>>,
) {
  const farmAssets = await db
    .select({
      id: assets.id,
      name: assets.name,
      assetTag: assets.assetTag,
    })
    .from(assets)
    .where(and(eq(assets.farmId, user.farmId), eq(assets.active, true)))

  const q = intent.assetQuery.toLowerCase()
  const asset = farmAssets.find(
    (a) =>
      a.name.toLowerCase() === q ||
      (a.assetTag != null && a.assetTag.toLowerCase() === q),
  )
  if (!asset) {
    await sendTelegramMessage(
      chatId,
      `Asset "${intent.assetQuery}" not found. Use the exact asset name or tag.`,
    )
    return
  }

  const stored = await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'asset_count',
    payload: {
      assetId: asset.id,
      assetName: asset.name,
      countAvailable: intent.countAvailable,
      countDamaged: intent.countDamaged,
      condition: intent.countDamaged > 0 ? 'damaged' : 'good',
    },
    channel: 'telegram',
    externalChatId: String(chatId),
  })

  await sendTelegramMessage(
    chatId,
    [
      'Draft asset count ready — confirm to save:',
      '',
      `Asset: ${asset.name}`,
      `Available: ${intent.countAvailable}`,
      `Damaged: ${intent.countDamaged}`,
      '',
      'Tap Confirm or Cancel below.',
    ].join('\n'),
    { replyMarkup: confirmCancelKeyboard(stored.id) },
  )
}

async function executeConfirmedCensus(
  user: SessionUser,
  payload: Record<string, unknown>,
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
  })

  return `✅ Census saved for ${payload.plotName ?? 'block'} · ${cropType} (${plantCount}). Awaiting verification.`
}

async function executeConfirmedAssetCount(
  user: SessionUser,
  payload: Record<string, unknown>,
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
    metadata: { source: 'telegram' },
  })

  return `✅ Asset count saved for ${asset.name}: ${countAvailable} available. Awaiting verification.`
}

async function offerTaskDraft(
  user: SessionUser,
  chatId: number,
  title: string,
  description?: string,
) {
  if (!canAssignTasks(user)) {
    await sendTelegramMessage(chatId, 'Only Admin or Supervisor can create tasks from Telegram.')
    return
  }

  const stored = await storeTaskDraft(
    user.id,
    user.farmId,
    { title, description },
    { channel: 'telegram', externalChatId: String(chatId) },
  )

  await sendTelegramMessage(
    chatId,
    [
      'Draft task ready — confirm to create:',
      '',
      `Title: ${title}`,
      description ? `Notes: ${description}` : null,
      '',
      'Tap Confirm or Cancel below.',
    ]
      .filter(Boolean)
      .join('\n'),
    { replyMarkup: confirmCancelKeyboard(stored.draftId) },
  )
}

async function executeConfirmedCreateTask(
  user: SessionUser,
  payload: Record<string, unknown>,
): Promise<string> {
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
    })
    .returning({ id: tasks.id, title: tasks.title })

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'create',
    entityType: 'task',
    entityId: task.id,
    metadata: { source: 'telegram_confirm' },
  })

  return `✅ Task created: ${task.title}`
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
    if (confirmed.actionType === 'create_task') {
      if (!canAssignTasks(user)) {
        await sendTelegramMessage(chatId, 'You are not allowed to confirm this action.')
        return
      }
      const result = await executeConfirmedCreateTask(user, confirmed.payload)
      await sendTelegramMessage(chatId, result)
      return
    }

    if (confirmed.actionType === 'create_census') {
      const result = await executeConfirmedCensus(user, confirmed.payload)
      await sendTelegramMessage(chatId, result)
      return
    }

    if (confirmed.actionType === 'asset_count') {
      const result = await executeConfirmedAssetCount(user, confirmed.payload)
      await sendTelegramMessage(chatId, result)
      return
    }

    if (confirmed.actionType === 'enrich_lot') {
      const payload = confirmed.payload as {
        lotId?: string
        productName?: string
        quantityKg?: number
        unit?: 'kg' | 'crates'
        plotId?: string | null
        publicNotes?: string | null
        internalNotes?: string | null
        photoUrl?: string | null
      }
      if (!payload.lotId) {
        await sendTelegramMessage(chatId, 'Draft is missing the lot id.')
        return
      }
      const result = await enrichHarvestLot({
        farmId: user.farmId,
        lotId: payload.lotId,
        userId: user.id,
        updates: {
          productName: payload.productName,
          quantityKg: payload.quantityKg,
          unit: payload.unit,
          plotId: payload.plotId,
          publicNotes: payload.publicNotes,
          internalNotes: canAssignTasks(user) ? payload.internalNotes : undefined,
          photoUrl: payload.photoUrl,
        },
      })
      if ('error' in result) {
        await sendTelegramMessage(chatId, result.error)
        return
      }
      await sendTelegramMessage(
        chatId,
        `Lot ${result.lot.lotCode} updated: ${result.lot.quantityKg} ${result.lot.unit}` +
          (result.lot.plotId ? ' · plot set' : '') +
          (result.lot.photoUrl ? ' · photo saved' : '') +
          '\nSupervisor can Verify it in Traceability when ready.',
      )
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
  const lots = await listIncompleteLots(user.farmId)
  if (!lots.length) {
    await sendTelegramMessage(chatId, 'No lots waiting for pack details. New customer orders create lots automatically.')
    return
  }
  const lines = lots.map(
    (lot, i) =>
      `${i + 1}. ${lot.lotCode} — ${lot.productName} (${lot.quantityKg} ${lot.unit})` +
      `${lot.plotId ? '' : ' · needs plot'}${lot.photoUrl ? '' : ' · needs photo'}`,
  )
  await sendTelegramMessage(
    chatId,
    [
      'Lots to pack / enrich:',
      '',
      ...lines,
      '',
      'Reply: pack LOTCODE',
      'Then: qty 12 crates | plot BLOCKNAME | notes public text',
      'Send a photo to attach it, then Confirm.',
    ].join('\n'),
  )
}

async function startLotEnrichDraft(user: SessionUser, chatId: number, lotCode: string) {
  const lot = await findLotByCode(user.farmId, lotCode.trim())
  if (!lot) {
    await sendTelegramMessage(chatId, `Lot not found: ${lotCode}`)
    return
  }

  const stored = await storeActionDraft({
    userId: user.id,
    farmId: user.farmId,
    actionType: 'enrich_lot',
    channel: 'telegram',
    externalChatId: String(chatId),
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

  await sendTelegramMessage(
    chatId,
    [
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
    { replyMarkup: confirmCancelKeyboard(stored.id) },
  )
}

async function applyLotEnrichText(user: SessionUser, chatId: number, text: string): Promise<boolean> {
  const draft = await getLatestPendingDraft(user.id, 'enrich_lot')
  if (!draft) return false

  const qtyMatch = text.match(/^qty\s+(\d+)\s*(kg|crates?|crate)?$/i)
  if (qtyMatch) {
    const quantityKg = Number(qtyMatch[1])
    const unit = normalizeLotUnit(qtyMatch[2] ?? (draft.payload.unit as string) ?? 'kg')
    await mergeActionDraftPayload(draft.id, user.id, { quantityKg, unit })
    await sendTelegramMessage(chatId, `Draft qty set to ${quantityKg} ${unit}. Confirm when ready.`, {
      replyMarkup: confirmCancelKeyboard(draft.id),
    })
    return true
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
      await sendTelegramMessage(chatId, `No plot named "${name}". Try exact block name from Zones.`)
      return true
    }
    await mergeActionDraftPayload(draft.id, user.id, { plotId: plot.id })
    await sendTelegramMessage(chatId, `Draft plot set to ${plot.name}. Confirm when ready.`, {
      replyMarkup: confirmCancelKeyboard(draft.id),
    })
    return true
  }

  const notesMatch = text.match(/^notes?\s+(.+)$/i)
  if (notesMatch) {
    await mergeActionDraftPayload(draft.id, user.id, { publicNotes: notesMatch[1].trim() })
    await sendTelegramMessage(chatId, 'Draft public notes saved. Confirm when ready.', {
      replyMarkup: confirmCancelKeyboard(draft.id),
    })
    return true
  }

  return false
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

  if (text === '/language' || text.toLowerCase() === 'language') {
    await promptLanguage(chatId, dbUser.preferredLocale)
    return
  }

  if (text === '/orders' || text.toLowerCase() === 'orders') {
    await sendTelegramMessage(chatId, orderCommandHelp(locale))
    if (dbUser.role === 'sales') {
      await sendTelegramMessage(chatId, salesOpsHelp(locale))
    }
    return
  }

  if (
    text === '/ops' ||
    text.toLowerCase() === 'ops' ||
    text === '/field' ||
    text.toLowerCase() === 'fieldhelp'
  ) {
    await sendTelegramMessage(chatId, staffOpsHelp(locale, dbUser.role))
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
    await startLotEnrichDraft(user, chatId, packMatch[1])
    return
  }

  if (await applyLotEnrichText(user, chatId, text)) return

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

  const enrichDraft = await getLatestPendingDraft(user.id, 'enrich_lot')
  if (enrichDraft) {
    try {
      const dataUrl = await downloadTelegramFile(fileId)
      await mergeActionDraftPayload(enrichDraft.id, user.id, { photoUrl: dataUrl })
      await sendTelegramMessage(chatId, 'Photo attached to lot draft. Confirm to save.', {
        replyMarkup: confirmCancelKeyboard(enrichDraft.id),
      })
    } catch {
      await sendTelegramMessage(chatId, 'Could not attach that photo. Please resend.')
    }
    return
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

  if (/^(?:done|complete|finish)\b/i.test(caption)) {
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
        await linkChat(chatId, u)
        await sendTelegramMessage(chatId, '✅ Connected successfully.')
        await promptLanguage(chatId, u.preferredLocale)
      } else {
        await sendTelegramMessage(
          chatId,
          'That number is not on any Trovara profile. Ask the Admin to add your phone, or use a link code from Settings.',
        )
      }
      return
    }

    const text = msg.text?.trim() ?? ''
    if (text.toLowerCase().startsWith('/link')) {
      const code = text.slice(5).trim()
      if (!code) {
        await sendTelegramMessage(chatId, LINK_CODE_FAIL_MSG)
        return
      }

      const u = await verifyAndConsumeLinkCode(code)
      if (u) {
        await linkChat(chatId, u)
        await sendTelegramMessage(chatId, '✅ Connected successfully.')
        await promptLanguage(chatId, u.preferredLocale)
      } else {
        await sendTelegramMessage(chatId, LINK_CODE_FAIL_MSG)
      }
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
