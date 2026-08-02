<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

const { t } = useI18n()

type TopQuestion = { question: string; normalized: string; count: number }
type ChannelCount = { channel: string; count: number }
type RecentInquiry = {
  id: string
  question: string
  channel: string
  answeredVia: string
  createdAt: string
}
type Insights = {
  summary: { total: number; unique: number; last7: number }
  topQuestions: TopQuestion[]
  byChannel: ChannelCount[]
  recent: RecentInquiry[]
}

const data = ref<Insights | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)

const maxCount = computed(() =>
  Math.max(1, ...(data.value?.topQuestions.map((q) => q.count) ?? [1])),
)

const answeredViaKeys: Record<string, string> = {
  catalog: 'insights.answeredVia.catalog',
  llm: 'insights.answeredVia.llm',
  faq: 'insights.answeredVia.faq',
  suggested: 'insights.answeredVia.suggested',
}

function answeredViaLabel(via: string): string {
  const key = answeredViaKeys[via]
  return key ? t(key) : via
}

function channelLabel(ch: string): string {
  if (ch === 'telegram') return t('insights.channel.telegram')
  if (ch === 'whatsapp') return t('insights.channel.whatsapp')
  return ch
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-NG', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function load() {
  loading.value = true
  error.value = null
  try {
    data.value = await api<Insights>('/api/customer-insights')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('insights.loadFailed')
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-black text-os-fg">{{ t('insights.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">
          {{ t('insights.subtitle') }}
        </p>
      </div>
      <button
        class="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-200 hover:bg-slate-700 flex-shrink-0"
        @click="load"
      >
        {{ t('insights.refresh') }}
      </button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-red-300">{{ error }}</p>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('insights.loading') }}</div>

    <template v-else-if="data">
      <!-- Summary tiles -->
      <div class="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p class="text-xs text-slate-500">{{ t('insights.totalQuestions') }}</p>
          <p class="text-2xl font-black text-os-fg">{{ data.summary.total }}</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p class="text-xs text-slate-500">{{ t('insights.uniqueQuestions') }}</p>
          <p class="text-2xl font-black text-os-fg">{{ data.summary.unique }}</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p class="text-xs text-slate-500">{{ t('insights.last7Days') }}</p>
          <p class="text-2xl font-black text-farm-green">{{ data.summary.last7 }}</p>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <p class="text-xs text-slate-500">{{ t('insights.byChannel') }}</p>
          <p class="text-sm font-semibold text-white mt-1">
            <span v-if="!data.byChannel.length" class="text-slate-500">-</span>
            <span v-for="ch in data.byChannel" :key="ch.channel" class="mr-2">
              {{ channelLabel(ch.channel) }}: {{ ch.count }}
            </span>
          </p>
        </div>
      </div>

      <!-- Most asked -->
      <div class="mt-8">
        <h3 class="font-bold text-white text-sm">{{ t('insights.mostAsked') }}</h3>
        <div
          v-if="!data.topQuestions.length"
          class="mt-3 text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-xl p-5"
        >
          {{ t('insights.noQuestionsYet') }}
        </div>
        <div v-else class="mt-3 space-y-2">
          <div
            v-for="(q, i) in data.topQuestions"
            :key="q.normalized"
            class="bg-slate-900 border border-slate-800 rounded-xl p-3"
          >
            <div class="flex items-center justify-between gap-3">
              <p class="text-sm text-slate-200 min-w-0 truncate">
                <span class="text-slate-500 mr-1">{{ i + 1 }}.</span>{{ q.question }}
              </p>
              <span class="text-xs font-semibold text-farm-green flex-shrink-0"
                >{{ q.count }}×</span
              >
            </div>
            <div class="mt-2 h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                class="h-full bg-farm-green/70 rounded-full"
                :style="{ width: `${(q.count / maxCount) * 100}%` }"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Recent -->
      <div class="mt-8">
        <h3 class="font-bold text-white text-sm">{{ t('insights.recentQuestions') }}</h3>
        <div
          v-if="!data.recent.length"
          class="mt-3 text-slate-500 text-sm bg-slate-900 border border-slate-800 rounded-xl p-5"
        >
          {{ t('insights.nothingYet') }}
        </div>
        <div v-else class="mt-3 space-y-2">
          <div
            v-for="r in data.recent"
            :key="r.id"
            class="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-start justify-between gap-3"
          >
            <div class="min-w-0">
              <p class="text-sm text-slate-200">{{ r.question }}</p>
              <p class="text-xs text-slate-500 mt-1">
                {{ channelLabel(r.channel) }} · {{ answeredViaLabel(r.answeredVia) }}
                · {{ formatDate(r.createdAt) }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </template>
  </AppLayout>
</template>
