import type { SessionUser } from './session.js'
import { db } from '../db/index.js'
import { fieldReports } from '../db/schema.js'
import { hasPermission } from './rbac.js'
import type { PermissionKey } from './permissions.js'
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
  applyConfirmedOpsDraft,
  parseAssetCountIntent,
  parseCensusIntent,
  parseCreateTaskIntent,
  prepareAssetCountDraft,
  prepareCensusDraft,
  prepareCreateTaskDraft,
} from './action-draft-ops.js'
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
  cancelActionDraft,
  confirmActionDraft,
  getPendingActionDraft,
  storeActionDraft,
} from './task-drafts.js'
import { canonicalDraftPayload } from './draft-canonical.js'
import { logAudit } from './audit.js'
import { notifyWorkerAlertChannels } from './farm-notify.js'
import { createSupportTicket } from './support-tickets.js'

export type AiActionDraft = {
  draftId: string
  actionType: string
  preview: string
}

const ACTION_PERMISSION: Record<string, PermissionKey> = {
  create_task: 'tasks.assign',
  stock_move: 'inventory.write',
  opening_count: 'inventory.write',
  low_stock_ack: 'inventory.write',
  create_zone: 'zones.manage',
  create_plot: 'zones.manage',
  livestock_log: 'livestock.log',
  create_census: 'census.create',
  asset_count: 'assets.count',
  create_field_report: 'field_reports.create',
  create_support_ticket: 'orders.manage',
}

export function aiActionCapabilities(user: SessionUser) {
  return Object.entries(ACTION_PERMISSION).map(([actionType, permission]) => ({
    actionType,
    permission,
    allowed: hasPermission(user, permission),
  }))
}

function permissionError(user: SessionUser, actionType: string): string | null {
  const permission = ACTION_PERMISSION[actionType]
  if (!permission || hasPermission(user, permission)) return null
  return `You do not have permission to perform this action (${permission}).`
}

type PrepareResult =
  | { handled: false }
  | { handled: true; draft?: AiActionDraft; error?: string }

function prepared(actionType: string, result: { ok: true; draftId: string; preview: string } | { ok: false; error: string }): PrepareResult {
  if (!result.ok) return { handled: true, error: result.error }
  return { handled: true, draft: { actionType, draftId: result.draftId, preview: result.preview } }
}

/** Parse only explicit command grammars; ordinary questions can never become writes. */
export async function prepareAiAction(params: {
  user: SessionUser
  text: string
  conversationId: string
  authorLocale?: string | null
}): Promise<PrepareResult> {
  const common = { user: params.user, channel: 'web', externalChatId: params.conversationId }

  const fieldReport = params.text.trim().match(
    /^field\s+report\s*:\s*category\s*=\s*(observation|crop|livestock|equipment|safety|theft|other)\s+severity\s*=\s*(normal|urgent|critical)\s+description\s*=\s*(.+)$/i,
  )
  if (fieldReport) {
    const denied = permissionError(params.user, 'create_field_report')
    if (denied) return { handled: true, error: denied }
    const payload = {
      category: fieldReport[1]!.toLowerCase(),
      severity: fieldReport[2]!.toLowerCase(),
      description: fieldReport[3]!.trim().slice(0, 4000),
    }
    const stored = await storeActionDraft({
      userId: params.user.id,
      farmId: params.user.farmId,
      actionType: 'create_field_report',
      payload,
      channel: 'web',
      externalChatId: params.conversationId,
    })
    return {
      handled: true,
      draft: {
        draftId: stored.id,
        actionType: 'create_field_report',
        preview: `Draft field report:\nCategory: ${payload.category}\nSeverity: ${payload.severity}\nDescription: ${payload.description}`,
      },
    }
  }

  const support = params.text.trim().match(
    /^support\s+ticket\s*:\s*category\s*=\s*(complaint|delivery|quality|payment|other)\s+priority\s*=\s*(low|normal|urgent)\s+description\s*=\s*(.+)$/i,
  )
  if (support) {
    const denied = permissionError(params.user, 'create_support_ticket')
    if (denied) return { handled: true, error: denied }
    const payload = {
      category: support[1]!.toLowerCase(),
      priority: support[2]!.toLowerCase(),
      description: support[3]!.trim().slice(0, 4000),
    }
    const stored = await storeActionDraft({
      userId: params.user.id,
      farmId: params.user.farmId,
      actionType: 'create_support_ticket',
      payload,
      channel: 'web',
      externalChatId: params.conversationId,
    })
    return {
      handled: true,
      draft: {
        draftId: stored.id,
        actionType: 'create_support_ticket',
        preview: `Draft support ticket:\nCategory: ${payload.category}\nPriority: ${payload.priority}\nDescription: ${payload.description}`,
      },
    }
  }

  const task = parseCreateTaskIntent(params.text)
  if (task) {
    const denied = permissionError(params.user, 'create_task')
    if (denied) return { handled: true, error: denied }
    return prepared('create_task', await prepareCreateTaskDraft({ ...common, ...task }))
  }
  const stock = parseStockMoveIntent(params.text)
  if (stock) {
    const denied = permissionError(params.user, 'stock_move')
    if (denied) return { handled: true, error: denied }
    return prepared('stock_move', await prepareStockMoveDraft({ ...common, ...stock }))
  }
  const opening = parseOpeningCountIntent(params.text)
  if (opening) {
    const denied = permissionError(params.user, 'opening_count')
    if (denied) return { handled: true, error: denied }
    return prepared('opening_count', await prepareOpeningCountDraft({ ...common, ...opening }))
  }
  const lowStock = parseLowStockAckIntent(params.text)
  if (lowStock) {
    const denied = permissionError(params.user, 'low_stock_ack')
    if (denied) return { handled: true, error: denied }
    return prepared('low_stock_ack', await prepareLowStockAckDraft({ ...common, ...lowStock }))
  }
  const zone = parseCreateZoneIntent(params.text)
  if (zone) {
    const denied = permissionError(params.user, 'create_zone')
    if (denied) return { handled: true, error: denied }
    return prepared('create_zone', await prepareCreateZoneDraft({ ...common, ...zone }))
  }
  const plot = parseCreatePlotIntent(params.text)
  if (plot) {
    const denied = permissionError(params.user, 'create_plot')
    if (denied) return { handled: true, error: denied }
    return prepared('create_plot', await prepareCreatePlotDraft({ ...common, ...plot }))
  }
  const livestock = parseLivestockLogIntent(params.text)
  if (livestock) {
    const denied = permissionError(params.user, 'livestock_log')
    if (denied) return { handled: true, error: denied }
    return prepared('livestock_log', await prepareLivestockLogDraft({ ...common, ...livestock }))
  }
  const census = parseCensusIntent(params.text)
  if (census) {
    const denied = permissionError(params.user, 'create_census')
    if (denied) return { handled: true, error: denied }
    return prepared('create_census', await prepareCensusDraft({ ...common, ...census, authorLocale: params.authorLocale }))
  }
  const asset = parseAssetCountIntent(params.text)
  if (asset) {
    const denied = permissionError(params.user, 'asset_count')
    if (denied) return { handled: true, error: denied }
    return prepared('asset_count', await prepareAssetCountDraft({ ...common, ...asset }))
  }
  return { handled: false }
}

export async function confirmAiAction(user: SessionUser, draftId: string) {
  const pending = await getPendingActionDraft(draftId, user.id)
  if (!pending || pending.farmId !== user.farmId || pending.channel !== 'web') {
    return { ok: false as const, error: 'Draft expired, already used, or unavailable.' }
  }
  const denied = permissionError(user, pending.actionType)
  if (denied) return { ok: false as const, error: denied }

  const confirmed = await confirmActionDraft(draftId, user.id)
  if (!confirmed) return { ok: false as const, error: 'Draft expired or already used.' }
  const canonical = await canonicalDraftPayload(confirmed)
  const apply = async () => {
    if (confirmed.actionType === 'create_field_report') {
      const category = String(canonical.payload.category ?? '')
      const severity = String(canonical.payload.severity ?? '')
      const description = String(canonical.payload.description ?? '').trim()
      if (!category || !severity || !description) return 'Draft was missing field report details.'
      const [report] = await db
        .insert(fieldReports)
        .values({
          farmId: user.farmId,
          createdById: user.id,
          category,
          severity,
          description,
        })
        .returning({ id: fieldReports.id })
      await logAudit({
        farmId: user.farmId,
        userId: user.id,
        action: 'create',
        entityType: 'field_report',
        entityId: report.id,
        metadata: { category, severity, source: 'web_copilot' },
      })
      if (severity !== 'normal' || category === 'theft') {
        void notifyWorkerAlertChannels(
          user.farmId,
          `Urgent field report from ${user.name}: ${description.slice(0, 500)}`,
          { actorUserId: user.id, reason: 'field_report' },
        ).catch(() => undefined)
      }
      return `✅ Field report created (${category}, ${severity}).`
    }
    if (confirmed.actionType === 'create_support_ticket') {
      const description = String(canonical.payload.description ?? '').trim()
      if (!description) return 'Draft was missing the support description.'
      const ticket = await createSupportTicket({
        farmId: user.farmId,
        description,
        category: String(canonical.payload.category ?? 'complaint') as 'complaint' | 'delivery' | 'quality' | 'payment' | 'other',
        priority: String(canonical.payload.priority ?? 'normal') as 'low' | 'normal' | 'urgent',
        actorUserId: user.id,
      })
      return `✅ Support ticket created: ${ticket.reference}`
    }
    const ops = await applyConfirmedOpsDraft(user, confirmed.actionType, canonical.payload, 'ai_confirm', canonical.locale)
    if (ops != null) return ops
    const inventory = await applyConfirmedInventoryDraft(user, confirmed.actionType, canonical.payload, 'ai_confirm', canonical.locale)
    if (inventory != null) return inventory
    const zones = await applyConfirmedZoneDraft(user, confirmed.actionType, canonical.payload, 'ai_confirm')
    if (zones != null) return zones
    return applyConfirmedLivestockLogDraft(user, confirmed.actionType, canonical.payload, 'ai_confirm', canonical.locale)
  }
  const result = await apply()
  if (result == null) return { ok: false as const, error: 'This action is not supported in Copilot.' }

  await logAudit({
    farmId: user.farmId,
    userId: user.id,
    action: 'confirm',
    entityType: 'ai_action',
    entityId: draftId,
    metadata: { actionType: confirmed.actionType, source: 'web_copilot' },
  })
  return {
    ok: true as const,
    result,
    actionType: confirmed.actionType,
    conversationId: confirmed.externalChatId,
  }
}

export async function cancelAiAction(user: SessionUser, draftId: string) {
  const pending = await getPendingActionDraft(draftId, user.id)
  if (!pending || pending.farmId !== user.farmId || pending.channel !== 'web') return null
  const ok = await cancelActionDraft(draftId, user.id)
  return ok ? { conversationId: pending.externalChatId } : null
}
