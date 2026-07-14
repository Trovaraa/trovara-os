import { and, eq, lt, ne, or, isNull, sql, gte } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  inventoryItems,
  livestockBatches,
  livestockLogs,
  orders,
  plots,
  tasks,
  users,
} from '../db/schema.js'
import type { SessionUser } from './session.js'

export type ExceptionType =
  | 'overdue_task'
  | 'low_stock'
  | 'pending_approval'
  | 'mortality_today'
  | 'order_pending'
  | 'rejected_task'

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
  ])

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
      message: `Pending over 48h — ${o.currency} ${o.totalAmount}`,
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
      message: `Rejected — needs resubmit (${t.assignedToName ?? 'unassigned'})`,
      entityType: 'task',
      entityId: t.id,
      timestamp: t.updatedAt.toISOString(),
      metadata: { assignedToName: t.assignedToName },
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
