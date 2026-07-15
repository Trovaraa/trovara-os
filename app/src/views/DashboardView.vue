<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
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
    error.value = e instanceof Error ? e.message : 'Failed to load dashboard'
  } finally {
    loading.value = false
  }
})

const statCards = [
  { key: 'tasksPending', label: 'Pending Tasks', color: 'text-amber-400', to: '/tasks' },
  { key: 'tasksInProgress', label: 'In Progress', color: 'text-blue-400', to: '/tasks' },
  { key: 'tasksAwaitingApproval', label: 'Awaiting Approval', color: 'text-purple-400', to: '/tasks' },
  { key: 'tasksCompleted', label: 'Completed', color: 'text-farm-green', to: '/tasks' },
] as const
</script>

<template>
  <AppLayout>
    <div v-if="loading" class="text-slate-400">Loading dashboard…</div>

    <div v-else-if="error" class="text-red-400">{{ error }}</div>

    <!-- Worker: simplified my-tasks today -->
    <div v-else-if="isWorker && workerData" class="relative z-0 w-full max-w-full min-w-0">
      <div>
        <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">My day</p>
        <h2 class="text-3xl font-black text-white mt-1">Dashboard</h2>
        <p class="text-slate-400 text-sm mt-1">Your tasks and blockers</p>
      </div>

      <div v-if="workerData.summary.rejectedTasks || workerData.summary.overdueTasks" class="mt-6">
        <RouterLink
          to="/today"
          class="block bg-red-950/40 border border-red-900/50 rounded-2xl p-4 transition-all hover:border-red-700/50 min-h-[44px]"
        >
          <p class="text-sm font-semibold text-red-300">
            {{ workerData.summary.rejectedTasks + workerData.summary.overdueTasks }} blocker(s) need attention
          </p>
          <p class="text-xs text-red-400/80 mt-1">View on Today →</p>
        </RouterLink>
      </div>

      <div class="mt-8">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">My tasks today</h3>
          <RouterLink to="/tasks" class="text-xs text-farm-green hover:underline">All tasks →</RouterLink>
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
          No open tasks for today
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
        <p class="text-farm-green text-xs font-bold tracking-widest uppercase">Start here</p>
        <p class="text-lg font-bold text-white mt-1">Open Today - exception dashboard</p>
        <p class="text-sm text-slate-400 mt-1">
          Review overdue tasks, approvals, low stock, and orders needing action
        </p>
      </RouterLink>

      <div>
        <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">Operations Hub</p>
        <h2 class="text-3xl font-black text-white mt-1">
          {{ data.farm?.name ?? 'Farm' }}
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
          <p class="text-xs text-slate-500 font-medium">{{ card.label }}</p>
          <p class="text-3xl font-black mt-1" :class="card.color">
            {{ data.summary[card.key] }}
          </p>
          <p class="text-xs text-slate-600 mt-2">View tasks →</p>
        </RouterLink>
      </div>

      <div class="grid lg:grid-cols-2 gap-6 mt-8">
        <RouterLink
          to="/today"
          class="bg-slate-900 border border-slate-800 rounded-2xl p-6 block cursor-pointer transition-all hover:border-amber-500/30 hover:bg-slate-800/80"
        >
          <h3 class="font-bold text-white mb-4">Alerts</h3>
          <ul v-if="data.alerts.length" class="space-y-3">
            <li
              v-for="alert in data.alerts"
              :key="alert.message"
              class="flex items-start gap-3 text-sm"
            >
              <span class="w-2 h-2 rounded-full bg-amber-400 mt-1.5 flex-shrink-0" />
              <span class="text-slate-300">{{ alert.message }}</span>
            </li>
          </ul>
          <p v-else class="text-slate-500 text-sm">No active alerts</p>
          <p class="text-xs text-farm-green mt-4">View on Today →</p>
        </RouterLink>

        <RouterLink
          to="/inventory"
          class="bg-slate-900 border border-slate-800 rounded-2xl p-6 block cursor-pointer transition-all hover:border-red-500/30 hover:bg-slate-800/80"
        >
          <h3 class="font-bold text-white mb-4">Low Stock</h3>
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
          <p v-else class="text-slate-500 text-sm">All stock levels healthy</p>
          <p v-if="data.lowStockItems.length" class="text-xs text-slate-600 mt-4">View inventory →</p>
        </RouterLink>
      </div>
    </div>
  </AppLayout>
</template>
