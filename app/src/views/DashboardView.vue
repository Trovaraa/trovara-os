<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

type DashboardData = {
  scope?: 'farm' | 'sales'
  farm: { name: string; location: string } | null
  summary: {
    tasksPending: number
    tasksInProgress: number
    tasksAwaitingApproval: number
    tasksCompleted: number
    plotCount: number
    lowStockCount: number
    pendingApprovals: number
    ordersPending?: number
    ordersConfirmed?: number
    ordersDispatched?: number
    ordersDelivered?: number
    unpaidOrders?: number
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
const isSales = computed(() => auth.user?.role === 'sales')
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

const farmStatCards = [
  { key: 'tasksPending', labelKey: 'dashboard.pendingTasks', color: 'text-amber-400', to: '/tasks' },
  { key: 'tasksInProgress', labelKey: 'dashboard.inProgress', color: 'text-blue-400', to: '/tasks' },
  { key: 'tasksAwaitingApproval', labelKey: 'dashboard.awaitingApproval', color: 'text-purple-400', to: '/tasks' },
  { key: 'tasksCompleted', labelKey: 'dashboard.completed', color: 'text-farm-green', to: '/tasks' },
] as const

const salesStatCards = [
  { key: 'ordersPending', labelKey: 'dashboard.ordersPending', color: 'text-orange-400', to: '/sales' },
  { key: 'unpaidOrders', labelKey: 'dashboard.unpaidOrders', color: 'text-amber-400', to: '/sales' },
  { key: 'ordersDispatched', labelKey: 'dashboard.ordersDispatched', color: 'text-sky-400', to: '/sales' },
  { key: 'ordersDelivered', labelKey: 'dashboard.ordersDelivered', color: 'text-farm-green', to: '/sales' },
] as const

const statCards = computed(() => (isSales.value ? salesStatCards : farmStatCards))

const dateLabel = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
}).format(new Date())

const firstName = computed(() => auth.user?.name?.trim() ?? '')

const completionRate = computed(() => {
  if (!data.value || isSales.value) return 0
  const summary = data.value.summary
  const total = summary.tasksPending + summary.tasksInProgress + summary.tasksAwaitingApproval + summary.tasksCompleted
  return total ? Math.round((summary.tasksCompleted / total) * 100) : 0
})

const quickLinks = computed(() => {
  if (isSales.value) {
    return [
      { to: '/sales', label: t('nav.sales'), detail: t('dashboard.ordersPending'), accent: 'text-orange-300' },
      { to: '/products', label: t('nav.products'), detail: t('dashboard.viewSales'), accent: 'text-sky-300' },
      { to: '/whatsapp', label: t('nav.whatsapp'), detail: t('dashboard.openTodaySalesSubtitle'), accent: 'text-emerald-300' },
    ]
  }
  return [
    { to: '/tasks', label: t('nav.tasks'), detail: t('dashboard.viewTasks'), accent: 'text-amber-300' },
    { to: '/inventory', label: t('nav.inventory'), detail: t('dashboard.lowStock'), accent: 'text-rose-300' },
    { to: '/advisory', label: t('nav.advisory'), detail: t('advisory.subtitle'), accent: 'text-teal-300' },
  ]
})

function stockPercent(item: DashboardData['lowStockItems'][number]) {
  if (!item.reorderLevel) return 0
  return Math.max(5, Math.min(100, Math.round((item.quantity / item.reorderLevel) * 100)))
}

function alertText(alert: DashboardData['alerts'][number]): string {
  if (alert.type === 'low_stock') {
    return t('dashboard.lowStockAlert', { count: data.value?.summary.lowStockCount ?? 0 })
  }
  if (alert.type === 'approval') {
    return t('dashboard.approvalAlert', { count: data.value?.summary.pendingApprovals ?? 0 })
  }
  if (alert.type === 'order_pending') {
    return t('dashboard.orderPendingAlert', { count: data.value?.summary.ordersPending ?? 0 })
  }
  if (alert.type === 'unpaid_orders') {
    return t('dashboard.unpaidAlert', { count: data.value?.summary.unpaidOrders ?? 0 })
  }
  return alert.message
}

function summaryValue(key: string): number {
  const s = data.value?.summary as Record<string, number> | undefined
  return Number(s?.[key] ?? 0)
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
        <h2 class="text-3xl font-black text-os-fg mt-1">{{ t('dashboard.workerTitle') }}</h2>
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
          <h3 class="font-bold text-os-fg">{{ t('dashboard.myTasksToday') }}</h3>
          <RouterLink to="/tasks" class="text-xs text-farm-green hover:underline">{{ t('dashboard.allTasks') }}</RouterLink>
        </div>
        <ul v-if="workerData.myTasksToday.length" class="space-y-3">
          <li
            v-for="task in workerData.myTasksToday"
            :key="task.id"
            class="w-full max-w-full box-border overflow-hidden bg-slate-900 border border-slate-800 rounded-xl p-4 min-w-0"
          >
            <TaskStatusBadge :status="task.status" class="mb-2" />
            <p class="font-medium text-os-fg text-base break-words leading-snug">{{ task.title }}</p>
            <p v-if="task.plotName" class="text-xs text-slate-500 mt-1">{{ task.plotName }}</p>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-2xl p-6">
          {{ t('dashboard.noOpenTasks') }}
        </p>
      </div>
    </div>

    <!-- Supervisor / owner / sales hub -->
    <div v-else-if="data" class="relative z-0 space-y-6 md:space-y-8">
      <header class="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5">
        <div>
          <div class="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
            <span>{{ dateLabel }}</span>
            <span class="h-1 w-1 rounded-full bg-slate-700" />
            <span>{{ data.farm?.location }}</span>
          </div>
          <h2 class="text-3xl sm:text-4xl font-black text-os-fg mt-2 tracking-[-0.035em]">
            {{ firstName ? t('dashboard.welcomeBack', { name: firstName }) : (data.farm?.name ?? t('dashboard.farmFallback')) }}
          </h2>
          <p class="text-slate-400 text-sm sm:text-base mt-2 max-w-2xl">
            {{ isSales ? t('dashboard.openTodaySalesSubtitle') : t('dashboard.openTodaySubtitle') }}
          </p>
        </div>
        <RouterLink
          v-if="isManager || isSales"
          to="/today"
          class="group inline-flex min-h-[3rem] items-center justify-between gap-5 rounded-2xl bg-farm-green px-5 py-3 text-sm font-black text-[#06130d] shadow-lg shadow-farm-green/10 hover:bg-emerald-400 transition-colors lg:min-w-[15rem]"
        >
          <span>{{ t('dashboard.openToday') }}</span>
          <span class="transition-transform group-hover:translate-x-1" aria-hidden="true">↗</span>
        </RouterLink>
      </header>

      <section class="rounded-[1.75rem] border border-slate-800 bg-slate-900 overflow-hidden shadow-2xl shadow-black/10">
        <div class="px-5 py-4 sm:px-6 border-b border-white/10 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="text-[10px] font-black uppercase tracking-[0.18em] text-farm-green">
              {{ isSales ? t('dashboard.salesHub') : t('dashboard.operationsHub') }}
            </p>
            <h3 class="text-base font-bold text-os-fg mt-1">{{ data.farm?.name ?? t('dashboard.farmFallback') }}</h3>
          </div>
          <div v-if="!isSales" class="flex items-center gap-3 text-xs text-slate-400">
            <span>{{ completionRate }}% {{ t('dashboard.completed').toLowerCase() }}</span>
            <div class="w-28 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div class="h-full rounded-full bg-farm-green" :style="{ width: `${completionRate}%` }" />
            </div>
          </div>
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-white/10">
          <RouterLink
            v-for="card in statCards"
            :key="card.key"
            :to="card.to"
            class="group p-5 sm:p-6 cursor-pointer transition-colors hover:bg-white/[0.045] min-h-[9rem] flex flex-col justify-between"
          >
            <div class="flex items-start justify-between gap-3">
              <p class="text-xs text-slate-400 font-semibold leading-snug">{{ t(card.labelKey) }}</p>
              <span class="text-slate-700 group-hover:text-slate-400 transition-colors" aria-hidden="true">↗</span>
            </div>
            <p class="text-4xl font-black mt-4 tracking-tight tabular-nums" :class="card.color">{{ summaryValue(card.key) }}</p>
          </RouterLink>
        </div>
      </section>

      <section>
        <div class="flex items-center justify-between gap-4 mb-3">
          <h3 class="text-sm font-black text-os-fg">{{ t('dashboard.quickAccess') }}</h3>
          <p class="hidden sm:block text-xs text-slate-600">{{ t('dashboard.signalToAction') }}</p>
        </div>
        <div class="grid sm:grid-cols-3 gap-3">
          <RouterLink
            v-for="link in quickLinks"
            :key="link.to"
            :to="link.to"
            class="group rounded-2xl border border-slate-800 bg-slate-900 p-4 hover:border-farm-green/30 hover:bg-slate-800 transition-all min-w-0"
          >
            <div class="flex items-center justify-between gap-3">
              <p class="font-bold text-os-fg">{{ link.label }}</p>
              <span class="h-8 w-8 rounded-full bg-white/5 grid place-items-center group-hover:bg-farm-green/15 transition-colors" :class="link.accent" aria-hidden="true">→</span>
            </div>
            <p class="mt-3 text-xs text-slate-500 leading-relaxed line-clamp-2">{{ link.detail }}</p>
          </RouterLink>
        </div>
      </section>

      <div class="grid lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)] gap-5">
        <RouterLink
          to="/today"
          class="rounded-[1.5rem] border border-slate-800 bg-slate-900 p-5 sm:p-6 block cursor-pointer transition-all hover:border-amber-500/30"
        >
          <div class="flex items-center justify-between gap-3 mb-5">
            <div>
              <p class="text-[10px] font-black uppercase tracking-[0.18em] text-amber-400">{{ t('dashboard.startHere') }}</p>
              <h3 class="font-bold text-os-fg mt-1">{{ t('dashboard.alerts') }}</h3>
            </div>
            <span class="rounded-full bg-amber-400/10 px-3 py-1 text-xs font-bold text-amber-300">{{ data.alerts.length }}</span>
          </div>
          <ul v-if="data.alerts.length" class="space-y-3">
            <li
              v-for="alert in data.alerts"
              :key="alert.message"
              class="flex items-start gap-3 rounded-xl bg-white/[0.035] px-4 py-3 text-sm"
            >
              <span class="w-2 h-2 rounded-full bg-amber-400 mt-1.5 flex-shrink-0 shadow-[0_0_0_4px_rgba(251,191,36,0.08)]" />
              <span class="text-slate-300 leading-relaxed">{{ alertText(alert) }}</span>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">{{ t('dashboard.noActiveAlerts') }}</p>
          <p class="text-xs font-bold text-farm-green mt-5">{{ t('dashboard.viewToday') }}</p>
        </RouterLink>

        <RouterLink
          :to="isSales ? '/sales' : '/inventory'"
          class="rounded-[1.5rem] border border-slate-800 bg-slate-900 p-5 sm:p-6 block cursor-pointer transition-all hover:border-red-500/30"
        >
          <div class="flex items-center justify-between gap-3 mb-5">
            <div>
              <p class="text-[10px] font-black uppercase tracking-[0.18em] text-rose-400">{{ t('nav.inventory') }}</p>
              <h3 class="font-bold text-os-fg mt-1">{{ t('dashboard.lowStock') }}</h3>
            </div>
            <span class="rounded-full bg-rose-400/10 px-3 py-1 text-xs font-bold text-rose-300">{{ data.lowStockItems.length }}</span>
          </div>
          <ul v-if="data.lowStockItems.length" class="space-y-4">
            <li v-for="item in data.lowStockItems" :key="item.name" class="text-sm">
              <div class="flex justify-between gap-4">
                <span class="text-slate-300 font-medium truncate">{{ item.name }}</span>
                <span class="text-rose-300 font-mono text-xs whitespace-nowrap">{{ item.quantity }} / {{ item.reorderLevel }} {{ item.unit }}</span>
              </div>
              <div class="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div class="h-full rounded-full bg-gradient-to-r from-rose-500 to-amber-400" :style="{ width: `${stockPercent(item)}%` }" />
              </div>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">{{ t('dashboard.allStockHealthy') }}</p>
          <p v-if="data.lowStockItems.length" class="text-xs font-bold text-farm-green mt-5">
            {{ isSales ? t('dashboard.viewSales') : t('dashboard.viewInventory') }}
          </p>
        </RouterLink>
      </div>
    </div>
  </AppLayout>
</template>
