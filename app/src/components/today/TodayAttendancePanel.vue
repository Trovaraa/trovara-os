<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AttendanceSession, PlotOption } from '@/composables/useTodayAttendance'

export type AttendanceTaskOption = { id: string; title: string }

const selectedPlotId = defineModel<string>('selectedPlotId', { required: true })
const selectedTaskId = defineModel<string>('selectedTaskId', { required: true })
const workSummary = defineModel<string>('workSummary', { required: true })
const workDate = defineModel<string>('workDate', { required: true })
const hoursValue = defineModel<string>('hoursValue', { required: true })
const _correctingId = defineModel<string | null>('correctingId', { required: true })
const _correctionClockIn = defineModel<string>('correctionClockIn', { required: true })
const _correctionClockOut = defineModel<string>('correctionClockOut', { required: true })
const _correctionNotes = defineModel<string>('correctionNotes', { required: true })

const props = defineProps<{
  canManageAttendance: boolean
  canClockSelf: boolean
  attendance: AttendanceSession[]
  myTodaySubmission: AttendanceSession | null
  plots: PlotOption[]
  myTasksToday: AttendanceTaskOption[]
  attendanceBusy: boolean
  attendanceError: string | null
  formatMinutes: (minutes: number) => string
}>()

const emit = defineEmits<{
  'submit-hours': []
  'review-hours': [session: AttendanceSession, decision: 'approved' | 'rejected']
  'start-correction': [session: AttendanceSession]
  'save-correction': [session: AttendanceSession]
}>()

const { t } = useI18n()
const pending = computed(() => props.attendance.filter((session) => session.approvalStatus === 'pending'))
const today = new Date().toISOString().slice(0, 10)
const showBackfill = ref(false)

function beginBackfill() {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  workDate.value = date.toISOString().slice(0, 10)
  showBackfill.value = true
}

function formatDate(date: string | null, fallback: string) {
  return date ? new Date(`${date}T12:00:00`).toLocaleDateString() : new Date(fallback).toLocaleDateString()
}

function statusClasses(status: string) {
  if (status === 'approved') return 'bg-emerald-500/10 text-emerald-300'
  if (status === 'rejected') return 'bg-red-500/10 text-red-300'
  return 'bg-amber-500/10 text-amber-300'
}
</script>

<template>
  <section class="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="font-bold text-white">{{ t('hoursEntry.title') }}</h3>
        <p class="mt-1 text-xs text-slate-400">{{ t('hoursEntry.description') }}</p>
      </div>
      <span v-if="canManageAttendance && pending.length" class="rounded-full bg-amber-500/10 px-3 py-1 text-xs font-bold text-amber-300">{{ t('hoursEntry.awaiting', { count: pending.length }) }}</span>
    </div>

    <p v-if="attendanceError" class="mt-3 text-sm text-red-400" role="alert">{{ attendanceError }}</p>

    <div v-if="canClockSelf" class="mt-4">
      <div v-if="myTodaySubmission" class="rounded-xl border border-slate-800 bg-slate-950 p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p class="font-semibold text-white">{{ t('hoursEntry.submitted') }}</p>
            <p class="mt-1 text-sm text-slate-400">{{ formatMinutes(myTodaySubmission.payableMinutes) }} · {{ myTodaySubmission.workSummary }}</p>
          </div>
          <span class="rounded-full px-3 py-1 text-xs font-bold" :class="statusClasses(myTodaySubmission.approvalStatus)">{{ t(`hoursEntry.status.${myTodaySubmission.approvalStatus}`) }}</span>
        </div>
        <p v-if="myTodaySubmission.rejectionReason" class="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-300">{{ t('hoursEntry.returned', { reason: myTodaySubmission.rejectionReason }) }}</p>
        <button v-if="myTodaySubmission.approvalStatus !== 'rejected' && !showBackfill" type="button" class="mt-3 min-h-10 rounded-lg border border-slate-700 px-3 text-xs font-bold text-slate-300" @click="beginBackfill">{{ t('hoursEntry.addMissedDay') }}</button>
      </div>

      <form v-if="!myTodaySubmission || myTodaySubmission.approvalStatus === 'rejected' || showBackfill" class="grid gap-3 sm:grid-cols-2" :class="myTodaySubmission ? 'mt-4' : ''" @submit.prevent="emit('submit-hours')">
        <label class="text-xs text-slate-400">{{ t('hoursEntry.workDate') }}
          <input v-model="workDate" type="date" :max="today" required class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white" />
        </label>
        <label class="text-xs text-slate-400">{{ t('hoursEntry.hoursWorked') }}
          <input v-model="hoursValue" type="number" min="0.25" max="16" step="0.25" inputmode="decimal" required :placeholder="t('hoursEntry.hoursPlaceholder')" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white" />
        </label>
        <label class="text-xs text-slate-400">{{ t('today.blockOptional') }}
          <select v-model="selectedPlotId" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white"><option value="">{{ t('today.noAllocation') }}</option><option v-for="plot in plots" :key="plot.id" :value="plot.id">{{ plot.name }}</option></select>
        </label>
        <label class="text-xs text-slate-400">{{ t('today.taskOptional') }}
          <select v-model="selectedTaskId" class="mt-1 min-h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-white"><option value="">{{ t('today.noAllocation') }}</option><option v-for="task in myTasksToday" :key="task.id" :value="task.id">{{ task.title }}</option></select>
        </label>
        <label class="text-xs text-slate-400 sm:col-span-2">{{ t('hoursEntry.summary') }} <span class="text-red-300">{{ t('hoursEntry.required') }}</span>
          <textarea v-model="workSummary" rows="3" minlength="3" maxlength="2000" required :placeholder="t('hoursEntry.summaryPlaceholder')" class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white" />
        </label>
        <button type="submit" class="min-h-11 rounded-xl bg-farm-green px-5 py-2.5 font-bold text-white disabled:opacity-50 sm:w-fit" :disabled="attendanceBusy">{{ attendanceBusy ? t('hoursEntry.submitting') : t('hoursEntry.submit') }}</button>
      </form>
    </div>

    <div v-if="canManageAttendance" class="mt-6 border-t border-slate-800 pt-4">
      <h4 class="text-sm font-bold text-slate-300">{{ t('hoursEntry.team') }}</h4>
      <p class="mt-1 text-xs text-slate-500">{{ t('hoursEntry.teamDescription') }}</p>
      <p v-if="!attendance.length" class="mt-3 text-sm text-slate-500">{{ t('hoursEntry.noneToday') }}</p>
      <ul v-else class="mt-3 space-y-3">
        <li v-for="session in attendance" :key="session.id" class="rounded-xl border border-slate-800 bg-slate-950 p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <p class="font-semibold text-white">{{ session.userName }}</p>
                <span class="rounded-full px-2 py-0.5 text-[11px] font-bold" :class="statusClasses(session.approvalStatus)">{{ t(`hoursEntry.status.${session.approvalStatus}`) }}</span>
              </div>
              <p class="mt-1 text-xs text-slate-400">{{ formatDate(session.workDate, session.clockInAt) }} · {{ formatMinutes(session.payableMinutes) }}</p>
              <p v-if="session.plotName || session.taskTitle" class="mt-1 text-xs text-slate-500">{{ session.plotName }}<span v-if="session.plotName && session.taskTitle"> · </span>{{ session.taskTitle }}</p>
              <p class="mt-2 text-sm text-slate-300">{{ session.workSummary }}</p>
              <p v-if="session.rejectionReason" class="mt-2 text-xs text-red-300">{{ t('hoursEntry.returned', { reason: session.rejectionReason }) }}</p>
            </div>
            <div v-if="session.approvalStatus === 'pending'" class="flex gap-2">
              <button type="button" class="min-h-10 rounded-lg bg-emerald-500/15 px-3 text-xs font-bold text-emerald-300 disabled:opacity-50" :disabled="attendanceBusy" @click="emit('review-hours', session, 'approved')">{{ t('hoursEntry.approve') }}</button>
              <button type="button" class="min-h-10 rounded-lg bg-red-500/10 px-3 text-xs font-bold text-red-300 disabled:opacity-50" :disabled="attendanceBusy" @click="emit('review-hours', session, 'rejected')">{{ t('hoursEntry.return') }}</button>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>
