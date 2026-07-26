import { and, eq, lt, ne, or, isNull, sql, gte } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  assets,
  assetLogs,
  inventoryItems,
  livestockBatches,
  livestockLogs,
  orders,
  plots,
  tasks,
  users,
} from '../db/schema.js'
import type { SessionUser } from './session.js'
import {
  plotsMissingVerifiedCensus,
  rejectedCensusSurveys,
  staleVerifiedCensus,
} from './census-service.js'
import {
  renderException,
  type ExceptionMessageKey,
  type ExceptionParams,
} from './exception-messages.js'

export type ExceptionType =
  | 'overdue_task'
  | 'low_stock'
  | 'pending_approval'
  | 'mortality_today'
  | 'order_pending'
  | 'rejected_task'
  | 'asset_log_missing'
  | 'asset_verification_pending'
  | 'census_missing'
  | 'census_rejected'
  | 'census_stale'
  | 'weather_rain'
  | 'weather_heat'
  | 'weather_wind'
  | 'weather_cold'

export type ExceptionItem = {
  type: ExceptionType
  severity: 'high' | 'medium'
  /** English copy; clients that can translate should prefer the keys below. */
  title: string
  message: string
  entityType: string
  entityId: string
  timestamp: string
  metadata?: Record<string, unknown>
  /** Absent when the title is an entity name (block, item, task) that must not translate. */
  titleKey?: ExceptionMessageKey
  titleParams?: ExceptionParams
  messageKey?: ExceptionMessageKey
  messageParams?: ExceptionParams
}

export type ActionItem = {
  priority: number
  action: string
  label: string
  entityType: string
  entityId: string
  link: string
  labelKey?: ExceptionMessageKey
  labelParams?: ExceptionParams
  /** Copied from the source exception so clients can localize the nested title. */
  titleKey?: ExceptionMessageKey
  titleParams?: ExceptionParams
}

export type ExceptionSummary = {
  overdueTasks: number
  lowStock: number
  pendingApprovals: number
  mortalityToday: number
  ordersPending: number
  rejectedTasks: number
  assetLogsMissing: number
  assetVerificationPending: number
  censusMissing: number
  censusRejected: number
  censusStale: number
  weatherAlerts: number
  total: number
}

const HOUR_MS = 60 * 60 * 1000

/** Shared by the census query and the message so the two cannot disagree. */
const CENSUS_STALE_DAYS = 30

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

/** English copy plus the key/params a translating client needs. */
function titleFields(key: ExceptionMessageKey, params?: ExceptionParams) {
  return {
    title: renderException(key, 'en', params),
    titleKey: key,
    ...(params ? { titleParams: params } : {}),
  }
}

function messageFields(key: ExceptionMessageKey, params?: ExceptionParams) {
  return {
    message: renderException(key, 'en', params),
    messageKey: key,
    ...(params ? { messageParams: params } : {}),
  }
}

export async function gatherExceptions(user: SessionUser): Promise<{
  exceptions: ExceptionItem[]
  actionList: ActionItem[]
  summary: ExceptionSummary
}> {
  const now = new Date()
  const overdueCutoff = new Date(now.getTime() - 24 * HOUR_MS)
  const approvalCutoff = new Date(now.getTime() - 12 * HOUR_MS)
  const orderCutoff = new Date(now.getTime() - 48 * HOUR_MS)
  const todayStart = startOfToday()

  const isWorker = user.role === 'field_worker'
  const isSales = user.role === 'sales'
  const skipFieldOps = isWorker || isSales
  const farmFilter = eq(tasks.farmId, user.farmId)
  const workerTaskFilter = isWorker
    ? and(farmFilter, eq(tasks.assignedToId, user.id))
    : farmFilter

  const [
    overdueRows,
    lowStockRows,
    pendingApprovalRows,
    mortalityRows,
    pendingOrderRows,
    rejectedRows,
    activeAssetRows,
    loggedTodayRows,
    pendingAssetVerificationRows,
    missingCensusPlots,
    rejectedCensusRows,
    staleCensusPlots,
  ] = await Promise.all([
    isSales
      ? Promise.resolve([])
      : db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        dueDate: tasks.dueDate,
        plotName: plots.name,
        assignedToName: users.name,
      })
      .from(tasks)
      .leftJoin(plots, eq(tasks.plotId, plots.id))
      .leftJoin(users, eq(tasks.assignedToId, users.id))
      .where(
        and(
          workerTaskFilter,
          sql`${tasks.dueDate} IS NOT NULL`,
          lt(tasks.dueDate, overdueCutoff),
          ne(tasks.status, 'completed'),
        ),
      )
      .orderBy(tasks.dueDate),
    isWorker
      ? Promise.resolve([])
      : db
          .select()
          .from(inventoryItems)
          .where(
            and(
              eq(inventoryItems.farmId, user.farmId),
              sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
            ),
          ),
    skipFieldOps
      ? Promise.resolve([])
      : db
          .select({
            id: tasks.id,
            title: tasks.title,
            updatedAt: tasks.updatedAt,
            assignedToName: users.name,
          })
          .from(tasks)
          .leftJoin(users, eq(tasks.assignedToId, users.id))
          .where(
            and(
              eq(tasks.farmId, user.farmId),
              eq(tasks.status, 'awaiting_approval'),
              lt(tasks.updatedAt, approvalCutoff),
            ),
          )
          .orderBy(tasks.updatedAt),
    skipFieldOps
      ? Promise.resolve([])
      : db
          .select({
            id: livestockLogs.id,
            headCount: livestockLogs.headCount,
            notes: livestockLogs.notes,
            createdAt: livestockLogs.createdAt,
            batchName: livestockBatches.name,
          })
          .from(livestockLogs)
          .innerJoin(livestockBatches, eq(livestockLogs.batchId, livestockBatches.id))
          .where(
            and(
              eq(livestockLogs.farmId, user.farmId),
              eq(livestockLogs.logType, 'mortality'),
              gte(livestockLogs.createdAt, todayStart),
            ),
          )
          .orderBy(livestockLogs.createdAt),
    isWorker
      ? Promise.resolve([])
      : db
          .select({
            id: orders.id,
            customerName: orders.customerName,
            totalAmount: orders.totalAmount,
            currency: orders.currency,
            createdAt: orders.createdAt,
          })
          .from(orders)
          .where(
            and(
              eq(orders.farmId, user.farmId),
              eq(orders.status, 'pending'),
              lt(orders.createdAt, orderCutoff),
            ),
          )
          .orderBy(orders.createdAt),
    isSales
      ? Promise.resolve([])
      : db
      .select({
        id: tasks.id,
        title: tasks.title,
        updatedAt: tasks.updatedAt,
        assignedToName: users.name,
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignedToId, users.id))
      .where(and(workerTaskFilter, eq(tasks.status, 'rejected')))
      .orderBy(tasks.updatedAt),
    // Asset alerts are Founder/supervisor concerns - skipped for workers and sales.
    skipFieldOps
      ? Promise.resolve([])
      : db
          .select({ id: assets.id, name: assets.name })
          .from(assets)
          .where(and(eq(assets.farmId, user.farmId), eq(assets.active, true))),
    skipFieldOps
      ? Promise.resolve([])
      : db
          .selectDistinct({ assetId: assetLogs.assetId })
          .from(assetLogs)
          .where(and(eq(assetLogs.farmId, user.farmId), gte(assetLogs.logDate, todayStart))),
    skipFieldOps
      ? Promise.resolve([])
      : db
          .select({
            id: assetLogs.id,
            assetName: assets.name,
            recordedByName: users.name,
            createdAt: assetLogs.createdAt,
          })
          .from(assetLogs)
          .innerJoin(assets, eq(assetLogs.assetId, assets.id))
          .leftJoin(users, eq(assetLogs.recordedById, users.id))
          .where(
            and(eq(assetLogs.farmId, user.farmId), eq(assetLogs.verificationStatus, 'reported')),
          )
          .orderBy(assetLogs.createdAt),
    skipFieldOps
      ? Promise.resolve([])
      : plotsMissingVerifiedCensus(user.farmId),
    skipFieldOps
      ? Promise.resolve([])
      : rejectedCensusSurveys(user.farmId),
    skipFieldOps ? Promise.resolve([]) : staleVerifiedCensus(user.farmId, CENSUS_STALE_DAYS),
  ])

  const loggedTodayAssetIds = new Set(
    (loggedTodayRows as Array<{ assetId: string }>).map((r) => r.assetId),
  )
  const missingAssetRows = (activeAssetRows as Array<{ id: string; name: string }>).filter(
    (a) => !loggedTodayAssetIds.has(a.id),
  )

  const exceptions: ExceptionItem[] = []

  for (const t of overdueRows) {
    exceptions.push({
      type: 'overdue_task',
      severity: 'high',
      title: t.title,
      ...(t.dueDate
        ? messageFields('exceptions.msg.overdueSince', { since: t.dueDate.toISOString() })
        : messageFields('exceptions.msg.overdueSinceUnknown')),
      entityType: 'task',
      entityId: t.id,
      timestamp: (t.dueDate ?? now).toISOString(),
      metadata: {
        status: t.status,
        plotName: t.plotName,
        assignedToName: t.assignedToName,
      },
    })
  }

  for (const item of lowStockRows) {
    exceptions.push({
      type: 'low_stock',
      severity: 'medium',
      title: item.name,
      ...messageFields('exceptions.msg.lowStock', {
        quantity: item.quantity,
        unit: item.unit,
        reorderLevel: item.reorderLevel,
      }),
      entityType: 'inventory_item',
      entityId: item.id,
      timestamp: item.updatedAt.toISOString(),
      metadata: {
        quantity: item.quantity,
        reorderLevel: item.reorderLevel,
        unit: item.unit,
        category: item.category,
      },
    })
  }

  for (const t of pendingApprovalRows) {
    exceptions.push({
      type: 'pending_approval',
      severity: 'medium',
      title: t.title,
      ...messageFields('exceptions.msg.awaitingApproval', {
        assignee: t.assignedToName ?? 'exceptions.unassigned',
      }),
      entityType: 'task',
      entityId: t.id,
      timestamp: t.updatedAt.toISOString(),
      metadata: { assignedToName: t.assignedToName },
    })
  }

  for (const log of mortalityRows) {
    exceptions.push({
      type: 'mortality_today',
      severity: 'high',
      ...titleFields('exceptions.title.batchMortality', { batch: log.batchName }),
      ...(log.notes
        ? messageFields('exceptions.msg.mortalityWithNotes', {
            count: log.headCount ?? 0,
            notes: log.notes,
          })
        : messageFields('exceptions.msg.mortality', { count: log.headCount ?? 0 })),
      entityType: 'livestock_log',
      entityId: log.id,
      timestamp: log.createdAt.toISOString(),
      metadata: { batchName: log.batchName, headCount: log.headCount },
    })
  }

  for (const o of pendingOrderRows) {
    exceptions.push({
      type: 'order_pending',
      severity: 'medium',
      ...titleFields('exceptions.title.order', { customer: o.customerName }),
      ...messageFields('exceptions.msg.orderPending', {
        currency: o.currency,
        amount: o.totalAmount,
      }),
      entityType: 'order',
      entityId: o.id,
      timestamp: o.createdAt.toISOString(),
      metadata: { customerName: o.customerName, totalAmount: o.totalAmount },
    })
  }

  for (const t of rejectedRows) {
    exceptions.push({
      type: 'rejected_task',
      severity: 'high',
      title: t.title,
      ...messageFields('exceptions.msg.rejectedResubmit', {
        assignee: t.assignedToName ?? 'exceptions.unassigned',
      }),
      entityType: 'task',
      entityId: t.id,
      timestamp: t.updatedAt.toISOString(),
      metadata: { assignedToName: t.assignedToName },
    })
  }

  for (const a of missingAssetRows) {
    exceptions.push({
      type: 'asset_log_missing',
      severity: 'medium',
      title: a.name,
      ...messageFields('exceptions.msg.noDailyLog'),
      entityType: 'asset',
      entityId: a.id,
      timestamp: now.toISOString(),
    })
  }

  for (const log of pendingAssetVerificationRows as Array<{
    id: string
    assetName: string | null
    recordedByName: string | null
    createdAt: Date
  }>) {
    exceptions.push({
      type: 'asset_verification_pending',
      severity: 'medium',
      ...(log.assetName ? { title: log.assetName } : titleFields('exceptions.title.assetLog')),
      ...messageFields('exceptions.msg.reportedNeedsVerification', {
        reporter: log.recordedByName ?? 'exceptions.staff',
      }),
      entityType: 'asset_log',
      entityId: log.id,
      timestamp: log.createdAt.toISOString(),
      metadata: { recordedByName: log.recordedByName },
    })
  }

  for (const plot of missingCensusPlots as Array<{ id: string; name: string }>) {
    exceptions.push({
      type: 'census_missing',
      severity: 'medium',
      title: plot.name,
      ...messageFields('exceptions.msg.noCensus'),
      entityType: 'plot',
      entityId: plot.id,
      timestamp: now.toISOString(),
    })
  }

  for (const survey of rejectedCensusRows as Array<{
    id: string
    plotName: string | null
    cropType: string
    rejectionReason: string | null
    createdAt: Date
  }>) {
    exceptions.push({
      type: 'census_rejected',
      severity: 'high',
      ...titleFields('exceptions.title.censusSurvey', {
        plot: survey.plotName ?? 'exceptions.block',
        crop: survey.cropType,
      }),
      ...(survey.rejectionReason
        ? messageFields('exceptions.msg.censusRejectedWithReason', {
            reason: survey.rejectionReason,
          })
        : messageFields('exceptions.msg.censusRejected')),
      entityType: 'crop_census_survey',
      entityId: survey.id,
      timestamp: survey.createdAt.toISOString(),
      metadata: { cropType: survey.cropType, plotName: survey.plotName },
    })
  }

  for (const plot of staleCensusPlots as Array<{
    id: string
    name: string
    lastVerifiedAt: Date
  }>) {
    exceptions.push({
      type: 'census_stale',
      severity: 'medium',
      title: plot.name,
      ...messageFields('exceptions.msg.censusStale', {
        days: CENSUS_STALE_DAYS,
        lastVerified: plot.lastVerifiedAt.toISOString(),
      }),
      entityType: 'plot',
      entityId: plot.id,
      timestamp: plot.lastVerifiedAt.toISOString(),
    })
  }

  const actionList = buildActionList(exceptions)

  const summary: ExceptionSummary = {
    overdueTasks: overdueRows.length,
    lowStock: lowStockRows.length,
    pendingApprovals: pendingApprovalRows.length,
    mortalityToday: mortalityRows.length,
    ordersPending: pendingOrderRows.length,
    rejectedTasks: rejectedRows.length,
    assetLogsMissing: missingAssetRows.length,
    assetVerificationPending: pendingAssetVerificationRows.length,
    censusMissing: (missingCensusPlots as unknown[]).length,
    censusRejected: (rejectedCensusRows as unknown[]).length,
    censusStale: (staleCensusPlots as unknown[]).length,
    weatherAlerts: 0,
    total: exceptions.length,
  }

  return { exceptions, actionList, summary }
}

const ACTION_BY_EXCEPTION: Record<
  ExceptionType,
  { action: string; labelKey: ExceptionMessageKey; link: string }
> = {
  pending_approval: {
    action: 'approve_task',
    labelKey: 'exceptions.action.approve',
    link: '/tasks',
  },
  low_stock: { action: 'restock_item', labelKey: 'exceptions.action.restock', link: '/inventory' },
  order_pending: {
    action: 'confirm_order',
    labelKey: 'exceptions.action.confirmOrder',
    link: '/sales',
  },
  rejected_task: {
    action: 'resubmit_task',
    labelKey: 'exceptions.action.resubmit',
    link: '/tasks',
  },
  overdue_task: {
    action: 'review_task',
    labelKey: 'exceptions.action.reviewOverdue',
    link: '/tasks',
  },
  mortality_today: {
    action: 'review_mortality',
    labelKey: 'exceptions.action.reviewMortality',
    link: '/livestock',
  },
  asset_log_missing: {
    action: 'log_asset',
    labelKey: 'exceptions.action.logEquipment',
    link: '/assets',
  },
  asset_verification_pending: {
    action: 'verify_asset',
    labelKey: 'exceptions.action.verifyAssetLog',
    link: '/assets',
  },
  census_missing: {
    action: 'record_census',
    labelKey: 'exceptions.action.recordCensus',
    link: '/zones',
  },
  census_rejected: {
    action: 'resubmit_census',
    labelKey: 'exceptions.action.resubmitCensus',
    link: '/zones',
  },
  census_stale: {
    action: 'refresh_census',
    labelKey: 'exceptions.action.refreshStaleCensus',
    link: '/zones',
  },
  weather_rain: { action: 'review_weather', labelKey: 'exceptions.action.weather', link: '/today' },
  weather_heat: { action: 'review_weather', labelKey: 'exceptions.action.weather', link: '/today' },
  weather_wind: { action: 'review_weather', labelKey: 'exceptions.action.weather', link: '/today' },
  weather_cold: { action: 'review_weather', labelKey: 'exceptions.action.weather', link: '/today' },
}

function buildActionList(exceptions: ExceptionItem[]): ActionItem[] {
  const actions: ActionItem[] = []
  let priority = 1

  for (const ex of exceptions) {
    const entry = ACTION_BY_EXCEPTION[ex.type]
    if (!entry) continue

    // Orders read better under the customer's name than the "Order: X" title.
    // The override replaces the exception's title key rather than nesting
    // inside it, or a translating client renders "Confirm order: Order: Ada".
    const overrideTitle =
      ex.type === 'order_pending' ? String(ex.metadata?.customerName ?? ex.title) : null
    const labelParams: ExceptionParams = { title: overrideTitle ?? ex.title }

    actions.push({
      priority: priority++,
      action: entry.action,
      label: renderException(entry.labelKey, 'en', labelParams),
      labelKey: entry.labelKey,
      labelParams,
      entityType: ex.entityType,
      entityId: ex.entityId,
      link: entry.link,
      ...(overrideTitle === null && ex.titleKey ? { titleKey: ex.titleKey } : {}),
      ...(overrideTitle === null && ex.titleParams ? { titleParams: ex.titleParams } : {}),
    })
  }

  return actions.sort((a, b) => a.priority - b.priority)
}

export async function gatherWorkerTodayTasks(user: SessionUser) {
  const todayStart = startOfToday()
  const tomorrowStart = new Date(todayStart)
  tomorrowStart.setDate(tomorrowStart.getDate() + 1)

  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      dueDate: tasks.dueDate,
      plotId: tasks.plotId,
      plotName: plots.name,
    })
    .from(tasks)
    .leftJoin(plots, eq(tasks.plotId, plots.id))
    .where(
      and(
        eq(tasks.farmId, user.farmId),
        eq(tasks.assignedToId, user.id),
        ne(tasks.status, 'completed'),
        or(isNull(tasks.dueDate), lt(tasks.dueDate, tomorrowStart)),
      ),
    )
    .orderBy(tasks.dueDate)
}
