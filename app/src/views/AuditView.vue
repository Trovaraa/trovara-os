<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

const { t } = useI18n()

type AuditActor = { id: string; name: string | null; email: string | null } | null

type AuditEvent = {
  id: string
  ts: string
  action: string
  entityType: string
  entityId: string | null
  domain: string
  actor: AuditActor
  metadata: Record<string, unknown>
}

type AuditDomainOption = { key: string; label: string }

const loading = ref(true)
const events = ref<AuditEvent[]>([])
const domains = ref<AuditDomainOption[]>([])
const loadError = ref<string | null>(null)
const selectedId = ref<string | null>(null)

const domain = ref('all')
const action = ref('')
const from = ref('')
const to = ref('')

const selected = computed(() => events.value.find((e) => e.id === selectedId.value) ?? null)

function formatDetails(metadata: Record<string, unknown>): string {
  const skip = new Set(['ip', 'country', 'region'])
  const keys = Object.keys(metadata).filter((k) => !skip.has(k))
  if (keys.length === 0) return t('audit.noDetails')
  return keys
    .slice(0, 4)
    .map((k) => `${k}: ${String(metadata[k])}`)
    .join(' · ')
}

function metaString(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key]
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function formatLocation(metadata: Record<string, unknown>): string {
  const country = metaString(metadata, 'country')
  const region = metaString(metadata, 'region')
  if (region && country) return `${region}, ${country}`
  return country || region || t('audit.noDetails')
}

function actorLabel(actor: AuditActor): string {
  if (!actor) return t('audit.systemActor')
  return actor.name?.trim() || actor.email?.trim() || actor.id
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const params = new URLSearchParams()
    if (domain.value && domain.value !== 'all') params.set('domain', domain.value)
    if (action.value.trim()) params.set('action', action.value.trim())
    if (from.value) params.set('from', new Date(from.value).toISOString())
    if (to.value) {
      const end = new Date(to.value)
      end.setHours(23, 59, 59, 999)
      params.set('to', end.toISOString())
    }
    params.set('limit', '100')
    const qs = params.toString()
    const data = await api<{ events: AuditEvent[]; domains: AuditDomainOption[] }>(
      `/api/system/audit-events${qs ? `?${qs}` : ''}`,
    )
    events.value = data.events
    domains.value = data.domains ?? []
    if (selectedId.value && !events.value.some((e) => e.id === selectedId.value)) {
      selectedId.value = null
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : t('audit.loadFailed')
  } finally {
    loading.value = false
  }
}

watch([domain, action, from, to], () => {
  void load()
})

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <RouterLink to="/settings" class="text-xs text-slate-500 hover:text-farm-green">
          {{ t('audit.backToSettings') }}
        </RouterLink>
        <h2 class="text-2xl font-black text-os-fg mt-2">{{ t('audit.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('audit.subtitle') }}</p>
      </div>
      <a
        href="/api/exports/audit.csv"
        class="text-sm px-4 py-2 rounded-lg bg-slate-800 text-farm-green hover:bg-slate-700"
      >
        {{ t('audit.downloadCsv') }}
      </a>
    </div>

    <div class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label class="block text-xs text-slate-500">
        {{ t('audit.filterDomain') }}
        <select
          v-model="domain"
          class="mt-1.5 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"
        >
          <option value="all">{{ t('audit.domainAll') }}</option>
          <option v-for="d in domains" :key="d.key" :value="d.key">{{ d.label }}</option>
        </select>
      </label>
      <label class="block text-xs text-slate-500">
        {{ t('audit.filterAction') }}
        <input
          v-model="action"
          type="text"
          :placeholder="t('audit.actionPlaceholder')"
          class="mt-1.5 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white placeholder:text-slate-600"
        />
      </label>
      <label class="block text-xs text-slate-500">
        {{ t('audit.filterFrom') }}
        <input
          v-model="from"
          type="date"
          class="mt-1.5 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"
        />
      </label>
      <label class="block text-xs text-slate-500">
        {{ t('audit.filterTo') }}
        <input
          v-model="to"
          type="date"
          class="mt-1.5 w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white"
        />
      </label>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('audit.loading') }}</div>
    <p v-else-if="loadError" class="mt-8 text-sm text-red-400">{{ loadError }}</p>

    <div v-else class="mt-8 grid lg:grid-cols-[1fr_320px] gap-6">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-slate-500 border-b border-slate-800">
              <th class="pb-3 font-semibold">{{ t('audit.thTimestamp') }}</th>
              <th class="pb-3 font-semibold">{{ t('audit.thAction') }}</th>
              <th class="pb-3 font-semibold">{{ t('audit.thEntity') }}</th>
              <th class="pb-3 font-semibold">{{ t('audit.thActor') }}</th>
              <th class="pb-3 font-semibold">{{ t('audit.thDetails') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="event in events"
              :key="event.id"
              class="border-b border-slate-800/50 cursor-pointer hover:bg-slate-900/60"
              :class="selectedId === event.id ? 'bg-slate-900' : ''"
              @click="selectedId = event.id"
            >
              <td class="py-3 text-slate-400 whitespace-nowrap">
                {{ new Date(event.ts).toLocaleString() }}
              </td>
              <td class="py-3 font-mono text-farm-gold">{{ event.action }}</td>
              <td class="py-3 text-slate-300 text-xs">
                <span class="text-slate-500">{{ event.domain }}</span>
                · {{ event.entityType }}
                <span v-if="event.entityId" class="text-slate-500"> #{{ event.entityId.slice(0, 8) }}</span>
              </td>
              <td class="py-3 text-slate-300 text-xs whitespace-nowrap">
                {{ actorLabel(event.actor) }}
              </td>
              <td class="py-3 text-slate-400 text-xs break-all">
                {{ formatDetails(event.metadata) }}
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!events.length" class="text-slate-500 text-sm mt-4">{{ t('audit.noEvents') }}</p>
        <p v-else class="text-xs text-slate-500 mt-4">{{ t('audit.hint') }}</p>
      </div>

      <aside
        v-if="selected"
        class="bg-slate-900 border border-slate-800 rounded-xl p-4 h-fit lg:sticky lg:top-4"
      >
        <div class="flex items-start justify-between gap-2">
          <h3 class="text-sm font-bold text-white">{{ t('audit.detailTitle') }}</h3>
          <button
            type="button"
            class="text-xs text-slate-500 hover:text-slate-300"
            @click="selectedId = null"
          >
            {{ t('audit.closeDetail') }}
          </button>
        </div>
        <dl class="mt-3 space-y-2 text-xs">
          <div>
            <dt class="text-slate-500">{{ t('audit.thTimestamp') }}</dt>
            <dd class="text-slate-200">{{ new Date(selected.ts).toLocaleString() }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">{{ t('audit.thAction') }}</dt>
            <dd class="font-mono text-farm-gold">{{ selected.action }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">{{ t('audit.thEntity') }}</dt>
            <dd class="text-slate-200">
              {{ selected.entityType }}
              <span v-if="selected.entityId" class="text-slate-500 block break-all">{{
                selected.entityId
              }}</span>
            </dd>
          </div>
          <div>
            <dt class="text-slate-500">{{ t('audit.thActor') }}</dt>
            <dd class="text-slate-200">
              {{ actorLabel(selected.actor) }}
              <span v-if="selected.actor?.email" class="text-slate-500 block">{{
                selected.actor.email
              }}</span>
            </dd>
          </div>
          <div>
            <dt class="text-slate-500">{{ t('audit.thIp') }}</dt>
            <dd class="font-mono text-slate-300">
              {{ metaString(selected.metadata, 'ip') || t('audit.noDetails') }}
            </dd>
          </div>
          <div>
            <dt class="text-slate-500">{{ t('audit.thLocation') }}</dt>
            <dd class="text-slate-300">{{ formatLocation(selected.metadata) }}</dd>
          </div>
          <div>
            <dt class="text-slate-500">{{ t('audit.thMetadata') }}</dt>
            <dd>
              <pre
                class="mt-1 max-h-64 overflow-auto rounded-lg bg-slate-950 border border-slate-800 p-2 text-[11px] text-slate-300 whitespace-pre-wrap break-all"
                >{{ JSON.stringify(selected.metadata, null, 2) }}</pre
              >
            </dd>
          </div>
        </dl>
      </aside>
    </div>
  </AppLayout>
</template>
