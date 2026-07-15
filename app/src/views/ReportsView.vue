<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type OwnerReports = {
  generatedAt: string
  reports: {
    dailyOps: {
      totalTasks: number
      byStatus: Record<string, number>
      overdue: number
      completedToday: number
      awaitingApproval: number
      inProgress: number
    }
    tasksOverdue: {
      count: number
      tasks: {
        id: string
        title: string
        status: string
        dueDate?: string
        plotName?: string
        assignedToName?: string
      }[]
    }
    inventory: {
      totalItems: number
      lowStockCount: number
      items: {
        name: string
        category: string
        quantity: number
        unit: string
        reorderLevel: number
        lowStock: boolean
      }[]
      recentMovements: {
        itemName: string
        unit: string
        delta: number
        reason: string
        createdAt: string
      }[]
    }
    cropStatus: {
      phase: string
      plots: { name: string; cropType: string; areaAcres?: string }[]
      cycles: {
        id: string
        plotName: string
        cropType: string
        stage: string
        plantedAt: string
        expectedHarvestAt?: string
      }[]
    }
    livestock: {
      phase: string
      batchCount: number
      totalHeadCount: number
      batches: {
        id: string
        name: string
        species: string
        headCount: number
        active: boolean
        acquiredAt: string
      }[]
      recentLogs: {
        id: string
        batchName: string
        logType: string
        headCount?: number
        notes?: string
        createdAt: string
      }[]
    }
    sales: {
      phase: string
      totalOrders: number
      byStatus: Record<string, number>
      totalRevenue: number
      currency: string
      recentOrders: {
        id: string
        customerName: string
        status: string
        totalAmount: number
        currency: string
        createdAt: string
      }[]
    }
    pnl: {
      phase: string
      currency: string
      revenue: number
      expenses: number
      net: number
      expensesByCategory: Record<string, number>
    }
    incidents: {
      phase: string
      count: number
      items: {
        id: string
        batchName: string
        headCount?: number
        notes?: string
        createdAt: string
      }[]
    }
    auditTrail: {
      action: string
      entityType: string
      entityId?: string
      userName?: string
      metadata?: unknown
      createdAt: string
    }[]
  }
}

const data = ref<OwnerReports | null>(null)
const digest = ref<DigestReport | null>(null)
const burnRate = ref<BurnRateReport | null>(null)
const actionList = ref<ActionListReport | null>(null)
const plotProfitability = ref<PlotProfitabilityReport | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

type DigestReport = {
  generatedAt: string
  report: string
  summary: {
    overdueTasks: number
    lowStock: number
    pendingApprovals: number
    mortalityToday: number
    ordersPending: number
    rejectedTasks: number
    assetLogsMissing: number
    assetVerificationPending: number
    total: number
  }
  sections: Record<string, { count: number; items: unknown[] }>
}

type BurnRateReport = {
  generatedAt: string
  report: string
  periodDays: number
  items: {
    itemId: string
    name: string
    unit: string
    quantity: number
    reorderLevel: number
    avgDailyConsumption: number
    daysRemaining: number | null
    lowStock: boolean
    needsReorder: boolean
  }[]
}

type ActionListReport = {
  generatedAt: string
  report: string
  summary: DigestReport['summary']
  actions: {
    priority: number
    action: string
    label: string
    entityType: string
    entityId: string
    link: string
  }[]
}

type PlotProfitabilityReport = {
  generatedAt: string
  report: string
  currency: string
  labourRatePerTask: number
  plots: {
    plotId: string
    plotName: string
    cropType: string
    areaAcres: number | null
    tasksCompleted: number
    labourCost: number
    inputCost: number
    revenue: number
    netProfit: number
  }[]
  totals: {
    revenue: number
    labourCost: number
    inputCost: number
    netProfit: number
  }
}

onMounted(async () => {
  try {
    const [owner, digestRes, burnRateRes, actionListRes, plotPnlRes] = await Promise.all([
      api<OwnerReports>('/api/reports/owner'),
      api<DigestReport>('/api/reports/digest'),
      api<BurnRateReport>('/api/reports/burn-rate'),
      api<ActionListReport>('/api/reports/action-list'),
      api<PlotProfitabilityReport>('/api/reports/plot-profitability'),
    ])
    data.value = owner
    digest.value = digestRes
    burnRate.value = burnRateRes
    actionList.value = actionListRes
    plotProfitability.value = plotPnlRes
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load reports'
  } finally {
    loading.value = false
  }
})

function formatMoney(amount: number, currency: string) {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-white">Founder Reports</h2>
      <p class="text-slate-400 text-sm mt-1">Full farm visibility - Founder only</p>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">Loading reports…</div>
    <div v-else-if="error" class="mt-8 text-red-400">{{ error }}</div>

    <div v-else-if="data" class="mt-8 space-y-6 min-w-0 max-w-full">
      <p class="text-xs text-slate-500">
        Generated {{ formatDate(data.generatedAt) }}
      </p>

      <!-- Exception Digest -->
      <section v-if="digest" class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Daily Exception Digest</h3>
          <span class="text-xs text-slate-500">{{ digest.summary.total }} exceptions</span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Overdue</p>
            <p class="text-xl font-black text-red-400">{{ digest.summary.overdueTasks }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Low stock</p>
            <p class="text-xl font-black text-amber-400">{{ digest.summary.lowStock }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Approvals</p>
            <p class="text-xl font-black text-purple-400">{{ digest.summary.pendingApprovals }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Mortality today</p>
            <p class="text-xl font-black text-red-300">{{ digest.summary.mortalityToday }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Orders pending</p>
            <p class="text-xl font-black text-blue-400">{{ digest.summary.ordersPending }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Rejected</p>
            <p class="text-xl font-black text-slate-300">{{ digest.summary.rejectedTasks }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Not logged today</p>
            <p class="text-xl font-black text-amber-400">{{ digest.summary.assetLogsMissing }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Assets to verify</p>
            <p class="text-xl font-black text-cyan-400">{{ digest.summary.assetVerificationPending }}</p>
          </div>
        </div>
      </section>

      <!-- Manager Action List -->
      <section v-if="actionList" class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <h3 class="font-bold text-white mb-4">Manager Action List</h3>
        <ul v-if="actionList.actions.length" class="space-y-2">
          <li
            v-for="item in actionList.actions.slice(0, 10)"
            :key="`${item.action}-${item.entityId}`"
            class="text-sm flex items-center justify-between gap-4 border-b border-slate-800/50 pb-2 last:border-0"
          >
            <span class="text-slate-300">{{ item.label }}</span>
            <span class="text-xs text-slate-500 capitalize">{{ item.action.replace('_', ' ') }}</span>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm">No actions queued</p>
      </section>

      <!-- Inventory Burn Rate -->
      <section v-if="burnRate" class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Inventory Burn Rate</h3>
          <span class="text-xs text-slate-500">Last {{ burnRate.periodDays }} days</span>
        </div>
        <ul v-if="burnRate.items.length" class="space-y-2">
          <li
            v-for="item in burnRate.items.slice(0, 8)"
            :key="item.itemId"
            class="text-sm flex justify-between gap-4"
          >
            <span class="text-slate-300">{{ item.name }}</span>
            <span
              class="font-mono text-xs flex-shrink-0"
              :class="item.needsReorder ? 'text-red-400' : 'text-slate-500'"
            >
              {{ item.quantity }} {{ item.unit }}
              <span v-if="item.daysRemaining !== null"> · ~{{ item.daysRemaining }}d left</span>
              <span v-else> · no usage data</span>
            </span>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm">No inventory items tracked</p>
      </section>

      <!-- Plot Profitability -->
      <section v-if="plotProfitability" class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Plot Profitability</h3>
          <span class="text-xs text-slate-500">
            Labour proxy: {{ formatMoney(plotProfitability.labourRatePerTask, plotProfitability.currency) }}/task
          </span>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Revenue</p>
            <p class="text-lg font-black text-farm-green">
              {{ formatMoney(plotProfitability.totals.revenue, plotProfitability.currency) }}
            </p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Labour</p>
            <p class="text-lg font-black text-amber-400">
              {{ formatMoney(plotProfitability.totals.labourCost, plotProfitability.currency) }}
            </p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Inputs</p>
            <p class="text-lg font-black text-slate-300">
              {{ formatMoney(plotProfitability.totals.inputCost, plotProfitability.currency) }}
            </p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Net profit</p>
            <p
              class="text-lg font-black"
              :class="plotProfitability.totals.netProfit >= 0 ? 'text-farm-green' : 'text-red-400'"
            >
              {{ formatMoney(plotProfitability.totals.netProfit, plotProfitability.currency) }}
            </p>
          </div>
        </div>
        <div v-if="plotProfitability.plots.length" class="overflow-x-auto -mx-1 px-1">
          <table class="w-full min-w-[20rem] text-sm">
            <thead>
              <tr class="text-left text-xs text-slate-500 border-b border-slate-800">
                <th class="pb-2 pr-4">Plot</th>
                <th class="pb-2 pr-4">Tasks</th>
                <th class="pb-2 pr-4">Revenue</th>
                <th class="pb-2 pr-4">Costs</th>
                <th class="pb-2">Net</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="plot in plotProfitability.plots"
                :key="plot.plotId"
                class="border-b border-slate-800/50 last:border-0"
              >
                <td class="py-2 pr-4">
                  <span class="text-white font-medium">{{ plot.plotName }}</span>
                  <span class="text-slate-500 text-xs block capitalize">{{ plot.cropType }}</span>
                </td>
                <td class="py-2 pr-4 text-slate-400">{{ plot.tasksCompleted }}</td>
                <td class="py-2 pr-4 text-farm-green">
                  {{ formatMoney(plot.revenue, plotProfitability.currency) }}
                </td>
                <td class="py-2 pr-4 text-slate-400">
                  {{ formatMoney(plot.labourCost + plot.inputCost, plotProfitability.currency) }}
                </td>
                <td
                  class="py-2 font-mono"
                  :class="plot.netProfit >= 0 ? 'text-farm-green' : 'text-red-400'"
                >
                  {{ formatMoney(plot.netProfit, plotProfitability.currency) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="text-slate-500 text-sm">No plots configured yet</p>
      </section>

      <!-- 1. Daily Operations -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <h3 class="font-bold text-white mb-4">Daily Operations</h3>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Total tasks</p>
            <p class="text-2xl font-black text-white">{{ data.reports.dailyOps.totalTasks }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">In progress</p>
            <p class="text-2xl font-black text-blue-400">{{ data.reports.dailyOps.inProgress }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Awaiting approval</p>
            <p class="text-2xl font-black text-purple-400">{{ data.reports.dailyOps.awaitingApproval }}</p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Completed today</p>
            <p class="text-2xl font-black text-farm-green">{{ data.reports.dailyOps.completedToday }}</p>
          </div>
        </div>
        <div class="flex flex-wrap gap-3">
          <span
            v-for="(count, status) in data.reports.dailyOps.byStatus"
            :key="status"
            class="text-xs bg-slate-800 px-3 py-1.5 rounded-lg text-slate-300 capitalize"
          >
            {{ String(status).replace('_', ' ') }}: {{ count }}
          </span>
        </div>
      </section>

      <!-- 2. Tasks Overdue -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Tasks Overdue</h3>
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full"
            :class="data.reports.tasksOverdue.count ? 'bg-red-900/40 text-red-300' : 'bg-farm-green/20 text-farm-green'"
          >
            {{ data.reports.tasksOverdue.count }} overdue
          </span>
        </div>
        <ul v-if="data.reports.tasksOverdue.tasks.length" class="space-y-3">
          <li
            v-for="task in data.reports.tasksOverdue.tasks"
            :key="task.id"
            class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-sm border-b border-slate-800/50 pb-3 last:border-0 last:pb-0"
          >
            <div>
              <span class="text-white font-medium">{{ task.title }}</span>
              <span class="text-slate-500 ml-2 capitalize">{{ task.status.replace('_', ' ') }}</span>
            </div>
            <div class="text-xs text-slate-500">
              <span v-if="task.plotName">{{ task.plotName }} · </span>
              <span v-if="task.assignedToName">{{ task.assignedToName }} · </span>
              <span class="text-red-400">Due {{ task.dueDate ? formatDate(task.dueDate) : '-' }}</span>
            </div>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm">No overdue tasks</p>
      </section>

      <!-- 3. Inventory -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Inventory</h3>
          <span class="text-xs text-slate-500">
            {{ data.reports.inventory.totalItems }} items ·
            <span :class="data.reports.inventory.lowStockCount ? 'text-red-400' : 'text-farm-green'">
              {{ data.reports.inventory.lowStockCount }} low stock
            </span>
          </span>
        </div>
        <div class="grid lg:grid-cols-2 gap-6">
          <ul class="space-y-2">
            <li
              v-for="item in data.reports.inventory.items"
              :key="item.name"
              class="text-sm flex justify-between gap-4"
            >
              <span class="text-slate-300">{{ item.name }}</span>
              <span
                class="font-mono flex-shrink-0"
                :class="item.lowStock ? 'text-red-400' : 'text-slate-400'"
              >
                {{ item.quantity }} {{ item.unit }}
              </span>
            </li>
          </ul>
          <div>
            <p class="text-xs text-slate-500 font-semibold mb-2 uppercase tracking-wide">Recent movements</p>
            <ul v-if="data.reports.inventory.recentMovements.length" class="space-y-2 max-h-48 overflow-y-auto">
              <li
                v-for="(m, i) in data.reports.inventory.recentMovements"
                :key="i"
                class="text-xs text-slate-400 flex justify-between gap-2"
              >
                <span>
                  <span class="text-slate-300">{{ m.itemName }}</span>
                  <span
                    class="font-mono ml-1"
                    :class="m.delta > 0 ? 'text-farm-green' : 'text-red-400'"
                  >
                    {{ m.delta > 0 ? '+' : '' }}{{ m.delta }}
                  </span>
                  · {{ m.reason }}
                </span>
                <span class="text-slate-600 flex-shrink-0">{{ formatDate(m.createdAt) }}</span>
              </li>
            </ul>
            <p v-else class="text-slate-500 text-sm">No movements recorded</p>
          </div>
        </div>
      </section>

      <!-- 4. Crop Status -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Crop Status</h3>
          <span
            v-if="data.reports.cropStatus.phase === 'placeholder'"
            class="text-xs bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full"
          >
            Phase 2
          </span>
        </div>
        <ul class="space-y-2 mb-4">
          <li
            v-for="plot in data.reports.cropStatus.plots"
            :key="plot.name"
            class="text-sm text-slate-300 flex justify-between"
          >
            <span>{{ plot.name }}</span>
            <span class="text-slate-500 capitalize">{{ plot.cropType }} · {{ plot.areaAcres }} acres</span>
          </li>
        </ul>
        <div v-if="data.reports.cropStatus.cycles.length">
          <p class="text-xs text-slate-500 font-semibold mb-2 uppercase tracking-wide">Active cycles</p>
          <ul class="space-y-2">
            <li
              v-for="cycle in data.reports.cropStatus.cycles"
              :key="cycle.id"
              class="text-sm flex justify-between"
            >
              <span class="text-slate-300">{{ cycle.plotName }} - {{ cycle.cropType }}</span>
              <span class="text-slate-500 capitalize">{{ cycle.stage.replace('_', ' ') }}</span>
            </li>
          </ul>
        </div>
        <p v-else class="text-slate-500 text-sm">No crop cycles tracked yet - plot layout shown above</p>
      </section>

      <!-- 5. Livestock -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Livestock</h3>
          <span
            v-if="data.reports.livestock.phase === 'placeholder'"
            class="text-xs bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full"
          >
            Phase 2
          </span>
        </div>
        <template v-if="data.reports.livestock.batches.length">
          <p class="text-sm text-slate-300 mb-3">
            {{ data.reports.livestock.batchCount }} batches ·
            {{ data.reports.livestock.totalHeadCount }} head total
          </p>
          <ul class="space-y-2">
            <li
              v-for="batch in data.reports.livestock.batches"
              :key="batch.id"
              class="text-sm flex justify-between"
            >
              <span class="text-slate-300">{{ batch.name }} ({{ batch.species }})</span>
              <span class="text-slate-500">{{ batch.headCount }} head</span>
            </li>
          </ul>
        </template>
        <p v-else class="text-slate-500 text-sm">Livestock tracking coming in Phase 2 - poultry zone prep in progress</p>
      </section>

      <!-- 6. Sales -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Sales</h3>
          <span
            v-if="data.reports.sales.phase === 'placeholder'"
            class="text-xs bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full"
          >
            Phase 3
          </span>
        </div>
        <template v-if="data.reports.sales.totalOrders">
          <p class="text-sm text-slate-300 mb-3">
            {{ data.reports.sales.totalOrders }} orders ·
            {{ formatMoney(data.reports.sales.totalRevenue, data.reports.sales.currency) }} revenue
          </p>
          <ul class="space-y-2">
            <li
              v-for="order in data.reports.sales.recentOrders"
              :key="order.id"
              class="text-sm flex justify-between"
            >
              <span class="text-slate-300">{{ order.customerName }}</span>
              <span class="text-slate-500 capitalize">
                {{ order.status }} · {{ formatMoney(order.totalAmount, order.currency) }}
              </span>
            </li>
          </ul>
        </template>
        <p v-else class="text-slate-500 text-sm">Sales order tracking coming in Phase 3</p>
      </section>

      <!-- 7. P&L -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">P&amp;L Snapshot</h3>
          <span
            v-if="data.reports.pnl.phase === 'placeholder'"
            class="text-xs bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full"
          >
            Phase 3
          </span>
        </div>
        <div class="grid grid-cols-3 gap-4 mb-4">
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Revenue</p>
            <p class="text-lg font-black text-farm-green">
              {{ formatMoney(data.reports.pnl.revenue, data.reports.pnl.currency) }}
            </p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Expenses</p>
            <p class="text-lg font-black text-red-400">
              {{ formatMoney(data.reports.pnl.expenses, data.reports.pnl.currency) }}
            </p>
          </div>
          <div class="bg-slate-800/50 rounded-xl p-3">
            <p class="text-xs text-slate-500">Net</p>
            <p
              class="text-lg font-black"
              :class="data.reports.pnl.net >= 0 ? 'text-farm-green' : 'text-red-400'"
            >
              {{ formatMoney(data.reports.pnl.net, data.reports.pnl.currency) }}
            </p>
          </div>
        </div>
        <div v-if="Object.keys(data.reports.pnl.expensesByCategory).length" class="flex flex-wrap gap-2">
          <span
            v-for="(amount, cat) in data.reports.pnl.expensesByCategory"
            :key="cat"
            class="text-xs bg-slate-800 px-3 py-1.5 rounded-lg text-slate-300 capitalize"
          >
            {{ cat }}: {{ formatMoney(amount, data.reports.pnl.currency) }}
          </span>
        </div>
        <p v-else class="text-slate-500 text-sm">Finance tracking coming in Phase 3</p>
      </section>

      <!-- 8. Incidents -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">Incidents</h3>
          <span
            class="text-xs font-bold px-2.5 py-1 rounded-full"
            :class="data.reports.incidents.count ? 'bg-red-900/40 text-red-300' : 'bg-slate-800 text-slate-500'"
          >
            {{ data.reports.incidents.count }} recorded
          </span>
        </div>
        <ul v-if="data.reports.incidents.items.length" class="space-y-2">
          <li
            v-for="incident in data.reports.incidents.items"
            :key="incident.id"
            class="text-sm flex justify-between gap-4"
          >
            <span class="text-slate-300">
              {{ incident.batchName }}
              <span v-if="incident.notes" class="text-slate-500"> - {{ incident.notes }}</span>
            </span>
            <span class="text-slate-600 text-xs flex-shrink-0">{{ formatDate(incident.createdAt) }}</span>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm">No incidents logged - incident reporting available in Phase 2</p>
      </section>

      <!-- 9. Audit Trail -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
        <h3 class="font-bold text-white mb-4">Audit Trail</h3>
        <ul class="space-y-2 max-h-64 overflow-y-auto">
          <li
            v-for="(e, i) in data.reports.auditTrail"
            :key="i"
            class="text-xs text-slate-400 flex justify-between gap-4"
          >
            <span>
              <span class="text-slate-300">{{ e.action }}</span>
              · {{ e.entityType }}
              <span v-if="e.userName" class="text-slate-500"> by {{ e.userName }}</span>
            </span>
            <span class="text-slate-600 flex-shrink-0">{{ formatDate(e.createdAt) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </AppLayout>
</template>
