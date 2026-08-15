<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()
const auth = useAuthStore()

type HoursRange = 'day' | 'week' | 'month' | 'ytd'

type HoursSession = {
  id: string
  clockInAt: string
  clockOutAt: string | null
  payableMinutes: number
  plotName: string | null
  taskTitle: string | null
  notes: string | null
  workSummary: string | null
  workDate: string | null
  approvalStatus: string
  rejectionReason: string | null
}

type HoursPerson = {
  userId: string
  userName: string
  role: string
  totalMinutes: number
  sessionCount: number
  sessions: HoursSession[]
}

const range = ref<HoursRange>('week')
const people = ref<HoursPerson[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const expanded = ref<Record<string, boolean>>({})

const ranges: HoursRange[] = ['day', 'week', 'month', 'ytd']

const totalMinutes = computed(() => people.value.reduce((sum, person) => sum + person.totalMinutes, 0))

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return t('hours.duration', { hours, minutes: remainder })
}

function formatWhen(iso: string | null) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

function statusClasses(status: string) {
  if (status === 'approved') return 'text-emerald-300 bg-emerald-500/10'
  if (status === 'rejected') return 'text-red-300 bg-red-500/10'
  return 'text-amber-300 bg-amber-500/10'
}

async function load() {
  loading.value = true
  error.value = null
  try {
    const data = await api<{ range: HoursRange; people: HoursPerson[] }>(
      `/api/attendance/summary?range=${range.value}`,
    )
    people.value = data.people
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('hours.loadFailed')
    people.value = []
  } finally {
    loading.value = false
  }
}

function toggle(userId: string) {
  expanded.value = { ...expanded.value, [userId]: !expanded.value[userId] }
}

onMounted(load)
watch(range, load)
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-os-fg">{{ t('hours.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('hours.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="option in ranges"
          :key="option"
          type="button"
          class="rounded-xl px-3 py-1.5 text-sm font-semibold border transition-colors"
          :class="
            range === option
              ? 'bg-farm-green text-white border-farm-green'
              : 'bg-slate-900 text-slate-300 border-slate-700 hover:border-slate-500'
          "
          @click="range = option"
        >
          {{ t(`hours.range.${option}`) }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('hours.loading') }}</div>
    <div v-else-if="error" class="mt-8 text-red-400">{{ error }}</div>
    <template v-else>
      <div class="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('hours.peopleCounted') }}</p>
          <p class="text-2xl font-black text-farm-green mt-1">{{ people.length }}</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-2xl p-5">
          <p class="text-xs text-slate-500 font-medium">{{ t('hours.totalTime') }}</p>
          <p class="text-2xl font-black text-farm-gold mt-1">{{ formatDuration(totalMinutes) }}</p>
        </div>
      </div>

      <div
        v-if="people.length === 0"
        class="mt-8 rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-slate-400 text-sm"
      >
        {{ t('hours.empty') }}
      </div>

      <div v-else class="mt-8 space-y-3">
        <div
          v-for="person in people"
          :key="person.userId"
          class="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden"
        >
          <button
            type="button"
            class="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-slate-800/50"
            @click="toggle(person.userId)"
          >
            <div>
              <p class="font-bold text-os-fg">{{ person.userName }}</p>
              <p class="text-xs text-slate-500 mt-0.5">
                {{ person.role }} · {{ t('hours.sessions', { count: person.sessionCount }) }}
              </p>
            </div>
            <p class="font-black text-farm-green shrink-0">{{ formatDuration(person.totalMinutes) }}</p>
          </button>
          <div v-if="expanded[person.userId]" class="border-t border-slate-800 px-5 py-3 space-y-3">
            <div
              v-for="session in person.sessions"
              :key="session.id"
              class="rounded-xl bg-slate-950/70 border border-slate-800 px-4 py-3 text-sm"
            >
              <div class="flex flex-wrap justify-between gap-2">
                <p class="text-slate-300">
                  {{ session.workDate ? new Date(`${session.workDate}T12:00:00`).toLocaleDateString() : formatWhen(session.clockInAt) }}
                </p>
                <div class="flex items-center gap-2">
                  <span class="rounded-full px-2 py-0.5 text-[11px] font-bold capitalize" :class="statusClasses(session.approvalStatus)">{{ session.approvalStatus }}</span>
                  <p class="text-farm-gold font-semibold">{{ formatDuration(session.payableMinutes) }}</p>
                </div>
              </div>
              <p v-if="session.plotName || session.taskTitle" class="text-xs text-slate-500 mt-1">
                <span v-if="session.plotName">{{ session.plotName }}</span>
                <span v-if="session.plotName && session.taskTitle"> · </span>
                <span v-if="session.taskTitle">{{ session.taskTitle }}</span>
              </p>
              <p v-if="session.notes" class="text-xs text-slate-400 mt-1">{{ session.notes }}</p>
              <p v-if="session.workSummary" class="text-xs text-slate-400 mt-1">
                {{ session.workSummary }}
              </p>
              <p v-if="session.rejectionReason" class="text-xs text-red-300 mt-1">Returned: {{ session.rejectionReason }}</p>
            </div>
          </div>
        </div>
      </div>

      <p v-if="auth.user?.role === 'sales' || auth.user?.role === 'field_worker'" class="mt-4 text-xs text-slate-500">
        {{ t('hours.selfOnlyNote') }}
      </p>
    </template>
  </AppLayout>
</template>
