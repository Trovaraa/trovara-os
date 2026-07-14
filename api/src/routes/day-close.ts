import { Hono } from 'hono'
import { and, eq, gte, lt, ne, count, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  tasks,
  users,
  plots,
  inventoryItems,
  livestockLogs,
  livestockBatches,
  expenses,
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

// GET /api/day-close — owner/supervisor only
dayCloseRoutes.get('/', async (c) => {
  const user = c.get('user')
  if (user.role === 'field_worker') {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const farmId = user.farmId
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
    // Task completion summary for today
    db
      .select({
        status: tasks.status,
        cnt: count(),
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.farmId, farmId),
          sql`(${tasks.dueDate} >= ${todayStart} AND ${tasks.dueDate} < ${tomorrowStart}) OR ${tasks.completedAt} >= ${todayStart}`,
        ),
      )
      .groupBy(tasks.status),

    // Tasks awaiting approval
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

    // Overdue tasks (due today or earlier, not completed)
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
          sql`${tasks.dueDate} IS NOT NULL AND ${tasks.dueDate} < ${tomorrowStart}`,
          ne(tasks.status, 'completed'),
          ne(tasks.status, 'awaiting_approval'),
        ),
      )
      .orderBy(tasks.dueDate),

    // Low stock items
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

    // Mortality logs today
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

    // Inventory movements today
    db.execute(
      sql`SELECT im.id, ii.name, im.delta, im.reason, im.created_at
          FROM inventory_movements im
          JOIN inventory_items ii ON ii.id = im.item_id
          WHERE im.farm_id = ${farmId}
            AND im.created_at >= ${todayStart}
            AND im.created_at < ${tomorrowStart}
          ORDER BY im.created_at DESC
          LIMIT 20`,
    ),

    // Expenses today
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

  // Build task status map
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

  // Tomorrow's checklist — carry-forward overdue + pending approvals
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
      movementsToday: (inventoryMovementsToday as Record<string, unknown>[]).length,
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
