<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type LeadType = 'contact' | 'product_waitlist' | 'survey_followup'
type LeadStatus = 'new' | 'in_progress' | 'contacted' | 'closed' | 'spam'

type MarketingLead = {
  id: string
  leadType: LeadType
  status: LeadStatus
  name: string
  email?: string | null
  phone?: string | null
  subjectKey?: string | null
  subjectLabel?: string | null
  message?: string | null
  productKey?: string | null
  productLabel?: string | null
  source: string
  submissionCount: number
  lastSubmittedAt: string
  assignedToId?: string | null
  assignedToName?: string | null
  notificationStatus?: string | null
  notificationError?: string | null
  notificationAt?: string | null
  createdAt: string
  updatedAt: string
}

type AssignmentUser = {
  id: string
  name: string
  role: 'owner' | 'supervisor' | 'field_worker' | 'sales'
  active: boolean
}

type LeadsResponse = {
  leads: MarketingLead[]
  assignees: AssignmentUser[]
  summary: {
    total: number
    byStatus: Record<LeadStatus, number>
    byType: Record<LeadType, number>
  }
}

const statuses: LeadStatus[] = ['new', 'in_progress', 'contacted', 'closed', 'spam']
const types: LeadType[] = ['contact', 'product_waitlist', 'survey_followup']
const statusSequence: LeadStatus[] = ['new', 'in_progress', 'contacted', 'closed']

const { t, locale, te } = useI18n()
const route = useRoute()
const leads = ref<MarketingLead[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const search = ref('')
const typeFilter = ref<'all' | LeadType>('all')
const statusFilter = ref<'all' | LeadStatus>('all')
const activeAction = ref<string | null>(null)
const assignmentUsers = ref<AssignmentUser[]>([])
const assignmentAvailable = ref(false)

async function revealLinkedLead() {
  const leadId = typeof route.query.lead === 'string' ? route.query.lead : ''
  if (!leadId || !leads.value.some((lead) => lead.id === leadId)) return
  typeFilter.value = 'all'
  statusFilter.value = 'all'
  search.value = ''
  await nextTick()
  document.getElementById(`lead-${leadId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  document.getElementById(`lead-${leadId}`)?.focus({ preventScroll: true })
}

const summary = ref<Record<LeadStatus, number>>({
  new: 0,
  in_progress: 0,
  contacted: 0,
  closed: 0,
  spam: 0,
})

const filteredLeads = computed(() => {
  const term = search.value.trim().toLocaleLowerCase(locale.value)
  return leads.value.filter((lead) => {
    if (typeFilter.value !== 'all' && lead.leadType !== typeFilter.value) return false
    if (statusFilter.value !== 'all' && lead.status !== statusFilter.value) return false
    if (!term) return true
    return [
      lead.name,
      lead.email,
      lead.phone,
      lead.subjectLabel,
      lead.subjectKey,
      lead.productLabel,
      lead.productKey,
      lead.message,
      lead.source,
      lead.assignedToName,
    ]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase(locale.value).includes(term))
  })
})

function statusLabel(status: LeadStatus): string {
  return t(`marketingLeads.status.${status}`)
}

function typeLabel(type: LeadType): string {
  return t(`marketingLeads.type.${type}`)
}

function notificationLabel(status: string | null | undefined): string {
  if (!status) return t('marketingLeads.notification.notSent')
  const key = `marketingLeads.notification.${status}`
  return te(key) ? t(key) : status.replaceAll('_', ' ')
}

function formatDate(value: string | null | undefined): string {
  if (!value) return t('marketingLeads.notAvailable')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('marketingLeads.notAvailable')
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function detailLabel(lead: MarketingLead): string {
  if (lead.leadType === 'product_waitlist') {
    return lead.productLabel || lead.productKey || t('marketingLeads.notAvailable')
  }
  return lead.subjectLabel || lead.subjectKey || t('marketingLeads.notAvailable')
}

function nextStatus(lead: MarketingLead): LeadStatus | null {
  const index = statusSequence.indexOf(lead.status)
  return index >= 0 && index < statusSequence.length - 1 ? statusSequence[index + 1] : null
}

async function loadLeads() {
  loading.value = true
  error.value = null
  try {
    const data = await api<LeadsResponse>('/api/marketing-leads')
    leads.value = data.leads ?? []
    summary.value = {
      new: data.summary?.byStatus?.new ?? 0,
      in_progress: data.summary?.byStatus?.in_progress ?? 0,
      contacted: data.summary?.byStatus?.contacted ?? 0,
      closed: data.summary?.byStatus?.closed ?? 0,
      spam: data.summary?.byStatus?.spam ?? 0,
    }
    assignmentUsers.value = data.assignees ?? []
    assignmentAvailable.value = assignmentUsers.value.length > 0
    await revealLinkedLead()
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('marketingLeads.loadFailed')
  } finally {
    loading.value = false
  }
}

async function refresh() {
  notice.value = null
  await loadLeads()
}

async function updateLead(
  lead: MarketingLead,
  payload: { status?: LeadStatus; assignedToId?: string },
  action: string,
) {
  if (activeAction.value) return
  activeAction.value = `${lead.id}:${action}`
  error.value = null
  notice.value = null
  try {
    await api(`/api/marketing-leads/${lead.id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    })
    await loadLeads()
    notice.value = t('marketingLeads.updated')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('marketingLeads.actionFailed')
  } finally {
    activeAction.value = null
  }
}

async function retryNotification(lead: MarketingLead) {
  if (activeAction.value) return
  activeAction.value = `${lead.id}:notify`
  error.value = null
  notice.value = null
  try {
    await api(`/api/marketing-leads/${lead.id}/notify`, { method: 'POST' })
    await loadLeads()
    notice.value = t('marketingLeads.notificationRetried')
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('marketingLeads.actionFailed')
  } finally {
    activeAction.value = null
  }
}

function actionBusy(lead: MarketingLead, action: string): boolean {
  return activeAction.value === `${lead.id}:${action}`
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value)
  // Prevent spreadsheet formula execution while retaining the displayed value.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function exportCsv() {
  const headers = [
    t('marketingLeads.name'),
    t('marketingLeads.typeLabel'),
    t('marketingLeads.statusLabel'),
    t('marketingLeads.email'),
    t('marketingLeads.phone'),
    t('marketingLeads.subjectProduct'),
    t('marketingLeads.message'),
    t('marketingLeads.repeatCount'),
    t('marketingLeads.source'),
    t('marketingLeads.lastSubmitted'),
    t('marketingLeads.assignedTo'),
    t('marketingLeads.notificationState'),
    t('marketingLeads.notificationError'),
    t('marketingLeads.notificationAt'),
    t('marketingLeads.createdAt'),
    t('marketingLeads.updatedAt'),
  ]
  const rows = filteredLeads.value.map((lead) => [
    lead.name,
    typeLabel(lead.leadType),
    statusLabel(lead.status),
    lead.email ?? '',
    lead.phone ?? '',
    detailLabel(lead),
    lead.message ?? '',
    lead.submissionCount,
    lead.source,
    lead.lastSubmittedAt,
    lead.assignedToName ?? '',
    notificationLabel(lead.notificationStatus),
    lead.notificationError ?? '',
    lead.notificationAt ?? '',
    lead.createdAt,
    lead.updatedAt,
  ])
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `marketing-leads-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

watch(() => route.query.lead, () => void revealLinkedLead())
onMounted(refresh)
</script>

<template>
  <AppLayout>
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="text-xs font-bold uppercase tracking-[0.2em] text-farm-green">
          {{ t('marketingLeads.eyebrow') }}
        </p>
        <h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('marketingLeads.title') }}</h2>
        <p class="mt-1 max-w-2xl text-sm text-slate-400">{{ t('marketingLeads.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          :disabled="loading"
          @click="refresh"
        >
          {{ t('marketingLeads.refresh') }}
        </button>
        <button
          type="button"
          class="rounded-lg bg-farm-green px-3 py-2 text-sm font-bold text-slate-950 hover:bg-farm-green/90 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="loading || !filteredLeads.length"
          @click="exportCsv"
        >
          {{ t('marketingLeads.exportCsv') }}
        </button>
      </div>
    </header>

    <div aria-live="polite" class="mt-4 min-h-5">
      <p v-if="error" role="alert" class="text-sm text-red-300">{{ error }}</p>
      <p v-else-if="notice" class="text-sm text-farm-green">{{ notice }}</p>
    </div>

    <section
      :aria-label="t('marketingLeads.summary')"
      class="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-5"
    >
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
      <div class="grid gap-3 border-b border-slate-800 p-4 md:grid-cols-[minmax(0,1fr)_13rem_13rem] md:items-end">
        <label class="min-w-0 text-sm font-semibold text-slate-300">
          {{ t('marketingLeads.search') }}
          <input
            v-model="search"
            type="search"
            :placeholder="t('marketingLeads.searchPlaceholder')"
            class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white placeholder:text-slate-600 focus:border-farm-green focus:outline-none"
          />
        </label>
        <label class="text-sm font-semibold text-slate-300">
          {{ t('marketingLeads.filterType') }}
          <select
            v-model="typeFilter"
            class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none"
          >
            <option value="all">{{ t('marketingLeads.allTypes') }}</option>
            <option v-for="type in types" :key="type" :value="type">{{ typeLabel(type) }}</option>
          </select>
        </label>
        <label class="text-sm font-semibold text-slate-300">
          {{ t('marketingLeads.filterStatus') }}
          <select
            v-model="statusFilter"
            class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-white focus:border-farm-green focus:outline-none"
          >
            <option value="all">{{ t('marketingLeads.allStatuses') }}</option>
            <option v-for="status in statuses" :key="status" :value="status">
              {{ statusLabel(status) }}
            </option>
          </select>
        </label>
      </div>

      <p v-if="loading" class="p-8 text-center text-sm text-slate-400" role="status">
        {{ t('marketingLeads.loading') }}
      </p>
      <div v-else-if="error && !leads.length" class="p-8 text-center">
        <p class="text-sm text-slate-400">{{ t('marketingLeads.loadFailed') }}</p>
        <button type="button" class="mt-3 text-sm font-semibold text-farm-green hover:underline" @click="refresh">
          {{ t('marketingLeads.tryAgain') }}
        </button>
      </div>
      <p v-else-if="!filteredLeads.length" class="p-8 text-center text-sm text-slate-500">
        {{ leads.length ? t('marketingLeads.noMatches') : t('marketingLeads.empty') }}
      </p>

      <div v-else class="divide-y divide-slate-800">
        <article
          v-for="lead in filteredLeads"
          :id="`lead-${lead.id}`"
          :key="lead.id"
          tabindex="-1"
          class="p-4 outline-none transition focus:bg-farm-green/5 focus:ring-2 focus:ring-inset focus:ring-farm-green/60 sm:p-5"
        >
          <div class="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-base font-bold text-white">{{ lead.name }}</h3>
                <span class="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-bold text-sky-300">
                  {{ typeLabel(lead.leadType) }}
                </span>
                <span
                  class="rounded-full px-2 py-0.5 text-[11px] font-bold"
                  :class="{
                    'bg-emerald-500/15 text-emerald-300': lead.status === 'new',
                    'bg-sky-500/15 text-sky-300': lead.status === 'in_progress',
                    'bg-amber-500/15 text-amber-300': lead.status === 'contacted',
                    'bg-slate-500/15 text-slate-300': lead.status === 'closed',
                    'bg-red-500/15 text-red-300': lead.status === 'spam',
                  }"
                >
                  {{ statusLabel(lead.status) }}
                </span>
                <span v-if="lead.submissionCount > 1" class="rounded-full bg-violet-500/15 px-2 py-0.5 text-[11px] font-bold text-violet-300">
                  {{ t('marketingLeads.repeated', { count: lead.submissionCount }) }}
                </span>
              </div>
              <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <a v-if="lead.email" class="break-all text-farm-green hover:underline" :href="`mailto:${lead.email}`">
                  {{ lead.email }}
                </a>
                <a v-if="lead.phone" class="text-slate-300 hover:text-white" :href="`tel:${lead.phone}`">
                  {{ lead.phone }}
                </a>
                <span v-if="!lead.email && !lead.phone" class="text-slate-500">{{ t('marketingLeads.noContact') }}</span>
              </div>
            </div>

            <div class="flex flex-wrap gap-2 xl:max-w-2xl xl:justify-end">
              <button
                v-if="nextStatus(lead)"
                type="button"
                class="rounded-lg border border-farm-green/40 px-3 py-2 text-xs font-bold text-farm-green hover:bg-farm-green/10 disabled:opacity-50"
                :disabled="Boolean(activeAction)"
                @click="updateLead(lead, { status: nextStatus(lead)! }, `status-${nextStatus(lead)}`)"
              >
                {{ actionBusy(lead, `status-${nextStatus(lead)}`) ? t('marketingLeads.working') : t('marketingLeads.moveTo', { status: statusLabel(nextStatus(lead)!) }) }}
              </button>
              <button
                v-if="lead.status === 'closed' || lead.status === 'spam'"
                type="button"
                class="rounded-lg border border-sky-500/40 px-3 py-2 text-xs font-bold text-sky-300 hover:bg-sky-500/10 disabled:opacity-50"
                :disabled="Boolean(activeAction)"
                @click="updateLead(lead, { status: 'new' }, 'reopen')"
              >
                {{ actionBusy(lead, 'reopen') ? t('marketingLeads.working') : t('marketingLeads.reopen') }}
              </button>
              <button
                v-if="lead.status !== 'spam'"
                type="button"
                class="rounded-lg border border-red-500/40 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                :disabled="Boolean(activeAction)"
                @click="updateLead(lead, { status: 'spam' }, 'spam')"
              >
                {{ actionBusy(lead, 'spam') ? t('marketingLeads.working') : t('marketingLeads.markSpam') }}
              </button>
              <button
                v-if="lead.notificationStatus === 'failed'"
                type="button"
                class="rounded-lg border border-amber-500/40 px-3 py-2 text-xs font-bold text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
                :disabled="Boolean(activeAction)"
                @click="retryNotification(lead)"
              >
                {{ actionBusy(lead, 'notify') ? t('marketingLeads.working') : t('marketingLeads.retryNotification') }}
              </button>
            </div>
          </div>

          <div class="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <p class="text-xs font-semibold text-slate-500">
              {{ lead.leadType === 'product_waitlist' ? t('marketingLeads.product') : t('marketingLeads.subject') }}
            </p>
            <p class="mt-1 text-sm font-semibold text-slate-200">{{ detailLabel(lead) }}</p>
            <p v-if="lead.message" class="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-300">
              {{ lead.message }}
            </p>
          </div>

          <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
            <div>
              <dt class="text-slate-500">{{ t('marketingLeads.source') }}</dt>
              <dd class="mt-0.5 break-words text-slate-300">{{ lead.source }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('marketingLeads.lastSubmitted') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ formatDate(lead.lastSubmittedAt) }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('marketingLeads.repeatCount') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ lead.submissionCount }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('marketingLeads.assignedTo') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ lead.assignedToName || t('marketingLeads.unassigned') }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('marketingLeads.notificationState') }}</dt>
              <dd class="mt-0.5 text-slate-300">
                {{ notificationLabel(lead.notificationStatus) }}
                <span v-if="lead.notificationAt"> · {{ formatDate(lead.notificationAt) }}</span>
              </dd>
            </div>
          </dl>

          <label v-if="assignmentAvailable" class="mt-4 block max-w-sm text-xs font-semibold text-slate-400">
            {{ t('marketingLeads.assignLead') }}
            <select
              :value="lead.assignedToId || ''"
              class="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-farm-green focus:outline-none disabled:opacity-50"
              :disabled="Boolean(activeAction)"
              @change="updateLead(lead, { assignedToId: ($event.target as HTMLSelectElement).value }, 'assign')"
            >
              <option value="" disabled>{{ t('marketingLeads.chooseAssignee') }}</option>
              <option v-for="user in assignmentUsers" :key="user.id" :value="user.id">{{ user.name }}</option>
            </select>
          </label>

          <p
            v-if="lead.notificationError"
            class="mt-3 break-words rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-300"
          >
            <span class="font-bold">{{ t('marketingLeads.notificationError') }}:</span>
            {{ lead.notificationError }}
          </p>
        </article>
      </div>
    </section>
  </AppLayout>
</template>
