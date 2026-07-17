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
  title: string
  message: string
  entityType: string
  entityId: string
  timestamp: string
  metadata?: Record<string, unknown>
}

export type ActionItem = {
  priority: number
  action: string
  label: string
  entityType: string
  entityId: string
  link: string
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

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
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
    db
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
    isWorker
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
    isWorker
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
    db
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
    // Asset alerts are Founder/supervisor concerns - skipped for workers.
    isWorker
      ? Promise.resolve([])
      : db
          .select({ id: assets.id, name: assets.name })
          .from(assets)
          .where(and(eq(assets.farmId, user.farmId), eq(assets.active, true))),
    isWorker
      ? Promise.resolve([])
      : db
          .selectDistinct({ assetId: assetLogs.assetId })
          .from(assetLogs)
          .where(and(eq(assetLogs.farmId, user.farmId), gte(assetLogs.logDate, todayStart))),
    isWorker
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
    isWorker
      ? Promise.resolve([])
      : plotsMissingVerifiedCensus(user.farmId),
    isWorker
      ? Promise.resolve([])
      : rejectedCensusSurveys(user.farmId),
    isWorker ? Promise.resolve([]) : staleVerifiedCensus(user.farmId, 30),
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
      message: `Overdue since ${t.dueDate?.toISOString() ?? 'unknown'}`,
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
      message: `${item.quantity} ${item.unit} remaining (reorder at ${item.reorderLevel})`,
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
      message: `Awaiting approval for over 12h (${t.assignedToName ?? 'unassigned'})`,
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
      title: `${log.batchName} mortality`,
      message: `${log.headCount ?? 0} head lost${log.notes ? `: ${log.notes}` : ''}`,
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
      title: `Order: ${o.customerName}`,
      message: `Pending over 48h - ${o.currency} ${o.totalAmount}`,
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
      message: `Rejected - needs resubmit (${t.assignedToName ?? 'unassigned'})`,
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
      message: 'No daily log recorded yet today',
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
      title: log.assetName ?? 'Asset log',
      message: `Reported by ${log.recordedByName ?? 'staff'} - needs verification`,
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
      message: 'No verified crop census for this block',
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
      title: `${survey.plotName ?? 'Block'} · ${survey.cropType}`,
      message: survey.rejectionReason
        ? `Census rejected: ${survey.rejectionReason}`
        : 'Census rejected - needs resubmit',
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
      message: `Verified census older than 30 days (last ${plot.lastVerifiedAt.toISOString().slice(0, 10)})`,
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

function buildActionList(exceptions: ExceptionItem[]): ActionItem[] {
  const actions: ActionItem[] = []
  let priority = 1

  for (const ex of exceptions) {
    if (ex.type === 'pending_approval') {
      actions.push({
        priority: priority++,
        action: 'approve_task',
        label: `Approve: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/tasks',
      })
    } else if (ex.type === 'low_stock') {
      actions.push({
        priority: priority++,
        action: 'restock_item',
        label: `Restock: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/inventory',
      })
    } else if (ex.type === 'order_pending') {
      actions.push({
        priority: priority++,
        action: 'confirm_order',
        label: `Confirm order: ${ex.metadata?.customerName ?? ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/sales',
      })
    } else if (ex.type === 'rejected_task') {
      actions.push({
        priority: priority++,
        action: 'resubmit_task',
        label: `Resubmit: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/tasks',
      })
    } else if (ex.type === 'overdue_task') {
      actions.push({
        priority: priority++,
        action: 'review_task',
        label: `Review overdue: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/tasks',
      })
    } else if (ex.type === 'mortality_today') {
      actions.push({
        priority: priority++,
        action: 'review_mortality',
        label: `Review mortality: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/livestock',
      })
    } else if (ex.type === 'asset_log_missing') {
      actions.push({
        priority: priority++,
        action: 'log_asset',
        label: `Log equipment: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/assets',
      })
    } else if (ex.type === 'asset_verification_pending') {
      actions.push({
        priority: priority++,
        action: 'verify_asset',
        label: `Verify asset log: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/assets',
      })
    } else if (ex.type === 'census_missing') {
      actions.push({
        priority: priority++,
        action: 'record_census',
        label: `Record census: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/zones',
      })
    } else if (ex.type === 'census_rejected') {
      actions.push({
        priority: priority++,
        action: 'resubmit_census',
        label: `Resubmit census: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/zones',
      })
    } else if (ex.type === 'census_stale') {
      actions.push({
        priority: priority++,
        action: 'refresh_census',
        label: `Refresh stale census: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/zones',
      })
    } else if (
      ex.type === 'weather_rain' ||
      ex.type === 'weather_heat' ||
      ex.type === 'weather_wind' ||
      ex.type === 'weather_cold'
    ) {
      actions.push({
        priority: priority++,
        action: 'review_weather',
        label: `Weather: ${ex.title}`,
        entityType: ex.entityType,
        entityId: ex.entityId,
        link: '/today',
      })
    }
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
