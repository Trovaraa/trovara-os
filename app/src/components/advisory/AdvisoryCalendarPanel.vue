<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { Subject } from '@/composables/useAdvisoryAnalysis'
import type { CalendarData } from '@/composables/useAdvisoryCalendar'

defineProps<{
  subjects: Subject[]
  calendarData: CalendarData | null
}>()

const emit = defineEmits<{
  'shift-month': [delta: number]
}>()

const { t } = useI18n()
</script>

<template>
  <section class="mt-8 space-y-4">
    <div class="flex items-center justify-between gap-3">
      <button type="button" class="rounded-lg bg-slate-800 px-3 py-2 text-white" @click="emit('shift-month', -1)">‹</button>
      <p class="font-bold text-white">{{ calendarData?.month || '—' }}</p>
      <button type="button" class="rounded-lg bg-slate-800 px-3 py-2 text-white" @click="emit('shift-month', 1)">›</button>
    </div>
    <div class="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <p class="text-sm text-slate-400 mb-3">{{ t('advisory.calendarHint') }}</p>
      <ul class="space-y-2">
        <li v-for="s in subjects" :key="s.id" class="text-sm text-slate-200 flex items-center gap-2">
          <span
            class="inline-block h-2 flex-1 max-w-[40%] rounded-full"
            :class="s.kind === 'livestock' ? 'bg-farm-gold/80' : 'bg-farm-green/80'"
          />
          {{ s.label }}
        </li>
      </ul>
      <h4 class="text-white font-semibold mt-6 mb-2">{{ t('advisory.monthLogs') }}</h4>
      <ul v-if="calendarData?.observations?.length" class="space-y-2">
        <li
          v-for="o in calendarData.observations"
          :key="o.id"
          class="text-sm text-slate-300 border-b border-slate-800 pb-2"
        >
          {{ new Date(o.loggedAt).toLocaleDateString() }} — {{ o.tiles.join(', ') }}
        </li>
      </ul>
      <p v-else class="text-slate-500 text-sm">{{ t('advisory.noLogs') }}</p>
    </div>
  </section>
</template>
