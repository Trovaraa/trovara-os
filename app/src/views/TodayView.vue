<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import TaskStatusBadge from '@/components/TaskStatusBadge.vue'
import TodayAttendancePanel from '@/components/today/TodayAttendancePanel.vue'
import TodayDayClosePanel from '@/components/today/TodayDayClosePanel.vue'
import WeatherTipsLoader from '@/components/WeatherTipsLoader.vue'
import { useTodayAttendance } from '@/composables/useTodayAttendance'
import { useTodayDayClose } from '@/composables/useTodayDayClose'
import { useExceptionText, type ExceptionParams } from '@/composables/useExceptionText'
import { useAuthStore } from '@/stores/auth'
import { api } from '@/lib/api'

const { t } = useI18n()
const { exceptionTitle, exceptionMessage, actionLabel } = useExceptionText()

type ExceptionItem = {
  type: string
  severity: 'high' | 'medium'
  title: string
  titleKey?: string
  titleParams?: ExceptionParams
  message: string
  messageKey?: string
  messageParams?: ExceptionParams
  entityType: string
  entityId: string
  timestamp: string
  metadata?: Record<string, unknown>
}

type ActionItem = {
  priority: number
  action: string
  label: string
  labelKey?: string
  labelParams?: ExceptionParams
  titleKey?: string
  titleParams?: ExceptionParams
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
  assetMaintenanceDue?: number
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
  actionsSource?: 'ai' | 'rules'
  actionsLocale?: string
  message?: string
}

type TodayData = {
  role: string
  exceptions: ExceptionItem[]
  actionList: ActionItem[]
  summary: ExceptionSummary
  weather?: WeatherSnapshot
  advisory?: {
    subject: {
      id: string
      label: string
      kind: string
      daysUntilNextHint: number | null
      nextHint: string | null
    } | null
    recommendation: {
      id: string
      payload: { happeningNow: string; whatNext: string }
    } | null
    openCount: number
  } | null
  myTasksToday?: {
    id: string
    title: string
    status: string
    dueDate: string | null
    plotId: string | null
    plotName: string | null
  }[]
}

const auth = useAuthStore()
const data = ref<TodayData | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const weatherTipsLoading = ref(false)
const weatherTipsError = ref<string | null>(null)

const {
  attendance,
  plots,
  attendanceBusy,
  attendanceError,
  selectedPlotId,
  selectedTaskId,
  attendanceNotes,
  workSummary,
  correctingId,
  correctionClockIn,
  correctionClockOut,
  correctionNotes,
  showAttendance,
  canManageAttendance,
  canClockSelf,
  openAttendance,
  loadAttendance,
  clockInNow,
  clockOutNow,
  startCorrection,
  saveCorrection,
  formatMinutes,
} = useTodayAttendance(
  () => auth.user?.role,
  () => auth.user?.id,
)

const {
  dayClose,
  dayCloseOpen,
  dayCloseLoading,
  showFarmDayClose,
  showSalesDayClose,
  openDayClose,
} = useTodayDayClose(() => auth.user?.role)

const isWorker = computed(() => auth.user?.role === 'field_worker')
const isSales = computed(() => auth.user?.role === 'sales')

const exceptionIcon: Record<string, string> = {
  overdue_task: 'text-red-400',
  low_stock: 'text-amber-400',
  pending_approval: 'text-purple-400',
  mortality_today: 'text-red-500',
  order_pending: 'text-orange-400',
  rejected_task: 'text-rose-400',
  asset_log_missing: 'text-amber-400',
  asset_maintenance_due: 'text-orange-400',
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
  asset_maintenance_due: 'today.lblMaintenanceDue',
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
  const cards: { key: keyof ExceptionSummary; labelKey: string; color: string }[] = isSales.value
    ? [
        { key: 'ordersPending', labelKey: 'today.lblOrders', color: 'text-orange-400' },
        { key: 'lowStock', labelKey: 'today.lblLowStock', color: 'text-amber-400' },
      ]
    : [
        { key: 'overdueTasks', labelKey: 'today.lblOverdue', color: 'text-red-400' },
        { key: 'lowStock', labelKey: 'today.lblLowStock', color: 'text-amber-400' },
        { key: 'pendingApprovals', labelKey: 'today.lblApprovals', color: 'text-purple-400' },
        { key: 'mortalityToday', labelKey: 'today.lblMortality', color: 'text-red-500' },
        { key: 'ordersPending', labelKey: 'today.lblOrders', color: 'text-orange-400' },
        { key: 'rejectedTasks', labelKey: 'today.lblRejected', color: 'text-rose-400' },
        { key: 'assetLogsMissing', labelKey: 'today.lblNotLogged', color: 'text-amber-400' },
        { key: 'assetMaintenanceDue', labelKey: 'today.lblMaintenanceDue', color: 'text-orange-400' },
        { key: 'assetVerificationPending', labelKey: 'today.lblVerifyAssets', color: 'text-cyan-400' },
      ]
  return isSales.value
    ? cards
    : cards.filter((card) => (Number(s[card.key] ?? 0) > 0) || !isWorker.value)
})

async function regenerateWeatherTips(force = false) {
  if (!data.value?.weather) return
  if (!force && data.value.weather.actionsSource === 'ai') return
  if (weatherTipsLoading.value) return
  if (data.value.weather.status !== 'ok' && data.value.weather.status !== 'stale') return

  weatherTipsLoading.value = true
  weatherTipsError.value = null
  try {
    const result = await api<{
      actions: NonNullable<WeatherSnapshot['actions']>
      actionsSource: 'ai' | 'rules'
      actionsLocale: string
    }>('/api/today/weather-actions/regenerate', { method: 'POST', body: '{}' })
    if (data.value?.weather) {
      data.value.weather.actions = result.actions
      data.value.weather.actionsSource = result.actionsSource
      data.value.weather.actionsLocale = result.actionsLocale
    }
  } catch (e) {
    weatherTipsError.value = e instanceof Error ? e.message : t('today.weatherTipsFailed')
  } finally {
    weatherTipsLoading.value = false
  }
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const [todayData] = await Promise.all([api<TodayData>('/api/today'), loadAttendance()])
    data.value = todayData
    void regenerateWeatherTips(false)
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('today.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(load)

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
</script>

<template>
  <AppLayout>
    <div v-if="loading" class="text-slate-400">{{ t('today.loading') }}</div>

    <div v-else-if="error" class="text-red-400">{{ error }}</div>

    <div v-else-if="data" class="relative z-0 w-full max-w-full min-w-0">
      <div>
        <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('today.eyebrow') }}</p>
        <h2 class="text-2xl sm:text-3xl font-black text-os-fg mt-1 leading-tight">
          {{ isWorker ? t('today.myTasks') : isSales ? t('today.salesDashboard') : t('today.exceptionDashboard') }}
        </h2>
        <p class="text-slate-400 text-sm mt-1">
          {{
            isWorker
              ? t('today.workerSubtitle')
              : isSales
                ? t('today.salesSubtitle', { count: data.summary.total })
                : t('today.needAttention', { count: data.summary.total })
          }}
        </p>
      </div>

      <!-- Trovara OS Advisory teaser -->
      <section
        v-if="!isSales && data.advisory !== undefined"
        class="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5"
      >
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-teal-300 text-xs font-bold tracking-widest uppercase">{{ t('advisory.todayTeaser') }}</p>
            <p v-if="data.advisory?.recommendation" class="text-white font-semibold mt-2">
              {{ data.advisory.recommendation.payload.happeningNow }}
            </p>
            <p v-else-if="data.advisory?.subject?.nextHint" class="text-white font-semibold mt-2">
              <template v-if="data.advisory.subject.daysUntilNextHint != null">
                {{ t('advisory.daysUntil', { n: data.advisory.subject.daysUntilNextHint }) }} —
              </template>
              {{ data.advisory.subject.nextHint }}
            </p>
            <p v-else class="text-slate-400 text-sm mt-2">{{ t('advisory.todayEmpty') }}</p>
            <p
              v-if="data.advisory?.recommendation"
              class="text-slate-300 text-sm mt-1"
            >
              {{ data.advisory.recommendation.payload.whatNext }}
            </p>
          </div>
          <RouterLink
            to="/advisory"
            class="rounded-full bg-teal-600 px-4 py-2 text-sm font-bold text-white min-h-[40px] inline-flex items-center"
          >
            {{ t('advisory.todayOpen') }}
          </RouterLink>
        </div>
      </section>

      <TodayAttendancePanel
        v-if="showAttendance"
        v-model:selected-plot-id="selectedPlotId"
        v-model:selected-task-id="selectedTaskId"
        v-model:attendance-notes="attendanceNotes"
        v-model:work-summary="workSummary"
        v-model:correcting-id="correctingId"
        v-model:correction-clock-in="correctionClockIn"
        v-model:correction-clock-out="correctionClockOut"
        v-model:correction-notes="correctionNotes"
        :can-manage-attendance="canManageAttendance"
        :can-clock-self="canClockSelf"
        :attendance="attendance"
        :open-attendance="openAttendance"
        :plots="plots"
        :my-tasks-today="data.myTasksToday ?? []"
        :attendance-busy="attendanceBusy"
        :attendance-error="attendanceError"
        :format-minutes="formatMinutes"
        @clock-in="clockInNow"
        @clock-out="clockOutNow"
        @start-correction="startCorrection"
        @save-correction="saveCorrection"
      />

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
            class="text-3xl font-black text-os-fg"
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

        <div class="mt-4 border-t border-slate-800 pt-4">
          <div class="flex items-center justify-between gap-3">
            <h4 class="text-xs font-bold uppercase tracking-wide text-slate-400">
              {{ t('today.weatherActions') }}
            </h4>
            <button
              type="button"
              class="text-xs font-semibold text-farm-green hover:underline disabled:opacity-50"
              :disabled="weatherTipsLoading"
              @click="regenerateWeatherTips(true)"
            >
              {{ t('today.refreshWeatherTips') }}
            </button>
          </div>
          <p v-if="weatherTipsError" class="mt-2 text-xs text-red-400">{{ weatherTipsError }}</p>
          <WeatherTipsLoader
            v-if="weatherTipsLoading"
            class="mt-2"
            :label="t('today.generatingWeatherTips')"
          />
          <ul v-else-if="data.weather.actions?.length" class="mt-2 space-y-2">
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
          <p v-else class="mt-2 text-xs text-slate-500">{{ t('today.noWeatherActions') }}</p>
        </div>

        <p v-if="data.weather.attribution" class="mt-3 text-[10px] text-slate-600">
          {{ data.weather.attribution }}
        </p>
      </section>

      <!-- Worker: my tasks today -->
      <section v-if="isWorker && data.myTasksToday" class="mt-8">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-white">{{ t('today.myTasksToday') }}</h3>
          <RouterLink to="/worker" class="text-xs text-farm-green hover:underline">{{ t('today.viewAll') }}</RouterLink>
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
              <span class="text-sm text-slate-200">{{ actionLabel(action) }}</span>
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
            <RouterLink
              v-if="isWorker"
              to="/worker"
              class="text-farm-green hover:underline"
            >{{ t('nav.myTasks') }}</RouterLink>
            <RouterLink
              v-if="isWorker"
              to="/inventory"
              class="text-farm-green hover:underline"
            >{{ t('nav.inventory') }}</RouterLink>
            <RouterLink
              v-if="!isWorker"
              to="/tasks"
              class="text-farm-green hover:underline"
            >{{ t('nav.tasks') }}</RouterLink>
            <RouterLink
              v-if="!isWorker"
              to="/inventory"
              class="text-farm-green hover:underline"
            >{{ t('nav.inventory') }}</RouterLink>
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
                <p class="font-medium text-white mt-1 truncate">{{ exceptionTitle(ex) }}</p>
                <p class="text-sm text-slate-400 mt-0.5">{{ exceptionMessage(ex) }}</p>
              </div>
              <time class="text-xs text-slate-600 shrink-0">{{ formatTime(ex.timestamp) }}</time>
            </div>
          </li>
        </ul>
        <p v-else class="text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-2xl p-6">
          {{ isWorker ? t('today.noBlockers') : t('today.noExceptions') }}
        </p>
      </section>

      <TodayDayClosePanel
        v-if="showFarmDayClose || showSalesDayClose"
        :is-sales="isSales"
        :day-close="dayClose"
        :day-close-open="dayCloseOpen"
        :day-close-loading="dayCloseLoading"
        @toggle="openDayClose"
      />
    </div>
  </AppLayout>
</template>
