import { Hono } from 'hono'
import { and, count, eq, sql, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { farms, inventoryItems, orders, plots, tasks } from '../db/schema.js'
import { authMiddleware, type AppVariables } from '../middleware/auth.js'

export const dashboardRoutes = new Hono<{ Variables: AppVariables }>()

dashboardRoutes.use('*', authMiddleware)

dashboardRoutes.get('/', async (c) => {
  const user = c.get('user')

  const [farm] = await db.select().from(farms).where(eq(farms.id, user.farmId)).limit(1)

  if (user.role === 'sales') {
    const [orderStats, unpaid, lowStock] = await Promise.all([
      db
        .select({ status: orders.status, total: count() })
        .from(orders)
        .where(eq(orders.farmId, user.farmId))
        .groupBy(orders.status),
      db
        .select({ total: count() })
        .from(orders)
        .where(
          and(
            eq(orders.farmId, user.farmId),
            eq(orders.paymentStatus, 'unpaid'),
            inArray(orders.status, ['pending', 'confirmed', 'dispatched', 'delivered']),
          ),
        ),
      db
        .select()
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.farmId, user.farmId),
            sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
          ),
        ),
    ])

    const byStatus = Object.fromEntries(orderStats.map((s) => [s.status, Number(s.total)]))
    const unpaidCount = Number(unpaid[0]?.total ?? 0)

    return c.json({
      scope: 'sales',
      farm: farm ? { id: farm.id, name: farm.name, location: farm.location } : null,
      summary: {
        ordersPending: byStatus.pending ?? 0,
        ordersConfirmed: byStatus.confirmed ?? 0,
        ordersDispatched: byStatus.dispatched ?? 0,
        ordersDelivered: byStatus.delivered ?? 0,
        unpaidOrders: unpaidCount,
        lowStockCount: lowStock.length,
        // Keep legacy keys empty so older clients don't crash
        tasksPending: 0,
        tasksInProgress: 0,
        tasksAwaitingApproval: 0,
        tasksCompleted: 0,
        plotCount: 0,
        pendingApprovals: 0,
      },
      lowStockItems: lowStock.map((i) => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        reorderLevel: i.reorderLevel,
        unit: i.unit,
      })),
      alerts: [
        ...(byStatus.pending
          ? [{ type: 'order_pending', message: `${byStatus.pending} pending order(s)` }]
          : []),
        ...(unpaidCount > 0
          ? [{ type: 'unpaid_orders', message: `${unpaidCount} unpaid order(s)` }]
          : []),
        ...(lowStock.length > 0
          ? [{ type: 'low_stock', message: `${lowStock.length} item(s) at or below reorder level` }]
          : []),
      ],
    })
  }

  const taskFilter =
    user.role === 'field_worker'
      ? and(eq(tasks.farmId, user.farmId), eq(tasks.assignedToId, user.id))
      : eq(tasks.farmId, user.farmId)

  const taskStats = await db
    .select({
      status: tasks.status,
      total: count(),
    })
    .from(tasks)
    .where(taskFilter)
    .groupBy(tasks.status)

  const [plotCount] = await db
    .select({ total: count() })
    .from(plots)
    .where(eq(plots.farmId, user.farmId))

  const lowStock =
    user.role === 'field_worker'
      ? []
      : await db
          .select()
          .from(inventoryItems)
          .where(
            and(
              eq(inventoryItems.farmId, user.farmId),
              sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
            ),
          )

  const pendingApprovals =
    user.role === 'field_worker'
      ? [{ total: 0 }]
      : await db
          .select({ total: count() })
          .from(tasks)
          .where(and(eq(tasks.farmId, user.farmId), eq(tasks.status, 'awaiting_approval')))

  const statsMap = Object.fromEntries(taskStats.map((s) => [s.status, Number(s.total)]))

  const myTasksSummary =
    user.role === 'field_worker'
      ? {
          tasksPending: statsMap.pending ?? 0,
          tasksInProgress: statsMap.in_progress ?? 0,
          tasksAwaitingApproval: statsMap.awaiting_approval ?? 0,
          tasksCompleted: statsMap.completed ?? 0,
          plotCount: 0,
          lowStockCount: 0,
          pendingApprovals: 0,
        }
      : {
          tasksPending: statsMap.pending ?? 0,
          tasksInProgress: statsMap.in_progress ?? 0,
          tasksAwaitingApproval: statsMap.awaiting_approval ?? 0,
          tasksCompleted: statsMap.completed ?? 0,
          plotCount: Number(plotCount?.total ?? 0),
          lowStockCount: lowStock.length,
          pendingApprovals: Number(pendingApprovals[0]?.total ?? 0),
        }

  return c.json({
    scope: 'farm',
    farm: farm ? { id: farm.id, name: farm.name, location: farm.location } : null,
    summary: myTasksSummary,
    lowStockItems:
      user.role === 'field_worker'
        ? []
        : lowStock.map((i) => ({
            id: i.id,
            name: i.name,
            quantity: i.quantity,
            reorderLevel: i.reorderLevel,
            unit: i.unit,
          })),
    alerts:
      user.role === 'field_worker'
        ? []
        : [
            ...(lowStock.length > 0
              ? [{ type: 'low_stock', message: `${lowStock.length} item(s) at or below reorder level` }]
              : []),
            ...((statsMap.awaiting_approval ?? 0) > 0
              ? [{ type: 'approval', message: `${statsMap.awaiting_approval} task(s) awaiting approval` }]
              : []),
          ],
  })
})
