<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type SubscriberStatus = 'confirmed' | 'pending' | 'unsubscribed' | 'suppressed'
type SyncStatus = 'synced' | 'pending' | 'failed' | 'not_synced'

type NewsletterSubscriber = {
  id: string
  fullName: string
  email: string
  phone: string | null
  status: SubscriberStatus
  emailConsentAt: string
  confirmedAt: string | null
  emailConsentSource: string
  resendLastSyncStatus: SyncStatus | null
  resendLastSyncError: string | null
  resendLastSyncAt?: string | null
}

type NewsletterSummary = Record<SubscriberStatus, number>
type NewsletterResponse = {
  subscribers: NewsletterSubscriber[]
  summary: NewsletterSummary
}

const { t, locale } = useI18n()
const subscribers = ref<NewsletterSubscriber[]>([])
const summary = ref<NewsletterSummary>({
  confirmed: 0,
  pending: 0,
  unsubscribed: 0,
  suppressed: 0,
})
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const search = ref('')
const statusFilter = ref<'all' | SubscriberStatus>('all')
const activeAction = ref<string | null>(null)

const statuses: SubscriberStatus[] = ['confirmed', 'pending', 'unsubscribed', 'suppressed']

const filteredSubscribers = computed(() => {
  const term = search.value.trim().toLocaleLowerCase(locale.value)
  return subscribers.value.filter((subscriber) => {
    if (statusFilter.value !== 'all' && subscriber.status !== statusFilter.value) return false
    if (!term) return true
    return [
      subscriber.fullName,
      subscriber.email,
      subscriber.phone,
      subscriber.emailConsentSource,
    ]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase(locale.value).includes(term))
  })
})

function statusLabel(status: SubscriberStatus): string {
  return t(`newsletter.status.${status}`)
}

function syncLabel(status: SyncStatus | null): string {
  return t(`newsletter.sync.${status ?? 'not_synced'}`)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return t('newsletter.notAvailable')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('newsletter.notAvailable')
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function clearMessages() {
  error.value = null
  notice.value = null
}

async function loadSubscribers() {
  loading.value = true
  error.value = null
  try {
    const data = await api<NewsletterResponse>('/api/newsletter')
    subscribers.value = data.subscribers ?? []
    summary.value = {
      confirmed: data.summary?.confirmed ?? 0,
      pending: data.summary?.pending ?? 0,
      unsubscribed: data.summary?.unsubscribed ?? 0,
      suppressed: data.summary?.suppressed ?? 0,
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('newsletter.loadFailed')
  } finally {
    loading.value = false
  }
}

async function runAction(
  subscriber: NewsletterSubscriber,
  action: 'resend' | 'sync' | 'unsubscribe',
) {
  if (activeAction.value) return
  if (
    action === 'unsubscribe' &&
    !window.confirm(t('newsletter.unsubscribeConfirm', { email: subscriber.email }))
  ) {
    return
  }

  activeAction.value = `${subscriber.id}:${action}`
  clearMessages()
  try {
    if (action === 'resend') {
      await api(`/api/newsletter/${subscriber.id}/resend-confirmation`, { method: 'POST' })
    } else if (action === 'sync') {
      await api(`/api/newsletter/${subscriber.id}/sync`, { method: 'POST' })
    } else {
      await api(`/api/newsletter/${subscriber.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'unsubscribed' }),
      })
    }
    await loadSubscribers()
    notice.value = t(`newsletter.notice.${action}`)
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('newsletter.actionFailed')
  } finally {
    activeAction.value = null
  }
}

function actionBusy(subscriber: NewsletterSubscriber, action: string): boolean {
  return activeAction.value === `${subscriber.id}:${action}`
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}

function exportCsv() {
  const headers = [
    t('newsletter.name'),
    t('newsletter.email'),
    t('newsletter.phone'),
    t('newsletter.subscriberStatus'),
    t('newsletter.consentDate'),
    t('newsletter.confirmedDate'),
    t('newsletter.source'),
    t('newsletter.resendSync'),
    t('newsletter.syncError'),
  ]
  const rows = filteredSubscribers.value.map((subscriber) => [
    subscriber.fullName,
    subscriber.email,
    subscriber.phone ?? '',
    statusLabel(subscriber.status),
    subscriber.emailConsentAt,
    subscriber.confirmedAt ?? '',
    subscriber.emailConsentSource,
    syncLabel(subscriber.resendLastSyncStatus),
    subscriber.resendLastSyncError ?? '',
  ])
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

onMounted(loadSubscribers)
</script>

<template>
  <AppLayout>
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="text-xs font-bold uppercase tracking-[0.2em] text-farm-green">
          {{ t('newsletter.eyebrow') }}
        </p>
        <h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('newsletter.title') }}</h2>
        <p class="mt-1 max-w-2xl text-sm text-slate-400">{{ t('newsletter.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          :disabled="loading"
          @click="loadSubscribers"
        >
          {{ t('newsletter.refresh') }}
        </button>
        <button
          type="button"
          class="rounded-lg bg-farm-green px-3 py-2 text-sm font-bold text-slate-950 hover:bg-farm-green/90 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="loading || !filteredSubscribers.length"
          @click="exportCsv"
        >
          {{ t('newsletter.exportCsv') }}
        </button>
      </div>
    </header>

    <div aria-live="polite" class="mt-4 min-h-5">
      <p v-if="error" role="alert" class="text-sm text-red-300">{{ error }}</p>
      <p v-else-if="notice" class="text-sm text-farm-green">{{ notice }}</p>
    </div>

    <section :aria-label="t('newsletter.summary')" class="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div
        v-for="status in statuses"
        :key="status"
        class="rounded-xl border border-slate-800 bg-slate-900/80 p-4"
      >
        <p class="text-xs font-semibold text-slate-400">{{ statusLabel(status) }}</p>
        <p class="mt-1 text-2xl font-black text-os-fg">{{ summary[status] }}</p>
      </div>
    </section>

    <section class="mt-6 rounded-2xl border border-slate-800 bg-slate-900/80">
      <div class="flex flex-col gap-3 border-b border-slate-800 p-4 sm:flex-row sm:items-end">
        <label class="min-w-0 flex-1 text-sm font-semibold text-slate-300">
          {{ t('newsletter.search') }}
          <input
            v-model="search"
            type="search"
            :placeholder="t('newsletter.searchPlaceholder')"
            class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 focus:border-farm-green focus:outline-none"
          />
        </label>
        <label class="text-sm font-semibold text-slate-300 sm:w-56">
          {{ t('newsletter.filterStatus') }}
          <select
            v-model="statusFilter"
            class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none"
          >
            <option value="all">{{ t('newsletter.allStatuses') }}</option>
            <option v-for="status in statuses" :key="status" :value="status">
              {{ statusLabel(status) }}
            </option>
          </select>
        </label>
      </div>

      <p v-if="loading" class="p-8 text-center text-sm text-slate-400" role="status">
        {{ t('newsletter.loading') }}
      </p>
      <div v-else-if="error && !subscribers.length" class="p-8 text-center">
        <p class="text-sm text-slate-400">{{ t('newsletter.loadFailed') }}</p>
        <button type="button" class="mt-3 text-sm font-semibold text-farm-green hover:underline" @click="loadSubscribers">
          {{ t('newsletter.tryAgain') }}
        </button>
      </div>
      <p v-else-if="!filteredSubscribers.length" class="p-8 text-center text-sm text-slate-500">
        {{ subscribers.length ? t('newsletter.noMatches') : t('newsletter.empty') }}
      </p>

      <div v-else class="divide-y divide-slate-800">
        <article
          v-for="subscriber in filteredSubscribers"
          :key="subscriber.id"
          class="p-4 sm:p-5"
        >
          <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="font-bold text-white">{{ subscriber.fullName }}</h3>
                <span
                  class="rounded-full px-2 py-0.5 text-[11px] font-bold"
                  :class="{
                    'bg-emerald-500/15 text-emerald-300': subscriber.status === 'confirmed',
                    'bg-amber-500/15 text-amber-300': subscriber.status === 'pending',
                    'bg-slate-500/15 text-slate-300': subscriber.status === 'unsubscribed',
                    'bg-red-500/15 text-red-300': subscriber.status === 'suppressed',
                  }"
                >
                  {{ statusLabel(subscriber.status) }}
                </span>
              </div>
              <a class="mt-1 block break-all text-sm text-farm-green hover:underline" :href="`mailto:${subscriber.email}`">
                {{ subscriber.email }}
              </a>
              <a v-if="subscriber.phone" class="mt-1 block text-sm text-slate-300 hover:text-white" :href="`tel:${subscriber.phone}`">
                {{ subscriber.phone }}
              </a>
            </div>

            <div class="flex flex-wrap gap-2 xl:max-w-xl xl:justify-end">
              <button
                v-if="subscriber.status === 'pending'"
                type="button"
                class="rounded-lg border border-amber-500/40 px-3 py-2 text-xs font-bold text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
                :disabled="Boolean(activeAction)"
                @click="runAction(subscriber, 'resend')"
              >
                {{ actionBusy(subscriber, 'resend') ? t('newsletter.working') : t('newsletter.resendConfirmation') }}
              </button>
              <button
                v-if="subscriber.resendLastSyncStatus === 'failed'"
                type="button"
                class="rounded-lg border border-sky-500/40 px-3 py-2 text-xs font-bold text-sky-300 hover:bg-sky-500/10 disabled:opacity-50"
                :disabled="Boolean(activeAction)"
                @click="runAction(subscriber, 'sync')"
              >
                {{ actionBusy(subscriber, 'sync') ? t('newsletter.working') : t('newsletter.retrySync') }}
              </button>
              <button
                v-if="subscriber.status === 'confirmed' || subscriber.status === 'pending'"
                type="button"
                class="rounded-lg border border-red-500/40 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                :disabled="Boolean(activeAction)"
                @click="runAction(subscriber, 'unsubscribe')"
              >
                {{ actionBusy(subscriber, 'unsubscribe') ? t('newsletter.working') : t('newsletter.unsubscribe') }}
              </button>
            </div>
          </div>

          <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt class="text-slate-500">{{ t('newsletter.consentDate') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ formatDate(subscriber.emailConsentAt) }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('newsletter.confirmedDate') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ formatDate(subscriber.confirmedAt) }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('newsletter.source') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ subscriber.emailConsentSource }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('newsletter.resendSync') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ syncLabel(subscriber.resendLastSyncStatus) }}</dd>
            </div>
          </dl>
          <p
            v-if="subscriber.resendLastSyncError"
            class="mt-3 break-words rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300"
          >
            <span class="font-bold">{{ t('newsletter.syncError') }}:</span>
            {{ subscriber.resendLastSyncError }}
          </p>
        </article>
      </div>
    </section>
  </AppLayout>
</template>
