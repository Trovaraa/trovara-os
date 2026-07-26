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
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
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

const { t, te } = useI18n()
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

const trackTiles = computed(() => {
  if (!home.value) return []
  if (selectedSubject.value?.kind === 'livestock') return home.value.tiles.poultry
  return home.value.tiles.crop
})

const todayLabel = computed(() =>
  new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }),
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
  return 90
})

const phaseName = computed(() => {
  const s = selectedSubject.value
  if (!s) return t('advisory.phaseUnknown')
  if (s.kind === 'crop') return s.stage.replace(/_/g, ' ')
  const d = s.dayInCycle
  if (d <= 7) return t('advisory.phaseBrooding')
  if (d <= 21) return t('advisory.phaseGrow')
  return t('advisory.phaseFinish')
})

const headline = computed(() => {
  const s = selectedSubject.value
  if (!s) return t('advisory.noUpcoming')
  if (s.daysUntilNextHint != null && s.daysUntilNextHint > 0 && s.nextHint) {
    return t('advisory.daysUntilShort', { n: s.daysUntilNextHint })
  }
  if (s.daysUntilNextHint === 0 && s.nextHint) return t('advisory.actionDueToday')
  return t('advisory.noUpcoming')
})

const headlineDetail = computed(() => selectedSubject.value?.nextHint ?? '')

const progressPct = computed(() =>
  Math.min(100, Math.round((cycleDay.value / cycleLength.value) * 100)),
)

const dialCirc = 2 * Math.PI * 52
const dialOffset = computed(() => dialCirc * (1 - Math.min(0.999, cycleDay.value / cycleLength.value)))

watch(selectedSubjectId, () => {
  aboutOpen.value = false
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

onMounted(async () => {
  const qTab = String(route.query.tab || 'home')
  if (qTab === 'calendar' || qTab === 'track' || qTab === 'analysis' || qTab === 'home') {
    tab.value = qTab
  }
  await loadHome()
  if (tab.value === 'calendar') await loadCalendar()
  if (tab.value === 'analysis') await loadAnalysis()
})
</script>

<template>
  <AppLayout>
    <div class="w-full max-w-2xl min-w-0 pb-8">
      <p class="text-farm-gold text-xs font-bold tracking-widest uppercase">{{ t('advisory.eyebrow') }}</p>
      <h2 class="text-2xl sm:text-3xl font-black text-white mt-1">{{ t('advisory.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">{{ t('advisory.subtitle') }}</p>

      <div class="mt-5 flex flex-wrap gap-2">
        <button
          v-for="key in (['home', 'calendar', 'track', 'analysis'] as const)"
          :key="key"
          type="button"
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
        <section v-if="tab === 'home'" class="mt-8 space-y-5">
          <label class="block text-xs text-slate-400">
            {{ t('advisory.mode') }}
            <select
              v-model="selectedSubjectId"
              class="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"
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
                  <p class="text-3xl font-black text-white leading-none mt-1 tabular-nums">{{ cycleDay }}</p>
                </div>
              </div>

              <div class="min-w-0 flex-1 text-center sm:text-left">
                <p class="text-slate-400 text-sm">{{ t('advisory.todayDate', { date: todayLabel }) }}</p>
                <p class="mt-1 text-xs font-semibold uppercase tracking-wide text-farm-gold">
                  {{ phaseName }}
                  <span class="text-slate-500 font-normal normal-case">· {{ progressPct }}%</span>
                </p>
                <h3 class="mt-2 text-xl sm:text-2xl font-black text-white leading-snug">
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
              <div class="h-full rounded-full bg-farm-green/80 transition-all" :style="{ width: `${progressPct}%` }" />
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

          <div>
            <h3 class="text-white font-bold mb-3">{{ t('advisory.predictions') }}</h3>
            <div v-if="filteredRecommendations.length === 0" class="text-slate-400 text-sm">
              {{ t('advisory.noPredictions') }}
            </div>
            <ul class="space-y-3">
              <li
                v-for="rec in filteredRecommendations"
                :key="rec.id"
                class="rounded-2xl border border-slate-800 bg-slate-900 p-4"
              >
                <p class="text-white font-semibold">{{ rec.payload.happeningNow }}</p>
                <p class="text-slate-300 text-sm mt-1">{{ rec.payload.whatNext }}</p>
                <p v-if="rec.aiSummary" class="text-slate-400 text-sm mt-2">{{ rec.aiSummary }}</p>
                <ul v-if="rec.payload.products?.length" class="mt-3 space-y-1">
                  <li v-for="(p, i) in rec.payload.products" :key="i" class="text-sm text-slate-200">
                    <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="text-farm-green underline">{{ p.title }}</a>
                    <span v-else>{{ p.title }} <span class="text-slate-500">({{ t('advisory.suggestedArea') }})</span></span>
                  </li>
                </ul>
                <div class="mt-3 flex flex-wrap gap-2">
                  <button type="button" class="rounded-lg bg-farm-green px-3 py-1.5 text-xs font-bold text-slate-950" @click="setStatus(rec.id, 'accepted')">
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
              <h3 class="text-xl font-black text-white">{{ t('advisory.howIsFarm') }}</h3>
              <p class="text-slate-400 text-sm mt-1">{{ t('advisory.trackSubtitle') }}</p>
            </div>
            <button type="button" class="text-slate-400 text-xl leading-none" @click="tab = 'home'">×</button>
          </div>
          <div class="mt-6 grid grid-cols-3 gap-3">
            <button
              v-for="tile in trackTiles"
              :key="tile.key"
              type="button"
              class="aspect-square rounded-xl border border-slate-700 p-2 flex flex-col items-center justify-center text-center"
              :class="
                selectedTiles.includes(tile.key)
                  ? 'border-farm-green bg-farm-green/10 text-farm-green'
                  : 'text-slate-200'
              "
              @click="toggleTile(tile.key)"
            >
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
            class="mt-4 w-full rounded-xl bg-farm-green text-slate-950 font-bold py-3 disabled:opacity-40"
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
