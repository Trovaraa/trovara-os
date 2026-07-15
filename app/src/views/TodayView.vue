<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

type ExceptionItem = {
  type: string
  severity: 'high' | 'medium'
  title: string
  message: string
  entityType: string
  entityId: string
  timestamp: string
  metadata?: Record<string, unknown>
}

type ActionItem = {
  priority: number
  action: string
  label: string
  entityType: string
  entityId: string
  link: string
}

type ExceptionSummary = {
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

type TodayData = {
  role: string
  exceptions: ExceptionItem[]
  actionList: ActionItem[]
  summary: ExceptionSummary
  myTasksToday?: {
    id: string
    title: string
    status: string
    dueDate: string | null
    plotName: string | null
  }[]
}

type DayCloseData = {
  date: string
  generatedAt: string
  tasks: {
    total: number
    completed: number
    overdue: number
    pendingApproval: number
    rejected: number
    inProgress: number
  }
  pendingApprovals: {
    id: string
    title: string
    worker: string | null
    plot: string | null
    submittedAt: string
  }[]
  overdueTasks: {
    id: string
    title: string
    status: string
    dueDate: string | null
    worker: string | null
    plot: string | null
  }[]
  inventory: {
    lowStockCount: number
    lowStockItems: { id: string; name: string; quantity: number; reorderLevel: number; unit: string }[]
    movementsToday: number
  }
  livestock: {
    mortalityToday: number
    incidents: { batch: string | null; headCount: number | null; notes: string | null; at: string }[]
  }
  finance: { expensesToday: number; totalExpenses: number; currency: string }
  tomorrowActions: string[]
  status: 'clear' | 'needs_attention'
}

const auth = useAuthStore()
const data = ref<TodayData | null>(null)
const dayClose = ref<DayCloseData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const dayCloseOpen = ref(false)
const dayCloseLoading = ref(false)

const isWorker = computed(() => auth.user?.role === 'field_worker')

const exceptionIcon: Record<string, string> = {
  overdue_task: 'text-red-400',
  low_stock: 'text-amber-400',
  pending_approval: 'text-purple-400',
  mortality_today: 'text-red-500',
  order_pending: 'text-orange-400',
  rejected_task: 'text-rose-400',
  asset_log_missing: 'text-amber-400',
  asset_verification_pending: 'text-cyan-400',
}

const exceptionLabel: Record<string, string> = {
  overdue_task: 'Overdue',
  low_stock: 'Low stock',
  pending_approval: 'Awaiting approval',
  mortality_today: 'Mortality',
  order_pending: 'Order pending',
  rejected_task: 'Rejected',
  asset_log_missing: 'Not logged',
  asset_verification_pending: 'Verify asset',
}

const summaryCards = computed(() => {
  if (!data.value) return []
  const s = data.value.summary
  const cards: { key: keyof ExceptionSummary; label: string; color: string }[] = [
    { key: 'overdueTasks', label: 'Overdue', color: 'text-red-400' },
    { key: 'lowStock', label: 'Low stock', color: 'text-amber-400' },
    { key: 'pendingApprovals', label: 'Approvals', color: 'text-purple-400' },
    { key: 'mortalityToday', label: 'Mortality', color: 'text-red-500' },
    { key: 'ordersPending', label: 'Orders', color: 'text-orange-400' },
    { key: 'rejectedTasks', label: 'Rejected', color: 'text-rose-400' },
    { key: 'assetLogsMissing', label: 'Not logged', color: 'text-amber-400' },
    { key: 'assetVerificationPending', label: 'Verify assets', color: 'text-cyan-400' },
  ]
  return cards.filter((card) => s[card.key] > 0 || !isWorker.value)
})

onMounted(async () => {
  try {
    data.value = await api<TodayData>('/api/today')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load today view'
  } finally {
    loading.value = false
  }
})

async function openDayClose() {
  if (dayClose.value) {
    dayCloseOpen.value = !dayCloseOpen.value
    return
  }
  dayCloseLoading.value = true
  dayCloseOpen.value = true
  try {
    dayClose.value = await api<DayCloseData>('/api/day-close')
  } finally {
    dayCloseLoading.value = false
  }
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatCurrency(amount: number, currency: string) {
  return `${currency} ${amount.toLocaleString()}`
}
</script>

<template>
  <AppLayout>
    <div v-if="loading" class="text-slate-400">Loading today…</div>

    <div v-else-if="error" class="text-red-400">{{ error }}</div>

    <div v-else-if="data" class="relative z-0 w-full max-w-full min-w-0">
      <div>
        <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">Today</p>
        <h2 class="text-2xl sm:text-3xl font-black text-white mt-1 leading-tight">
          {{ isWorker ? 'My tasks' : 'Exception dashboard' }}
        </h2>
        <p class="text-slate-400 text-sm mt-1">
          {{ isWorker ? 'Your open tasks for today' : `${data.summary.total} item(s) need attention` }}
        </p>
      </div>

      <!-- Worker: my tasks today -->
      <section v-if="isWorker && data.myTasksToday" class="mt-8">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">My tasks today</h3>
          <RouterLink to="/tasks" class="text-xs text-farm-green hover:underline">View all →</RouterLink>
        </div>
        <ul v-if="data.myTasksToday.length" class="space-y-3">
          <li
            v-for="task in data.myTasksToday"
            :key="task.id"
            class="w-full max-w-full box-border overflow-hidden bg-slate-900 border border-slate-800 rounded-xl p-4 min-w-0"
          >
            <TaskStatusBadge :status="task.status" class="mb-2" />
            <p class="font-medium text-white text-base break-words leading-snug">{{ task.title }}</p>
            <p v-if="task.plotName" class="text-xs text-slate-500 mt-1">{{ task.plotName }}</p>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-2xl p-6">
          No open tasks for today
        </p>
      </section>

      <!-- Summary counts (managers) -->
      <div v-if="!isWorker" class="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-8">
        <div
          v-for="card in summaryCards"
          :key="card.key"
          class="bg-slate-900 border border-slate-800 rounded-2xl p-4 min-h-[44px]"
        >
          <p class="text-xs text-slate-500 font-medium">{{ card.label }}</p>
          <p class="text-2xl font-black mt-1" :class="card.color">
            {{ data.summary[card.key] }}
          </p>
        </div>
      </div>

      <!-- Action list -->
      <section v-if="data.actionList.length" class="mt-8">
        <h3 class="font-bold text-white mb-4">Action list</h3>
        <ul class="space-y-2">
          <li v-for="action in data.actionList" :key="`${action.action}-${action.entityId}`">
            <RouterLink
              :to="action.link"
              class="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 min-h-[44px] transition-all hover:border-farm-green/40 hover:bg-slate-800/80 active:scale-[0.99]"
            >
              <span class="w-6 h-6 rounded-full bg-farm-green/20 text-farm-green text-xs font-bold flex items-center justify-center shrink-0">
                {{ action.priority }}
              </span>
              <span class="text-sm text-slate-200">{{ action.label }}</span>
            </RouterLink>
          </li>
        </ul>
      </section>

      <!-- Exceptions -->
      <section class="mt-8">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">
            {{ isWorker ? 'Blockers' : 'Exceptions' }}
          </h3>
          <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <RouterLink to="/tasks" class="text-farm-green hover:underline">Tasks</RouterLink>
            <RouterLink to="/inventory" class="text-farm-green hover:underline">Inventory</RouterLink>
            <RouterLink v-if="!isWorker" to="/sales" class="text-farm-green hover:underline">Sales</RouterLink>
          </div>
        </div>

        <ul v-if="data.exceptions.length" class="space-y-3">
          <li
            v-for="ex in data.exceptions"
            :key="`${ex.type}-${ex.entityId}`"
            class="bg-slate-900 border rounded-2xl p-4 min-h-[44px]"
            :class="ex.severity === 'high' ? 'border-red-900/50' : 'border-slate-800'"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <span
                  class="text-xs font-bold uppercase tracking-wide"
                  :class="exceptionIcon[ex.type] ?? 'text-slate-400'"
                >
                  {{ exceptionLabel[ex.type] ?? ex.type }}
                </span>
                <p class="font-medium text-white mt-1 truncate">{{ ex.title }}</p>
                <p class="text-sm text-slate-400 mt-0.5">{{ ex.message }}</p>
              </div>
              <time class="text-xs text-slate-600 shrink-0">{{ formatTime(ex.timestamp) }}</time>
            </div>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-2xl p-6">
          {{ isWorker ? "No blockers - you're clear" : 'No exceptions - farm is on track' }}
        </p>
      </section>

      <!-- ── Farm Day Close (supervisor/owner only) ── -->
      <section v-if="!isWorker" class="mt-10">
        <button
          type="button"
          class="w-full flex items-center justify-between bg-slate-900 border border-slate-700 rounded-2xl px-5 py-4 transition-all hover:border-farm-green/50 active:scale-[0.99]"
          @click="openDayClose"
        >
          <div class="flex items-center gap-3">
            <span class="text-farm-green text-lg">🌙</span>
            <div class="text-left">
              <p class="font-bold text-white text-sm">Farm Day Close</p>
              <p class="text-xs text-slate-400 mt-0.5">End-of-day summary - tasks, approvals, inventory, finance</p>
            </div>
          </div>
          <svg
            class="w-4 h-4 text-slate-400 shrink-0 transition-transform"
            :class="{ 'rotate-180': dayCloseOpen }"
            fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        <div v-if="dayCloseOpen" class="mt-3 space-y-4">
          <div v-if="dayCloseLoading" class="text-slate-400 text-sm px-1">Loading day close…</div>

          <template v-else-if="dayClose">
            <!-- Status banner -->
            <div
              class="rounded-2xl px-5 py-4 flex items-center gap-3"
              :class="dayClose.status === 'clear'
                ? 'bg-farm-green/10 border border-farm-green/30'
                : 'bg-amber-950/40 border border-amber-700/40'"
            >
              <span class="text-xl">{{ dayClose.status === 'clear' ? '✅' : '⚠️' }}</span>
              <div>
                <p class="font-bold text-sm" :class="dayClose.status === 'clear' ? 'text-farm-green' : 'text-amber-300'">
                  {{ dayClose.status === 'clear' ? 'Day is clear' : 'Needs attention before close' }}
                </p>
                <p class="text-xs text-slate-400 mt-0.5">{{ dayClose.date }}</p>
              </div>
            </div>

            <!-- Task breakdown -->
            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h4 class="font-bold text-white text-sm mb-3">Tasks today</h4>
              <div class="grid grid-cols-3 gap-3">
                <div class="text-center">
                  <p class="text-2xl font-black text-farm-green">{{ dayClose.tasks.completed }}</p>
                  <p class="text-xs text-slate-500 mt-0.5">Completed</p>
                </div>
                <div class="text-center">
                  <p class="text-2xl font-black" :class="dayClose.tasks.overdue > 0 ? 'text-red-400' : 'text-slate-400'">
                    {{ dayClose.tasks.overdue }}
                  </p>
                  <p class="text-xs text-slate-500 mt-0.5">Overdue</p>
                </div>
                <div class="text-center">
                  <p class="text-2xl font-black" :class="dayClose.tasks.pendingApproval > 0 ? 'text-purple-400' : 'text-slate-400'">
                    {{ dayClose.tasks.pendingApproval }}
                  </p>
                  <p class="text-xs text-slate-500 mt-0.5">For approval</p>
                </div>
              </div>
            </div>

            <!-- Pending approvals -->
            <div v-if="dayClose.pendingApprovals.length" class="bg-slate-900 border border-purple-900/40 rounded-2xl p-5">
              <h4 class="font-bold text-purple-300 text-sm mb-3">
                Awaiting approval ({{ dayClose.pendingApprovals.length }})
              </h4>
              <ul class="space-y-2">
                <li
                  v-for="t in dayClose.pendingApprovals"
                  :key="t.id"
                  class="flex items-start justify-between gap-2 text-sm"
                >
                  <div class="min-w-0">
                    <p class="font-medium text-white truncate">{{ t.title }}</p>
                    <p class="text-xs text-slate-500">{{ t.worker ?? 'Unassigned' }}{{ t.plot ? ` · ${t.plot}` : '' }}</p>
                  </div>
                  <RouterLink to="/tasks" class="text-xs text-farm-green shrink-0 hover:underline">Approve →</RouterLink>
                </li>
              </ul>
            </div>

            <!-- Overdue tasks -->
            <div v-if="dayClose.overdueTasks.length" class="bg-slate-900 border border-red-900/40 rounded-2xl p-5">
              <h4 class="font-bold text-red-400 text-sm mb-3">
                Overdue tasks ({{ dayClose.overdueTasks.length }})
              </h4>
              <ul class="space-y-2">
                <li
                  v-for="t in dayClose.overdueTasks.slice(0, 5)"
                  :key="t.id"
                  class="text-sm"
                >
                  <p class="font-medium text-white truncate">{{ t.title }}</p>
                  <p class="text-xs text-slate-500">
                    {{ t.worker ?? 'Unassigned' }}{{ t.plot ? ` · ${t.plot}` : '' }}
                    <span v-if="t.dueDate"> · Due {{ formatTime(t.dueDate) }}</span>
                  </p>
                </li>
              </ul>
              <p v-if="dayClose.overdueTasks.length > 5" class="text-xs text-slate-500 mt-2">
                +{{ dayClose.overdueTasks.length - 5 }} more
              </p>
            </div>

            <!-- Inventory & livestock -->
            <div class="grid grid-cols-2 gap-3">
              <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                <p class="text-xs text-slate-500 font-medium">Low stock</p>
                <p class="text-2xl font-black mt-1" :class="dayClose.inventory.lowStockCount > 0 ? 'text-amber-400' : 'text-slate-400'">
                  {{ dayClose.inventory.lowStockCount }}
                </p>
                <p class="text-xs text-slate-500 mt-0.5">{{ dayClose.inventory.movementsToday }} movements today</p>
              </div>
              <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                <p class="text-xs text-slate-500 font-medium">Mortality</p>
                <p class="text-2xl font-black mt-1" :class="dayClose.livestock.mortalityToday > 0 ? 'text-red-400' : 'text-slate-400'">
                  {{ dayClose.livestock.mortalityToday }}
                </p>
                <p class="text-xs text-slate-500 mt-0.5">head today</p>
              </div>
            </div>

            <!-- Finance -->
            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h4 class="font-bold text-white text-sm mb-1">Expenses today</h4>
              <p class="text-xl font-black text-white">
                {{ formatCurrency(dayClose.finance.totalExpenses, dayClose.finance.currency) }}
              </p>
              <p class="text-xs text-slate-500 mt-0.5">{{ dayClose.finance.expensesToday }} expense(s) logged</p>
            </div>

            <!-- Tomorrow's actions -->
            <div v-if="dayClose.tomorrowActions.length" class="bg-slate-900 border border-farm-green/20 rounded-2xl p-5">
              <h4 class="font-bold text-farm-green text-sm mb-3">For tomorrow</h4>
              <ul class="space-y-2">
                <li
                  v-for="(action, idx) in dayClose.tomorrowActions"
                  :key="idx"
                  class="flex items-start gap-2 text-sm text-slate-300"
                >
                  <span class="text-farm-green shrink-0">→</span>
                  <span>{{ action }}</span>
                </li>
              </ul>
            </div>
            <p v-else class="text-xs text-slate-500 px-1">No carry-forward actions - clean day close.</p>
          </template>
        </div>
      </section>
    </div>
  </AppLayout>
</template>
