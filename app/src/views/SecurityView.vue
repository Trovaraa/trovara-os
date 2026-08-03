<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/AppLayout.vue'
import { api } from '@/lib/api'

const { t } = useI18n()

type SecurityEvent = {
  ts: string
  type: string
  metadata: Record<string, unknown>
}

type SessionRow = {
  id: string
  createdAt: string
  expiresAt: string
  userAgent: string | null
  current: boolean
}

const loading = ref(true)
const events = ref<SecurityEvent[]>([])
const loadError = ref<string | null>(null)
const activeSessions = ref<number | null>(null)
const sessionRows = ref<SessionRow[]>([])
const revoking = ref(false)
const revokingId = ref<string | null>(null)
const revokeMessage = ref<string | null>(null)

function formatDetails(metadata: Record<string, unknown>): string {
  const skip = new Set(['ip', 'country', 'region'])
  const keys = Object.keys(metadata).filter((k) => !skip.has(k))
  if (keys.length === 0) return t('security.noDetails')
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
  return country || region || t('security.noDetails')
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    const [eventsData, sessionsData] = await Promise.all([
      api<{ events: SecurityEvent[] }>('/api/system/security-events'),
      api<{ activeSessions?: number; sessions?: SessionRow[] }>('/auth/sessions'),
    ])
    events.value = eventsData.events
    activeSessions.value =
      typeof sessionsData.activeSessions === 'number' ? sessionsData.activeSessions : null
    sessionRows.value = sessionsData.sessions ?? []
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : t('security.loadFailed')
  } finally {
    loading.value = false
  }
}

async function revokeAllSessions() {
  if (!window.confirm(t('security.confirmRevoke'))) return
  revoking.value = true
  revokeMessage.value = null
  try {
    const data = await api<{ revokedSessions?: number; message?: string }>(
      '/auth/revoke-all-sessions',
      { method: 'POST' },
    )
    revokeMessage.value =
      data.message ??
      t('security.revokedN', { count: data.revokedSessions ?? 0 })
    await load()
  } catch (e) {
    revokeMessage.value = e instanceof Error ? e.message : t('security.revokeFailed')
  } finally {
    revoking.value = false
  }
}

async function revokeOne(sessionId: string) {
  revokingId.value = sessionId
  revokeMessage.value = null
  try {
    await api(`/auth/sessions/${sessionId}`, { method: 'DELETE' })
    revokeMessage.value = t('security.sessionRevoked')
    await load()
  } catch (e) {
    revokeMessage.value = e instanceof Error ? e.message : t('security.revokeFailed')
  } finally {
    revokingId.value = null
  }
}

onMounted(load)
</script>

<template>
  <AppLayout>
    <div class="flex items-start justify-between gap-4">
      <div>
        <RouterLink to="/settings" class="text-xs text-slate-500 hover:text-farm-green">
          {{ t('security.backToSettings') }}
        </RouterLink>
        <h2 class="text-2xl font-black text-os-fg mt-2">{{ t('security.title') }}</h2>
        <p class="text-slate-400 text-sm mt-1">{{ t('security.subtitle') }}</p>
      </div>
      <button
        type="button"
        class="text-sm px-4 py-2 rounded-lg bg-red-900/40 text-red-300 hover:bg-red-900/60 disabled:opacity-50"
        :disabled="revoking"
        @click="revokeAllSessions"
      >
        {{ revoking ? t('security.revoking') : t('security.logOutAllDevices') }}
      </button>
    </div>

    <p v-if="revokeMessage" class="mt-4 text-xs text-slate-400">{{ revokeMessage }}</p>

    <div v-if="activeSessions !== null" class="mt-6 bg-slate-900 border border-slate-800 rounded-xl p-5">
      <p class="text-xs text-slate-500">{{ t('security.activeSessionsLabel') }}</p>
      <p class="text-2xl font-black text-os-fg mt-1">{{ activeSessions }}</p>
      <ul v-if="sessionRows.length" class="mt-4 space-y-2">
        <li
          v-for="s in sessionRows"
          :key="s.id"
          class="flex items-center justify-between gap-3 text-xs border border-slate-800 rounded-lg px-3 py-2"
        >
          <div class="min-w-0">
            <p class="text-slate-200 truncate">{{ s.userAgent || t('security.unknownDevice') }}</p>
            <p class="text-slate-500 mt-0.5">
              {{ new Date(s.createdAt).toLocaleString() }}
              <span v-if="s.current" class="ml-2 text-farm-green font-semibold">{{ t('security.thisDevice') }}</span>
            </p>
          </div>
          <button
            v-if="!s.current"
            type="button"
            class="shrink-0 px-2 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
            :disabled="revokingId === s.id"
            @click="revokeOne(s.id)"
          >
            {{ revokingId === s.id ? '…' : t('security.revokeSession') }}
          </button>
        </li>
      </ul>
    </div>

    <div v-if="loading" class="mt-8 text-slate-400">{{ t('security.loading') }}</div>
    <p v-else-if="loadError" class="mt-8 text-sm text-red-400">{{ loadError }}</p>

    <div v-else class="mt-8 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="pb-3 font-semibold">{{ t('security.thTimestamp') }}</th>
            <th class="pb-3 font-semibold">{{ t('security.thAction') }}</th>
            <th class="pb-3 font-semibold">{{ t('security.thIp') }}</th>
            <th class="pb-3 font-semibold">{{ t('security.thLocation') }}</th>
            <th class="pb-3 font-semibold">{{ t('security.thDetails') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(event, idx) in events"
            :key="`${event.ts}-${idx}`"
            class="border-b border-slate-800/50"
          >
            <td class="py-3 text-slate-400 whitespace-nowrap">
              {{ new Date(event.ts).toLocaleString() }}
            </td>
            <td class="py-3 font-mono text-farm-gold">{{ event.type }}</td>
            <td class="py-3 text-slate-300 font-mono text-xs whitespace-nowrap">
              {{ metaString(event.metadata, 'ip') || t('security.noDetails') }}
            </td>
            <td class="py-3 text-slate-400 text-xs whitespace-nowrap">
              {{ formatLocation(event.metadata) }}
            </td>
            <td class="py-3 text-slate-400 text-xs break-all">
              {{ formatDetails(event.metadata) }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!events.length" class="text-slate-500 text-sm mt-4">{{ t('security.noEvents') }}</p>
    </div>
  </AppLayout>
</template>
