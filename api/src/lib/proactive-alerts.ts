import { and, eq, gte, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  assets,
  assetLogs,
  cropCycles,
  inventoryItems,
  livestockLogs,
  plots,
  tasks,
} from '../db/schema.js'

export type ProactiveAlert = {
  type:
    | 'low_stock'
    | 'overdue_tasks'
    | 'mortality_spike'
    | 'crop_stage_reminder'
    | 'asset_log_missing'
    | 'asset_verification_pending'
  severity: 'high' | 'medium'
  title: string
  message: string
  count: number
  metadata?: Record<string, unknown>
}

export async function checkProactiveAlerts(farmId: string): Promise<ProactiveAlert[]> {
  const now = new Date()
  const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)

  const [
    lowStockItems,
    [overdue],
    [mortality],
    cropReminders,
    activeAssets,
    loggedTodayRows,
    [pendingVerification],
  ] = await Promise.all([
    db
      .select({
        id: inventoryItems.id,
        name: inventoryItems.name,
        unit: inventoryItems.unit,
        quantity: inventoryItems.quantity,
        reorderLevel: inventoryItems.reorderLevel,
      })
      .from(inventoryItems)
      .where(
        and(
          eq(inventoryItems.farmId, farmId),
          sql`${inventoryItems.quantity} <= ${inventoryItems.reorderLevel}`,
        ),
      ),
    db
      .select({
        count:
          sql<number>`COALESCE(COUNT(*), 0)`.mapWith(Number),
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.farmId, farmId),
          sql`${tasks.dueDate} IS NOT NULL`,
          lt(tasks.dueDate, now),
          ne(tasks.status, 'completed'),
        ),
      ),
    db
      .select({
        count:
          sql<number>`COALESCE(COUNT(*), 0)`.mapWith(Number),
      })
      .from(livestockLogs)
      .where(
        and(
          eq(livestockLogs.farmId, farmId),
          eq(livestockLogs.logType, 'mortality'),
          gte(livestockLogs.createdAt, last7Days),
        ),
      ),
    db
      .select({
        id: cropCycles.id,
        cropType: cropCycles.cropType,
        stage: cropCycles.stage,
        plantedAt: cropCycles.plantedAt,
        expectedHarvestAt: cropCycles.expectedHarvestAt,
        plotName: plots.name,
      })
      .from(cropCycles)
      .leftJoin(plots, eq(cropCycles.plotId, plots.id))
      .where(
        and(
          eq(cropCycles.farmId, farmId),
          or(
            and(
              sql`${cropCycles.expectedHarvestAt} IS NOT NULL`,
              gte(cropCycles.expectedHarvestAt, now),
              lt(cropCycles.expectedHarvestAt, in14Days),
              ne(cropCycles.stage, 'harvested'),
            ),
            and(eq(cropCycles.stage, 'planted'), lt(cropCycles.plantedAt, ninetyDaysAgo)),
          ),
        ),
      ),
    db
      .select({ id: assets.id, name: assets.name })
      .from(assets)
      .where(and(eq(assets.farmId, farmId), eq(assets.active, true))),
    db
      .selectDistinct({ assetId: assetLogs.assetId })
      .from(assetLogs)
      .where(and(eq(assetLogs.farmId, farmId), gte(assetLogs.logDate, todayStart))),
    db
      .select({ count: sql<number>`COALESCE(COUNT(*), 0)`.mapWith(Number) })
      .from(assetLogs)
      .where(and(eq(assetLogs.farmId, farmId), eq(assetLogs.verificationStatus, 'reported'))),
  ])

  const alerts: ProactiveAlert[] = []

  if (lowStockItems.length > 0) {
    alerts.push({
      type: 'low_stock',
      severity: 'high',
      title: 'Low stock items',
      message: `${lowStockItems.length} inventory item(s) are at or below reorder level.`,
      count: lowStockItems.length,
      metadata: {
        items: lowStockItems.slice(0, 5),
      },
    })
  }

  if ((overdue?.count ?? 0) > 0) {
    alerts.push({
      type: 'overdue_tasks',
      severity: 'medium',
      title: 'Overdue tasks',
      message: `${overdue.count} task(s) are overdue and not completed.`,
      count: overdue.count,
    })
  }

  if ((mortality?.count ?? 0) >= 3) {
    alerts.push({
      type: 'mortality_spike',
      severity: 'high',
      title: 'Mortality spike detected',
      message: `${mortality.count} mortality logs were recorded in the last 7 days.`,
      count: mortality.count,
      metadata: { windowDays: 7 },
    })
  }

  if (cropReminders.length > 0) {
    alerts.push({
      type: 'crop_stage_reminder',
      severity: 'medium',
      title: 'Crop stage reminders',
      message: `${cropReminders.length} crop cycle(s) need attention soon (harvest window or stage stall).`,
      count: cropReminders.length,
      metadata: {
        items: cropReminders.slice(0, 8).map((cycle) => ({
          id: cycle.id,
          cropType: cycle.cropType,
          stage: cycle.stage,
          plotName: cycle.plotName,
          plantedAt: cycle.plantedAt,
          expectedHarvestAt: cycle.expectedHarvestAt,
        })),
      },
    })
  }

  const loggedTodayIds = new Set(loggedTodayRows.map((r) => r.assetId))
  const missingAssets = activeAssets.filter((a) => !loggedTodayIds.has(a.id))

  if (missingAssets.length > 0) {
    alerts.push({
      type: 'asset_log_missing',
      severity: 'medium',
      title: 'Equipment not logged today',
      message: `${missingAssets.length} asset(s) have no daily log yet today.`,
      count: missingAssets.length,
      metadata: {
        items: missingAssets.slice(0, 8).map((a) => ({ id: a.id, name: a.name })),
      },
    })
  }

  if ((pendingVerification?.count ?? 0) > 0) {
    alerts.push({
      type: 'asset_verification_pending',
      severity: 'medium',
      title: 'Asset logs awaiting verification',
      message: `${pendingVerification.count} asset log(s) reported by staff need a supervisor to verify.`,
      count: pendingVerification.count,
    })
  }

  return alerts
}
