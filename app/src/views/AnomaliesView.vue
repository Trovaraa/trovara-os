<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'

type ReviewStatus = 'explained' | 'confirmed' | 'false_positive'
type Observation = {
  id: string
  observationType: string
  category: string
  title: string
  summary: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  evidence: Record<string, unknown>
  status: 'observed' | ReviewStatus
  reviewNote: string | null
  lastObservedAt: string
}

const { t } = useI18n()
const auth = useAuthStore()
const canReview = computed(() => auth.hasPermission('anomalies.review'))
const observations = ref<Observation[]>([])
const filter = ref<'observed' | ReviewStatus>('observed')
const loading = ref(true)
const running = ref(false)
const error = ref('')
const success = ref('')
const reviews = ref<Record<string, { status: ReviewStatus; note: string }>>({})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await api<{ observations: Observation[] }>(`/api/anomalies?status=${filter.value}`)
    observations.value = result.observations
    for (const row of observations.value) reviews.value[row.id] ??= { status: 'explained', note: '' }
  } catch (e) { error.value = e instanceof Error ? e.message : t('anomalies.loadFailed') } finally { loading.value = false }
}

async function runCheck() {
  running.value = true
  error.value = ''
  success.value = ''
  try {
    const result = await api<{ created: number; refreshed: number }>('/api/anomalies/run', { method: 'POST' })
    success.value = t('anomalies.runSummary', result)
    filter.value = 'observed'
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : t('anomalies.runFailed') } finally { running.value = false }
}

async function saveReview(row: Observation) {
  const review = reviews.value[row.id]
  if (!review?.note.trim()) { error.value = t('anomalies.noteRequired'); return }
  try {
    await api(`/api/anomalies/${row.id}/review`, { method: 'PATCH', body: JSON.stringify({ status: review.status, reviewNote: review.note.trim() }) })
    await load()
  } catch (e) { error.value = e instanceof Error ? e.message : t('anomalies.reviewFailed') }
}

function evidenceValue(value: unknown): string {
  if (value == null) return '—'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function localizedObservation(row: Observation, field: 'title' | 'summary'): string {
  if (!['inventory_variance', 'inventory_shrink', 'expense_outlier', 'repeat_repair'].includes(row.observationType)) return field === 'title' ? row.title : row.summary
  return t(`anomalies.types.${row.observationType}.${field}`, row.evidence)
}

function date(value: string) { return new Date(value).toLocaleString() }
onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div><p class="text-xs font-black uppercase tracking-[.2em] text-amber-300">{{ t('anomalies.eyebrow') }}</p><h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('anomalies.title') }}</h2><p class="mt-1 max-w-3xl text-sm text-slate-400">{{ t('anomalies.subtitle') }}</p></div>
      <button v-if="canReview" :disabled="running" class="rounded-xl bg-farm-green px-4 py-2 font-bold text-slate-950 disabled:opacity-50" @click="runCheck">{{ running ? t('anomalies.running') : t('anomalies.run') }}</button>
    </div>

    <div class="mt-5 rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4"><p class="font-bold text-amber-200">{{ t('anomalies.mode') }}</p><p class="mt-1 text-sm text-amber-100/80">{{ t('anomalies.modeBody') }}</p></div>
    <p v-if="error" class="mt-4 rounded-xl border border-red-700/50 bg-red-950/30 p-3 text-sm text-red-300">{{ error }}</p>
    <p v-if="success" class="mt-4 rounded-xl border border-green-700/50 bg-green-950/30 p-3 text-sm text-green-300">{{ success }}</p>

    <div class="mt-6 flex gap-2 overflow-x-auto pb-1"><button v-for="status in ['observed','explained','confirmed','false_positive'] as const" :key="status" class="whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold" :class="filter === status ? 'border-farm-green bg-farm-green/15 text-farm-green' : 'border-slate-700 text-slate-400'" @click="filter = status; load()">{{ t(`anomalies.filters.${status}`) }}</button></div>
    <p v-if="loading" class="mt-8 text-slate-400">{{ t('anomalies.loading') }}</p>
    <p v-else-if="!observations.length" class="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">{{ t('anomalies.empty') }}</p>
    <div v-else class="mt-4 grid gap-4 xl:grid-cols-2">
      <details v-for="row in observations" :key="row.id" class="group rounded-2xl border border-slate-800 bg-slate-900 p-5" :open="row.severity === 'high'">
        <summary class="cursor-pointer list-none"><div class="flex items-start justify-between gap-3"><div><div class="flex flex-wrap gap-2"><span class="rounded-full bg-slate-800 px-2 py-1 text-[10px] font-black uppercase text-slate-300">{{ row.category }}</span><span class="rounded-full px-2 py-1 text-[10px] font-black uppercase" :class="row.severity === 'high' ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'">{{ row.severity }}</span></div><h3 class="mt-3 font-bold text-white">{{ localizedObservation(row, 'title') }}</h3><p class="mt-2 text-sm leading-6 text-slate-300">{{ localizedObservation(row, 'summary') }}</p></div><span class="text-slate-500 group-open:rotate-180">⌄</span></div></summary>
        <div class="mt-4 border-t border-slate-800 pt-4"><div class="grid grid-cols-2 gap-3 text-xs"><div><p class="text-slate-500">{{ t('anomalies.confidence') }}</p><p class="mt-1 font-bold text-white">{{ row.confidence }}%</p></div><div><p class="text-slate-500">{{ t('anomalies.observedAt') }}</p><p class="mt-1 text-white">{{ date(row.lastObservedAt) }}</p></div></div>
          <h4 class="mt-4 text-xs font-black uppercase tracking-wide text-slate-400">{{ t('anomalies.evidence') }}</h4><dl class="mt-2 grid gap-2 sm:grid-cols-2"><div v-for="(value, key) in row.evidence" :key="key" class="min-w-0 rounded-lg bg-slate-950 p-3"><dt class="break-all text-[10px] uppercase text-slate-500">{{ key }}</dt><dd class="mt-1 break-words text-xs text-slate-200">{{ evidenceValue(value) }}</dd></div></dl>
          <div v-if="row.status === 'observed' && canReview" class="mt-5 rounded-xl border border-slate-700 p-3"><p class="text-sm font-bold text-white">{{ t('anomalies.review') }}</p><div class="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"><textarea v-model="reviews[row.id].note" rows="2" class="os-input" :placeholder="t('anomalies.notePlaceholder')"/><select v-model="reviews[row.id].status" class="os-input sm:w-48"><option value="explained">{{ t('anomalies.explained') }}</option><option value="confirmed">{{ t('anomalies.confirmed') }}</option><option value="false_positive">{{ t('anomalies.falsePositive') }}</option></select></div><button class="mt-3 rounded-lg bg-farm-green px-3 py-2 text-xs font-bold text-slate-950" @click="saveReview(row)">{{ t('anomalies.saveReview') }}</button></div>
          <p v-else-if="row.reviewNote" class="mt-4 rounded-xl bg-slate-950 p-3 text-sm text-slate-300">{{ row.reviewNote }}</p>
        </div>
      </details>
    </div>
  </AppLayout>
</template>

<style scoped>.os-input{width:100%;border-radius:.75rem;border:1px solid rgb(51 65 85);background:rgb(2 6 23);padding:.7rem .8rem;font-size:.875rem;color:white}.os-input::placeholder{color:rgb(100 116 139)}</style>
