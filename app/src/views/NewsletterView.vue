<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
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

type CreditSummary = {
  eligible: number
  invitationsSent: number
  invitationsClaimed: number
  accountsCredited: number
}

type CampaignAudience = 'newsletter' | 'product_waitlist'
type CampaignStatus = 'draft' | 'sending' | 'sent' | 'partial' | 'failed'
type NewsletterCampaign = {
  id: string
  campaignType: 'journal' | 'marketing' | 'product_availability'
  audienceType: CampaignAudience
  productKey: string | null
  subject: string
  status: CampaignStatus
  recipientCount: number
  deliveredCount: number
  failedCount: number
  lastError: string | null
  providerBroadcastId: string | null
  providerStatus: string | null
  sentAt: string | null
  createdAt: string
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
const campaigns = ref<NewsletterCampaign[]>([])
const campaignSending = ref(false)
const creditSummary = ref<CreditSummary | null>(null)
const creditsLoading = ref(false)
const creditsSending = ref(false)
const singleCreditEmail = ref('')
const singleCreditSending = ref(false)
const audienceLoading = ref(false)
const audienceCount = ref(0)
const campaignForm = reactive({
  audienceType: 'newsletter' as CampaignAudience,
  productKey: 'plantain',
  subject: '',
  previewText: '',
  bodyText: '',
  ctaLabel: '',
  ctaUrl: '',
})

const products = [
  { key: 'plantain', label: 'Plantain' },
  { key: 'coconut', label: 'Coconut' },
  { key: 'poultry', label: 'Pasture-raised Chicken' },
  { key: 'eggs', label: 'Pasture-raised Eggs' },
  { key: 'palm-oil', label: 'Palm Oil' },
]

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

function pendingDeliveryCount(campaign: NewsletterCampaign): number {
  return Math.max(0, campaign.recipientCount - campaign.deliveredCount - campaign.failedCount)
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

async function loadCampaigns() {
  try {
    const data = await api<{ campaigns: NewsletterCampaign[] }>('/api/newsletter-campaigns')
    campaigns.value = data.campaigns ?? []
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('newsletter.campaignLoadFailed')
  }
}

async function loadAudienceCount() {
  audienceLoading.value = true
  try {
    const params = new URLSearchParams({ audienceType: campaignForm.audienceType })
    if (campaignForm.audienceType === 'product_waitlist') params.set('productKey', campaignForm.productKey)
    const data = await api<{ recipientCount: number }>(`/api/newsletter-campaigns/audience?${params}`)
    audienceCount.value = data.recipientCount ?? 0
  } catch {
    audienceCount.value = 0
  } finally {
    audienceLoading.value = false
  }
}

async function loadCreditSummary() {
  creditsLoading.value = true
  try {
    const data = await api<{ summary: CreditSummary }>('/api/customer-credits/summary')
    creditSummary.value = data.summary
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('newsletter.creditsLoadFailed')
  } finally {
    creditsLoading.value = false
  }
}

async function sendCreditInvitations() {
  if (creditsSending.value || !creditSummary.value?.eligible) return
  if (!window.confirm(t('newsletter.creditsSendConfirm', { count: creditSummary.value.eligible }))) return
  creditsSending.value = true
  clearMessages()
  try {
    const data = await api<{
      result: { invitationsSent: number; accountsCredited: number; alreadyProcessed: number; failed: number }
      summary: CreditSummary
    }>('/api/customer-credits/invitations/send', {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    })
    creditSummary.value = data.summary
    notice.value = t('newsletter.creditsSent', {
      sent: data.result.invitationsSent,
      credited: data.result.accountsCredited,
      skipped: data.result.alreadyProcessed,
      failed: data.result.failed,
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('newsletter.creditsSendFailed')
  } finally {
    creditsSending.value = false
  }
}

async function sendSingleCreditInvitation() {
  const email = singleCreditEmail.value.trim().toLowerCase()
  if (singleCreditSending.value || !email) return
  if (!window.confirm(t('newsletter.creditsSingleConfirm', { email }))) return
  singleCreditSending.value = true
  clearMessages()
  try {
    const data = await api<{
      result: { invitationsSent: number; accountsCredited: number; alreadyProcessed: number; failed: number }
      summary: CreditSummary
    }>('/api/customer-credits/invitations/send-one', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, email }),
    })
    creditSummary.value = data.summary
    notice.value = t('newsletter.creditsSent', {
      sent: data.result.invitationsSent,
      credited: data.result.accountsCredited,
      skipped: data.result.alreadyProcessed,
      failed: data.result.failed,
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('newsletter.creditsSendFailed')
  } finally {
    singleCreditSending.value = false
  }
}

async function sendCampaign() {
  if (campaignSending.value || !campaignForm.subject.trim() || !campaignForm.bodyText.trim()) return
  if (!audienceCount.value) {
    error.value = t('newsletter.noCampaignRecipients')
    return
  }
  const audienceLabel = campaignForm.audienceType === 'newsletter'
    ? t('newsletter.confirmedAudience')
    : products.find((product) => product.key === campaignForm.productKey)?.label ?? campaignForm.productKey
  if (!window.confirm(t('newsletter.sendCampaignConfirm', { count: audienceCount.value, audience: audienceLabel }))) return

  campaignSending.value = true
  clearMessages()
  try {
    await api('/api/newsletter-campaigns', {
      method: 'POST',
      body: JSON.stringify({
        audienceType: campaignForm.audienceType,
        ...(campaignForm.audienceType === 'product_waitlist' ? { productKey: campaignForm.productKey } : {}),
        subject: campaignForm.subject.trim(),
        ...(campaignForm.previewText.trim() ? { previewText: campaignForm.previewText.trim() } : {}),
        bodyText: campaignForm.bodyText.trim(),
        ...(campaignForm.ctaLabel.trim() && campaignForm.ctaUrl.trim()
          ? { ctaLabel: campaignForm.ctaLabel.trim(), ctaUrl: campaignForm.ctaUrl.trim() }
          : {}),
      }),
    })
    Object.assign(campaignForm, {
      subject: '',
      previewText: '',
      bodyText: '',
      ctaLabel: '',
      ctaUrl: '',
    })
    notice.value = t('newsletter.campaignSent', { count: audienceCount.value })
    await Promise.all([loadCampaigns(), loadSubscribers(), loadAudienceCount()])
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('newsletter.campaignSendFailed')
    await loadCampaigns()
  } finally {
    campaignSending.value = false
  }
}

async function retryCampaign(campaign: NewsletterCampaign) {
  if (campaignSending.value || !window.confirm(t('newsletter.retryCampaignConfirm'))) return
  campaignSending.value = true
  clearMessages()
  try {
    await api(`/api/newsletter-campaigns/${campaign.id}/send`, { method: 'POST' })
    notice.value = t('newsletter.campaignRetried')
    await loadCampaigns()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('newsletter.campaignSendFailed')
    await loadCampaigns()
  } finally {
    campaignSending.value = false
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

watch(
  () => [campaignForm.audienceType, campaignForm.productKey],
  () => void loadAudienceCount(),
)

onMounted(() => Promise.all([loadSubscribers(), loadCampaigns(), loadAudienceCount(), loadCreditSummary()]))
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

    <details class="group mt-6 rounded-2xl border border-farm-green/25 bg-slate-900/80" open>
      <summary class="flex cursor-pointer list-none items-center justify-between gap-4 p-4 sm:p-6">
        <div>
          <p class="text-xs font-black uppercase tracking-[0.18em] text-farm-green">{{ t('newsletter.creditsEyebrow') }}</p>
          <h3 class="mt-1 text-lg font-black text-white">{{ t('newsletter.creditsTitle') }}</h3>
          <p class="mt-1 max-w-3xl text-sm text-slate-400">{{ t('newsletter.creditsSubtitle') }}</p>
        </div>
        <span aria-hidden="true" class="shrink-0 text-xl text-slate-400 group-open:rotate-180">⌄</span>
      </summary>
      <div class="border-t border-slate-800 p-4 sm:p-6">
        <p v-if="creditsLoading" class="text-sm text-slate-400">{{ t('newsletter.creditsLoading') }}</p>
        <template v-else-if="creditSummary">
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div class="rounded-xl bg-slate-950 p-4">
              <p class="text-xs text-slate-500">{{ t('newsletter.creditsEligible') }}</p>
              <p class="mt-1 text-2xl font-black text-white">{{ creditSummary.eligible }}</p>
            </div>
            <div class="rounded-xl bg-slate-950 p-4">
              <p class="text-xs text-slate-500">{{ t('newsletter.creditsInvited') }}</p>
              <p class="mt-1 text-2xl font-black text-white">{{ creditSummary.invitationsSent }}</p>
            </div>
            <div class="rounded-xl bg-slate-950 p-4">
              <p class="text-xs text-slate-500">{{ t('newsletter.creditsClaimed') }}</p>
              <p class="mt-1 text-2xl font-black text-white">{{ creditSummary.invitationsClaimed }}</p>
            </div>
            <div class="rounded-xl bg-slate-950 p-4">
              <p class="text-xs text-slate-500">{{ t('newsletter.creditsAccounts') }}</p>
              <p class="mt-1 text-2xl font-black text-white">{{ creditSummary.accountsCredited }}</p>
            </div>
          </div>
          <p class="mt-4 text-xs leading-5 text-slate-500">{{ t('newsletter.creditsSafety') }}</p>
          <form class="mt-4 rounded-xl border border-farm-green/25 bg-slate-950/70 p-4" @submit.prevent="sendSingleCreditInvitation">
            <label class="block text-sm font-bold text-slate-200">
              {{ t('newsletter.creditsSingleLabel') }}
              <input
                v-model="singleCreditEmail"
                type="email"
                autocomplete="off"
                required
                :placeholder="t('newsletter.creditsSinglePlaceholder')"
                class="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 focus:border-farm-green focus:outline-none"
              />
            </label>
            <p class="mt-2 text-xs leading-5 text-slate-500">{{ t('newsletter.creditsSingleHint') }}</p>
            <button
              type="submit"
              class="mt-3 rounded-lg border border-farm-green/50 px-4 py-2.5 text-sm font-black text-farm-green disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="singleCreditSending || !singleCreditEmail.trim()"
            >
              {{ singleCreditSending ? t('newsletter.creditsSending') : t('newsletter.creditsSingleSend') }}
            </button>
          </form>
          <p class="mt-5 text-xs font-black uppercase tracking-[0.16em] text-slate-500">{{ t('newsletter.creditsBulkLabel') }}</p>
          <button type="button" class="mt-4 rounded-lg bg-farm-green px-4 py-2.5 text-sm font-black text-slate-950 disabled:opacity-50" :disabled="creditsSending || !creditSummary.eligible" @click="sendCreditInvitations">
            {{ creditsSending ? t('newsletter.creditsSending') : t('newsletter.creditsSend') }}
          </button>
        </template>
      </div>
    </details>

    <section class="mt-6 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 sm:p-6">
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 class="text-lg font-black text-white">{{ t('newsletter.campaignTitle') }}</h3>
          <p class="mt-1 max-w-3xl text-sm text-slate-400">{{ t('newsletter.campaignSubtitle') }}</p>
        </div>
        <p class="rounded-full border border-farm-green/30 bg-farm-green/10 px-3 py-1.5 text-xs font-bold text-farm-green">
          {{ audienceLoading ? t('newsletter.countingAudience') : t('newsletter.recipientCount', { count: audienceCount }) }}
        </p>
      </div>

      <form class="mt-5 grid gap-4" @submit.prevent="sendCampaign">
        <div class="grid gap-4 md:grid-cols-2">
          <label class="text-sm font-semibold text-slate-300">
            {{ t('newsletter.audience') }}
            <select v-model="campaignForm.audienceType" class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none">
              <option value="newsletter">{{ t('newsletter.confirmedAudience') }}</option>
              <option value="product_waitlist">{{ t('newsletter.productAudience') }}</option>
            </select>
          </label>
          <label v-if="campaignForm.audienceType === 'product_waitlist'" class="text-sm font-semibold text-slate-300">
            {{ t('newsletter.product') }}
            <select v-model="campaignForm.productKey" class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none">
              <option v-for="product in products" :key="product.key" :value="product.key">{{ product.label }}</option>
            </select>
          </label>
          <label class="text-sm font-semibold text-slate-300" :class="campaignForm.audienceType !== 'product_waitlist' ? 'md:col-start-2' : ''">
            {{ t('newsletter.emailSubject') }}
            <input v-model="campaignForm.subject" required maxlength="200" class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 focus:border-farm-green focus:outline-none" :placeholder="t('newsletter.emailSubjectPlaceholder')" />
          </label>
        </div>
        <label class="text-sm font-semibold text-slate-300">
          {{ t('newsletter.previewText') }}
          <input v-model="campaignForm.previewText" maxlength="240" class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 focus:border-farm-green focus:outline-none" :placeholder="t('newsletter.previewTextPlaceholder')" />
        </label>
        <label class="text-sm font-semibold text-slate-300">
          {{ t('newsletter.message') }}
          <textarea v-model="campaignForm.bodyText" required maxlength="10000" rows="6" class="mt-1.5 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 focus:border-farm-green focus:outline-none" :placeholder="t('newsletter.messagePlaceholder')" />
        </label>
        <div class="grid gap-4 md:grid-cols-2">
          <label class="text-sm font-semibold text-slate-300">
            {{ t('newsletter.ctaLabel') }}
            <input v-model="campaignForm.ctaLabel" maxlength="80" class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 focus:border-farm-green focus:outline-none" :placeholder="t('newsletter.ctaLabelPlaceholder')" />
          </label>
          <label class="text-sm font-semibold text-slate-300">
            {{ t('newsletter.ctaUrl') }}
            <input v-model="campaignForm.ctaUrl" type="url" maxlength="1000" class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 focus:border-farm-green focus:outline-none" placeholder="https://trovara.farm/..." />
          </label>
        </div>
        <p class="text-xs text-slate-500">{{ t('newsletter.sendSafetyNote') }}</p>
        <div>
          <button type="submit" class="rounded-lg bg-farm-green px-4 py-2.5 text-sm font-black text-slate-950 hover:bg-farm-green/90 disabled:cursor-not-allowed disabled:opacity-50" :disabled="campaignSending || audienceLoading || !audienceCount">
            {{ campaignSending ? t('newsletter.sendingCampaign') : t('newsletter.sendCampaign') }}
          </button>
        </div>
      </form>
    </section>

    <section v-if="campaigns.length" class="mt-6 rounded-2xl border border-slate-800 bg-slate-900/80">
      <div class="border-b border-slate-800 p-4 sm:p-5">
        <h3 class="font-black text-white">{{ t('newsletter.recentCampaigns') }}</h3>
      </div>
      <div class="divide-y divide-slate-800">
        <article v-for="campaign in campaigns.slice(0, 12)" :key="campaign.id" class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <p class="truncate font-bold text-white">{{ campaign.subject }}</p>
              <span class="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-bold text-slate-300">{{ campaign.status }}</span>
            </div>
            <template v-if="campaign.providerBroadcastId">
              <p class="mt-1 text-xs text-slate-400">
                {{ t('newsletter.broadcastAccepted', { total: campaign.recipientCount }) }} ·
                {{ t('newsletter.providerStatus', { status: campaign.providerStatus || campaign.status }) }} ·
                {{ formatDate(campaign.sentAt || campaign.createdAt) }}
              </p>
              <p class="mt-1 text-xs text-slate-400">
                {{ t('newsletter.broadcastDelivery', {
                  delivered: campaign.deliveredCount,
                  total: campaign.recipientCount,
                  pending: pendingDeliveryCount(campaign),
                  failed: campaign.failedCount,
                }) }}
              </p>
            </template>
            <p v-else class="mt-1 text-xs text-slate-400">
              {{ t('newsletter.campaignResult', { sent: campaign.deliveredCount, total: campaign.recipientCount, failed: campaign.failedCount }) }} · {{ formatDate(campaign.sentAt || campaign.createdAt) }}
            </p>
            <p v-if="campaign.lastError" class="mt-1 text-xs text-red-300">{{ campaign.lastError }}</p>
          </div>
          <button v-if="campaign.status === 'failed' || campaign.status === 'partial'" type="button" class="rounded-lg border border-amber-500/40 px-3 py-2 text-xs font-bold text-amber-300 hover:bg-amber-500/10 disabled:opacity-50" :disabled="campaignSending" @click="retryCampaign(campaign)">
            {{ t('newsletter.retryCampaign') }}
          </button>
        </article>
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
