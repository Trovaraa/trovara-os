import { Hono } from 'hono'
import { and, desc, eq, gte, isNotNull, lt, ne, or, count, sql, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  tasks,
  users,
  plots,
  inventoryItems,
  inventoryMovements,
  livestockLogs,
  livestockBatches,
  expenses,
  orders,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

export const dayCloseRoutes = new Hono<{ Variables: AppVariables }>()

dayCloseRoutes.use('*', authMiddleware)

function startOfToday(): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function startOfTomorrow(): Date {
  const d = startOfToday()
  d.setDate(d.getDate() + 1)
  return d
}

async function salesDayClose(farmId: string) {
  const todayStart = startOfToday()
  const tomorrowStart = startOfTomorrow()

  const [orderRows, lowStock, unpaidOrders] = await Promise.all([
    db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        totalAmount: orders.totalAmount,
        currency: orders.currency,
        createdAt: orders.createdAt,
        dispatchedAt: orders.dispatchedAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.farmId, farmId),
          or(
            and(gte(orders.createdAt, todayStart), lt(orders.createdAt, tomorrowStart)),
            and(
              isNotNull(orders.dispatchedAt),
              gte(orders.dispatchedAt, todayStart),
              lt(orders.dispatchedAt, tomorrowStart),
            ),
          ),
        ),
      )
      .orderBy(desc(orders.createdAt)),
    db
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        quantity: inventoryItems.quantity,
        reorderLevel: inventoryItems.reorderLevel,
        unit: inventoryItems.unit,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.farmId, farmId),
          sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
        ),
      )
      .orderBy(inventoryItems.quantity)
      .limit(20),
    db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        totalAmount: orders.totalAmount,
        currency: orders.currency,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
      })
      .from(orders)
      .where(
        and(
          eq(orders.farmId, farmId),
          eq(orders.paymentStatus, 'unpaid'),
          inArray(orders.status, ['pending', 'confirmed', 'dispatched', 'delivered']),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(20),
  ])

  const byStatus: Record<string, number> = {}
  let revenueToday = 0
  let currency = 'NGN'
  for (const o of orderRows) {
    byStatus[o.status] = (byStatus[o.status] ?? 0) + 1
    revenueToday += o.totalAmount
    currency = o.currency || currency
  }

  const pending = byStatus.pending ?? 0
  const confirmed = byStatus.confirmed ?? 0
  const dispatched = byStatus.dispatched ?? 0
  const delivered = byStatus.delivered ?? 0
  const cancelled = byStatus.cancelled ?? 0
  const unpaidCount = unpaidOrders.length
  const unpaidTotal = unpaidOrders.reduce((s, o) => s + o.totalAmount, 0)

  const tomorrowActions: string[] = []
  if (pending > 0) tomorrowActions.push(`${pending} pending order(s) to confirm or pack`)
  if (unpaidCount > 0) tomorrowActions.push(`${unpaidCount} unpaid order(s) to follow up`)
  if (dispatched > 0) tomorrowActions.push(`Confirm delivery for ${dispatched} dispatched order(s)`)
  if (lowStock.length > 0) tomorrowActions.push(`${lowStock.length} low-stock item(s) for packing`)

  const needsAttention = pending > 0 || unpaidCount > 0 || cancelled > 0

  return {
    scope: 'sales' as const,
    date: todayStart.toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    orders: {
      totalToday: orderRows.length,
      pending,
      confirmed,
      dispatched,
      delivered,
      cancelled,
      revenueToday,
      currency,
      unpaidCount,
      unpaidTotal,
      items: orderRows.slice(0, 10).map((o) => ({
        id: o.id,
        customerName: o.customerName,
        status: o.status,
        paymentStatus: o.paymentStatus,
        totalAmount: o.totalAmount,
        currency: o.currency,
      })),
      unpaid: unpaidOrders.map((o) => ({
        id: o.id,
        customerName: o.customerName,
        status: o.status,
        paymentStatus: o.paymentStatus,
        totalAmount: o.totalAmount,
        currency: o.currency,
      })),
    },
    inventory: {
      lowStockCount: lowStock.length,
      lowStockItems: lowStock,
    },
    tomorrowActions,
    status: needsAttention ? ('needs_attention' as const) : ('clear' as const),
  }
}

// GET /api/day-close — owner/supervisor farm close; sales get sales-scoped close
dayCloseRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (user.role === 'field_worker') {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const farmId = user.farmId

  if (user.role === 'sales') {
    return c.json(await salesDayClose(farmId))
  }

  const todayStart = startOfToday()
  const tomorrowStart = startOfTomorrow()

  const [
    taskSummary,
    pendingApprovals,
    overdueTasks,
    lowStock,
    mortalityToday,
    inventoryMovementsToday,
    expensesToday,
  ] = await Promise.all([
    db
      .select({
        status: tasks.status,
        cnt: count(),
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.farmId, farmId),
          or(
            and(
              isNotNull(tasks.dueDate),
              gte(tasks.dueDate, todayStart),
              lt(tasks.dueDate, tomorrowStart),
            ),
            gte(tasks.completedAt, todayStart),
          ),
        ),
      )
      .groupBy(tasks.status),

    db
      .select({
        id: tasks.id,
        title: tasks.title,
        assignedToName: users.name,
        plotName: plots.name,
        updatedAt: tasks.updatedAt,
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignedToId, users.id))
      .leftJoin(plots, eq(tasks.plotId, plots.id))
      .where(and(eq(tasks.farmId, farmId), eq(tasks.status, 'awaiting_approval')))
      .orderBy(tasks.updatedAt),

    db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        dueDate: tasks.dueDate,
        assignedToName: users.name,
        plotName: plots.name,
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignedToId, users.id))
      .leftJoin(plots, eq(tasks.plotId, plots.id))
      .where(
        and(
          eq(tasks.farmId, farmId),
          isNotNull(tasks.dueDate),
          lt(tasks.dueDate, tomorrowStart),
          ne(tasks.status, 'completed'),
          ne(tasks.status, 'awaiting_approval'),
        ),
      )
      .orderBy(tasks.dueDate),

    db
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        quantity: inventoryItems.quantity,
        reorderLevel: inventoryItems.reorderLevel,
        unit: inventoryItems.unit,
        category: inventoryItems.category,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.farmId, farmId),
          sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
        ),
      )
      .orderBy(inventoryItems.quantity),

    db
      .select({
        id: livestockLogs.id,
        batchName: livestockBatches.name,
        headCount: livestockLogs.headCount,
        notes: livestockLogs.notes,
        createdAt: livestockLogs.createdAt,
      })
      .from(livestockLogs)
      .innerJoin(livestockBatches, eq(livestockLogs.batchId, livestockBatches.id))
      .where(
        and(
          eq(livestockLogs.farmId, farmId),
          eq(livestockLogs.logType, 'mortality'),
          gte(livestockLogs.createdAt, todayStart),
          lt(livestockLogs.createdAt, tomorrowStart),
        ),
      ),

    db
      .select({
        id: inventoryMovements.id,
        name: inventoryItems.name,
        delta: inventoryMovements.delta,
        reason: inventoryMovements.reason,
        createdAt: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .innerJoin(inventoryItems, eq(inventoryMovements.itemId, inventoryItems.id))
      .where(
        and(
          eq(inventoryMovements.farmId, farmId),
          gte(inventoryMovements.createdAt, todayStart),
          lt(inventoryMovements.createdAt, tomorrowStart),
        ),
      )
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(20),

    db
      .select({
        id: expenses.id,
        category: expenses.category,
        description: expenses.description,
        amount: expenses.amount,
        currency: expenses.currency,
        approvalStatus: expenses.approvalStatus,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.farmId, farmId),
          gte(expenses.expenseDate, todayStart),
          lt(expenses.expenseDate, tomorrowStart),
        ),
      ),
  ])

  const taskCounts: Record<string, number> = {}
  for (const row of taskSummary) {
    taskCounts[row.status] = Number(row.cnt)
  }
  const totalTasksToday =
    (taskCounts.completed ?? 0) +
    (taskCounts.in_progress ?? 0) +
    (taskCounts.pending ?? 0) +
    (taskCounts.awaiting_approval ?? 0) +
    (taskCounts.rejected ?? 0)

  const totalExpenses = expensesToday.reduce((sum, e) => sum + (e.amount ?? 0), 0)
  const currency = expensesToday[0]?.currency ?? 'NGN'

  const tomorrowActions: string[] = []
  if (overdueTasks.length > 0) {
    tomorrowActions.push(`${overdueTasks.length} overdue task(s) to reschedule or follow up`)
  }
  if (pendingApprovals.length > 0) {
    tomorrowActions.push(`${pendingApprovals.length} task submission(s) awaiting your approval`)
  }
  if (lowStock.length > 0) {
    tomorrowActions.push(`${lowStock.length} low-stock item(s) to reorder`)
  }
  if (mortalityToday.length > 0) {
    tomorrowActions.push(`Review mortality: ${mortalityToday.reduce((s, l) => s + (l.headCount ?? 0), 0)} head`)
  }

  return c.json({
    scope: 'farm' as const,
    date: todayStart.toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    tasks: {
      total: totalTasksToday,
      completed: taskCounts.completed ?? 0,
      overdue: overdueTasks.length,
      pendingApproval: pendingApprovals.length,
      rejected: taskCounts.rejected ?? 0,
      inProgress: taskCounts.in_progress ?? 0,
    },
    pendingApprovals: pendingApprovals.map((t) => ({
      id: t.id,
      title: t.title,
      worker: t.assignedToName,
      plot: t.plotName,
      submittedAt: t.updatedAt.toISOString(),
    })),
    overdueTasks: overdueTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueDate: t.dueDate?.toISOString() ?? null,
      worker: t.assignedToName,
      plot: t.plotName,
    })),
    inventory: {
      lowStockCount: lowStock.length,
      lowStockItems: lowStock,
      movementsToday: inventoryMovementsToday.length,
    },
    livestock: {
      mortalityToday: mortalityToday.reduce((s, l) => s + (l.headCount ?? 0), 0),
      incidents: mortalityToday.map((l) => ({
        batch: l.batchName,
        headCount: l.headCount,
        notes: l.notes,
        at: l.createdAt.toISOString(),
      })),
    },
    finance: {
      expensesToday: expensesToday.length,
      totalExpenses,
      currency,
    },
    tomorrowActions,
    status:
      overdueTasks.length === 0 && pendingApprovals.length === 0 && mortalityToday.length === 0
        ? 'clear'
        : 'needs_attention',
  })
})
