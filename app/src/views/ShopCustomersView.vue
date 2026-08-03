<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

type ShopCustomer = {
  id: string
  email: string
  name: string
  phone: string | null
  emailVerifiedAt: string | null
  active: boolean
  createdAt: string
  updatedAt: string
  channels: { channel: string; name: string | null }[]
}

type ShopCustomersResponse = {
  customers: ShopCustomer[]
  summary: {
    total: number
    verified: number
    unverified: number
    inactive: number
  }
}

type VerifiedFilter = 'all' | 'yes' | 'no'
type ActiveFilter = 'all' | 'yes' | 'no'

const { t, locale } = useI18n()
const customers = ref<ShopCustomer[]>([])
const summary = ref({ total: 0, verified: 0, unverified: 0, inactive: 0 })
const loading = ref(true)
const error = ref<string | null>(null)
const search = ref('')
const verifiedFilter = ref<VerifiedFilter>('all')
const activeFilter = ref<ActiveFilter>('all')

const filteredCustomers = computed(() => {
  const term = search.value.trim().toLocaleLowerCase(locale.value)
  return customers.value.filter((customer) => {
    if (verifiedFilter.value === 'yes' && !customer.emailVerifiedAt) return false
    if (verifiedFilter.value === 'no' && customer.emailVerifiedAt) return false
    if (activeFilter.value === 'yes' && !customer.active) return false
    if (activeFilter.value === 'no' && customer.active) return false
    if (!term) return true
    return [customer.name, customer.email, customer.phone, ...customer.channels.map((c) => c.channel)]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase(locale.value).includes(term))
  })
})

function formatDate(value: string | null | undefined): string {
  if (!value) return t('shopCustomers.notAvailable')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return t('shopCustomers.notAvailable')
  return new Intl.DateTimeFormat(locale.value, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}

function verificationLabel(customer: ShopCustomer): string {
  return customer.emailVerifiedAt
    ? t('shopCustomers.verified')
    : t('shopCustomers.unverified')
}

function activeLabel(customer: ShopCustomer): string {
  return customer.active ? t('shopCustomers.active') : t('shopCustomers.inactive')
}

function channelsLabel(customer: ShopCustomer): string {
  if (!customer.channels.length) return t('shopCustomers.noChannels')
  return customer.channels.map((c) => c.channel).join(', ')
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

async function loadCustomers() {
  loading.value = true
  error.value = null
  try {
    const data = await api<ShopCustomersResponse>('/api/shop-customers')
    customers.value = data.customers ?? []
    summary.value = {
      total: data.summary?.total ?? 0,
      verified: data.summary?.verified ?? 0,
      unverified: data.summary?.unverified ?? 0,
      inactive: data.summary?.inactive ?? 0,
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('shopCustomers.loadFailed')
  } finally {
    loading.value = false
  }
}

function exportCsv() {
  const headers = [
    t('shopCustomers.name'),
    t('shopCustomers.email'),
    t('shopCustomers.phone'),
    t('shopCustomers.verification'),
    t('shopCustomers.verifiedAt'),
    t('shopCustomers.statusLabel'),
    t('shopCustomers.channels'),
    t('shopCustomers.createdAt'),
    t('shopCustomers.updatedAt'),
  ]
  const rows = filteredCustomers.value.map((customer) => [
    customer.name,
    customer.email,
    customer.phone ?? '',
    verificationLabel(customer),
    customer.emailVerifiedAt ?? '',
    activeLabel(customer),
    channelsLabel(customer),
    customer.createdAt,
    customer.updatedAt,
  ])
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `shop-customers-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

onMounted(loadCustomers)
</script>

<template>
  <AppLayout>
    <header class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <p class="text-xs font-bold uppercase tracking-[0.2em] text-farm-green">
          {{ t('shopCustomers.eyebrow') }}
        </p>
        <h2 class="mt-1 text-2xl font-black text-os-fg">{{ t('shopCustomers.title') }}</h2>
        <p class="mt-1 max-w-2xl text-sm text-slate-400">{{ t('shopCustomers.subtitle') }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          :disabled="loading"
          @click="loadCustomers"
        >
          {{ t('shopCustomers.refresh') }}
        </button>
        <button
          type="button"
          class="rounded-lg border border-farm-green/40 bg-farm-green/10 px-3 py-2 text-sm font-semibold text-farm-green hover:bg-farm-green/20 disabled:opacity-50"
          :disabled="loading || !filteredCustomers.length"
          @click="exportCsv"
        >
          {{ t('shopCustomers.exportCsv') }}
        </button>
      </div>
    </header>

    <section class="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" :aria-label="t('shopCustomers.summary')">
      <div class="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p class="text-xs font-bold uppercase tracking-wider text-slate-500">{{ t('shopCustomers.total') }}</p>
        <p class="mt-2 text-2xl font-black text-os-fg">{{ summary.total }}</p>
      </div>
      <div class="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p class="text-xs font-bold uppercase tracking-wider text-slate-500">{{ t('shopCustomers.verified') }}</p>
        <p class="mt-2 text-2xl font-black text-emerald-300">{{ summary.verified }}</p>
      </div>
      <div class="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p class="text-xs font-bold uppercase tracking-wider text-slate-500">{{ t('shopCustomers.unverified') }}</p>
        <p class="mt-2 text-2xl font-black text-amber-300">{{ summary.unverified }}</p>
      </div>
      <div class="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p class="text-xs font-bold uppercase tracking-wider text-slate-500">{{ t('shopCustomers.inactive') }}</p>
        <p class="mt-2 text-2xl font-black text-slate-300">{{ summary.inactive }}</p>
      </div>
    </section>

    <section class="mt-6 flex flex-wrap gap-3">
      <label class="min-w-[14rem] flex-1 text-sm">
        <span class="sr-only">{{ t('shopCustomers.search') }}</span>
        <input
          v-model="search"
          type="search"
          :placeholder="t('shopCustomers.searchPlaceholder')"
          class="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-2.5 text-sm text-os-fg outline-none focus:border-farm-green"
        />
      </label>
      <label class="text-sm">
        <span class="sr-only">{{ t('shopCustomers.filterVerified') }}</span>
        <select
          v-model="verifiedFilter"
          class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-os-fg outline-none focus:border-farm-green"
        >
          <option value="all">{{ t('shopCustomers.allVerification') }}</option>
          <option value="yes">{{ t('shopCustomers.verified') }}</option>
          <option value="no">{{ t('shopCustomers.unverified') }}</option>
        </select>
      </label>
      <label class="text-sm">
        <span class="sr-only">{{ t('shopCustomers.filterActive') }}</span>
        <select
          v-model="activeFilter"
          class="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-os-fg outline-none focus:border-farm-green"
        >
          <option value="all">{{ t('shopCustomers.allStatuses') }}</option>
          <option value="yes">{{ t('shopCustomers.active') }}</option>
          <option value="no">{{ t('shopCustomers.inactive') }}</option>
        </select>
      </label>
    </section>

    <p v-if="error" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
      {{ error }}
      <button type="button" class="ml-3 font-bold underline" @click="loadCustomers">
        {{ t('shopCustomers.tryAgain') }}
      </button>
    </p>

    <section class="mt-6">
      <div v-if="loading" class="rounded-2xl border border-slate-800 bg-slate-950/40 p-8 text-center text-sm text-slate-400">
        {{ t('shopCustomers.loading') }}
      </div>
      <div
        v-else-if="!filteredCustomers.length"
        class="rounded-2xl border border-slate-800 bg-slate-950/40 p-8 text-center text-sm text-slate-400"
      >
        {{ customers.length ? t('shopCustomers.noMatches') : t('shopCustomers.empty') }}
      </div>
      <div v-else class="space-y-3">
        <article
          v-for="customer in filteredCustomers"
          :key="customer.id"
          class="rounded-2xl border border-slate-800 bg-slate-950/60 p-5"
        >
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-lg font-black text-os-fg">{{ customer.name }}</h3>
                <span
                  class="rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider"
                  :class="customer.emailVerifiedAt ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'"
                >
                  {{ verificationLabel(customer) }}
                </span>
                <span
                  class="rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider"
                  :class="customer.active ? 'bg-farm-green/15 text-farm-green' : 'bg-slate-500/15 text-slate-300'"
                >
                  {{ activeLabel(customer) }}
                </span>
              </div>
              <a class="mt-1 block break-all text-sm text-farm-green hover:underline" :href="`mailto:${customer.email}`">
                {{ customer.email }}
              </a>
              <a
                v-if="customer.phone"
                class="mt-1 block text-sm text-slate-300 hover:text-white"
                :href="`tel:${customer.phone}`"
              >
                {{ customer.phone }}
              </a>
            </div>
          </div>

          <dl class="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt class="text-slate-500">{{ t('shopCustomers.verifiedAt') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ formatDate(customer.emailVerifiedAt) }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('shopCustomers.createdAt') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ formatDate(customer.createdAt) }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('shopCustomers.updatedAt') }}</dt>
              <dd class="mt-0.5 text-slate-300">{{ formatDate(customer.updatedAt) }}</dd>
            </div>
            <div>
              <dt class="text-slate-500">{{ t('shopCustomers.channels') }}</dt>
              <dd class="mt-0.5 capitalize text-slate-300">{{ channelsLabel(customer) }}</dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
  </AppLayout>
</template>
