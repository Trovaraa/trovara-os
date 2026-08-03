<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import ReportsDigestPanel from '@/components/reports/ReportsDigestPanel.vue'
import ReportsPlotProfitabilityPanel from '@/components/reports/ReportsPlotProfitabilityPanel.vue'
import { useReportsData } from '@/composables/useReportsData'
import { useExceptionText } from '@/composables/useExceptionText'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()
const { actionLabel } = useExceptionText()

const {
  data,
  digest,
  burnRate,
  inventoryShrink,
  actionList,
  plotProfitability,
  loading,
  error,
  formatMoney,
  formatDate,
} = useReportsData()

const hasAnyReport = computed(
  () =>
    !!data.value ||
    !!digest.value ||
    !!burnRate.value ||
    !!inventoryShrink.value ||
    !!actionList.value ||
    !!plotProfitability.value,
)

const generatedAt = computed(
  () =>
    data.value?.generatedAt ||
    digest.value?.generatedAt ||
    actionList.value?.generatedAt ||
    burnRate.value?.generatedAt ||
    inventoryShrink.value?.generatedAt ||
    plotProfitability.value?.generatedAt ||
    null,
)

function auditMetaString(metadata: unknown, key: string): string {
  if (!metadata || typeof metadata !== 'object') return ''
  const value = (metadata as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function auditIp(metadata: unknown): string {
  return auditMetaString(metadata, 'ip')
}

function auditLocation(metadata: unknown): string {
  const country = auditMetaString(metadata, 'country')
  const region = auditMetaString(metadata, 'region')
  if (region && country) return `${region}, ${country}`
  return country || region
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-os-fg">{{ t('reports.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('reports.subtitle') }}</p>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('reports.loading') }}</div>
    <div v-else-if="error" class="mt-8 text-red-400">{{ error }}</div>

    <div v-else-if="hasAnyReport" class="mt-8 space-y-6 min-w-0 max-w-full">
      <p v-if="generatedAt" class="text-xs text-slate-500">
        {{ t('reports.generated') }} {{ formatDate(generatedAt) }}
      </p>

      <template v-if="auth.canApprove">
        <!-- Exception Digest -->
        <ReportsDigestPanel v-if="digest" :digest="digest" />

        <!-- Manager Action List -->
        <section v-if="actionList" class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <h3 class="font-bold text-white mb-4">{{ t('reports.actionListTitle') }}</h3>
          <ul v-if="actionList.actions.length" class="space-y-2">
            <li
              v-for="item in actionList.actions.slice(0, 10)"
              :key="`${item.action}-${item.entityId}`"
              class="text-sm flex items-center justify-between gap-4 border-b border-slate-800/50 pb-2 last:border-0"
            >
              <span class="text-slate-300">{{ actionLabel(item) }}</span>
              <span class="text-xs text-slate-500 capitalize">{{ item.action.replace('_', ' ') }}</span>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">{{ t('reports.noActions') }}</p>
        </section>

        <!-- Inventory shrink / leakage -->
        <section v-if="inventoryShrink" class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-white">{{ t('reports.shrinkTitle') }}</h3>
            <span class="text-xs text-slate-500">
              {{ t('reports.lastDays', { count: inventoryShrink.periodDays }) }} ·
              <span :class="inventoryShrink.flaggedCount ? 'text-amber-300' : 'text-farm-green'">
                {{ t('reports.shrinkFlagged', { count: inventoryShrink.flaggedCount }) }}
              </span>
            </span>
          </div>
          <ul v-if="inventoryShrink.items.length" class="space-y-2">
            <li
              v-for="item in inventoryShrink.items.slice(0, 10)"
              :key="item.itemId"
              class="text-sm flex justify-between gap-4 border-b border-slate-800/40 pb-2 last:border-0"
            >
              <span class="text-slate-300 min-w-0">
                <span class="font-mono text-[11px] text-farm-green">{{ item.sku }}</span>
                {{ item.name }}
                <span
                  v-if="item.flags.length"
                  class="ml-2 text-[10px] uppercase tracking-wide text-amber-300"
                >
                  {{ item.flags.join(' · ') }}
                </span>
              </span>
              <span class="font-mono text-xs text-slate-500 flex-shrink-0 text-right">
                {{ t('reports.shrinkIn') }} {{ item.qtyIn }} ·
                {{ t('reports.shrinkSale') }} {{ item.qtyOutSale }} ·
                {{ t('reports.shrinkSold') }} {{ item.soldQty }} ·
                {{ t('reports.shrinkOther') }} {{ item.qtyOutOther }}
              </span>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">{{ t('reports.shrinkNone') }}</p>
        </section>

        <!-- Inventory Burn Rate -->
        <section v-if="burnRate" class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-white">{{ t('reports.burnRateTitle') }}</h3>
            <span class="text-xs text-slate-500">{{ t('reports.lastDays', { count: burnRate.periodDays }) }}</span>
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
                <span v-if="item.daysRemaining !== null"> · {{ t('reports.daysLeft', { count: item.daysRemaining }) }}</span>
                <span v-else> · {{ t('reports.noUsageData') }}</span>
              </span>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">{{ t('reports.noInventoryTracked') }}</p>
        </section>
      </template>

      <!-- Plot Profitability (finance) -->
      <ReportsPlotProfitabilityPanel
        v-if="auth.canAccessFinance && plotProfitability"
        :plot-profitability="plotProfitability"
        :format-money="formatMoney"
      />

      <template v-if="data">
        <!-- 1. Daily Operations -->
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <h3 class="font-bold text-white mb-4">{{ t('reports.dailyOpsTitle') }}</h3>
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
            <div class="bg-slate-800/50 rounded-xl p-3">
              <p class="text-xs text-slate-500">{{ t('reports.totalTasks') }}</p>
              <p class="text-2xl font-black text-os-fg">{{ data.reports.dailyOps.totalTasks }}</p>
            </div>
            <div class="bg-slate-800/50 rounded-xl p-3">
              <p class="text-xs text-slate-500">{{ t('reports.inProgress') }}</p>
              <p class="text-2xl font-black text-blue-400">{{ data.reports.dailyOps.inProgress }}</p>
            </div>
            <div class="bg-slate-800/50 rounded-xl p-3">
              <p class="text-xs text-slate-500">{{ t('reports.awaitingApproval') }}</p>
              <p class="text-2xl font-black text-purple-400">{{ data.reports.dailyOps.awaitingApproval }}</p>
            </div>
            <div class="bg-slate-800/50 rounded-xl p-3">
              <p class="text-xs text-slate-500">{{ t('reports.completedToday') }}</p>
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
            <h3 class="font-bold text-white">{{ t('reports.tasksOverdueTitle') }}</h3>
            <span
              class="text-xs font-bold px-2.5 py-1 rounded-full"
              :class="data.reports.tasksOverdue.count ? 'bg-red-900/40 text-red-300' : 'bg-farm-green/20 text-farm-green'"
            >
              {{ t('reports.overdueCount', { count: data.reports.tasksOverdue.count }) }}
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
                <span class="text-red-400">{{ t('reports.due') }} {{ task.dueDate ? formatDate(task.dueDate) : '-' }}</span>
              </div>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">{{ t('reports.noOverdueTasks') }}</p>
        </section>

        <!-- 3. Inventory -->
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-white">{{ t('reports.inventoryTitle') }}</h3>
            <span class="text-xs text-slate-500">
              {{ t('reports.itemsCount', { count: data.reports.inventory.totalItems }) }} ·
              <span :class="data.reports.inventory.lowStockCount ? 'text-red-400' : 'text-farm-green'">
                {{ t('reports.lowStockCount', { count: data.reports.inventory.lowStockCount }) }}
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
              <p class="text-xs text-slate-500 font-semibold mb-2 uppercase tracking-wide">{{ t('reports.recentMovements') }}</p>
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
              <p v-else class="text-slate-500 text-sm">{{ t('reports.noMovements') }}</p>
            </div>
          </div>
        </section>

        <!-- 4. Crop Status -->
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-white">{{ t('reports.cropStatusTitle') }}</h3>
            <span
              v-if="data.reports.cropStatus.phase === 'placeholder'"
              class="text-xs bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full"
            >
              {{ t('reports.phase2') }}
            </span>
          </div>
          <ul class="space-y-2 mb-4">
            <li
              v-for="plot in data.reports.cropStatus.plots"
              :key="plot.name"
              class="text-sm text-slate-300 flex justify-between"
            >
              <span>{{ plot.name }}</span>
              <span class="text-slate-500 capitalize">{{ plot.cropType }} · {{ plot.areaAcres }} {{ t('reports.acres') }}</span>
            </li>
          </ul>
          <div v-if="data.reports.cropStatus.cycles.length">
            <p class="text-xs text-slate-500 font-semibold mb-2 uppercase tracking-wide">{{ t('reports.activeCycles') }}</p>
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
          <p v-else class="text-slate-500 text-sm">{{ t('reports.noCropCycles') }}</p>
        </section>

        <!-- 5. Livestock -->
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-white">{{ t('reports.livestockTitle') }}</h3>
            <span
              v-if="data.reports.livestock.phase === 'placeholder'"
              class="text-xs bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full"
            >
              {{ t('reports.phase2') }}
            </span>
          </div>
          <template v-if="data.reports.livestock.batches.length">
            <p class="text-sm text-slate-300 mb-3">
              {{ t('reports.batchesCount', { count: data.reports.livestock.batchCount }) }} ·
              {{ t('reports.headTotal', { count: data.reports.livestock.totalHeadCount }) }}
            </p>
            <ul class="space-y-2">
              <li
                v-for="batch in data.reports.livestock.batches"
                :key="batch.id"
                class="text-sm flex justify-between"
              >
                <span class="text-slate-300">{{ batch.name }} ({{ batch.species }})</span>
                <span class="text-slate-500">{{ batch.headCount }} {{ t('reports.head') }}</span>
              </li>
            </ul>
          </template>
          <p v-else class="text-slate-500 text-sm">{{ t('reports.livestockComing') }}</p>
        </section>

        <template v-if="auth.canAccessFinance">
          <!-- 6. Sales -->
          <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
            <div class="flex items-center justify-between mb-4">
              <h3 class="font-bold text-white">{{ t('reports.salesTitle') }}</h3>
              <span
                v-if="data.reports.sales.phase === 'placeholder'"
                class="text-xs bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full"
              >
                {{ t('reports.phase3') }}
              </span>
            </div>
            <template v-if="data.reports.sales.totalOrders">
              <p class="text-sm text-slate-300 mb-3">
                {{ t('reports.ordersCount', { count: data.reports.sales.totalOrders }) }} ·
                {{ formatMoney(data.reports.sales.totalRevenue, data.reports.sales.currency) }} {{ t('reports.revenueLabel') }}
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
            <p v-else class="text-slate-500 text-sm">{{ t('reports.salesComing') }}</p>
          </section>

          <!-- 7. P&L -->
          <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
            <div class="flex items-center justify-between mb-4">
              <h3 class="font-bold text-white">{{ t('reports.pnlTitle') }}</h3>
              <span
                v-if="data.reports.pnl.phase === 'placeholder'"
                class="text-xs bg-slate-800 text-slate-500 px-2.5 py-1 rounded-full"
              >
                {{ t('reports.phase3') }}
              </span>
            </div>
            <div class="grid grid-cols-3 gap-4 mb-4">
              <div class="bg-slate-800/50 rounded-xl p-3">
                <p class="text-xs text-slate-500">{{ t('reports.revenue') }}</p>
                <p class="text-lg font-black text-farm-green">
                  {{ formatMoney(data.reports.pnl.revenue, data.reports.pnl.currency) }}
                </p>
              </div>
              <div class="bg-slate-800/50 rounded-xl p-3">
                <p class="text-xs text-slate-500">{{ t('reports.expenses') }}</p>
                <p class="text-lg font-black text-red-400">
                  {{ formatMoney(data.reports.pnl.expenses, data.reports.pnl.currency) }}
                </p>
              </div>
              <div class="bg-slate-800/50 rounded-xl p-3">
                <p class="text-xs text-slate-500">{{ t('reports.net') }}</p>
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
            <p v-else class="text-slate-500 text-sm">{{ t('reports.financeComing') }}</p>
          </section>
        </template>

        <!-- 8. Incidents -->
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="font-bold text-white">{{ t('reports.incidentsTitle') }}</h3>
            <span
              class="text-xs font-bold px-2.5 py-1 rounded-full"
              :class="data.reports.incidents.count ? 'bg-red-900/40 text-red-300' : 'bg-slate-800 text-slate-500'"
            >
              {{ t('reports.recordedCount', { count: data.reports.incidents.count }) }}
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
          <p v-else class="text-slate-500 text-sm">{{ t('reports.noIncidents') }}</p>
        </section>

        <!-- 9. Audit Trail (finance) -->
        <section
          v-if="auth.canAccessFinance"
          class="bg-slate-900 border border-slate-800 rounded-2xl p-6"
        >
          <h3 class="font-bold text-white mb-4">{{ t('reports.auditTrailTitle') }}</h3>
          <ul class="space-y-2 max-h-64 overflow-y-auto">
            <li
              v-for="(e, i) in data.reports.auditTrail"
              :key="i"
              class="text-xs text-slate-400 flex justify-between gap-4"
            >
              <span class="min-w-0">
                <span class="text-slate-300">{{ e.action }}</span>
                · {{ e.entityType }}
                <span v-if="e.userName" class="text-slate-500"> {{ t('reports.by') }} {{ e.userName }}</span>
                <span v-if="auditIp(e.metadata)" class="text-slate-500">
                  · {{ t('reports.auditIp') }} {{ auditIp(e.metadata) }}
                </span>
                <span v-if="auditLocation(e.metadata)" class="text-slate-500">
                  · {{ auditLocation(e.metadata) }}
                </span>
              </span>
              <span class="text-slate-600 flex-shrink-0">{{ formatDate(e.createdAt) }}</span>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </AppLayout>
</template>
