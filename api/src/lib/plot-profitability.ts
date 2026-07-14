import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  expenses,
  harvestLots,
  orders,
  plots,
  tasks,
  users,
} from '../db/schema.js'

const FALLBACK_TASK_LABOUR_NGN = 5000

export type PlotProfitRow = {
  plotId: string
  plotName: string
  cropType: string
  areaAcres: number | null
  tasksCompleted: number
  labourCost: number
  inputCost: number
  revenue: number
  netProfit: number
}

export async function computePlotProfitability(farmId: string): Promise<PlotProfitRow[]> {
  const allPlots = await db.select().from(plots).where(eq(plots.farmId, farmId))

  const [completedTaskRows, lots, orderRows, expenseRows] = await Promise.all([
    db
      .select({
        id: tasks.id,
        plotId: tasks.plotId,
        assignedToId: tasks.assignedToId,
      })
      .from(tasks)
      .where(and(eq(tasks.farmId, farmId), eq(tasks.status, 'completed'))),
    db.select().from(harvestLots).where(eq(harvestLots.farmId, farmId)),
    db
      .select({ lotId: orders.lotId, totalAmount: orders.totalAmount, status: orders.status })
      .from(orders)
      .where(
        and(eq(orders.farmId, farmId), inArray(orders.status, ['confirmed', 'dispatched', 'delivered'])),
      ),
    db.select({ amount: expenses.amount }).from(expenses).where(eq(expenses.farmId, farmId)),
  ])

  const workerIds = [
    ...new Set(completedTaskRows.map((row) => row.assignedToId).filter((id): id is string => Boolean(id))),
  ]
  const workerRows = workerIds.length
    ? await db
        .select({ id: users.id, dailyWageNgn: users.dailyWageNgn })
        .from(users)
        .where(inArray(users.id, workerIds))
    : []
  const wageByWorker = new Map(workerRows.map((row) => [row.id, row.dailyWageNgn]))

  const taskCountByPlot = new Map<string, number>()
  const labourByPlot = new Map<string, number>()
  for (const task of completedTaskRows) {
    if (!task.plotId) continue
    taskCountByPlot.set(task.plotId, (taskCountByPlot.get(task.plotId) ?? 0) + 1)

    const wage = task.assignedToId ? wageByWorker.get(task.assignedToId) : null
    const taskLabour = wage ? Math.round(wage / 8) : FALLBACK_TASK_LABOUR_NGN
    labourByPlot.set(task.plotId, (labourByPlot.get(task.plotId) ?? 0) + taskLabour)
  }

  const lotPlotMap = new Map(lots.map((l) => [l.id, l.plotId]))
  const revenueByPlot = new Map<string, number>()
  for (const order of orderRows) {
    if (!order.lotId) continue
    const plotId = lotPlotMap.get(order.lotId)
    if (!plotId) continue
    revenueByPlot.set(plotId, (revenueByPlot.get(plotId) ?? 0) + order.totalAmount)
  }

  const totalArea = allPlots.reduce((sum, p) => sum + (Number(p.areaAcres) || 0), 0) || 1
  const totalExpenses = expenseRows.reduce((sum, e) => sum + e.amount, 0)

  const inputByPlot = new Map<string, number>()
  for (const plot of allPlots) {
    const area = Number(plot.areaAcres) || 0
    const areaShare = area / totalArea
    const allocatedExpenses = Math.round(totalExpenses * areaShare)
    inputByPlot.set(plot.id, allocatedExpenses)
  }

  return allPlots.map((plot) => {
    const tasksCompleted = taskCountByPlot.get(plot.id) ?? 0
    const labourCost = labourByPlot.get(plot.id) ?? 0
    const inputCost = inputByPlot.get(plot.id) ?? 0
    const revenue = revenueByPlot.get(plot.id) ?? 0
    return {
      plotId: plot.id,
      plotName: plot.name,
      cropType: plot.cropType,
      areaAcres: plot.areaAcres ? Number(plot.areaAcres) : null,
      tasksCompleted,
      labourCost,
      inputCost,
      revenue,
      netProfit: revenue - labourCost - inputCost,
    }
  })
}
