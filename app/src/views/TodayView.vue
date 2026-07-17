<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

const { t } = useI18n()

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
  censusMissing?: number
  censusRejected?: number
  censusStale?: number
  weatherAlerts?: number
  total: number
}

type WeatherDay = {
  date: string
  tempMinC: number
  tempMaxC: number
  precipMm: number
  precipProb: number | null
  windKmh: number
  condition: string
}

type WeatherSnapshot = {
  status: 'ok' | 'stale' | 'unavailable' | 'unconfigured'
  provider: string
  attribution: string
  fetchedAt: string | null
  timezone: string | null
  locationLabel: string | null
  current: {
    tempC: number
    feelsLikeC: number | null
    humidity: number | null
    windKmh: number
    condition: string
  } | null
  daily: WeatherDay[]
  alerts: Array<{ type: string; severity: string; title: string; message: string }>
  actions?: Array<{
    id: string
    priority: 'high' | 'medium' | 'low'
    title: string
    detail: string
    relatedAlert?: string
  }>
  message?: string
}

type TodayData = {
  role: string
  exceptions: ExceptionItem[]
  actionList: ActionItem[]
  summary: ExceptionSummary
  weather?: WeatherSnapshot
  myTasksToday?: {
    id: string
    title: string
    status: string
    dueDate: string | null
    plotId: string | null
    plotName: string | null
  }[]
}

type AttendanceSession = {
  id: string
  userId: string
  userName: string
  clockInAt: string
  clockOutAt: string | null
  monthlyWageSnapshotNgn: number
  plotId: string | null
  plotName: string | null
  taskId: string | null
  taskTitle: string | null
  notes: string | null
  correctedById: string | null
  correctedAt: string | null
  payableMinutes: number
}

type PlotOption = { id: string; name: string; active: boolean }

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
const attendance = ref<AttendanceSession[]>([])
const plots = ref<PlotOption[]>([])
const attendanceBusy = ref(false)
const attendanceError = ref<string | null>(null)
const selectedPlotId = ref('')
const selectedTaskId = ref('')
const attendanceNotes = ref('')
const correctingId = ref<string | null>(null)
const correctionClockIn = ref('')
const correctionClockOut = ref('')
const correctionNotes = ref('')

const isWorker = computed(() => auth.user?.role === 'field_worker')
const openAttendance = computed(
  () => attendance.value.find((session) => session.clockOutAt === null) ?? null,
)

const exceptionIcon: Record<string, string> = {
  overdue_task: 'text-red-400',
  low_stock: 'text-amber-400',
  pending_approval: 'text-purple-400',
  mortality_today: 'text-red-500',
  order_pending: 'text-orange-400',
  rejected_task: 'text-rose-400',
  asset_log_missing: 'text-amber-400',
  asset_verification_pending: 'text-cyan-400',
  census_missing: 'text-amber-400',
  census_rejected: 'text-rose-400',
  census_stale: 'text-orange-400',
  weather_rain: 'text-sky-400',
  weather_heat: 'text-orange-400',
  weather_wind: 'text-cyan-300',
  weather_cold: 'text-blue-300',
}

const exceptionLabel: Record<string, string> = {
  overdue_task: 'today.lblOverdue',
  low_stock: 'today.lblLowStock',
  pending_approval: 'today.lblAwaitingApproval',
  mortality_today: 'today.lblMortality',
  order_pending: 'today.lblOrderPending',
  rejected_task: 'today.lblRejected',
  asset_log_missing: 'today.lblNotLogged',
  asset_verification_pending: 'today.lblVerifyAsset',
  census_missing: 'today.lblCensusMissing',
  census_rejected: 'today.lblCensusRejected',
  census_stale: 'today.lblCensusStale',
  weather_rain: 'today.lblWeatherRain',
  weather_heat: 'today.lblWeatherHeat',
  weather_wind: 'today.lblWeatherWind',
  weather_cold: 'today.lblWeatherCold',
}

const summaryCards = computed(() => {
  if (!data.value) return []
  const s = data.value.summary
  const cards: { key: keyof ExceptionSummary; labelKey: string; color: string }[] = [
    { key: 'overdueTasks', labelKey: 'today.lblOverdue', color: 'text-red-400' },
    { key: 'lowStock', labelKey: 'today.lblLowStock', color: 'text-amber-400' },
    { key: 'pendingApprovals', labelKey: 'today.lblApprovals', color: 'text-purple-400' },
    { key: 'mortalityToday', labelKey: 'today.lblMortality', color: 'text-red-500' },
    { key: 'ordersPending', labelKey: 'today.lblOrders', color: 'text-orange-400' },
    { key: 'rejectedTasks', labelKey: 'today.lblRejected', color: 'text-rose-400' },
    { key: 'assetLogsMissing', labelKey: 'today.lblNotLogged', color: 'text-amber-400' },
    { key: 'assetVerificationPending', labelKey: 'today.lblVerifyAssets', color: 'text-cyan-400' },
  ]
  return cards.filter((card) => (Number(s[card.key] ?? 0) > 0) || !isWorker.value)
})

onMounted(async () => {
  try {
    const [todayData, attendanceData] = await Promise.all([
      api<TodayData>('/api/today'),
      api<{ sessions: AttendanceSession[] }>('/api/attendance/today'),
    ])
    data.value = todayData
    attendance.value = attendanceData.sessions
    if (auth.user?.role === 'field_worker') {
      const plotData = await api<{ plots: PlotOption[] }>('/api/zones/plots')
      plots.value = plotData.plots.filter((plot) => plot.active)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('today.loadFailed')
  } finally {
    loading.value = false
  }
})

async function reloadAttendance() {
  const result = await api<{ sessions: AttendanceSession[] }>('/api/attendance/today')
  attendance.value = result.sessions
}

async function clockInNow() {
  attendanceBusy.value = true
  attendanceError.value = null
  try {
    await api('/api/attendance/clock-in', {
      method: 'POST',
      body: JSON.stringify({
        plotId: selectedPlotId.value || null,
        taskId: selectedTaskId.value || null,
        notes: attendanceNotes.value.trim() || null,
      }),
    })
    await reloadAttendance()
  } catch (e) {
    attendanceError.value = e instanceof Error ? e.message : t('today.attendanceActionFailed')
  } finally {
    attendanceBusy.value = false
  }
}

async function clockOutNow() {
  attendanceBusy.value = true
  attendanceError.value = null
  try {
    await api('/api/attendance/clock-out', { method: 'POST', body: '{}' })
    await reloadAttendance()
  } catch (e) {
    attendanceError.value = e instanceof Error ? e.message : t('today.attendanceActionFailed')
  } finally {
    attendanceBusy.value = false
  }
}

function toLocalInput(iso: string | null) {
  if (!iso) return ''
  const date = new Date(iso)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function startCorrection(session: AttendanceSession) {
  correctingId.value = session.id
  correctionClockIn.value = toLocalInput(session.clockInAt)
  correctionClockOut.value = toLocalInput(session.clockOutAt)
  correctionNotes.value = session.notes ?? ''
}

async function saveCorrection(session: AttendanceSession) {
  attendanceBusy.value = true
  attendanceError.value = null
  try {
    await api(`/api/attendance/${session.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        clockInAt: new Date(correctionClockIn.value).toISOString(),
        clockOutAt: correctionClockOut.value
          ? new Date(correctionClockOut.value).toISOString()
          : null,
        notes: correctionNotes.value.trim() || null,
      }),
    })
    correctingId.value = null
    await reloadAttendance()
  } catch (e) {
    attendanceError.value = e instanceof Error ? e.message : t('today.attendanceActionFailed')
  } finally {
    attendanceBusy.value = false
  }
}

function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return t('today.attendanceDuration', { hours, minutes: remainder })
}

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
    <div v-if="loading" class="text-slate-400">{{ t('today.loading') }}</div>

    <div v-else-if="error" class="text-red-400">{{ error }}</div>

    <div v-else-if="data" class="relative z-0 w-full max-w-full min-w-0">
      <div>
        <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('today.eyebrow') }}</p>
        <h2 class="text-2xl sm:text-3xl font-black text-white mt-1 leading-tight">
          {{ isWorker ? t('today.myTasks') : t('today.exceptionDashboard') }}
        </h2>
        <p class="text-slate-400 text-sm mt-1">
          {{ isWorker ? t('today.workerSubtitle') : t('today.needAttention', { count: data.summary.total }) }}
        </p>
      </div>

      <!-- Attendance -->
      <section class="mt-8 bg-slate-900 border border-slate-800 rounded-2xl p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="font-bold text-white">{{ t('today.attendance') }}</h3>
            <p class="text-xs text-slate-400 mt-1">
              {{ isWorker ? t('today.attendanceWorkerSubtitle') : t('today.attendanceManagerSubtitle') }}
            </p>
          </div>
          <span
            v-if="isWorker"
            class="rounded-full px-3 py-1 text-xs font-bold"
            :class="openAttendance ? 'bg-farm-green/15 text-farm-green' : 'bg-slate-800 text-slate-400'"
          >
            {{ openAttendance ? t('today.clockedIn') : t('today.clockedOut') }}
          </span>
        </div>

        <p v-if="attendanceError" class="mt-3 text-sm text-red-400">{{ attendanceError }}</p>

        <div v-if="isWorker" class="mt-4">
          <div v-if="openAttendance" class="space-y-3">
            <p class="text-sm text-slate-300">
              {{ t('today.since') }} {{ formatTime(openAttendance.clockInAt) }}
              <span v-if="openAttendance.plotName"> · {{ openAttendance.plotName }}</span>
              <span v-if="openAttendance.taskTitle"> · {{ openAttendance.taskTitle }}</span>
            </p>
            <button
              type="button"
              class="min-h-[44px] rounded-xl bg-red-500/90 px-5 py-2.5 font-bold text-white disabled:opacity-50"
              :disabled="attendanceBusy"
              @click="clockOutNow"
            >
              {{ attendanceBusy ? t('today.savingAttendance') : t('today.clockOut') }}
            </button>
          </div>

          <div v-else class="grid gap-3 sm:grid-cols-2">
            <label class="text-xs text-slate-400">
              {{ t('today.blockOptional') }}
              <select v-model="selectedPlotId" class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">
                <option value="">{{ t('today.noAllocation') }}</option>
                <option v-for="plot in plots" :key="plot.id" :value="plot.id">{{ plot.name }}</option>
              </select>
            </label>
            <label class="text-xs text-slate-400">
              {{ t('today.taskOptional') }}
              <select v-model="selectedTaskId" class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">
                <option value="">{{ t('today.noAllocation') }}</option>
                <option v-for="task in data.myTasksToday ?? []" :key="task.id" :value="task.id">
                  {{ task.title }}
                </option>
              </select>
            </label>
            <label class="text-xs text-slate-400 sm:col-span-2">
              {{ t('today.notesOptional') }}
              <input v-model="attendanceNotes" maxlength="2000" class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white" />
            </label>
            <button
              type="button"
              class="min-h-[44px] rounded-xl bg-farm-green px-5 py-2.5 font-bold text-slate-950 disabled:opacity-50 sm:w-fit"
              :disabled="attendanceBusy"
              @click="clockInNow"
            >
              {{ attendanceBusy ? t('today.savingAttendance') : t('today.clockIn') }}
            </button>
          </div>
        </div>

        <div v-else class="mt-4">
          <p v-if="!attendance.length" class="text-sm text-slate-500">{{ t('today.noAttendanceToday') }}</p>
          <ul v-else class="space-y-3">
            <li
              v-for="session in attendance"
              :key="session.id"
              class="rounded-xl border border-slate-800 bg-slate-950 p-4"
            >
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="font-semibold text-white">{{ session.userName }}</p>
                  <p class="mt-1 text-xs text-slate-400">
                    {{ formatTime(session.clockInAt) }}
                    → {{ session.clockOutAt ? formatTime(session.clockOutAt) : t('today.inProgress') }}
                    · {{ formatMinutes(session.payableMinutes) }}
                  </p>
                  <p v-if="session.plotName || session.taskTitle" class="mt-1 text-xs text-slate-500">
                    {{ session.plotName }}<span v-if="session.plotName && session.taskTitle"> · </span>{{ session.taskTitle }}
                  </p>
                  <p v-if="session.correctedAt" class="mt-1 text-[11px] text-amber-400">
                    {{ t('today.corrected') }} · {{ formatTime(session.correctedAt) }}
                  </p>
                </div>
                <button type="button" class="text-xs text-farm-green hover:underline" @click="startCorrection(session)">
                  {{ t('today.correctAttendance') }}
                </button>
              </div>

              <form
                v-if="correctingId === session.id"
                class="mt-4 grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-2"
                @submit.prevent="saveCorrection(session)"
              >
                <label class="text-xs text-slate-400">
                  {{ t('today.clockInTime') }}
                  <input v-model="correctionClockIn" type="datetime-local" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white" />
                </label>
                <label class="text-xs text-slate-400">
                  {{ t('today.clockOutTime') }}
                  <input v-model="correctionClockOut" type="datetime-local" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white" />
                </label>
                <label class="text-xs text-slate-400 sm:col-span-2">
                  {{ t('today.notesOptional') }}
                  <input v-model="correctionNotes" maxlength="2000" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white" />
                </label>
                <div class="flex gap-2 sm:col-span-2">
                  <button type="submit" :disabled="attendanceBusy" class="rounded-lg bg-farm-green px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-50">
                    {{ t('today.saveCorrection') }}
                  </button>
                  <button type="button" class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300" @click="correctingId = null">
                    {{ t('today.cancelCorrection') }}
                  </button>
                </div>
              </form>
            </li>
          </ul>
        </div>
      </section>

      <!-- Weather -->
      <section
        v-if="data.weather"
        class="mt-8 bg-slate-900 border border-slate-800 rounded-2xl p-5"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 class="font-bold text-white">{{ t('today.weather') }}</h3>
            <p class="text-xs text-slate-500 mt-0.5">
              <span v-if="data.weather.locationLabel">{{ data.weather.locationLabel }}</span>
              <span v-if="data.weather.timezone"> · {{ data.weather.timezone }}</span>
              <span
                v-if="data.weather.status === 'stale'"
                class="text-amber-400"
              > · {{ t('today.weatherStale') }}</span>
            </p>
          </div>
          <p
            v-if="data.weather.current"
            class="text-3xl font-black text-white"
          >
            {{ data.weather.current.tempC.toFixed(0) }}°C
          </p>
        </div>

        <div v-if="data.weather.current" class="mt-3 flex flex-wrap gap-3 text-xs text-slate-400">
          <span class="capitalize">{{ data.weather.current.condition }}</span>
          <span>{{ t('today.wind') }} {{ data.weather.current.windKmh }} km/h</span>
          <span v-if="data.weather.current.humidity != null">
            {{ t('today.humidity') }} {{ data.weather.current.humidity }}%
          </span>
        </div>

        <p
          v-else-if="data.weather.message"
          class="mt-3 text-sm"
          :class="data.weather.status === 'unconfigured' ? 'text-amber-300' : 'text-slate-400'"
        >
          {{ data.weather.message }}
          <RouterLink
            v-if="data.weather.status === 'unconfigured' && !isWorker"
            to="/settings"
            class="text-farm-green hover:underline ml-1"
          >{{ t('today.setFarmLocation') }}</RouterLink>
        </p>

        <div
          v-if="data.weather.daily.length"
          class="mt-4 grid grid-cols-2 sm:grid-cols-5 gap-2"
        >
          <div
            v-for="day in data.weather.daily"
            :key="day.date"
            class="rounded-xl bg-slate-950 border border-slate-800 px-3 py-2"
          >
            <p class="text-[10px] uppercase tracking-wide text-slate-500">
              {{ new Date(day.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' }) }}
            </p>
            <p class="text-sm text-white font-semibold mt-0.5">
              {{ day.tempMinC.toFixed(0) }}–{{ day.tempMaxC.toFixed(0) }}°
            </p>
            <p class="text-[11px] text-slate-500 mt-0.5">
              {{ day.precipMm }} mm
              <span v-if="day.precipProb != null"> · {{ day.precipProb }}%</span>
            </p>
          </div>
        </div>

        <div
          v-if="data.weather.actions?.length"
          class="mt-4 border-t border-slate-800 pt-4"
        >
          <h4 class="text-xs font-bold uppercase tracking-wide text-slate-400">
            {{ t('today.weatherActions') }}
          </h4>
          <ul class="mt-2 space-y-2">
            <li
              v-for="action in data.weather.actions"
              :key="action.id"
              class="rounded-xl bg-slate-950 border border-slate-800 px-3 py-2"
            >
              <div class="flex items-start gap-2">
                <span
                  class="mt-0.5 shrink-0 text-[10px] font-bold uppercase tracking-wide"
                  :class="
                    action.priority === 'high'
                      ? 'text-amber-400'
                      : action.priority === 'medium'
                        ? 'text-sky-400'
                        : 'text-slate-500'
                  "
                >{{ t(`today.weatherActionPriority.${action.priority}`) }}</span>
                <div class="min-w-0">
                  <p class="text-sm font-medium text-white">{{ action.title }}</p>
                  <p class="text-xs text-slate-400 mt-0.5 leading-snug">{{ action.detail }}</p>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <p v-if="data.weather.attribution" class="mt-3 text-[10px] text-slate-600">
          {{ data.weather.attribution }}
        </p>
      </section>

      <!-- Worker: my tasks today -->
      <section v-if="isWorker && data.myTasksToday" class="mt-8">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">{{ t('today.myTasksToday') }}</h3>
          <RouterLink to="/tasks" class="text-xs text-farm-green hover:underline">{{ t('today.viewAll') }}</RouterLink>
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
          {{ t('today.noOpenTasks') }}
        </p>
      </section>

      <!-- Summary counts (managers) -->
      <div v-if="!isWorker" class="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-8">
        <div
          v-for="card in summaryCards"
          :key="card.key"
          class="bg-slate-900 border border-slate-800 rounded-2xl p-4 min-h-[44px]"
        >
          <p class="text-xs text-slate-500 font-medium">{{ t(card.labelKey) }}</p>
          <p class="text-2xl font-black mt-1" :class="card.color">
            {{ data.summary[card.key] }}
          </p>
        </div>
      </div>

      <!-- Action list -->
      <section v-if="data.actionList.length" class="mt-8">
        <h3 class="font-bold text-white mb-4">{{ t('today.actionList') }}</h3>
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
            {{ isWorker ? t('today.blockers') : t('today.exceptions') }}
          </h3>
          <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            <RouterLink to="/tasks" class="text-farm-green hover:underline">{{ t('nav.tasks') }}</RouterLink>
            <RouterLink to="/inventory" class="text-farm-green hover:underline">{{ t('nav.inventory') }}</RouterLink>
            <RouterLink v-if="!isWorker" to="/sales" class="text-farm-green hover:underline">{{ t('nav.sales') }}</RouterLink>
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
                  {{ exceptionLabel[ex.type] ? t(exceptionLabel[ex.type]) : ex.type }}
                </span>
                <p class="font-medium text-white mt-1 truncate">{{ ex.title }}</p>
                <p class="text-sm text-slate-400 mt-0.5">{{ ex.message }}</p>
              </div>
              <time class="text-xs text-slate-600 shrink-0">{{ formatTime(ex.timestamp) }}</time>
            </div>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-2xl p-6">
          {{ isWorker ? t('today.noBlockers') : t('today.noExceptions') }}
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
              <p class="font-bold text-white text-sm">{{ t('today.dayClose') }}</p>
              <p class="text-xs text-slate-400 mt-0.5">{{ t('today.dayCloseSubtitle') }}</p>
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
          <div v-if="dayCloseLoading" class="text-slate-400 text-sm px-1">{{ t('today.dayCloseLoading') }}</div>

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
                  {{ dayClose.status === 'clear' ? t('today.dayClear') : t('today.needsAttentionClose') }}
                </p>
                <p class="text-xs text-slate-400 mt-0.5">{{ dayClose.date }}</p>
              </div>
            </div>

            <!-- Task breakdown -->
            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h4 class="font-bold text-white text-sm mb-3">{{ t('today.tasksToday') }}</h4>
              <div class="grid grid-cols-3 gap-3">
                <div class="text-center">
                  <p class="text-2xl font-black text-farm-green">{{ dayClose.tasks.completed }}</p>
                  <p class="text-xs text-slate-500 mt-0.5">{{ t('today.completed') }}</p>
                </div>
                <div class="text-center">
                  <p class="text-2xl font-black" :class="dayClose.tasks.overdue > 0 ? 'text-red-400' : 'text-slate-400'">
                    {{ dayClose.tasks.overdue }}
                  </p>
                  <p class="text-xs text-slate-500 mt-0.5">{{ t('today.lblOverdue') }}</p>
                </div>
                <div class="text-center">
                  <p class="text-2xl font-black" :class="dayClose.tasks.pendingApproval > 0 ? 'text-purple-400' : 'text-slate-400'">
                    {{ dayClose.tasks.pendingApproval }}
                  </p>
                  <p class="text-xs text-slate-500 mt-0.5">{{ t('today.forApproval') }}</p>
                </div>
              </div>
            </div>

            <!-- Pending approvals -->
            <div v-if="dayClose.pendingApprovals.length" class="bg-slate-900 border border-purple-900/40 rounded-2xl p-5">
              <h4 class="font-bold text-purple-300 text-sm mb-3">
                {{ t('today.awaitingApprovalCount', { count: dayClose.pendingApprovals.length }) }}
              </h4>
              <ul class="space-y-2">
                <li
                  v-for="item in dayClose.pendingApprovals"
                  :key="item.id"
                  class="flex items-start justify-between gap-2 text-sm"
                >
                  <div class="min-w-0">
                    <p class="font-medium text-white truncate">{{ item.title }}</p>
                    <p class="text-xs text-slate-500">{{ item.worker ?? t('today.unassigned') }}{{ item.plot ? ` · ${item.plot}` : '' }}</p>
                  </div>
                  <RouterLink to="/tasks" class="text-xs text-farm-green shrink-0 hover:underline">{{ t('today.approve') }}</RouterLink>
                </li>
              </ul>
            </div>

            <!-- Overdue tasks -->
            <div v-if="dayClose.overdueTasks.length" class="bg-slate-900 border border-red-900/40 rounded-2xl p-5">
              <h4 class="font-bold text-red-400 text-sm mb-3">
                {{ t('today.overdueTasksCount', { count: dayClose.overdueTasks.length }) }}
              </h4>
              <ul class="space-y-2">
                <li
                  v-for="item in dayClose.overdueTasks.slice(0, 5)"
                  :key="item.id"
                  class="text-sm"
                >
                  <p class="font-medium text-white truncate">{{ item.title }}</p>
                  <p class="text-xs text-slate-500">
                    {{ item.worker ?? t('today.unassigned') }}{{ item.plot ? ` · ${item.plot}` : '' }}
                    <span v-if="item.dueDate"> · {{ t('today.due') }} {{ formatTime(item.dueDate) }}</span>
                  </p>
                </li>
              </ul>
              <p v-if="dayClose.overdueTasks.length > 5" class="text-xs text-slate-500 mt-2">
                {{ t('today.more', { count: dayClose.overdueTasks.length - 5 }) }}
              </p>
            </div>

            <!-- Inventory & livestock -->
            <div class="grid grid-cols-2 gap-3">
              <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                <p class="text-xs text-slate-500 font-medium">{{ t('today.lowStock') }}</p>
                <p class="text-2xl font-black mt-1" :class="dayClose.inventory.lowStockCount > 0 ? 'text-amber-400' : 'text-slate-400'">
                  {{ dayClose.inventory.lowStockCount }}
                </p>
                <p class="text-xs text-slate-500 mt-0.5">{{ t('today.movementsToday', { count: dayClose.inventory.movementsToday }) }}</p>
              </div>
              <div class="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                <p class="text-xs text-slate-500 font-medium">{{ t('today.mortality') }}</p>
                <p class="text-2xl font-black mt-1" :class="dayClose.livestock.mortalityToday > 0 ? 'text-red-400' : 'text-slate-400'">
                  {{ dayClose.livestock.mortalityToday }}
                </p>
                <p class="text-xs text-slate-500 mt-0.5">{{ t('today.headToday') }}</p>
              </div>
            </div>

            <!-- Finance -->
            <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
              <h4 class="font-bold text-white text-sm mb-1">{{ t('today.expensesToday') }}</h4>
              <p class="text-xl font-black text-white">
                {{ formatCurrency(dayClose.finance.totalExpenses, dayClose.finance.currency) }}
              </p>
              <p class="text-xs text-slate-500 mt-0.5">{{ t('today.expensesLogged', { count: dayClose.finance.expensesToday }) }}</p>
            </div>

            <!-- Tomorrow's actions -->
            <div v-if="dayClose.tomorrowActions.length" class="bg-slate-900 border border-farm-green/20 rounded-2xl p-5">
              <h4 class="font-bold text-farm-green text-sm mb-3">{{ t('today.forTomorrow') }}</h4>
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
            <p v-else class="text-xs text-slate-500 px-1">{{ t('today.noCarryForward') }}</p>
          </template>
        </div>
      </section>
    </div>
  </AppLayout>
</template>
