<script lang="ts">
/**
 * Resolve an insight category name the API addressed by `key`.
 *
 * These four names are fixed UI chrome, so they live in the vue-i18n catalogs
 * (`advisory.insightCategories.*`) rather than going through the server's
 * content translator. The API keeps sending an English `label`, which is used
 * for any key this build does not know — an unrecognized category then reads in
 * English instead of rendering blank.
 */
export function resolveInsightLabel(
  key: string,
  fallback: string,
  i18n: { t: (key: string) => string; te: (key: string, locale?: string) => boolean },
): string {
  const catalogKey = `advisory.insightCategories.${key}`
  if (!i18n.te(catalogKey) && !i18n.te(catalogKey, 'en')) return fallback
  return i18n.t(catalogKey) || fallback
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import CollapsibleSection from '@/components/CollapsibleSection.vue'
import AdvisoryAnalysisPanel from '@/components/advisory/AdvisoryAnalysisPanel.vue'
import AdvisoryCalendarPanel from '@/components/advisory/AdvisoryCalendarPanel.vue'
import {
  useAdvisoryAnalysis,
  type InsightKey,
  type ProductHit,
  type Recommendation,
  type Subject,
} from '@/composables/useAdvisoryAnalysis'
import { useAdvisoryCalendar } from '@/composables/useAdvisoryCalendar'
import { api } from '@/lib/api'

const { t, te, locale } = useI18n()
const route = useRoute()
const router = useRouter()

type Tile = { key: string; label: string }

type HomeData = {
  subjects: Subject[]
  recommendations: Recommendation[]
  stats: Record<string, number>
  tiles: { crop: Tile[]; poultry: Tile[] }
  closeLine: { livestock: string; crop: string }
}

const tab = ref<'home' | 'calendar' | 'track' | 'analysis'>('home')
const loading = ref(true)
const error = ref('')
const home = ref<HomeData | null>(null)
const selectedSubjectId = ref('')
const selectedTiles = ref<string[]>([])
const trackNote = ref('')
const trackSaving = ref(false)
const trackResult = ref<{ products: ProductHit[]; closeLine: string | null } | null>(null)
const aboutOpen = ref(false)
const analysis = ref<{
  stats: Record<string, number>
  subjects: Subject[]
  insights: Array<{ key: string; label: string }>
  recentObservations: Array<{ id: string; loggedAt: string; tiles: string[] }>
} | null>(null)

const {
  insightKey,
  insightLoading,
  tipBucket,
  tipBucketLoading,
  tipBucketRows,
  insightList,
  activeInsight,
  insightRecommendations,
  openInsight,
  closeInsight,
  openTipBucket,
  closeTipBucket,
  clearOverlays,
} = useAdvisoryAnalysis({
  onError: (message) => {
    error.value = message
  },
})

const { calendarData, loadCalendar, shiftMonth } = useAdvisoryCalendar()

/**
 * Insight categories for the analysis tab, named by the `key` the server sends.
 * Until that payload has loaded, the composable's own list stands in.
 */
const insightCategories = computed(() => {
  const rows = analysis.value?.insights ?? []
  if (rows.length === 0) return insightList.value
  return rows.map((insight) => ({
    key: insight.key as InsightKey,
    label: resolveInsightLabel(insight.key, insight.label, {
      t: (key: string) => t(key),
      te: (key: string, locale?: string) => (locale ? te(key, locale) : te(key)),
    }),
  }))
})

const selectedSubject = computed(() => {
  const subjects = home.value?.subjects ?? []
  return subjects.find((s) => s.id === selectedSubjectId.value) ?? subjects[0] ?? null
})

/** Predictions for the selected cycle/batch (plus farm-wide weather tips). */
const filteredRecommendations = computed(() => {
  const all = home.value?.recommendations ?? []
  const id = selectedSubject.value?.id
  if (!id) return all
  return all.filter(
    (r) => r.sourceId === id || r.sourceType === 'weather' || r.sourceType === 'farm',
  )
})

const PREVIEW_PREDICTIONS = 2
const previewRecommendations = computed(() =>
  filteredRecommendations.value.slice(0, PREVIEW_PREDICTIONS),
)
const extraRecommendations = computed(() =>
  filteredRecommendations.value.slice(PREVIEW_PREDICTIONS),
)

function predictionHasExtra(rec: Recommendation) {
  return Boolean(
    rec.aiSummary ||
    rec.payload.products?.length ||
    rec.payload.prediction?.evidence?.length,
  )
}

function predictionModeLabel(rec: Recommendation) {
  const mode = rec.payload.prediction?.mode
  if (mode === 'ai_plan') return t('advisory.aiPlan')
  if (mode === 'ai_summary') return t('advisory.aiSummary')
  return t('advisory.ruleFallback')
}

function predictionConfidenceLabel(rec: Recommendation) {
  const confidence = rec.payload.prediction?.confidence
  if (!confidence) return ''
  const level = t(`advisory.confidence${confidence[0].toUpperCase()}${confidence.slice(1)}`)
  return t('advisory.confidence', { level })
}

const trackTiles = computed(() => {
  if (!home.value) return []
  const tiles = selectedSubject.value?.kind === 'livestock'
    ? home.value.tiles.poultry
    : home.value.tiles.crop
  return tiles.map((tile) => {
    const key = `advisory.tiles.${tile.key}`
    return { ...tile, label: te(key) ? t(key) : tile.label }
  })
})

const todayLabel = computed(() =>
  new Date().toLocaleDateString(locale.value, { weekday: 'short', day: 'numeric', month: 'short' }),
)

const cycleDay = computed(() => {
  const s = selectedSubject.value
  if (!s) return 0
  return s.kind === 'livestock' ? s.dayInCycle : s.dayInStage
})

const cycleLength = computed(() => {
  const s = selectedSubject.value
  if (!s) return 42
  if (s.kind === 'livestock') return 42
  return s.totalStageDays
})

const stageOverdueDays = computed(() => {
  const subject = selectedSubject.value
  if (subject?.kind !== 'crop' || !subject.totalStageDays) return 0
  return Math.max(0, subject.dayInStage - subject.totalStageDays)
})

const phaseName = computed(() => {
  const s = selectedSubject.value
  if (!s) return t('advisory.phaseUnknown')
  if (s.kind === 'crop') {
    const key = `crops.stage.${s.stage}`
    return te(key) ? t(key) : s.stage.replace(/_/g, ' ')
  }
  const d = s.dayInCycle
  if (d <= 7) return t('advisory.phaseBrooding')
  if (d <= 21) return t('advisory.phaseGrow')
  return t('advisory.phaseFinish')
})

const headline = computed(() => {
  const s = selectedSubject.value
  if (!s) return t('advisory.noUpcoming')
  if (stageOverdueDays.value > 0) {
    return t('advisory.stageOverdue', { n: stageOverdueDays.value })
  }
  if (s.daysUntilNextHint != null && s.daysUntilNextHint > 0 && s.nextHint) {
    return t('advisory.daysUntilShort', { n: s.daysUntilNextHint })
  }
  if (s.daysUntilNextHint === 0 && s.nextHint) return t('advisory.actionDueToday')
  return t('advisory.noUpcoming')
})

const headlineDetail = computed(() =>
  stageOverdueDays.value > 0
    ? t('advisory.stageOverdueDetail')
    : selectedSubject.value?.nextHint ?? '',
)

const progressPct = computed(() =>
  cycleLength.value
    ? Math.min(100, Math.round((cycleDay.value / cycleLength.value) * 100))
    : null,
)

const dialCirc = 2 * Math.PI * 52
const dialOffset = computed(() =>
  cycleLength.value
    ? dialCirc * (1 - Math.min(0.999, cycleDay.value / cycleLength.value))
    : dialCirc,
)

watch(selectedSubjectId, () => {
  aboutOpen.value = false
  selectedTiles.value = []
  trackResult.value = null
})

function openSubject(id: string) {
  selectedSubjectId.value = id
  insightKey.value = null
  tab.value = 'home'
}

async function loadHome() {
  loading.value = true
  error.value = ''
  try {
    home.value = await api<HomeData>('/api/advisory/home')
    if (!selectedSubjectId.value && home.value.subjects[0]) {
      selectedSubjectId.value = home.value.subjects[0].id
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('advisory.loadError')
  } finally {
    loading.value = false
  }
}

async function loadAnalysis() {
  analysis.value = await api('/api/advisory/analysis')
}

async function setStatus(id: string, status: 'accepted' | 'ignored' | 'completed') {
  await api(`/api/advisory/recommendations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
  await loadHome()
  if (tipBucket.value) await openTipBucket(tipBucket.value)
  if (analysis.value) await loadAnalysis()
}

function toggleTile(key: string) {
  if (selectedTiles.value.includes(key)) {
    selectedTiles.value = selectedTiles.value.filter((k) => k !== key)
  } else {
    selectedTiles.value = [...selectedTiles.value, key]
  }
}

async function saveTrack() {
  if (selectedTiles.value.length === 0) return
  trackSaving.value = true
  trackResult.value = null
  try {
    const subject = selectedSubject.value
    const res = await api<{
      products: ProductHit[]
      closeLine: string | null
    }>('/api/advisory/observations', {
      method: 'POST',
      body: JSON.stringify({
        tiles: selectedTiles.value,
        note: trackNote.value || undefined,
        sourceType: subject?.kind === 'livestock' ? 'livestock_batch' : subject ? 'crop_cycle' : undefined,
        sourceId: subject?.id,
      }),
    })
    trackResult.value = { products: res.products ?? [], closeLine: res.closeLine }
    selectedTiles.value = []
    trackNote.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('advisory.saveError')
  } finally {
    trackSaving.value = false
  }
}

watch(tab, async (v) => {
  if (v !== 'analysis') {
    clearOverlays()
  }
  if (v === 'calendar' && !calendarData.value) await loadCalendar()
  if (v === 'analysis' && !analysis.value) await loadAnalysis()
  void router.replace({ query: { ...route.query, tab: v } })
})

async function reloadLocalizedContent() {
  await loadHome()
  if (tab.value === 'calendar') await loadCalendar()
  if (tab.value === 'analysis') await loadAnalysis()
  if (tipBucket.value) await openTipBucket(tipBucket.value)
  if (insightKey.value) await openInsight(insightKey.value)
}

onMounted(async () => {
  window.addEventListener('trovara:locale-preference-saved', reloadLocalizedContent)
  const qTab = String(route.query.tab || 'home')
  if (qTab === 'calendar' || qTab === 'track' || qTab === 'analysis' || qTab === 'home') {
    tab.value = qTab
  }
  await loadHome()
  if (tab.value === 'calendar') await loadCalendar()
  if (tab.value === 'analysis') await loadAnalysis()
})

onBeforeUnmount(() => {
  window.removeEventListener('trovara:locale-preference-saved', reloadLocalizedContent)
})
</script>

<template>
  <AppLayout>
    <div class="w-full min-w-0 max-w-6xl pb-8">
      <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('advisory.eyebrow') }}</p>
      <h2 class="text-2xl sm:text-3xl font-black text-os-fg mt-1">{{ t('advisory.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1 max-w-2xl">{{ t('advisory.subtitle') }}</p>

      <div class="mt-5 flex flex-wrap gap-2" role="tablist" :aria-label="t('advisory.title')">
        <button
          v-for="key in (['home', 'calendar', 'track', 'analysis'] as const)"
          :key="key"
          type="button"
          role="tab"
          :aria-selected="tab === key"
          class="rounded-full px-4 py-2 text-sm font-semibold min-h-[40px]"
          :class="tab === key ? 'bg-farm-green text-slate-950' : 'bg-slate-800 text-slate-300'"
          @click="tab = key"
        >
          {{ t(`advisory.tabs.${key}`) }}
        </button>
      </div>

      <p v-if="loading" class="mt-8 text-slate-400">{{ t('advisory.loading') }}</p>
      <p v-else-if="error" class="mt-8 text-red-400">{{ error }}</p>

      <template v-else-if="home">
        <section v-if="tab === 'home'" class="mt-8">
          <div class="space-y-5 lg:grid lg:grid-cols-12 lg:items-start lg:gap-8 lg:space-y-0">
          <div class="space-y-5 lg:col-span-5">
          <label class="block text-xs text-slate-400">
            {{ t('advisory.mode') }}
            <select
              v-model="selectedSubjectId"
              class="mt-1 w-full max-w-md rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"
            >
              <option v-for="s in home.subjects" :key="s.id" :value="s.id">{{ s.label }}</option>
            </select>
          </label>

          <div class="rounded-2xl border border-slate-800 bg-slate-900 p-5 sm:p-6">
            <div class="flex flex-col sm:flex-row sm:items-center gap-5">
              <!-- Small ring: day number only — no cramped paragraphs inside -->
              <div class="relative mx-auto sm:mx-0 w-[7.5rem] h-[7.5rem] shrink-0">
                <svg viewBox="0 0 120 120" class="w-full h-full -rotate-90" aria-hidden="true">
                  <circle cx="60" cy="60" r="52" fill="none" stroke="#1e293b" stroke-width="10" />
                  <circle
                    cx="60"
                    cy="60"
                    r="52"
                    fill="none"
                    stroke="#86efac"
                    stroke-width="10"
                    stroke-linecap="round"
                    :stroke-dasharray="dialCirc"
                    :stroke-dashoffset="dialOffset"
                  />
                </svg>
                <div class="absolute inset-0 flex flex-col items-center justify-center text-center px-2">
                  <p class="text-[10px] uppercase tracking-wide text-slate-400 leading-none">
                    {{ t('advisory.dayShort') }}
                  </p>
                  <p class="text-3xl font-black text-os-fg leading-none mt-1 tabular-nums">{{ cycleDay }}</p>
                </div>
              </div>

              <div class="min-w-0 flex-1 text-center sm:text-left">
                <p class="text-slate-400 text-sm">{{ t('advisory.todayDate', { date: todayLabel }) }}</p>
                <p class="mt-1 text-xs font-semibold uppercase tracking-wide text-farm-gold">
                  {{ phaseName }}
                  <span v-if="progressPct !== null" class="text-slate-500 font-normal normal-case">· {{ progressPct }}%</span>
                </p>
                <h3 class="mt-2 text-xl sm:text-2xl font-black text-os-fg leading-snug">
                  {{ headline }}
                </h3>
                <p v-if="headlineDetail" class="mt-2 text-slate-300 text-sm leading-relaxed">
                  {{ headlineDetail }}
                </p>
                <button
                  type="button"
                  class="mt-3 text-farm-green text-sm font-semibold hover:underline"
                  @click="aboutOpen = !aboutOpen"
                >
                  {{ t('advisory.aboutPhase', { phase: phaseName }) }}
                </button>
              </div>
            </div>

            <div class="mt-4 h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div class="h-full rounded-full bg-farm-green/80 transition-all" :style="{ width: `${progressPct ?? 0}%` }" />
            </div>

            <div
              v-if="aboutOpen"
              class="mt-4 rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-300"
            >
              <p>
                {{
                  selectedSubject?.kind === 'livestock'
                    ? t('advisory.aboutPoultryBody', { day: cycleDay, phase: phaseName })
                    : t('advisory.aboutCropBody', { stage: phaseName, day: cycleDay })
                }}
              </p>
            </div>
          </div>

          <button
            type="button"
            class="w-full rounded-xl border border-slate-700 bg-slate-900 hover:border-farm-green/40 text-white font-bold py-3.5 px-4 flex items-center justify-between min-h-[48px]"
            @click="tab = 'track'"
          >
            <span>{{ t('advisory.howIsFarm') }}</span>
            <span class="text-farm-green" aria-hidden="true">›</span>
          </button>

          </div>

          <div class="lg:col-span-7">
            <h3 class="text-white font-bold mb-3">{{ t('advisory.predictions') }}</h3>
            <div v-if="filteredRecommendations.length === 0" class="text-slate-400 text-sm">
              {{ t('advisory.noPredictions') }}
            </div>
            <ul class="space-y-3">
              <li
                v-for="rec in previewRecommendations"
                :key="rec.id"
                class="rounded-2xl border border-slate-800 bg-slate-900 p-4"
              >
                <div v-if="rec.payload.prediction" class="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
                  <span
                    class="rounded-full border px-2.5 py-1"
                    :class="rec.payload.prediction.mode === 'ai_plan' ? 'border-farm-green/40 bg-farm-green/10 text-farm-green' : 'border-slate-700 bg-slate-800 text-slate-300'"
                  >
                    {{ predictionModeLabel(rec) }}
                  </span>
                  <span v-if="predictionConfidenceLabel(rec)" class="rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-1 text-slate-300">
                    {{ predictionConfidenceLabel(rec) }}
                  </span>
                </div>
                <p class="text-white font-semibold">{{ rec.payload.happeningNow }}</p>
                <p class="text-slate-300 text-sm mt-1">{{ rec.payload.whatNext }}</p>
                <details v-if="predictionHasExtra(rec)" class="mt-2">
                  <summary class="cursor-pointer text-sm font-semibold text-farm-green">
                    {{ t('advisory.moreDetail') }}
                  </summary>
                  <p v-if="rec.aiSummary" class="mt-2 text-sm text-slate-400">{{ rec.aiSummary }}</p>
                  <div v-if="rec.payload.prediction?.evidence?.length" class="mt-3 rounded-xl border border-slate-800 bg-slate-950/45 p-3">
                    <p class="text-xs font-bold uppercase tracking-wider text-slate-400">{{ t('advisory.evidence') }}</p>
                    <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
                      <li v-for="item in rec.payload.prediction.evidence" :key="item">{{ item }}</li>
                    </ul>
                  </div>
                  <p v-if="rec.payload.products?.some((p) => p.source === 'search')" class="mt-3 text-xs font-bold uppercase tracking-wider text-slate-400">
                    {{ t('advisory.liveSearch') }}
                  </p>
                  <ul v-if="rec.payload.products?.length" class="mt-3 space-y-1">
                    <li v-for="(p, i) in rec.payload.products" :key="i" class="text-sm text-slate-200">
                      <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="text-farm-green underline">{{ p.title }}</a>
                      <span v-else>{{ p.title }} <span class="text-slate-500">({{ t('advisory.suggestedArea') }})</span></span>
                    </li>
                  </ul>
                </details>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button v-if="rec.status !== 'accepted'" type="button" class="rounded-lg bg-farm-green px-3 py-1.5 text-xs font-bold text-slate-950" @click="setStatus(rec.id, 'accepted')">
                    {{ t('advisory.accept') }}
                  </button>
                  <button type="button" class="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-bold text-white" @click="setStatus(rec.id, 'completed')">
                    {{ t('advisory.complete') }}
                  </button>
                  <button type="button" class="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-300" @click="setStatus(rec.id, 'ignored')">
                    {{ t('advisory.ignore') }}
                  </button>
                </div>
              </li>
            </ul>
            <CollapsibleSection
              v-if="extraRecommendations.length"
              class="mt-3"
              :title="t('advisory.morePredictions', { count: extraRecommendations.length })"
              :default-open="false"
            >
              <ul class="space-y-3">
                <li
                  v-for="rec in extraRecommendations"
                  :key="rec.id"
                  class="rounded-2xl border border-slate-800 bg-slate-950/45 p-4"
                >
                  <div v-if="rec.payload.prediction" class="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-wider">
                    <span
                      class="rounded-full border px-2.5 py-1"
                      :class="rec.payload.prediction.mode === 'ai_plan' ? 'border-farm-green/40 bg-farm-green/10 text-farm-green' : 'border-slate-700 bg-slate-800 text-slate-300'"
                    >
                      {{ predictionModeLabel(rec) }}
                    </span>
                    <span v-if="predictionConfidenceLabel(rec)" class="rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-300">
                      {{ predictionConfidenceLabel(rec) }}
                    </span>
                  </div>
                  <p class="text-white font-semibold">{{ rec.payload.happeningNow }}</p>
                  <p class="text-slate-300 text-sm mt-1">{{ rec.payload.whatNext }}</p>
                  <details v-if="predictionHasExtra(rec)" class="mt-2">
                    <summary class="cursor-pointer text-sm font-semibold text-farm-green">
                      {{ t('advisory.moreDetail') }}
                    </summary>
                    <p v-if="rec.aiSummary" class="mt-2 text-sm text-slate-400">{{ rec.aiSummary }}</p>
                    <div v-if="rec.payload.prediction?.evidence?.length" class="mt-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
                      <p class="text-xs font-bold uppercase tracking-wider text-slate-400">{{ t('advisory.evidence') }}</p>
                      <ul class="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
                        <li v-for="item in rec.payload.prediction.evidence" :key="item">{{ item }}</li>
                      </ul>
                    </div>
                    <p v-if="rec.payload.products?.some((p) => p.source === 'search')" class="mt-3 text-xs font-bold uppercase tracking-wider text-slate-400">
                      {{ t('advisory.liveSearch') }}
                    </p>
                    <ul v-if="rec.payload.products?.length" class="mt-3 space-y-1">
                      <li v-for="(p, i) in rec.payload.products" :key="i" class="text-sm text-slate-200">
                        <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="text-farm-green underline">{{ p.title }}</a>
                        <span v-else>{{ p.title }} <span class="text-slate-500">({{ t('advisory.suggestedArea') }})</span></span>
                      </li>
                    </ul>
                  </details>
                  <div class="mt-3 flex flex-wrap gap-2">
                    <button v-if="rec.status !== 'accepted'" type="button" class="rounded-lg bg-farm-green px-3 py-1.5 text-xs font-bold text-slate-950" @click="setStatus(rec.id, 'accepted')">
                      {{ t('advisory.accept') }}
                    </button>
                    <button type="button" class="rounded-lg bg-slate-700 px-3 py-1.5 text-xs font-bold text-white" @click="setStatus(rec.id, 'completed')">
                      {{ t('advisory.complete') }}
                    </button>
                    <button type="button" class="rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-bold text-slate-300" @click="setStatus(rec.id, 'ignored')">
                      {{ t('advisory.ignore') }}
                    </button>
                  </div>
                </li>
              </ul>
            </CollapsibleSection>
          </div>
          </div>
        </section>

        <AdvisoryCalendarPanel
          v-else-if="tab === 'calendar'"
          :subjects="home.subjects"
          :calendar-data="calendarData"
          @shift-month="shiftMonth"
        />

        <section v-else-if="tab === 'track'" class="mt-8">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="text-xl font-black text-os-fg">{{ t('advisory.howIsFarm') }}</h3>
              <p class="text-slate-400 text-sm mt-1">{{ t('advisory.trackSubtitle') }}</p>
            </div>
            <button
              type="button"
              class="rounded-lg px-3 py-2 text-sm font-bold text-slate-300 hover:bg-slate-800"
              :aria-label="t('advisory.closeTrack')"
              @click="tab = 'home'"
            >
              {{ t('advisory.closeTrack') }}
            </button>
          </div>
          <div class="mt-5 rounded-2xl border border-slate-800 bg-slate-900 p-4">
            <label class="block text-xs font-bold uppercase tracking-wide text-slate-400">
              {{ t('advisory.recordingFor') }}
              <select
                v-model="selectedSubjectId"
                class="mt-2 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm font-semibold text-white sm:max-w-md"
              >
                <option v-for="s in home.subjects" :key="s.id" :value="s.id">{{ s.label }}</option>
              </select>
            </label>
          </div>
          <div class="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-4">
            <button
              v-for="tile in trackTiles"
              :key="tile.key"
              type="button"
              class="relative min-h-24 rounded-xl border border-slate-700 p-3 flex flex-col items-center justify-center text-center lg:min-h-20"
              :aria-pressed="selectedTiles.includes(tile.key)"
              :class="
                selectedTiles.includes(tile.key)
                  ? 'border-farm-green bg-farm-green/10 text-farm-green'
                  : 'text-slate-200'
              "
              @click="toggleTile(tile.key)"
            >
              <span
                v-if="selectedTiles.includes(tile.key)"
                class="absolute right-2 top-1 text-base font-black"
                aria-hidden="true"
              >✓</span>
              <span class="text-xs font-semibold leading-tight">{{ tile.label }}</span>
            </button>
          </div>
          <label class="block mt-4 text-xs text-slate-400">
            {{ t('advisory.noteOptional') }}
            <textarea
              v-model="trackNote"
              rows="2"
              class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
            />
          </label>
          <button
            type="button"
            class="mt-4 w-full rounded-xl bg-farm-green py-3 font-bold text-slate-950 disabled:opacity-40 sm:w-auto sm:px-8"
            :disabled="trackSaving || selectedTiles.length === 0"
            @click="saveTrack"
          >
            {{ trackSaving ? t('advisory.saving') : t('advisory.save') }}
          </button>
          <div v-if="trackResult" class="mt-4 rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-2">
            <p v-if="trackResult.products.length" class="text-sm text-slate-200 font-semibold">{{ t('advisory.suggestedInputs') }}</p>
            <ul class="space-y-1">
              <li v-for="(p, i) in trackResult.products" :key="i" class="text-sm text-farm-green">
                <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="underline">{{ p.title }}</a>
                <span v-else>{{ p.title }}</span>
              </li>
            </ul>
            <p v-if="trackResult.closeLine" class="text-sm text-amber-200/90 mt-2">{{ trackResult.closeLine }}</p>
          </div>
        </section>

        <AdvisoryAnalysisPanel
          v-else
          :stats="home.stats"
          :subjects="home.subjects"
          :tip-bucket="tipBucket"
          :tip-bucket-loading="tipBucketLoading"
          :tip-bucket-rows="tipBucketRows"
          :insight-key="insightKey"
          :insight-loading="insightLoading"
          :insight-recommendations="insightRecommendations"
          :insight-list="insightCategories"
          :active-insight="activeInsight"
          @open-tip-bucket="openTipBucket"
          @close-tip-bucket="closeTipBucket"
          @open-insight="openInsight"
          @close-insight="closeInsight"
          @open-subject="openSubject"
          @set-status="setStatus"
        />
      </template>
    </div>
  </AppLayout>
</template>
