<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Subject } from '@/composables/useAdvisoryAnalysis'
import type { CalendarData } from '@/composables/useAdvisoryCalendar'

const props = defineProps<{
  subjects: Subject[]
  calendarData: CalendarData | null
}>()

const emit = defineEmits<{
  'shift-month': [delta: number]
}>()

const { t, te, locale } = useI18n()

const monthStart = computed(() => {
  const match = props.calendarData?.month.match(/^(\d{4})-(\d{2})$/)
  if (!match) {
    const now = new Date()
    return new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
  }
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
})

const monthLabel = computed(() => {
  if (!monthStart.value) return '—'
  return new Intl.DateTimeFormat(locale.value, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(monthStart.value)
})

function stageName(subject: Subject): string {
  if (subject.kind !== 'crop') return subject.species
  const key = `crops.stage.${subject.stage}`
  return te(key) ? t(key) : subject.stage.replaceAll('_', ' ')
}

function windowFor(subject: Subject): { start: Date; end: Date | null } {
  const start = new Date(subject.kind === 'crop' ? subject.stageEnteredAt : subject.acquiredAt)
  const days = subject.kind === 'crop' ? subject.totalStageDays : 42
  return { start, end: days ? new Date(start.getTime() + days * 86_400_000) : null }
}

function bandStyle(subject: Subject): Record<string, string> {
  const start = monthStart.value
  if (!start) return { display: 'none' }
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  const window = windowFor(subject)
  if (!window.end) return { display: 'none' }
  const visibleStart = Math.max(start.getTime(), window.start.getTime())
  const visibleEnd = Math.min(end.getTime(), window.end.getTime())
  if (visibleEnd <= visibleStart) return { display: 'none' }
  const span = end.getTime() - start.getTime()
  return {
    left: `${((visibleStart - start.getTime()) / span) * 100}%`,
    width: `${Math.max(2, ((visibleEnd - visibleStart) / span) * 100)}%`,
  }
}

function dateRange(subject: Subject): string {
  const { start, end } = windowFor(subject)
  const formatter = new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'short' })
  if (!end) return t('advisory.startedNoDuration', { date: formatter.format(start) })
  return `${formatter.format(start)} – ${formatter.format(end)}`
}

function observationDate(value: string): string {
  return new Intl.DateTimeFormat(locale.value, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value))
}

function tileName(key: string): string {
  const catalogKey = `advisory.tiles.${key}`
  return te(catalogKey) ? t(catalogKey) : key.replaceAll('_', ' ')
}
</script>

<template>
  <section class="mt-8 space-y-4">
    <div class="flex items-center justify-between gap-3">
      <button
        type="button"
        class="rounded-lg bg-slate-800 px-3 py-2 text-white"
        :aria-label="t('advisory.previousMonth')"
        @click="emit('shift-month', -1)"
      >
        <span aria-hidden="true">‹</span>
      </button>
      <p class="font-bold capitalize text-white">{{ monthLabel }}</p>
      <button
        type="button"
        class="rounded-lg bg-slate-800 px-3 py-2 text-white"
        :aria-label="t('advisory.nextMonth')"
        @click="emit('shift-month', 1)"
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
    <div class="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
      <p class="mb-4 text-sm text-slate-400">{{ t('advisory.calendarHint') }}</p>
      <ul class="space-y-3">
        <li v-for="subject in subjects" :key="subject.id" class="rounded-xl bg-slate-950/55 p-3">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="text-sm font-bold text-slate-100">{{ subject.label }}</p>
            <p class="text-xs text-slate-400">
              {{ stageName(subject) }} · {{ dateRange(subject) }}
            </p>
          </div>
          <div
            v-if="subject.kind === 'livestock' || subject.totalStageDays"
            class="relative mt-3 h-2 overflow-hidden rounded-full bg-slate-800"
            aria-hidden="true"
          >
            <span
              class="absolute inset-y-0 rounded-full"
              :class="subject.kind === 'livestock' ? 'bg-farm-gold/90' : 'bg-farm-green/90'"
              :style="bandStyle(subject)"
            />
          </div>
        </li>
      </ul>
      <h4 class="mb-2 mt-6 font-semibold text-white">{{ t('advisory.monthLogs') }}</h4>
      <ul v-if="calendarData?.observations?.length" class="space-y-2">
        <li
          v-for="observation in calendarData.observations"
          :key="observation.id"
          class="border-b border-slate-800 pb-2 text-sm text-slate-300"
        >
          <span class="font-semibold text-slate-200">{{ observationDate(observation.loggedAt) }}</span>
          — {{ observation.tiles.map(tileName).join(', ') }}
        </li>
      </ul>
      <p v-else class="text-sm text-slate-500">{{ t('advisory.noLogs') }}</p>
    </div>
  </section>
</template>
