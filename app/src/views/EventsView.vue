<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

const { t } = useI18n()

type Json = Record<string, unknown> | null

type FarmEvent = {
  id: string
  eventType: string
  entityType: string
  entityId: string
  source: string
  approvalStatus?: string | null
  actorName?: string | null
  createdAt: string
  metadata?: Json
  beforeValue?: Json
  afterValue?: Json
}

const events = ref<FarmEvent[]>([])
const loading = ref(true)
const selected = ref<FarmEvent | null>(null)
const filter = ref<'all' | 'chat' | 'actions'>('all')

const FILTERS = computed<{ id: 'all' | 'chat' | 'actions'; label: string }[]>(() => [
  { id: 'all', label: t('events.filterAll') },
  { id: 'chat', label: t('events.filterChat') },
  { id: 'actions', label: t('events.filterActions') },
])

function isChat(evt: FarmEvent): boolean {
  return evt.entityType.includes('message') || messageText(evt) !== null
}

const filteredEvents = computed(() => {
  if (filter.value === 'chat') return events.value.filter(isChat)
  if (filter.value === 'actions') return events.value.filter((e) => !isChat(e))
  return events.value
})

async function load() {
  loading.value = true
  try {
    const data = await api<{ events: FarmEvent[] }>('/api/events?limit=100')
    events.value = data.events
  } finally {
    loading.value = false
  }
}

onMounted(load)

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Chat/message events store the question or reply text in afterValue.text. */
function messageText(evt: FarmEvent): string | null {
  const after = asRecord(evt.afterValue)
  return typeof after?.text === 'string' ? after.text : null
}

function messageKind(evt: FarmEvent): string | null {
  const meta = asRecord(evt.metadata)
  return typeof meta?.kind === 'string' ? meta.kind : null
}

function direction(evt: FarmEvent): string | null {
  const meta = asRecord(evt.metadata)
  return typeof meta?.direction === 'string' ? meta.direction : null
}

function messageRole(evt: FarmEvent): string | null {
  const after = asRecord(evt.afterValue)
  return typeof after?.role === 'string' ? after.role : null
}

/** Human label for what the event is: a question, a reply, a voice note, etc. */
function kindLabel(evt: FarmEvent): string | null {
  const kind = messageKind(evt)
  const dir = direction(evt)
  if (kind === 'voice') return dir === 'outbound' ? t('events.voiceReply') : t('events.voiceNote')
  if (kind === 'image') return t('events.photo')
  if (dir === 'inbound') return t('events.question')
  if (dir === 'outbound') return t('events.reply')
  return null
}

function preview(evt: FarmEvent): string {
  const text = messageText(evt)
  if (text) return text.length > 90 ? `${text.slice(0, 90)}…` : text
  return '-'
}

function hasKeys(value: Json | undefined): boolean {
  return !!value && Object.keys(value).length > 0
}

function prettyJson(value: Json | undefined): string {
  return JSON.stringify(value ?? null, null, 2)
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
</script>

<template>
  <AppLayout>
    <div>
      <h2 class="text-2xl font-black text-os-fg">{{ t('events.title') }}</h2>
      <p class="text-slate-400 text-sm mt-1">
        {{ t('events.subtitle') }}
      </p>
    </div>

    <div class="mt-4 flex flex-wrap gap-2">
      <button
        v-for="f in FILTERS"
        :key="f.id"
        type="button"
        class="text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors"
        :class="filter === f.id ? 'bg-farm-green/20 text-farm-green' : 'bg-slate-800 text-slate-400 hover:text-white'"
        @click="filter = f.id"
      >
        {{ f.label }}
      </button>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('events.loading') }}</div>

    <div v-else class="mt-6">
      <ul class="space-y-3 sm:hidden">
        <li v-for="evt in filteredEvents" :key="`mobile-${evt.id}`">
          <button
            type="button"
            class="w-full rounded-xl border border-slate-800 bg-slate-900 p-4 text-left"
            @click="selected = evt"
          >
            <span class="flex items-start justify-between gap-3">
              <span class="font-semibold capitalize text-white">{{ evt.eventType.replace(/_/g, ' ') }}</span>
              <span class="shrink-0 text-xs text-slate-500">{{ formatTime(evt.createdAt) }}</span>
            </span>
            <span class="mt-1 block text-xs capitalize text-slate-500">
              {{ evt.entityType.replace(/_/g, ' ') }} · {{ evt.source }}
            </span>
            <span v-if="preview(evt) !== '-'" class="mt-2 block truncate text-sm text-slate-300">
              {{ preview(evt) }}
            </span>
            <span class="mt-2 block text-xs text-slate-400">
              {{ evt.actorName ?? '-' }}
              <span v-if="evt.approvalStatus"> · {{ evt.approvalStatus.replace(/_/g, ' ') }}</span>
            </span>
          </button>
        </li>
      </ul>

      <div class="hidden overflow-x-auto sm:block">
      <table class="w-full min-w-[720px] text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">{{ t('events.time') }}</th>
            <th class="pb-3 font-semibold">{{ t('events.event') }}</th>
            <th class="pb-3 font-semibold">{{ t('events.details') }}</th>
            <th class="pb-3 font-semibold">{{ t('events.source') }}</th>
            <th class="pb-3 font-semibold">{{ t('events.actor') }}</th>
            <th class="pb-3 font-semibold">{{ t('events.status') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="evt in filteredEvents"
            :key="evt.id"
            class="border-b border-slate-800/50 cursor-pointer hover:bg-slate-900/60 transition-colors"
            @click="selected = evt"
          >
            <td class="py-4 text-slate-400 whitespace-nowrap align-top">
              {{ formatTime(evt.createdAt) }}
            </td>
            <td class="py-4 align-top">
              <span class="text-white capitalize">{{ evt.eventType.replace(/_/g, ' ') }}</span>
              <span class="block text-xs text-slate-500 capitalize">{{ evt.entityType.replace(/_/g, ' ') }}</span>
            </td>
            <td class="py-4 align-top max-w-xs">
              <span
                v-if="kindLabel(evt)"
                class="inline-block mb-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
                :class="direction(evt) === 'outbound'
                  ? 'bg-farm-green/20 text-farm-green'
                  : 'bg-blue-500/20 text-blue-300'"
              >
                {{ kindLabel(evt) }}
              </span>
              <span class="block text-slate-300 truncate">{{ preview(evt) }}</span>
            </td>
            <td class="py-4 text-slate-400 capitalize align-top">{{ evt.source }}</td>
            <td class="py-4 text-slate-400 align-top">{{ evt.actorName ?? '-' }}</td>
            <td class="py-4 text-slate-400 capitalize align-top">
              {{ evt.approvalStatus?.replace(/_/g, ' ') ?? '-' }}
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-if="!filteredEvents.length" class="text-slate-500 text-sm mt-4">{{ t('events.noEvents') }}</p>
    </div>

    <!-- Event detail -->
    <div
      v-if="selected"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div class="absolute inset-0 bg-black/70" @click="selected = null" />
      <div class="relative w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h3 class="text-lg font-black text-os-fg capitalize">
              {{ selected.eventType.replace(/_/g, ' ') }}
            </h3>
            <p class="text-xs text-slate-500 capitalize">{{ selected.entityType.replace(/_/g, ' ') }}</p>
          </div>
          <button
            type="button"
            class="text-slate-400 hover:text-white p-1 -m-1"
            :aria-label="t('events.close')"
            @click="selected = null"
          >
            ✕
          </button>
        </div>

        <!-- The message / question / transcript -->
        <div v-if="messageText(selected)" class="mt-4 rounded-xl border border-slate-700 bg-slate-950/60 p-4">
          <div class="flex flex-wrap items-center gap-2">
            <span
              v-if="kindLabel(selected)"
              class="text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
              :class="direction(selected) === 'outbound'
                ? 'bg-farm-green/20 text-farm-green'
                : 'bg-blue-500/20 text-blue-300'"
            >
              {{ kindLabel(selected) }}
            </span>
            <span v-if="messageRole(selected)" class="text-[11px] text-slate-500 capitalize">
              {{ messageRole(selected) === 'assistant' ? t('events.butler') : messageRole(selected) }}
            </span>
          </div>
          <p class="mt-2 text-sm text-slate-200 whitespace-pre-wrap break-words">{{ messageText(selected) }}</p>
          <p v-if="messageKind(selected) === 'voice'" class="mt-2 text-[11px] text-slate-500">
            {{ t('events.transcribedNote') }}
          </p>
        </div>

        <!-- Key facts -->
        <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div>
            <dt class="text-xs text-slate-500">{{ t('events.time') }}</dt>
            <dd class="text-slate-300">{{ formatTime(selected.createdAt) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-500">{{ t('events.actor') }}</dt>
            <dd class="text-slate-300">{{ selected.actorName ?? '-' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-500">{{ t('events.source') }}</dt>
            <dd class="text-slate-300 capitalize">{{ selected.source }}</dd>
          </div>
          <div v-if="direction(selected)">
            <dt class="text-xs text-slate-500">{{ t('events.direction') }}</dt>
            <dd class="text-slate-300 capitalize">{{ direction(selected) }}</dd>
          </div>
          <div v-if="selected.approvalStatus">
            <dt class="text-xs text-slate-500">{{ t('events.status') }}</dt>
            <dd class="text-slate-300 capitalize">{{ selected.approvalStatus.replace(/_/g, ' ') }}</dd>
          </div>
        </dl>

        <!-- Raw data changes for non-chat events -->
        <details v-if="hasKeys(selected.beforeValue)" class="mt-4">
          <summary class="cursor-pointer text-xs font-semibold text-slate-400 hover:text-white">{{ t('events.before') }}</summary>
          <pre class="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-300">{{ prettyJson(selected.beforeValue) }}</pre>
        </details>
        <details v-if="hasKeys(selected.afterValue) && !messageText(selected)" class="mt-4">
          <summary class="cursor-pointer text-xs font-semibold text-slate-400 hover:text-white">{{ t('events.after') }}</summary>
          <pre class="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-300">{{ prettyJson(selected.afterValue) }}</pre>
        </details>
        <details v-if="hasKeys(selected.metadata)" class="mt-4">
          <summary class="cursor-pointer text-xs font-semibold text-slate-400 hover:text-white">{{ t('events.metadata') }}</summary>
          <pre class="mt-2 overflow-x-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-300">{{ prettyJson(selected.metadata) }}</pre>
        </details>
      </div>
    </div>
  </AppLayout>
</template>
