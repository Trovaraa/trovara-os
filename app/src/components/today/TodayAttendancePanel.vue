<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AttendanceSession, PlotOption } from '@/composables/useTodayAttendance'

export type AttendanceTaskOption = {
  id: string
  title: string
}

const selectedPlotId = defineModel<string>('selectedPlotId', { required: true })
const selectedTaskId = defineModel<string>('selectedTaskId', { required: true })
const attendanceNotes = defineModel<string>('attendanceNotes', { required: true })
const workSummary = defineModel<string>('workSummary', { required: true })
const correctingId = defineModel<string | null>('correctingId', { required: true })
const correctionClockIn = defineModel<string>('correctionClockIn', { required: true })
const correctionClockOut = defineModel<string>('correctionClockOut', { required: true })
const correctionNotes = defineModel<string>('correctionNotes', { required: true })

defineProps<{
  canManageAttendance: boolean
  canClockSelf: boolean
  attendance: AttendanceSession[]
  openAttendance: AttendanceSession | null
  plots: PlotOption[]
  myTasksToday: AttendanceTaskOption[]
  attendanceBusy: boolean
  attendanceError: string | null
  formatMinutes: (minutes: number) => string
}>()

const emit = defineEmits<{
  'clock-in': []
  'clock-out': []
  'start-correction': [session: AttendanceSession]
  'save-correction': [session: AttendanceSession]
}>()

const { t } = useI18n()
const clockOutPromptOpen = ref(false)

function confirmClockOut() {
  clockOutPromptOpen.value = false
  emit('clock-out')
}

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
  <section class="mt-8 bg-slate-900 border border-slate-800 rounded-2xl p-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h3 class="font-bold text-white">{{ t('today.attendance') }}</h3>
        <p class="text-xs text-slate-400 mt-1">
          {{
            canManageAttendance
              ? t('today.attendanceManagerSubtitle')
              : t('today.attendanceWorkerSubtitle')
          }}
        </p>
      </div>
      <span
        v-if="canClockSelf"
        class="rounded-full px-3 py-1 text-xs font-bold"
        :class="openAttendance ? 'bg-farm-green/15 text-farm-green' : 'bg-slate-800 text-slate-400'"
      >
        {{ openAttendance ? t('today.clockedIn') : t('today.clockedOut') }}
      </span>
    </div>

    <p v-if="attendanceError" class="mt-3 text-sm text-red-400">{{ attendanceError }}</p>

    <div v-if="canClockSelf" class="mt-4">
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
          @click="clockOutPromptOpen = true"
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
            <option v-for="task in myTasksToday" :key="task.id" :value="task.id">
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
          @click="emit('clock-in')"
        >
          {{ attendanceBusy ? t('today.savingAttendance') : t('today.clockIn') }}
        </button>
      </div>
    </div>

    <div
      v-if="clockOutPromptOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      :aria-label="t('today.clockOutQuestion')"
      @click.self="clockOutPromptOpen = false"
    >
      <div class="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h4 class="text-lg font-black text-os-fg">{{ t('today.clockOutQuestion') }}</h4>
        <p class="mt-1 text-sm text-slate-400">{{ t('today.clockOutSummaryHint') }}</p>
        <textarea
          v-model="workSummary"
          rows="4"
          maxlength="2000"
          class="mt-4 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-3 text-sm text-white"
          :placeholder="t('today.clockOutSummaryPlaceholder')"
        />
        <div class="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            class="min-h-[44px] rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300"
            @click="clockOutPromptOpen = false"
          >
            {{ t('today.cancelCorrection') }}
          </button>
          <button
            type="button"
            class="min-h-[44px] rounded-xl bg-red-500/90 px-5 py-2 font-bold text-white disabled:opacity-50"
            :disabled="attendanceBusy"
            @click="confirmClockOut"
          >
            {{ t('today.confirmClockOut') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="canManageAttendance" class="mt-6 border-t border-slate-800 pt-4">
      <h4 class="text-sm font-bold text-slate-300 mb-3">{{ t('today.teamAttendance') }}</h4>
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
              <p v-if="session.workSummary" class="mt-2 text-sm text-slate-300">
                {{ session.workSummary }}
              </p>
              <p v-if="session.correctedAt" class="mt-1 text-[11px] text-amber-400">
                {{ t('today.corrected') }} · {{ formatTime(session.correctedAt) }}
              </p>
            </div>
            <button type="button" class="text-xs text-farm-green hover:underline" @click="emit('start-correction', session)">
              {{ t('today.correctAttendance') }}
            </button>
          </div>

          <form
            v-if="correctingId === session.id"
            class="mt-4 grid gap-3 border-t border-slate-800 pt-4 sm:grid-cols-2"
            @submit.prevent="emit('save-correction', session)"
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
</template>
