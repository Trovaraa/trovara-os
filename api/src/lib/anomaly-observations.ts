import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  anomalyObservations,
  assets,
  expenses,
  inventoryReconciliationAlerts,
  inventoryShrinkAlerts,
  maintenanceWorkOrders,
} from '../db/schema.js'

export type ObservationCandidate = {
  fingerprint: string
  observationType: string
  category: 'inventory' | 'finance' | 'maintenance'
  title: string
  summary: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  entityType: string
  entityId: string
  sourceRule: string
  evidence: Record<string, unknown>
}

type ReconciliationRow = {
  id: string
  itemId: string
  sku: string
  expectedQuantity: number
  countedQuantity: number
  variance: number
  tolerance: number
}

type ShrinkRow = {
  id: string
  itemId: string
  sku: string
  alertType: string
  periodDays: number
  qtyIn: number
  qtyOutSale: number
  qtyOutTask: number
  qtyOutSpoilage: number
  qtyOutOther: number
  soldQty: number
  unexplainedOut: number
  tolerance: number
}

type ExpenseRow = {
  id: string
  category: string
  costCentreCode: string | null
  description: string
  amount: number
  currency: string
  expenseDate: Date
}

type RepairRow = {
  id: string
  assetId: string
  assetName: string
  completedAt: Date | null
  actualCostMinor: number | null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

/**
 * Deterministic rules only. Candidates describe source records and never
 * mutate them. Labels deliberately say "possible" or "unusual".
 */
export function detectObservationCandidates(input: {
  reconciliation: ReconciliationRow[]
  shrink: ShrinkRow[]
  expenses: ExpenseRow[]
  repairs: RepairRow[]
  now?: Date
}): ObservationCandidate[] {
  const now = input.now ?? new Date()
  const recentExpenseCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const candidates: ObservationCandidate[] = []

  for (const row of input.reconciliation) {
    if (Math.abs(row.variance) <= row.tolerance) continue
    candidates.push({
      fingerprint: `inventory_variance:${row.id}`,
      observationType: 'inventory_variance',
      category: 'inventory',
      title: `Possible inventory variance for ${row.sku}`,
      summary: `The verified count differs from the expected quantity by ${row.variance}. Review the count and movement records.`,
      severity: Math.abs(row.variance) > Math.max(row.tolerance * 3, 10) ? 'high' : 'medium',
      confidence: 95,
      entityType: 'inventory_item',
      entityId: row.itemId,
      sourceRule: 'verified_count_outside_tolerance_v1',
      evidence: { alertId: row.id, sku: row.sku, expectedQuantity: row.expectedQuantity, countedQuantity: row.countedQuantity, variance: row.variance, tolerance: row.tolerance },
    })
  }

  for (const row of input.shrink) {
    if (row.unexplainedOut <= row.tolerance) continue
    candidates.push({
      fingerprint: `inventory_shrink:${row.id}`,
      observationType: 'inventory_shrink',
      category: 'inventory',
      title: `Possible unexplained stock output for ${row.sku}`,
      summary: `${row.unexplainedOut} unit(s) of recorded output are not reconciled within the ${row.periodDays}-day window. Review movements and sales before drawing a conclusion.`,
      severity: row.unexplainedOut > Math.max(row.tolerance * 3, 10) ? 'high' : 'medium',
      confidence: 90,
      entityType: 'inventory_item',
      entityId: row.itemId,
      sourceRule: 'unexplained_output_outside_tolerance_v1',
      evidence: { alertId: row.id, sku: row.sku, alertType: row.alertType, periodDays: row.periodDays, qtyIn: row.qtyIn, qtyOutSale: row.qtyOutSale, qtyOutTask: row.qtyOutTask, qtyOutSpoilage: row.qtyOutSpoilage, qtyOutOther: row.qtyOutOther, soldQty: row.soldQty, unexplainedOut: row.unexplainedOut, tolerance: row.tolerance },
    })
  }

  for (const row of input.expenses) {
    if (row.expenseDate < recentExpenseCutoff) continue
    const peers = input.expenses.filter((peer) =>
      peer.id !== row.id &&
      peer.expenseDate < row.expenseDate &&
      peer.category === row.category &&
      peer.costCentreCode === row.costCentreCode &&
      peer.currency === row.currency,
    )
    if (peers.length < 5) continue
    const baseline = median(peers.map((peer) => peer.amount))
    const minimumDifference = row.currency === 'NGN' ? 100_000 : Math.max(100, baseline)
    if (baseline <= 0 || row.amount < baseline * 3 || row.amount - baseline < minimumDifference) continue
    candidates.push({
      fingerprint: `expense_outlier:${row.id}`,
      observationType: 'expense_outlier',
      category: 'finance',
      title: 'Unusually high expense for its group',
      summary: `This ${row.category} expense is more than three times the median of ${peers.length} earlier matching expenses. Check the source document and approval.`,
      severity: row.amount >= baseline * 5 ? 'high' : 'medium',
      confidence: Math.min(92, 65 + peers.length * 3),
      entityType: 'expense',
      entityId: row.id,
      sourceRule: 'expense_three_times_group_median_v1',
      evidence: { amount: row.amount, currency: row.currency, category: row.category, costCentreCode: row.costCentreCode, description: row.description, baselineMedian: baseline, peerCount: peers.length },
    })
  }

  const repairsByAsset = new Map<string, RepairRow[]>()
  for (const repair of input.repairs) {
    const current = repairsByAsset.get(repair.assetId) ?? []
    current.push(repair)
    repairsByAsset.set(repair.assetId, current)
  }
  for (const [assetId, repairs] of repairsByAsset) {
    if (repairs.length < 2) continue
    const name = repairs[0].assetName
    candidates.push({
      fingerprint: `repeat_repair:${assetId}`,
      observationType: 'repeat_repair',
      category: 'maintenance',
      title: `Possible recurring repair issue for ${name}`,
      summary: `${repairs.length} repairs were completed for this equipment in the last 90 days. Review the work orders before planning replacement or further service.`,
      severity: repairs.length >= 3 ? 'high' : 'medium',
      confidence: repairs.length >= 3 ? 85 : 72,
      entityType: 'asset',
      entityId: assetId,
      sourceRule: 'repeat_repairs_90_days_v1',
      evidence: { assetName: name, repairCount: repairs.length, workOrderIds: repairs.map((repair) => repair.id), completedDates: repairs.map((repair) => repair.completedAt), totalCostMinor: repairs.reduce((sum, repair) => sum + (repair.actualCostMinor ?? 0), 0) },
    })
  }

  return candidates
}

export async function runAnomalyObservationMode(farmId: string) {
  const now = new Date()
  const historyStart = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000)
  const repairsStart = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
  const [reconciliation, shrink, expenseRows, repairRows] = await Promise.all([
    db.select().from(inventoryReconciliationAlerts).where(and(eq(inventoryReconciliationAlerts.farmId, farmId), eq(inventoryReconciliationAlerts.status, 'open'))),
    db.select().from(inventoryShrinkAlerts).where(and(eq(inventoryShrinkAlerts.farmId, farmId), eq(inventoryShrinkAlerts.status, 'open'))),
    db.select({ id: expenses.id, category: expenses.category, costCentreCode: expenses.costCentreCode, description: expenses.description, amount: expenses.amount, currency: expenses.currency, expenseDate: expenses.expenseDate })
      .from(expenses)
      .where(and(eq(expenses.farmId, farmId), eq(expenses.approvalStatus, 'approved'), gte(expenses.expenseDate, historyStart)))
      .orderBy(desc(expenses.expenseDate)).limit(500),
    db.select({ id: maintenanceWorkOrders.id, assetId: maintenanceWorkOrders.assetId, assetName: assets.name, completedAt: maintenanceWorkOrders.completedAt, actualCostMinor: maintenanceWorkOrders.actualCostMinor })
      .from(maintenanceWorkOrders)
      .innerJoin(assets, eq(maintenanceWorkOrders.assetId, assets.id))
      .where(and(eq(maintenanceWorkOrders.farmId, farmId), eq(maintenanceWorkOrders.status, 'completed'), eq(maintenanceWorkOrders.serviceType, 'repair'), gte(maintenanceWorkOrders.completedAt, repairsStart)))
      .orderBy(desc(maintenanceWorkOrders.completedAt)).limit(200),
  ])

  const candidates = detectObservationCandidates({ reconciliation, shrink, expenses: expenseRows, repairs: repairRows, now })
  let created = 0
  let refreshed = 0
  for (const candidate of candidates) {
    const [existing] = await db.select({ id: anomalyObservations.id }).from(anomalyObservations)
      .where(and(eq(anomalyObservations.farmId, farmId), eq(anomalyObservations.fingerprint, candidate.fingerprint), eq(anomalyObservations.status, 'observed'))).limit(1)
    if (existing) {
      await db.update(anomalyObservations).set({ title: candidate.title, summary: candidate.summary, severity: candidate.severity, confidence: candidate.confidence, evidence: candidate.evidence, lastObservedAt: now, updatedAt: now }).where(eq(anomalyObservations.id, existing.id))
      refreshed += 1
      continue
    }
    const inserted = await db.insert(anomalyObservations).values({ farmId, ...candidate, firstObservedAt: now, lastObservedAt: now }).onConflictDoNothing().returning({ id: anomalyObservations.id })
    created += inserted.length
  }
  return { mode: 'observation' as const, candidates: candidates.length, created, refreshed, notified: false, sourceRecordsChanged: false }
}
