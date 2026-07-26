<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type {
  InsightKey,
  InsightTip,
  Recommendation,
  Subject,
} from '@/composables/useAdvisoryAnalysis'

defineProps<{
  stats: Record<string, number>
  subjects: Subject[]
  tipBucket: 'open' | 'completed' | null
  tipBucketLoading: boolean
  tipBucketRows: Recommendation[]
  insightKey: InsightKey | null
  insightLoading: boolean
  insightRecommendations: InsightTip[]
  insightList: Array<{ key: InsightKey; label: string }>
  activeInsight: { key: InsightKey; label: string } | null
}>()

const emit = defineEmits<{
  'open-tip-bucket': [bucket: 'open' | 'completed']
  'close-tip-bucket': []
  'open-insight': [key: InsightKey]
  'close-insight': []
  'open-subject': [id: string]
  'set-status': [id: string, status: 'accepted' | 'ignored' | 'completed']
}>()

const { t } = useI18n()

function capitalizeWord(value: string) {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function formatSubjectTitle(s: Subject) {
  if (s.kind === 'crop') {
    const plot = s.plotName || s.label.split('·').slice(1).join('·').trim()
    return plot ? `${capitalizeWord(s.cropType)} · ${plot}` : capitalizeWord(s.cropType)
  }
  return s.label
}
</script>

<template>
  <section class="mt-8 space-y-4">
    <template v-if="tipBucket">
      <button
        type="button"
        class="text-sm text-farm-green font-semibold hover:underline"
        @click="emit('close-tip-bucket')"
      >
        ← {{ t('advisory.tabs.analysis') }}
      </button>
      <h3 class="text-xl font-black text-white">
        {{ tipBucket === 'open' ? t('advisory.statOpen') : t('advisory.statDone') }}
      </h3>
      <p v-if="tipBucketLoading" class="text-slate-400 text-sm">{{ t('advisory.loading') }}</p>
      <p v-else-if="tipBucketRows.length === 0" class="text-slate-400 text-sm">
        {{ tipBucket === 'open' ? t('advisory.openTipsEmpty') : t('advisory.completedTipsEmpty') }}
      </p>
      <ul v-else class="space-y-3">
        <li
          v-for="rec in tipBucketRows"
          :key="rec.id"
          class="rounded-2xl border border-slate-800 bg-slate-900 p-4"
        >
          <p class="text-white font-semibold">{{ rec.payload.happeningNow }}</p>
          <p class="text-slate-300 text-sm mt-1">{{ rec.payload.whatNext }}</p>
          <p v-if="rec.aiSummary" class="text-slate-400 text-sm mt-2">{{ rec.aiSummary }}</p>
          <ul v-if="rec.payload.products?.length" class="mt-3 space-y-1">
            <li v-for="(p, i) in rec.payload.products" :key="i" class="text-sm text-slate-200">
              <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="text-farm-green underline">{{ p.title }}</a>
              <span v-else>{{ p.title }}</span>
            </li>
          </ul>
          <div v-if="tipBucket === 'open'" class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="rounded-lg bg-farm-green px-3 py-1.5 text-xs font-bold text-slate-950" @click="emit('set-status', rec.id, 'accepted')">
              {{ t('advisory.accept') }}
            </button>
            <button type="button" class="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-bold text-white" @click="emit('set-status', rec.id, 'completed')">
              {{ t('advisory.complete') }}
            </button>
            <button type="button" class="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-300" @click="emit('set-status', rec.id, 'ignored')">
              {{ t('advisory.ignore') }}
            </button>
          </div>
        </li>
      </ul>
    </template>

    <template v-else-if="insightKey && activeInsight">
      <button
        type="button"
        class="text-sm text-farm-green font-semibold hover:underline"
        @click="emit('close-insight')"
      >
        ← {{ t('advisory.insights') }}
      </button>
      <h3 class="text-xl font-black text-white">{{ activeInsight.label }}</h3>
      <p v-if="insightLoading" class="text-slate-400 text-sm">{{ t('advisory.loading') }}</p>
      <p v-else-if="insightRecommendations.length === 0" class="text-slate-400 text-sm">
        {{ t('advisory.insightEmpty') }}
      </p>
      <ul v-else class="space-y-3">
        <li
          v-for="rec in insightRecommendations"
          :key="rec.id"
          class="rounded-2xl border border-slate-800 bg-slate-900 p-4"
        >
          <p class="text-white font-semibold">{{ rec.happeningNow }}</p>
          <p class="text-slate-300 text-sm mt-1">{{ rec.whatNext }}</p>
          <ul v-if="rec.products?.length" class="mt-3 space-y-1">
            <li v-for="(p, i) in rec.products" :key="i" class="text-sm text-slate-200">
              <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="text-farm-green underline">{{ p.title }}</a>
              <span v-else>{{ p.title }} <span class="text-slate-500">({{ t('advisory.suggestedArea') }})</span></span>
            </li>
          </ul>
        </li>
      </ul>
    </template>

    <template v-else>
      <div class="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          class="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-left hover:bg-slate-800/60 min-h-[44px] transition-colors"
          @click="emit('open-tip-bucket', 'open')"
        >
          <p class="text-xs text-slate-400">{{ t('advisory.statOpen') }}</p>
          <p class="text-2xl font-black text-white mt-1">
            {{ (stats.pending || 0) + (stats.notified || 0) + (stats.accepted || 0) }}
          </p>
          <p class="text-slate-500 text-xs mt-2">{{ t('advisory.tapToView') }}</p>
        </button>
        <button
          type="button"
          class="rounded-2xl border border-slate-800 bg-slate-900 p-4 text-left hover:bg-slate-800/60 min-h-[44px] transition-colors"
          @click="emit('open-tip-bucket', 'completed')"
        >
          <p class="text-xs text-slate-400">{{ t('advisory.statDone') }}</p>
          <p class="text-2xl font-black text-white mt-1">{{ stats.completed || 0 }}</p>
          <p class="text-slate-500 text-xs mt-2">{{ t('advisory.tapToView') }}</p>
        </button>
      </div>
      <div>
        <h3 class="text-white font-bold mb-2">{{ t('advisory.insights') }}</h3>
        <ul class="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900">
          <li v-for="insight in insightList" :key="insight.key">
            <button
              type="button"
              class="w-full px-4 py-3 text-slate-200 flex justify-between items-center text-left hover:bg-slate-800/60 min-h-[44px]"
              @click="emit('open-insight', insight.key)"
            >
              <span>{{ insight.label }}</span>
              <span class="text-slate-500" aria-hidden="true">›</span>
            </button>
          </li>
        </ul>
      </div>
      <div>
        <h3 class="text-white font-bold mb-2">{{ t('advisory.activeCycles') }}</h3>
        <p class="text-slate-500 text-xs mb-2">{{ t('advisory.activeCyclesHint') }}</p>
        <ul class="divide-y divide-slate-800 rounded-2xl border border-slate-800 bg-slate-900">
          <li v-for="s in subjects" :key="s.id">
            <button
              type="button"
              class="w-full px-4 py-3 text-left flex justify-between items-center gap-3 hover:bg-slate-800/60 min-h-[44px]"
              @click="emit('open-subject', s.id)"
            >
              <span class="min-w-0">
                <span class="text-slate-100 font-medium">{{ formatSubjectTitle(s) }}</span>
                <span class="text-slate-500 text-sm block sm:inline sm:ml-2">
                  {{
                    s.kind === 'crop'
                      ? t('advisory.stageDay', { n: s.dayInStage })
                      : t('advisory.day', { n: s.dayInCycle })
                  }}
                </span>
              </span>
              <span class="text-slate-500 shrink-0" aria-hidden="true">›</span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>
