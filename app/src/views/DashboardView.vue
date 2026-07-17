<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

type DashboardData = {
  farm: { name: string; location: string } | null
  summary: {
    tasksPending: number
    tasksInProgress: number
    tasksAwaitingApproval: number
    tasksCompleted: number
    plotCount: number
    lowStockCount: number
    pendingApprovals: number
  }
  alerts: { type: string; message: string }[]
  lowStockItems: { name: string; quantity: number; reorderLevel: number; unit: string }[]
}

type WorkerTodayData = {
  myTasksToday: {
    id: string
    title: string
    status: string
    dueDate: string | null
    plotName: string | null
  }[]
  summary: { total: number; rejectedTasks: number; overdueTasks: number }
}

const auth = useAuthStore()
const { t } = useI18n()
const isWorker = computed(() => auth.user?.role === 'field_worker')
const isManager = computed(() => auth.user?.role === 'owner' || auth.user?.role === 'supervisor')

const data = ref<DashboardData | null>(null)
const workerData = ref<WorkerTodayData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    if (isWorker.value) {
      workerData.value = await api<WorkerTodayData>('/api/today')
    } else {
      data.value = await api<DashboardData>('/api/dashboard')
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('dashboard.loadFailed')
  } finally {
    loading.value = false
  }
})

const statCards = [
  { key: 'tasksPending', labelKey: 'dashboard.pendingTasks', color: 'text-amber-400', to: '/tasks' },
  { key: 'tasksInProgress', labelKey: 'dashboard.inProgress', color: 'text-blue-400', to: '/tasks' },
  { key: 'tasksAwaitingApproval', labelKey: 'dashboard.awaitingApproval', color: 'text-purple-400', to: '/tasks' },
  { key: 'tasksCompleted', labelKey: 'dashboard.completed', color: 'text-farm-green', to: '/tasks' },
] as const

function alertText(alert: DashboardData['alerts'][number]): string {
  if (alert.type === 'low_stock') {
    return t('dashboard.lowStockAlert', { count: data.value?.summary.lowStockCount ?? 0 })
  }
  if (alert.type === 'approval') {
    return t('dashboard.approvalAlert', { count: data.value?.summary.pendingApprovals ?? 0 })
  }
  return alert.message
}
</script>

<template>
  <AppLayout>
    <div v-if="loading" class="text-slate-400">{{ t('dashboard.loading') }}</div>

    <div v-else-if="error" class="text-red-400">{{ error }}</div>

    <!-- Worker: simplified my-tasks today -->
    <div v-else-if="isWorker && workerData" class="relative z-0 w-full max-w-full min-w-0">
      <div>
        <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('dashboard.workerEyebrow') }}</p>
        <h2 class="text-3xl font-black text-white mt-1">{{ t('dashboard.workerTitle') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('dashboard.workerSubtitle') }}</p>
      </div>

      <div v-if="workerData.summary.rejectedTasks || workerData.summary.overdueTasks" class="mt-6">
        <RouterLink
          to="/today"
          class="block bg-red-950/40 border border-red-900/50 rounded-2xl p-4 transition-all hover:border-red-700/50 min-h-[44px]"
        >
          <p class="text-sm font-semibold text-red-300">
            {{ t('dashboard.blockers', { count: workerData.summary.rejectedTasks + workerData.summary.overdueTasks }) }}
          </p>
          <p class="text-xs text-red-400/80 mt-1">{{ t('dashboard.viewToday') }}</p>
        </RouterLink>
      </div>

      <div class="mt-8">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">{{ t('dashboard.myTasksToday') }}</h3>
          <RouterLink to="/tasks" class="text-xs text-farm-green hover:underline">{{ t('dashboard.allTasks') }}</RouterLink>
        </div>
        <ul v-if="workerData.myTasksToday.length" class="space-y-3">
          <li
            v-for="task in workerData.myTasksToday"
            :key="task.id"
            class="w-full max-w-full box-border overflow-hidden bg-slate-900 border border-slate-800 rounded-xl p-4 min-w-0"
          >
            <TaskStatusBadge :status="task.status" class="mb-2" />
            <p class="font-medium text-white text-base break-words leading-snug">{{ task.title }}</p>
            <p v-if="task.plotName" class="text-xs text-slate-500 mt-1">{{ task.plotName }}</p>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-2xl p-6">
          {{ t('dashboard.noOpenTasks') }}
        </p>
      </div>
    </div>

    <!-- Supervisor / owner: ops hub with Today emphasis -->
    <div v-else-if="data" class="relative z-0">
      <RouterLink
        v-if="isManager"
        to="/today"
        class="block mb-8 bg-farm-green/10 border border-farm-green/30 rounded-2xl p-5 transition-all hover:border-farm-green/50 hover:bg-farm-green/15 min-h-[44px]"
      >
        <p class="text-farm-green text-xs font-bold tracking-widest uppercase">{{ t('dashboard.startHere') }}</p>
        <p class="text-lg font-bold text-white mt-1">{{ t('dashboard.openToday') }}</p>
        <p class="text-sm text-slate-400 mt-1">
          {{ t('dashboard.openTodaySubtitle') }}
        </p>
      </RouterLink>

      <div>
        <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('dashboard.operationsHub') }}</p>
        <h2 class="text-3xl font-black text-white mt-1">
          {{ data.farm?.name ?? t('dashboard.farmFallback') }}
        </h2>
        <p class="text-slate-400 text-sm mt-1">{{ data.farm?.location }}</p>
      </div>

      <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mt-8">
        <RouterLink
          v-for="card in statCards"
          :key="card.key"
          :to="card.to"
          class="bg-slate-900 border border-slate-800 rounded-2xl p-5 cursor-pointer transition-all hover:border-farm-green/40 hover:bg-slate-800/80 hover:scale-[1.02] active:scale-[0.99]"
        >
          <p class="text-xs text-slate-500 font-medium">{{ t(card.labelKey) }}</p>
          <p class="text-3xl font-black mt-1" :class="card.color">
            {{ data.summary[card.key] }}
          </p>
          <p class="text-xs text-slate-600 mt-2">{{ t('dashboard.viewTasks') }}</p>
        </RouterLink>
      </div>

      <div class="grid lg:grid-cols-2 gap-6 mt-8">
        <RouterLink
          to="/today"
          class="bg-slate-900 border border-slate-800 rounded-2xl p-6 block cursor-pointer transition-all hover:border-amber-500/30 hover:bg-slate-800/80"
        >
          <h3 class="font-bold text-white mb-4">{{ t('dashboard.alerts') }}</h3>
          <ul v-if="data.alerts.length" class="space-y-3">
            <li
              v-for="alert in data.alerts"
              :key="alert.message"
              class="flex items-start gap-3 text-sm"
            >
              <span class="w-2 h-2 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
              <span class="text-slate-300">{{ alertText(alert) }}</span>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">{{ t('dashboard.noActiveAlerts') }}</p>
          <p class="text-xs text-farm-green mt-4">{{ t('dashboard.viewToday') }}</p>
        </RouterLink>

        <RouterLink
          to="/inventory"
          class="bg-slate-900 border border-slate-800 rounded-2xl p-6 block cursor-pointer transition-all hover:border-red-500/30 hover:bg-slate-800/80"
        >
          <h3 class="font-bold text-white mb-4">{{ t('dashboard.lowStock') }}</h3>
          <ul v-if="data.lowStockItems.length" class="space-y-3">
            <li
              v-for="item in data.lowStockItems"
              :key="item.name"
              class="flex justify-between text-sm"
            >
              <span class="text-slate-300">{{ item.name }}</span>
              <span class="text-red-400 font-mono">
                {{ item.quantity }} / {{ item.reorderLevel }} {{ item.unit }}
              </span>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">{{ t('dashboard.allStockHealthy') }}</p>
          <p v-if="data.lowStockItems.length" class="text-xs text-slate-600 mt-4">{{ t('dashboard.viewInventory') }}</p>
        </RouterLink>
      </div>
    </div>
  </AppLayout>
</template>
