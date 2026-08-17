<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import { api, resolveApiUrl } from '@/lib/api'

type FollowUp = 'yes' | 'maybe' | 'no'

type SurveyAnswer = {
  key: string
  label: string
  value: string
}

type SurveyResponse = {
  id: string
  surveyKey: string
  followUp: FollowUp
  name: string | null
  email: string | null
  phone: string | null
  source: string
  leadId: string | null
  createdAt: string
  answers: SurveyAnswer[]
}

type SurveysResponse = {
  responses: SurveyResponse[]
  page: number
  pageSize: number
  hasMore: boolean
  summary: {
    total: number
    byFollowUp: Record<FollowUp, number>
  }
}

const followUps: FollowUp[] = ['yes', 'maybe', 'no']
const { t, te, locale } = useI18n()
const responses = ref<SurveyResponse[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const search = ref('')
const followUpFilter = ref<'all' | FollowUp>('all')
const openId = ref<string | null>(null)
const page = ref(1)
const hasMore = ref(false)
const loadingMore = ref(false)
const exporting = ref(false)
let filterTimer: ReturnType<typeof setTimeout> | undefined

const summary = ref<Record<FollowUp, number>>({
  yes: 0,
  maybe: 0,
  no: 0,
})

function followUpLabel(value: FollowUp): string {
  return t(`customerSurveys.followUp${value[0]!.toUpperCase()}${value.slice(1)}`)
}

function answerLabel(answer: SurveyAnswer): string {
  const key = `customerSurveys.questions.${answer.key}`
  return te(key) ? t(key) : answer.label
}

function formatDate(value: string | null | undefined): string {
  if (!value) return t('customerSurveys.notAvailable')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('customerSurveys.notAvailable')
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function queryString(includePage = true): string {
  const params = new URLSearchParams()
  const term = search.value.trim()
  if (term) params.set('search', term)
  if (followUpFilter.value !== 'all') params.set('followUp', followUpFilter.value)
  if (includePage) {
    params.set('page', String(page.value))
    params.set('pageSize', '50')
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

async function load(reset = true) {
  if (reset) {
    loading.value = true
    page.value = 1
  } else {
    loadingMore.value = true
  }
  error.value = null
  try {
    const data = await api<SurveysResponse>(`/api/customer-surveys${queryString()}`)
    responses.value = reset ? data.responses : [...responses.value, ...data.responses]
    summary.value = data.summary.byFollowUp
    page.value = data.page
    hasMore.value = data.hasMore
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('customerSurveys.loadFailed')
  } finally {
    loading.value = false
    loadingMore.value = false
  }
}

async function loadMore() {
  if (!hasMore.value || loadingMore.value) return
  page.value += 1
  await load(false)
}

async function exportCsv() {
  exporting.value = true
  error.value = null
  try {
    const response = await fetch(
      resolveApiUrl(`/api/customer-surveys/export${queryString(false)}`),
      { credentials: 'include' },
    )
    if (!response.ok) throw new Error(t('customerSurveys.exportFailed'))
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `food-surveys-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('customerSurveys.exportFailed')
  } finally {
    exporting.value = false
  }
}

watch([search, followUpFilter], () => {
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => void load(), 300)
})

onMounted(() => void load())
onBeforeUnmount(() => {
  if (filterTimer) clearTimeout(filterTimer)
})
</script>

<template>
  <AppLayout>
    <div class="space-y-6">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="text-xs font-black uppercase tracking-[0.18em] text-os-gold">
            {{ t('customerSurveys.eyebrow') }}
          </p>
          <h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('customerSurveys.title') }}</h2>
          <p class="mt-1 max-w-2xl text-sm text-slate-400">{{ t('customerSurveys.subtitle') }}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="rounded-xl border border-white/10 px-4 py-2 text-sm font-bold text-slate-200" @click="load()">
            {{ t('customerSurveys.refresh') }}
          </button>
          <button
            type="button"
            class="rounded-xl bg-os-gold px-4 py-2 text-sm font-bold text-os-bg disabled:opacity-50"
            :disabled="exporting || summary.yes + summary.maybe + summary.no === 0"
            @click="exportCsv"
          >
            {{ exporting ? t('customerSurveys.exporting') : t('customerSurveys.exportCsv') }}
          </button>
        </div>
      </div>

      <div class="grid gap-3 sm:grid-cols-4" :aria-label="t('customerSurveys.summary')">
        <div class="rounded-2xl border border-white/10 bg-white/5 p-4">
          <p class="text-xs uppercase tracking-wider text-slate-500">{{ t('customerSurveys.total') }}</p>
          <p class="mt-1 text-2xl font-black text-os-fg">{{ summary.yes + summary.maybe + summary.no }}</p>
        </div>
        <div v-for="value in followUps" :key="value" class="rounded-2xl border border-white/10 bg-white/5 p-4">
          <p class="text-xs uppercase tracking-wider text-slate-500">{{ followUpLabel(value) }}</p>
          <p class="mt-1 text-2xl font-black text-os-fg">{{ summary[value] }}</p>
        </div>
      </div>

      <div class="grid gap-3 md:grid-cols-2">
        <label class="block text-sm">
          <span class="mb-1 block text-slate-400">{{ t('customerSurveys.search') }}</span>
          <input
            v-model="search"
            type="search"
            class="w-full rounded-xl border border-white/10 bg-os-bg px-3 py-2 text-sm text-os-fg"
            :placeholder="t('customerSurveys.searchPlaceholder')"
          />
        </label>
        <label class="block text-sm">
          <span class="mb-1 block text-slate-400">{{ t('customerSurveys.filterFollowUp') }}</span>
          <select v-model="followUpFilter" class="w-full rounded-xl border border-white/10 bg-os-bg px-3 py-2 text-sm text-os-fg">
            <option value="all">{{ t('customerSurveys.allFollowUp') }}</option>
            <option v-for="value in followUps" :key="value" :value="value">{{ followUpLabel(value) }}</option>
          </select>
        </label>
      </div>

      <p v-if="loading" class="text-sm text-slate-400">{{ t('customerSurveys.loading') }}</p>
      <div v-else-if="error" class="rounded-2xl border border-red-500/30 bg-red-500/10 p-4">
        <p class="text-sm text-red-200">{{ error }}</p>
        <button type="button" class="mt-3 text-sm font-bold text-os-gold" @click="load()">
          {{ t('customerSurveys.tryAgain') }}
        </button>
      </div>
      <p v-else-if="!responses.length" class="text-sm text-slate-400">
        {{ search || followUpFilter !== 'all' ? t('customerSurveys.noMatches') : t('customerSurveys.empty') }}
      </p>

      <div v-else class="space-y-3">
        <article
          v-for="row in responses"
          :key="row.id"
          class="rounded-2xl border border-white/10 bg-white/5 p-4"
        >
          <button
            type="button"
            class="flex w-full items-start justify-between gap-4 text-left"
            :aria-expanded="openId === row.id"
            :aria-controls="`survey-${row.id}`"
            @click="openId = openId === row.id ? null : row.id"
          >
            <div>
              <p class="font-bold text-os-fg">{{ row.name || t('customerSurveys.noContact') }}</p>
              <p class="mt-1 text-sm text-slate-400">
                <span v-if="row.email">{{ row.email }}</span>
                <span v-if="row.email && row.phone"> · </span>
                <span v-if="row.phone">{{ row.phone }}</span>
                <span v-if="!row.email && !row.phone">{{ t('customerSurveys.noContact') }}</span>
              </p>
            </div>
            <div class="text-right">
              <p class="text-xs font-bold uppercase tracking-wider text-os-gold">{{ followUpLabel(row.followUp) }}</p>
              <p class="mt-1 text-xs text-slate-500">{{ formatDate(row.createdAt) }}</p>
            </div>
          </button>
          <dl
            v-if="openId === row.id"
            :id="`survey-${row.id}`"
            class="mt-4 grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2"
          >
            <div v-for="answer in row.answers" :key="answer.key">
              <dt class="text-xs uppercase tracking-wider text-slate-500">{{ answerLabel(answer) }}</dt>
              <dd class="mt-1 text-sm text-slate-200">{{ answer.value }}</dd>
            </div>
            <div v-if="row.leadId" class="sm:col-span-2">
              <RouterLink
                :to="{ path: '/marketing-leads', query: { lead: row.leadId } }"
                class="inline-flex rounded-lg border border-farm-green/40 px-3 py-2 text-sm font-bold text-farm-green hover:bg-farm-green/10"
              >
                {{ t('customerSurveys.openLead') }}
              </RouterLink>
            </div>
          </dl>
        </article>
        <div v-if="hasMore" class="flex justify-center pt-2">
          <button
            type="button"
            class="rounded-xl border border-white/10 px-4 py-2 text-sm font-bold text-slate-200 disabled:opacity-50"
            :disabled="loadingMore"
            @click="loadMore"
          >
            {{ loadingMore ? t('customerSurveys.loadingMore') : t('customerSurveys.loadMore') }}
          </button>
        </div>
      </div>
    </div>
  </AppLayout>
</template>
