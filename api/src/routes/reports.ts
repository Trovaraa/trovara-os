import { Hono } from 'hono'
import { and, desc, eq, gte, lt, ne, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  auditEvents,
  cropCycles,
  expenseLabelLinks,
  expenseLabels,
  expenses,
  inventoryItems,
  inventoryMovements,
  livestockBatches,
  livestockLogs,
  orders,
  plots,
  tasks,
  users,
} from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'
import { gatherExceptions } from '../lib/exceptions.js'
import { computePlotProfitability } from '../lib/plot-profitability.js'
import { computeInventoryShrinkReport } from '../lib/inventory-stock.js'
import { canAccessFinance, canApproveTasks, hasPermission } from '../lib/rbac.js'
import { filterAndGroupExpensesByLabel } from '../lib/expense-label-report.js'

export const reportRoutes = new Hono<{ Variables: AppVariables }>()

reportRoutes.use('*', authMiddleware)

reportRoutes.get('/owner', async (c) => {
  const user = c.get('user')
  if (
    !hasPermission(user, 'reports.read') ||
    !hasPermission(user, 'audit.export') ||
    !canAccessFinance(user)
  ) return c.json({ error: 'Forbidden' }, 403)
  const labelFilter = c.req.query('labelId')

  const now = new Date()
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)

  const [
    allTasks,
    overdueRows,
    allInventory,
    recentMovements,
    allPlots,
    allCycles,
    allBatches,
    recentLivestockLogs,
    allOrders,
    allExpenses,
    expenseLabelAllocations,
    incidentLogs,
    recentAudit,
  ] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.farmId, user.farmId)),
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
          eq(tasks.farmId, user.farmId),
          lt(tasks.dueDate, now),
          ne(tasks.status, 'completed'),
        ),
      )
      .orderBy(tasks.dueDate),
    db.select().from(inventoryItems).where(eq(inventoryItems.farmId, user.farmId)),
    db
      .select({
        itemName: inventoryItems.name,
        unit: inventoryItems.unit,
        delta: inventoryMovements.delta,
        reason: inventoryMovements.reason,
        createdAt: inventoryMovements.createdAt,
      })
      .from(inventoryMovements)
      .innerJoin(inventoryItems, eq(inventoryMovements.itemId, inventoryItems.id))
      .where(eq(inventoryMovements.farmId, user.farmId))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(10),
    db.select().from(plots).where(eq(plots.farmId, user.farmId)),
    db
      .select({
        id: cropCycles.id,
        cropType: cropCycles.cropType,
        stage: cropCycles.stage,
        plantedAt: cropCycles.plantedAt,
        expectedHarvestAt: cropCycles.expectedHarvestAt,
        standCount: cropCycles.standCount,
        costCentre: cropCycles.costCentre,
        plotName: plots.name,
      })
      .from(cropCycles)
      .innerJoin(plots, eq(cropCycles.plotId, plots.id))
      .where(eq(cropCycles.farmId, user.farmId))
      .orderBy(desc(cropCycles.updatedAt)),
    db.select().from(livestockBatches).where(eq(livestockBatches.farmId, user.farmId)),
    db
      .select({
        id: livestockLogs.id,
        logType: livestockLogs.logType,
        headCount: livestockLogs.headCount,
        notes: livestockLogs.notes,
        createdAt: livestockLogs.createdAt,
        batchName: livestockBatches.name,
      })
      .from(livestockLogs)
      .innerJoin(livestockBatches, eq(livestockLogs.batchId, livestockBatches.id))
      .where(eq(livestockLogs.farmId, user.farmId))
      .orderBy(desc(livestockLogs.createdAt))
      .limit(10),
    db.select().from(orders).where(eq(orders.farmId, user.farmId)).orderBy(desc(orders.createdAt)),
    db.select().from(expenses).where(eq(expenses.farmId, user.farmId)),
    db
      .select({
        expenseId: expenseLabelLinks.expenseId,
        labelId: expenseLabels.id,
        labelName: expenseLabels.name,
        labelSlug: expenseLabels.slug,
      })
      .from(expenseLabelLinks)
      .innerJoin(expenseLabels, eq(expenseLabelLinks.labelId, expenseLabels.id))
      .innerJoin(expenses, eq(expenseLabelLinks.expenseId, expenses.id))
      .where(and(eq(expenses.farmId, user.farmId), eq(expenseLabels.farmId, user.farmId))),
    db
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
        and(eq(livestockLogs.farmId, user.farmId), eq(livestockLogs.logType, 'incident')),
      )
      .orderBy(desc(livestockLogs.createdAt))
      .limit(20),
    db
      .select({
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        metadata: auditEvents.metadata,
        createdAt: auditEvents.createdAt,
        userName: users.name,
      })
      .from(auditEvents)
      .leftJoin(users, eq(auditEvents.userId, users.id))
      .where(eq(auditEvents.farmId, user.farmId))
      .orderBy(desc(auditEvents.createdAt))
      .limit(50),
  ])

  const byStatus = allTasks.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] ?? 0) + 1
    return acc
  }, {})

  const completedToday = allTasks.filter(
    (t) => t.completedAt && t.completedAt >= startOfDay,
  ).length

  const lowStockItems = allInventory.filter((i) => i.quantity <= i.reorderLevel)

  const ngnOrders = allOrders.filter(
    (order) =>
      order.currency === 'NGN' &&
      (order.status === 'delivered' || order.status === 'confirmed' || order.status === 'dispatched'),
  )
  const revenue = ngnOrders.reduce((sum, o) => sum + o.totalAmount, 0)

  const reportableExpenses = allExpenses.filter(
    (expense) => expense.approvalStatus === 'approved' && expense.currency === 'NGN',
  )
  const { expenses: filteredExpenses, expensesByLabel } = filterAndGroupExpensesByLabel(
    reportableExpenses,
    expenseLabelAllocations,
    labelFilter,
  )

  const totalExpenses = filteredExpenses.reduce((sum, e) => sum + e.amount, 0)

  const expensesByCategory = filteredExpenses.reduce<Record<string, number>>((acc, e) => {
    acc[e.category] = (acc[e.category] ?? 0) + e.amount
    return acc
  }, {})

  const ordersByStatus = allOrders.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1
    return acc
  }, {})

  return c.json({
    generatedAt: now.toISOString(),
    reports: {
      dailyOps: {
        totalTasks: allTasks.length,
        byStatus,
        overdue: overdueRows.length,
        completedToday,
        awaitingApproval: byStatus.awaiting_approval ?? 0,
        inProgress: byStatus.in_progress ?? 0,
      },
      tasksOverdue: {
        count: overdueRows.length,
        tasks: overdueRows.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          dueDate: t.dueDate,
          plotName: t.plotName,
          assignedToName: t.assignedToName,
        })),
      },
      inventory: {
        totalItems: allInventory.length,
        lowStockCount: lowStockItems.length,
        items: allInventory.map((i) => ({
          name: i.name,
          category: i.category,
          quantity: i.quantity,
          unit: i.unit,
          reorderLevel: i.reorderLevel,
          lowStock: i.quantity <= i.reorderLevel,
        })),
        recentMovements: recentMovements.map((m) => ({
          itemName: m.itemName,
          unit: m.unit,
          delta: m.delta,
          reason: m.reason,
          createdAt: m.createdAt,
        })),
      },
      cropStatus: {
        phase: allCycles.length ? 'active' : 'placeholder',
        plots: allPlots.map((p) => ({
          name: p.name,
          cropType: p.cropType,
          areaAcres: p.areaAcres,
        })),
        cycles: allCycles.map((c) => ({
          id: c.id,
          plotName: c.plotName,
          cropType: c.cropType,
          stage: c.stage,
          plantedAt: c.plantedAt,
          expectedHarvestAt: c.expectedHarvestAt,
          standCount: c.standCount,
          costCentre: c.costCentre,
        })),
      },
      livestock: {
        phase: allBatches.length ? 'active' : 'placeholder',
        batchCount: allBatches.length,
        totalHeadCount: allBatches.reduce((sum, b) => sum + (b.active ? b.headCount : 0), 0),
        batches: allBatches.map((b) => ({
          id: b.id,
          name: b.name,
          species: b.species,
          headCount: b.headCount,
          active: b.active,
          acquiredAt: b.acquiredAt,
        })),
        recentLogs: recentLivestockLogs.map((l) => ({
          id: l.id,
          batchName: l.batchName,
          logType: l.logType,
          headCount: l.headCount,
          notes: l.notes,
          createdAt: l.createdAt,
        })),
      },
      sales: {
        phase: allOrders.length ? 'active' : 'placeholder',
        totalOrders: allOrders.length,
        byStatus: ordersByStatus,
        totalRevenue: revenue,
        currency: allOrders[0]?.currency ?? 'NGN',
        recentOrders: allOrders.slice(0, 10).map((o) => ({
          id: o.id,
          customerName: o.customerName,
          status: o.status,
          totalAmount: o.totalAmount,
          currency: o.currency,
          createdAt: o.createdAt,
        })),
      },
      pnl: {
        phase: allOrders.length || filteredExpenses.length ? 'active' : 'placeholder',
        currency: 'NGN',
        revenue,
        expenses: totalExpenses,
        net: revenue - totalExpenses,
        expensesByCategory,
        expensesByLabel,
      },
      incidents: {
        phase: incidentLogs.length ? 'active' : 'placeholder',
        count: incidentLogs.length,
        items: incidentLogs.map((i) => ({
          id: i.id,
          batchName: i.batchName,
          headCount: i.headCount,
          notes: i.notes,
          createdAt: i.createdAt,
        })),
      },
      auditTrail: recentAudit.map((e) => ({
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        userName: e.userName,
        metadata: e.metadata,
        createdAt: e.createdAt,
      })),
    },
  })
})

reportRoutes.get('/digest', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'reports.read') || !canApproveTasks(user)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const now = new Date()
  const { exceptions, summary } = await gatherExceptions(user)

  const byType = exceptions.reduce<Record<string, typeof exceptions>>((acc, ex) => {
    if (!acc[ex.type]) acc[ex.type] = []
    acc[ex.type].push(ex)
    return acc
  }, {})

  return c.json({
    generatedAt: now.toISOString(),
    report: 'daily_exception_digest',
    summary,
    sections: {
      overdueTasks: {
        count: summary.overdueTasks,
        items: byType.overdue_task ?? [],
      },
      lowStock: {
        count: summary.lowStock,
        items: byType.low_stock ?? [],
      },
      pendingApprovals: {
        count: summary.pendingApprovals,
        items: byType.pending_approval ?? [],
      },
      mortalityToday: {
        count: summary.mortalityToday,
        items: byType.mortality_today ?? [],
      },
      ordersPending: {
        count: summary.ordersPending,
        items: byType.order_pending ?? [],
      },
      rejectedTasks: {
        count: summary.rejectedTasks,
        items: byType.rejected_task ?? [],
      },
    },
    exceptions,
  })
})

reportRoutes.get('/inventory-shrink', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'reports.read') || !canApproveTasks(user)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const daysRaw = Number(c.req.query('days') ?? '30')
  const periodDays = Number.isFinite(daysRaw) ? daysRaw : 30
  const report = await computeInventoryShrinkReport(user.farmId, periodDays)

  return c.json({
    report: 'inventory_shrink',
    ...report,
    flaggedCount: report.items.filter((item) => item.flags.length > 0).length,
  })
})

reportRoutes.get('/burn-rate', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'reports.read') || !canApproveTasks(user)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const [items, consumptionRows] = await Promise.all([
    db.select().from(inventoryItems).where(eq(inventoryItems.farmId, user.farmId)),
    db
      .select({
        itemId: inventoryMovements.itemId,
        totalConsumed: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.delta} < 0 THEN ABS(${inventoryMovements.delta}) ELSE 0 END), 0)`,
      })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.farmId, user.farmId),
          gte(inventoryMovements.createdAt, thirtyDaysAgo),
        ),
      )
      .groupBy(inventoryMovements.itemId),
  ])

  const consumedByItem = Object.fromEntries(
    consumptionRows.map((r) => [r.itemId, Number(r.totalConsumed)]),
  )

  const burnRate = items.map((item) => {
    const totalConsumed = consumedByItem[item.id] ?? 0
    const avgDailyConsumption = totalConsumed / 30
    const daysRemaining =
      avgDailyConsumption > 0 ? Math.floor(item.quantity / avgDailyConsumption) : null
    const lowStock = item.quantity <= item.reorderLevel

    return {
      itemId: item.id,
      name: item.name,
      category: item.category,
      unit: item.unit,
      quantity: item.quantity,
      reorderLevel: item.reorderLevel,
      totalConsumedLast30Days: totalConsumed,
      avgDailyConsumption: Math.round(avgDailyConsumption * 100) / 100,
      daysRemaining,
      lowStock,
      needsReorder: lowStock || (daysRemaining !== null && daysRemaining <= 7),
    }
  })

  return c.json({
    generatedAt: now.toISOString(),
    report: 'inventory_burn_rate',
    periodDays: 30,
    items: burnRate.sort((a, b) => {
      if (a.needsReorder && !b.needsReorder) return -1
      if (!a.needsReorder && b.needsReorder) return 1
      if (a.daysRemaining === null) return 1
      if (b.daysRemaining === null) return -1
      return a.daysRemaining - b.daysRemaining
    }),
  })
})

reportRoutes.get('/action-list', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'reports.read') || !canApproveTasks(user)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const now = new Date()
  const { actionList, summary } = await gatherExceptions(user)

  return c.json({
    generatedAt: now.toISOString(),
    report: 'manager_action_list',
    summary,
    actions: actionList,
  })
})

reportRoutes.get('/plot-profitability', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'reports.read') || !canAccessFinance(user)) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const rows = await computePlotProfitability(user.farmId)
  const totals = rows.reduce(
    (acc, r) => ({
      revenue: acc.revenue + r.revenue,
      labourCost: acc.labourCost + r.labourCost,
      inputCost: acc.inputCost + r.inputCost,
      netProfit: acc.netProfit + r.netProfit,
    }),
    { revenue: 0, labourCost: 0, inputCost: 0, netProfit: 0 },
  )

  return c.json({
    generatedAt: new Date().toISOString(),
    report: 'plot_profitability',
    currency: 'NGN',
    labourRatePerTask: 5000,
    plots: rows,
    totals,
  })
})

reportRoutes.get('/audit-export', async (c) => {
  const user = c.get('user')
  if (!hasPermission(user, 'reports.read') || !hasPermission(user, 'audit.export')) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const events = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.farmId, user.farmId))
    .orderBy(desc(auditEvents.createdAt))

  return c.json({ events })
})
